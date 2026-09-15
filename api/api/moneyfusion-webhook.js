// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/moneyfusion-webhook  (webhook MoneyFusion : crédite le portefeuille)
//
//  MoneyFusion appelle cette URL quand un paiement change de statut, ET
//  redirige le navigateur vers return_url (?token=…). On NE FAIT JAMAIS
//  confiance au corps reçu : on REVÉRIFIE le statut réel auprès de
//  MoneyFusion via le token, puis on crédite le portefeuille / passe la
//  commande en "payée" — UNE SEULE FOIS (anti-doublon via notre référence).
//
//  ⚠️ Dans le tableau de bord MoneyFusion, l'URL webhook doit être :
//        https://mgloot.com/api/moneyfusion-webhook
//  Env Vercel REQUISES : MONEYFUSION_API_URL, FIREBASE_SERVICE_ACCOUNT
//  Env OPTIONNELLE : MONEYFUSION_STATUS_URL_TEMPLATE
//        (défaut : https://pay.moneyfusion.net/paiementNotif/{token})
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

// ── Sortie via proxy à IP FIXE pour la vérification (whitelist IP MoneyFusion).
//    Réutilise FT_PROXY_URL (ou MONEYFUSION_PROXY_URL). Ne s'applique QU'AUX
//    appels vers MoneyFusion, pas aux appels internes Vercel.
let _mfAgent = null;
function _buildAgent(proxy) {
  const { ProxyAgent } = require('undici');
  const u = new URL(proxy);
  const cfg = { uri: u.protocol + '//' + u.host };
  if (u.username || u.password) {
    const cred = decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password);
    cfg.token = 'Basic ' + Buffer.from(cred).toString('base64');
  }
  return new ProxyAgent(cfg);
}
async function mfFetch(url, opts) {
  const proxy = process.env.MONEYFUSION_PROXY_URL || process.env.FT_PROXY_URL;
  if (proxy) {
    const { fetch: uFetch } = require('undici');
    if (!_mfAgent) _mfAgent = _buildAgent(proxy);
    return uFetch(url, Object.assign({}, opts, { dispatcher: _mfAgent }));
  }
  return fetch(url, opts);
}

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

function statusUrl(token) {
  const tpl = (process.env.MONEYFUSION_STATUS_URL_TEMPLATE || 'https://pay.moneyfusion.net/paiementNotif/{token}');
  return tpl.indexOf('{token}') >= 0 ? tpl.replace('{token}', encodeURIComponent(token)) : (tpl.replace(/\/+$/, '') + '/' + encodeURIComponent(token));
}

// Vérifie le statut réel auprès de MoneyFusion. Renvoie l'objet "data" ou null.
async function verifyPayment(token) {
  try {
    const r = await mfFetch(statusUrl(token), { method: 'GET', headers: { 'Accept': 'application/json' } });
    const j = await r.json().catch(() => ({}));
    const data = (j && (j.data || j.datas || j.details)) || (j && j.tokenPay ? j : null);
    return data || null;
  } catch (e) { return null; }
}

const isPaid = (s) => String(s || '').toLowerCase().trim() === 'paid';

module.exports = async (req, res) => {
  // MoneyFusion utilise POST pour le webhook ; on tolère aussi GET (retour navigateur).
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!process.env.MONEYFUSION_API_URL) { /* pas bloquant pour la vérif, mais on note la config */ }

    // 1) Récupère le token (corps webhook, ou ?token= du retour navigateur)
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { try { b = require('querystring').parse(b); } catch (_) { b = {}; } } }
    b = b || {};
    const q = req.query || {};
    const token = String(b.tokenPay || b.token || q.token || q.tokenPay || '').trim();
    if (!token) return res.status(400).json({ error: 'token manquant' });

    // 2) REVÉRIFICATION côté serveur (on ne fait pas confiance au corps reçu)
    const vd = await verifyPayment(token);
    if (!vd) return res.status(502).json({ error: 'Vérification MoneyFusion indisponible, réessayez.' });
    if (!isPaid(vd.statut)) return res.status(200).json({ ok: true, ignored: String(vd.statut || 'unknown') });

    // 3) Retrouve NOTRE référence (personal_Info.ref → sinon table token→ref)
    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    let ref = '';
    const pinfo = Array.isArray(vd.personal_Info) ? (vd.personal_Info[0] || {}) : (vd.personal_Info || {});
    if (pinfo && pinfo.ref) ref = String(pinfo.ref);
    if (!ref && Array.isArray(b.personal_Info) && b.personal_Info[0] && b.personal_Info[0].ref) ref = String(b.personal_Info[0].ref);
    if (!ref) {
      try { const t = await db.collection('moneyfusionTokens').doc(token).get(); if (t.exists) ref = String((t.data() || {}).ref || ''); } catch (e) {}
    }
    if (!ref) return res.status(400).json({ error: 'Référence de paiement introuvable' });

    const payRef = db.collection('moneyfusionPayments').doc(ref);
    const verifiedXof = Math.round(+vd.Montant || 0) + Math.round(+vd.frais || 0); // total payé (frais inclus)

    // 4) Traitement atomique + anti-doublon
    let credited = 0, target = '', kind = '', paidOrderId = '';
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(payRef);
      const d = snap.exists ? (snap.data() || {}) : {};
      if (d.status === 'credited' || d.status === 'paid') return;   // déjà traité

      let uid = d.uid, amountEur = +d.amountEur || 0, purpose = d.purpose || 'wallet', orderId = d.orderId || '', xof = +d.xof || 0;
      if (!uid || !amountEur) { // secours depuis personal_Info si l'enregistrement pending manque
        uid = uid || (pinfo && pinfo.userId) || '';
        amountEur = amountEur || (+ (pinfo && pinfo.amountEur) || 0);
        purpose = purpose || (pinfo && pinfo.purpose) || 'wallet';
        orderId = orderId || (pinfo && pinfo.orderId) || '';
      }
      if (!uid) throw new Error('Données de paiement incomplètes');

      // Contrôle anti-sous-paiement : le montant vérifié doit couvrir ~ le montant attendu
      if (xof > 0 && verifiedXof > 0 && verifiedXof < Math.floor(xof * 0.8)) {
        tx.set(payRef, { status: 'underpaid', verifiedXof, checkedAt: FieldValue.serverTimestamp() }, { merge: true });
        return;
      }

      if (purpose === 'order' && orderId) {
        // 💳 Paiement d'une COMMANDE → "payée" (la livraison auto se fait ensuite)
        tx.set(db.collection('orders').doc(orderId), {
          status: 'paid', paymentMethod: 'MoneyFusion', paymentRef: ref, paidAt: FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(payRef, { status: 'paid', paymentMethod: 'MoneyFusion', tokenPay: token, verifiedXof, creditedAt: FieldValue.serverTimestamp() }, { merge: true });
        kind = 'order'; paidOrderId = orderId; target = uid;
      } else {
        // 💰 Recharge du PORTEFEUILLE
        if (amountEur <= 0) throw new Error('Montant invalide');
        tx.set(db.collection('users').doc(uid), { walletBalance: FieldValue.increment(amountEur) }, { merge: true });
        tx.set(db.collection('users').doc(uid).collection('walletHistory').doc(), {
          amount: amountEur, type: 'credit', note: 'Recharge MoneyFusion', method: 'MoneyFusion',
          ref: ref, createdAt: FieldValue.serverTimestamp()
        });
        tx.set(payRef, { status: 'credited', paymentMethod: 'MoneyFusion', tokenPay: token, verifiedXof, creditedAt: FieldValue.serverTimestamp() }, { merge: true });
        kind = 'wallet'; credited = amountEur; target = uid;
      }
    });

    // 5) Après paiement d'une commande : déclenche la livraison automatique (FlashTopup)
    if (kind === 'order' && paidOrderId) {
      try {
        const base = (process.env.PUBLIC_BASE_URL || 'https://www.mgloot.com').replace(/\/+$/, '');
        await fetch(base + '/api/flashtopup-deliver', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: paidOrderId })
        }).catch(() => {});
      } catch (e) {}
    }
    // 6) Notifie le client
    if (target) {
      try {
        const note = (kind === 'order')
          ? { icon: '✅', title: 'Paiement reçu', body: 'Votre commande est payée (MoneyFusion). Livraison en cours.', type: 'order', link: 'orders' }
          : { icon: '💰', title: 'Portefeuille rechargé', body: 'Votre recharge de ' + credited.toFixed(2) + ' € (MoneyFusion) a été créditée.', type: 'wallet', link: 'wallet' };
        note.read = false; note.createdAt = FieldValue.serverTimestamp();
        await db.collection('users').doc(target).collection('notifications').add(note);
        // 📲 Push téléphone (même app fermée) — via /api/send-push
        try {
          const BASE = (process.env.PUBLIC_BASE_URL || 'https://www.mgloot.com').replace(/\/+$/, '');
          await fetch(BASE + '/api/send-push', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: target, title: (note.icon || '🔔') + ' ' + note.title, body: note.body, url: '/' })
          });
        } catch (e) {}
      } catch (e) {}
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
