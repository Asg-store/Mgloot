// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/moneyfusion-request  (créer un paiement MoneyFusion)
//
//  Flux : le client demande une recharge/commande → cette fonction crée
//  la session de paiement chez MoneyFusion et renvoie l'URL de redirection.
//  Le client est redirigé vers le guichet MoneyFusion (Orange Money, Wave,
//  MTN, Moov, carte…). Quand le paiement réussit, MoneyFusion appelle
//  /api/moneyfusion-webhook qui — après REVÉRIFICATION du statut auprès de
//  MoneyFusion — crédite le portefeuille côté serveur (sécurisé, anti-doublon).
//
//  Sécurité : vérifie le jeton Firebase du client (on connaît le vrai uid).
//  Env Vercel REQUISES :
//    - MONEYFUSION_API_URL   (votre URL d'API perso MoneyFusion, ex :
//        https://pay.moneyfusion.net/MGLOOT/919992e65a2b7491/pay/)
//    - PUBLIC_BASE_URL       (ex : https://mgloot.com)  ← return_url / webhook_url
//    - FIREBASE_SERVICE_ACCOUNT (déjà présente)
//  Env OPTIONNELLE :
//    - MONEYFUSION_STATUS_URL_TEMPLATE (défaut :
//        https://pay.moneyfusion.net/paiementNotif/{token} )
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

// ── Sortie via proxy à IP FIXE (pour la whitelist IP de MoneyFusion).
//    Réutilise le même proxy que FlashTopup (FT_PROXY_URL) sauf si
//    MONEYFUSION_PROXY_URL est défini. Ex : http://user:pass@31.59.20.176:6754
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

const EUR_XOF = 655.957;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const API_URL = (process.env.MONEYFUSION_API_URL || 'https://pay.moneyfusion.net/MGLOOT/919992e65a2b7491/pay/').trim();
    if (!API_URL) return res.status(500).json({ error: 'MoneyFusion non configuré (MONEYFUSION_API_URL manquant)' });
    const BASE = (process.env.PUBLIC_BASE_URL || 'https://www.mgloot.com').replace(/\/+$/, '');

    getApp();

    // 1) Authentification Firebase
    const authHeader = req.headers.authorization || '';
    const m = String(authHeader).match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Non authentifié' });
    let uid, email = '', name = '';
    try { const d = await admin.auth().verifyIdToken(m[1]); uid = d.uid; email = d.email || ''; name = d.name || ''; }
    catch (e) { return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' }); }

    // 2) Montant + but
    let p = req.body; if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    const amountEur = Math.round(((+p.amountEur || 0)) * 100) / 100;
    const purpose = (p.purpose || 'wallet').toString();       // 'wallet' | 'order'
    const orderId = (p.orderId || '').toString();
    if (amountEur < 0.5) return res.status(400).json({ error: 'Montant trop faible.' });
    if (purpose === 'order' && !orderId) return res.status(400).json({ error: 'Commande introuvable.' });
    const xof = Math.max(100, Math.round(amountEur * EUR_XOF)); // MoneyFusion = FCFA (XOF)

    // 3) Référence unique + enregistrement "pending" (pour le webhook)
    const refCommand = 'MGLOOT-' + uid.slice(0, 6) + '-' + Date.now();
    const itemName = purpose === 'order' ? 'Commande MgLoot' : 'Recharge Portefeuille MgLoot';
    const clientName = (name || (email ? email.split('@')[0] : '') || 'Client MgLoot').toString().slice(0, 60);
    const db = admin.firestore();
    await db.collection('moneyfusionPayments').doc(refCommand).set({
      uid, email, amountEur, xof, purpose, orderId: orderId || null, status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // 4) Appel MoneyFusion
    const params = {
      totalPrice: xof,
      article: [ { [itemName]: xof } ],
      personal_Info: [ { userId: uid, orderId: orderId || '', ref: refCommand, amountEur, purpose } ],
      nomclient: clientName,
      return_url: BASE + '/payment/success',
      webhook_url: BASE + '/api/moneyfusion-webhook'
    };
    if (p.numeroSend) params.numeroSend = String(p.numeroSend);

    const r = await mfFetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(params)
    });
    const data = await r.json().catch(() => ({}));

    // MoneyFusion renvoie { statut:true, token, message, url }
    const ok = data && (data.statut === true || data.statut === 'true' || data.success === true);
    const url = data && (data.url || data.redirect_url || data.redirectUrl);
    const token = (data && (data.token || data.tokenPay)) || '';
    if (ok && url) {
      // Garde le token pour la revérification côté webhook + lien inverse token→ref
      try {
        await db.collection('moneyfusionPayments').doc(refCommand).set({ token }, { merge: true });
        if (token) await db.collection('moneyfusionTokens').doc(String(token)).set({ ref: refCommand, uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch (e) {}
      return res.status(200).json({ ok: true, redirect_url: url, token });
    }
    return res.status(200).json({ error: (data && (data.message || (data.errors && JSON.stringify(data.errors)))) || 'MoneyFusion a refusé la demande.' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
