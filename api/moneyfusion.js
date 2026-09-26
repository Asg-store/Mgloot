// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/moneyfusion   (créer un paiement + vérifier + webhook)
//
//  UNE seule fonction pour rester dans la limite Vercel :
//   • action:'create'  → le client (authentifié Firebase) demande un
//     paiement. On crée un enregistrement "pending", on appelle
//     MoneyFusion, et on renvoie l'URL de redirection.
//   • action:'status'  → VÉRIFICATION ACTIVE (rapide) : au retour du
//     paiement, le client interroge cet endpoint avec sa "ref". On
//     demande directement à MoneyFusion l'état du paiement (endpoint
//     paiementNotif/{token}) et, s'il est payé, on crédite/livre TOUT
//     DE SUITE — sans attendre le webhook (qui peut prendre 10 min).
//   • sinon (POST de MoneyFusion) = WEBHOOK : filet de sécurité si le
//     client ne revient pas. Même traitement, idempotent (anti-doublon).
//
//  Env Vercel REQUISES :
//    - MONEYFUSION_API_URL   (ton lien d'API MoneyFusion)
//    - PUBLIC_BASE_URL       (ex : https://mgloot.com)
//    - FIREBASE_SERVICE_ACCOUNT (déjà présente)
//  Optionnelle :
//    - MONEYFUSION_VERIFY_URL (base de vérif, défaut :
//        https://www.pay.moneyfusion.net/paiementNotif/)
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
// Base de l'endpoint de vérification de MoneyFusion (FusionPay). On y ajoute le token.
const MF_VERIFY = (process.env.MONEYFUSION_VERIFY_URL || 'https://www.pay.moneyfusion.net/paiementNotif/').replace(/\/*$/, '/');

// Un statut MoneyFusion est-il "payé" ?
function isPaidStatus(s) {
  s = String(s || '').toLowerCase().trim();
  return s === 'paid' || s === 'success' || s === 'completed' || s === 'succes' || s === 'réussi' || s === 'reussi';
}

// ─────────── Crédit / livraison partagé (webhook ET status) — idempotent ───────────
async function applyPaid(db, FieldValue, payRef, BASE) {
  let credited = 0, target = '', kind = '', paidOrderId = '', already = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(payRef);
    if (!snap.exists) return;
    const d = snap.data() || {};
    if (d.status === 'credited' || d.status === 'paid') { already = true; return; } // déjà traité
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

  if (already) return { already: true, done: true };

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
  return { done: !!kind, kind, credited, target };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 🔎 Outil : afficher l'IP de SORTIE réelle du serveur (allowlist MoneyFusion)
  if (req.method === 'GET' && (req.query && (req.query.ip === '1' || req.query.ip === 'true'))) {
    try {
      const r = await fetch('https://api.ipify.org?format=json');
      const j = await r.json().catch(() => ({}));
      return res.status(200).json({ outboundIP: j.ip || '?', note: "Rechargez plusieurs fois : Vercel peut renvoyer plusieurs IP différentes." });
    } catch (e) { return res.status(200).json({ error: e.message }); }
  }

  // 🩺 DIAGNOSTIC : montre les derniers paiements + ce que MoneyFusion répond EN DIRECT.
  //    Ouvre https://mgloot.com/api/moneyfusion?diag=1  juste après un paiement test.
  //    → On voit si MoneyFusion dit "paid" tout de suite (retard chez nous) ou pas (retard MoneyFusion).
  if (req.method === 'GET' && req.query && (req.query.diag === '1' || req.query.diag === 'true')) {
    try {
      getApp();
      const db = admin.firestore();
      const snap = await db.collection('moneyfusionPayments').orderBy('createdAt', 'desc').limit(6).get();
      const out = [];
      for (const doc of snap.docs) {
        const d = doc.data() || {};
        let live = null;
        if (d.token) {
          try {
            const t0 = Date.now();
            const r = await fetch(MF_VERIFY + encodeURIComponent(d.token), { headers: { 'Accept': 'application/json' } });
            const j = await r.json().catch(() => ({}));
            const dd = (j && j.data && typeof j.data === 'object') ? j.data : j;
            live = { httpStatus: r.status, mfStatut: (dd && (dd.statut || dd.status)) || null, ms: Date.now() - t0 };
          } catch (e) { live = { error: e.message }; }
        }
        out.push({
          ref: doc.id, statusEnBase: d.status || '?', purpose: d.purpose || '?',
          xof: d.xof || 0, aToken: !!d.token,
          creeIlYaSec: d.createdAt && d.createdAt.toMillis ? Math.round((Date.now() - d.createdAt.toMillis()) / 1000) : null,
          moneyFusionEnDirect: live
        });
      }
      return res.status(200).json({ ok: true, verifyUrl: MF_VERIFY, derniers: out });
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
      if (!String(p.phone || '').trim()) return res.status(400).json({ error: 'Numéro de téléphone requis pour MoneyFusion.' });
      if (purpose === 'order' && !orderId) return res.status(400).json({ error: 'Commande introuvable.' });
      const xof = Math.max(100, Math.round(amountEur * EUR_XOF));

      const ref = 'MF-' + uid.slice(0, 6) + '-' + Date.now();
      await db.collection('moneyfusionPayments').doc(ref).set({
        uid, email, amountEur, xof, purpose, orderId: orderId || null, status: 'pending',
        createdAt: FieldValue.serverTimestamp()
      });

      const payload = {
        totalPrice: xof,
        article: [{ nom: purpose === 'order' ? 'Commande MgLoot' : 'Recharge Portefeuille MgLoot', montant: xof }],
        numeroSend: (p.phone || '').toString(),
        nomclient: (p.name || email || 'Client MgLoot').toString(),
        personal_Info: [{ userId: uid, orderId: orderId || '', ref: ref }],
        return_url: BASE + '/success',
        webhook_url: BASE + '/api/moneyfusion'
      };
      let data = {};
      try {
        console.log('[MoneyFusion] REQ url=' + MF_URL + ' payload=' + JSON.stringify(payload));
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
      return res.status(200).json({ error: (data && (data.message || data.msg)) || 'MoneyFusion a refusé la demande.', mf: data });
    }

    // ─────────────── 2) VÉRIFICATION ACTIVE (retour client, rapide) ───────────────
    //  Le client appelle {action:'status', ref} en boucle après le paiement.
    //  On demande DIRECTEMENT l'état à MoneyFusion et on crédite tout de suite.
    if (p.action === 'status') {
      const ref = String(p.ref || '').trim();
      let payRef = null, docData = null;
      if (ref) {
        payRef = db.collection('moneyfusionPayments').doc(ref);
        const s = await payRef.get();
        if (!s.exists) return res.status(200).json({ ok: true, paid: false, note: 'ref introuvable' });
        docData = s.data() || {};
      } else if (p.token) {
        const q = await db.collection('moneyfusionPayments').where('token', '==', String(p.token)).limit(1).get();
        if (q.empty) return res.status(200).json({ ok: true, paid: false, note: 'token introuvable' });
        payRef = q.docs[0].ref; docData = q.docs[0].data() || {};
      } else {
        return res.status(400).json({ error: 'ref ou token requis' });
      }

      // Déjà crédité/payé côté base → on répond "payé" immédiatement (aucun appel réseau)
      if (docData.status === 'credited' || docData.status === 'paid') {
        return res.status(200).json({ ok: true, paid: true, status: docData.status, purpose: docData.purpose || 'wallet' });
      }

      const token = docData.token || String(p.token || '');
      if (!token) return res.status(200).json({ ok: true, paid: false, note: 'token manquant' });

      // Interroge MoneyFusion : GET paiementNotif/{token}
      let mf = {};
      try {
        const r = await fetch(MF_VERIFY + encodeURIComponent(token), { headers: { 'Accept': 'application/json' } });
        mf = await r.json().catch(() => ({}));
      } catch (e) {
        return res.status(200).json({ ok: true, paid: false, note: 'vérif indisponible: ' + e.message });
      }
      const dd = (mf && mf.data && typeof mf.data === 'object') ? mf.data : mf;
      const statut = (dd && (dd.statut || dd.status)) || '';

      if (isPaidStatus(statut)) {
        const r2 = await applyPaid(db, FieldValue, payRef, BASE);
        return res.status(200).json({ ok: true, paid: true, credited: !!(r2 && r2.done), purpose: docData.purpose || 'wallet' });
      }
      // Pas encore payé (pending / no paid / failure)
      return res.status(200).json({ ok: true, paid: false, status: String(statut || '').toLowerCase() });
    }

    // ─────────────── 3) WEBHOOK MoneyFusion (filet de sécurité) ───────────────
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
    if (!isPaidStatus(statut)) {
      return res.status(200).json({ ok: true, statut });
    }
    await applyPaid(db, FieldValue, payRef, BASE);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
