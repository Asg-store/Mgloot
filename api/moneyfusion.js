// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/moneyfusion   (créer un paiement MoneyFusion + webhook)
//
//  UNE seule fonction pour rester dans la limite Vercel :
//   • action:'create'  → le client (authentifié Firebase) demande un
//     paiement. On crée un enregistrement "pending", on appelle
//     MoneyFusion, et on renvoie l'URL de redirection.
//   • sinon (POST de MoneyFusion) = WEBHOOK : quand le paiement réussit,
//     MoneyFusion appelle cette URL → on crédite le portefeuille OU on
//     passe la commande en "payée" + livraison auto (sécurisé, anti-doublon).
//
//  Env Vercel REQUISES :
//    - MONEYFUSION_API_URL   (ton lien d'API MoneyFusion, ex :
//        https://pay.moneyfusion.net/MGLOOT/919992e65a2b7491/pay/)
//    - PUBLIC_BASE_URL       (ex : https://mgloot.com)
//    - FIREBASE_SERVICE_ACCOUNT (déjà présente)
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

const EUR_XOF = 655.957;
const MF_URL = (process.env.MONEYFUSION_API_URL || 'https://pay.moneyfusion.net/MGLOOT/919992e65a2b7491/pay/');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 🔎 Outil : afficher l'IP de SORTIE réelle du serveur (pour l'allowlist MoneyFusion)
  //    Ouvrez https://mgloot.com/api/moneyfusion?ip=1 plusieurs fois.
  if (req.method === 'GET' && (req.query && (req.query.ip === '1' || req.query.ip === 'true'))) {
    try {
      const r = await fetch('https://api.ipify.org?format=json');
      const j = await r.json().catch(() => ({}));
      return res.status(200).json({ outboundIP: j.ip || '?', note: "Rechargez plusieurs fois : Vercel peut renvoyer plusieurs IP différentes." });
    } catch (e) { return res.status(200).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;
    let p = req.body; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    p = p || {};
    const BASE = (process.env.PUBLIC_BASE_URL || 'https://mgloot.com').replace(/\/+$/, '');

    // ─────────────── 1) CRÉER LE PAIEMENT (client authentifié) ───────────────
    if (p.action === 'create') {
      const authHeader = req.headers.authorization || '';
      const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
      if (!m) return res.status(401).json({ error: 'Non authentifié' });
      let uid, email = '';
      try { const dd = await admin.auth().verifyIdToken(m[1]); uid = dd.uid; email = dd.email || ''; }
      catch (e) { return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' }); }

      const amountEur = Math.round(((+p.amountEur || 0)) * 100) / 100;
      const purpose = (p.purpose || 'wallet').toString();
      const orderId = (p.orderId || '').toString();
      if (amountEur < 0.5) return res.status(400).json({ error: 'Montant trop faible.' });
      if (purpose === 'order' && !orderId) return res.status(400).json({ error: 'Commande introuvable.' });
      const xof = Math.max(100, Math.round(amountEur * EUR_XOF));

      const ref = 'MF-' + uid.slice(0, 6) + '-' + Date.now();
      await db.collection('moneyfusionPayments').doc(ref).set({
        uid, email, amountEur, xof, purpose, orderId: orderId || null, status: 'pending',
        createdAt: FieldValue.serverTimestamp()
      });

      const payload = {
        totalPrice: xof,
        article: [{ name: purpose === 'order' ? 'Commande MgLoot' : 'Recharge Portefeuille MgLoot', price: xof, quantity: 1 }],
        numeroSend: (p.phone || '').toString(),
        nomclient: (p.name || email || 'Client MgLoot').toString(),
        personal_Info: [{ userId: uid, orderId: orderId || '', ref: ref }],
        return_url: BASE + '/success',
        webhook_url: BASE + '/api/moneyfusion'
      };
      let data = {};
      try {
        const r = await fetch(MF_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(payload)
        });
        data = await r.json().catch(() => ({}));
        console.log('[MoneyFusion] status=' + r.status + ' resp=' + JSON.stringify(data));
      } catch (err) {
        console.log('[MoneyFusion] fetch error: ' + err.message);
        return res.status(200).json({ error: 'Connexion MoneyFusion impossible: ' + err.message });
      }
      if (data && (data.statut === true || data.statut === 'true' || data.statut === 1) && data.url) {
        await db.collection('moneyfusionPayments').doc(ref).set({ token: data.token || '' }, { merge: true });
        return res.status(200).json({ ok: true, url: data.url, token: data.token || '', ref });
      }
      // On renvoie le message EXACT de MoneyFusion pour diagnostiquer (IP, URL, etc.)
      return res.status(200).json({ error: (data && (data.message || data.msg)) || 'MoneyFusion a refusé la demande.', mf: data });
    }

    // ─────────────── 2) WEBHOOK MoneyFusion (paiement terminé) ───────────────
    const d0 = (p.data && typeof p.data === 'object') ? p.data : p;
    const statut = String(d0.statut || d0.status || '').toLowerCase();
    const token = d0.tokenPay || d0.token || p.token || '';
    let ref = '';
    try { const pi = d0.personal_Info || p.personal_Info; if (Array.isArray(pi) && pi[0]) ref = pi[0].ref || ''; } catch (e) {}

    let payRef = null;
    if (ref) payRef = db.collection('moneyfusionPayments').doc(ref);
    else if (token) {
      const q = await db.collection('moneyfusionPayments').where('token', '==', token).limit(1).get();
      if (!q.empty) payRef = q.docs[0].ref;
    }
    if (!payRef) return res.status(200).json({ ok: true, ignored: 'ref/token introuvable' });
    // On ne crédite QUE si le paiement est réussi (jamais sur pending/failure)
    if (!(statut === 'paid' || statut === 'success' || statut === 'completed' || statut === 'succes' || statut === 'réussi')) {
      return res.status(200).json({ ok: true, statut });
    }

    let credited = 0, target = '', kind = '', paidOrderId = '';
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(payRef);
      if (!snap.exists) return;
      const d = snap.data() || {};
      if (d.status === 'credited' || d.status === 'paid') return; // déjà traité (anti-doublon)
      const uid = d.uid, amountEur = +d.amountEur || 0, purpose = d.purpose || 'wallet', orderId = d.orderId || '';
      if (!uid) return;
      if (purpose === 'order' && orderId) {
        tx.set(db.collection('orders').doc(orderId), {
          status: 'paid', paymentMethod: 'MoneyFusion', paymentRef: payRef.id, paidAt: FieldValue.serverTimestamp()
        }, { merge: true });
        tx.set(payRef, { status: 'paid', creditedAt: FieldValue.serverTimestamp() }, { merge: true });
        kind = 'order'; paidOrderId = orderId; target = uid;
      } else {
        if (amountEur <= 0) return;
        tx.set(db.collection('users').doc(uid), { walletBalance: FieldValue.increment(amountEur) }, { merge: true });
        tx.set(db.collection('users').doc(uid).collection('walletHistory').doc(), {
          amount: amountEur, type: 'credit', note: 'Recharge MoneyFusion', method: 'MoneyFusion',
          ref: payRef.id, createdAt: FieldValue.serverTimestamp()
        });
        tx.set(payRef, { status: 'credited', creditedAt: FieldValue.serverTimestamp() }, { merge: true });
        kind = 'wallet'; credited = amountEur; target = uid;
      }
    });

    // Livraison automatique après paiement d'une commande
    if (kind === 'order' && paidOrderId) {
      try {
        await fetch(BASE + '/api/flashtopup-deliver', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: paidOrderId })
        }).catch(() => {});
      } catch (e) {}
    }
    // Notification + push au client
    if (target) {
      try {
        const note = (kind === 'order')
          ? { icon: '✅', title: 'Paiement reçu', body: 'Votre commande est payée (MoneyFusion). Livraison en cours.', type: 'order', link: 'orders' }
          : { icon: '💰', title: 'Portefeuille rechargé', body: 'Votre recharge de ' + credited.toFixed(2) + ' € (MoneyFusion) a été créditée.', type: 'wallet', link: 'wallet' };
        note.read = false; note.createdAt = FieldValue.serverTimestamp();
        await db.collection('users').doc(target).collection('notifications').add(note);
        try {
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
