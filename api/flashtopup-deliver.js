// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/flashtopup-deliver  (Fonction serverless Vercel)
//  Livraison AUTOMATIQUE d'une commande via l'API FazerCards Reseller v2.
//  (Remplace l'ancien fournisseur FlashTopup — même nom de fichier pour ne
//   rien casser côté paiements qui appellent /api/flashtopup-deliver.)
//
//  Body attendu (POST JSON) : { "orderId": "<id commande Firestore>" }
//
//  Auth FazerCards : header  X-API-Key: <clé>
//  Recharge jeu :
//     POST /topups/order  { category_id, offer_id, fields:{ player_id, server_id? } }
//     → { ok, order:{ id:"ord-…", status:"processing" } }
//     puis GET /orders/{id} jusqu'à status "completed".
//
//  Chaque produit (admin) porte :  fzrCat (category_id) + fzrOffer (offer_id).
//
//  ⚙️ Variables Vercel REQUISES :
//     - FIREBASE_SERVICE_ACCOUNT
//     - FAZERCARDS_API_KEY         (X-API-Key, Profil → API sur reseller.fazercards.com)
//     - FAZERCARDS_BASE_URL        (optionnel, défaut: https://api.fzr.cards/api/v2)
//     - PUBLIC_BASE_URL            (ex: https://mgloot.com)
// ════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

const FZR_BASE = (process.env.FAZERCARDS_BASE_URL || 'https://api.fzr.cards/api/v2').replace(/\/+$/, '');
const FZR_KEY = process.env.FAZERCARDS_API_KEY || '';

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

// Appel FazerCards (X-API-Key). idem = Idempotency-Key (anti double-commande).
async function fzr(method, endpoint, body, idem) {
  const headers = { 'X-API-Key': FZR_KEY, 'Accept': 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(FZR_BASE + endpoint, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch (e) { json = null; }
  return { http: res.status, ok: !!(json && json.ok) && res.status < 400, data: json };
}

const DONE = ['completed', 'success', 'delivered', 'done'];
const FAILED = ['failed', 'error', 'cancelled', 'canceled', 'refunded', 'rejected'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pushToUser(db, uid, title, body) {
  try {
    const B = (process.env.PUBLIC_BASE_URL || 'https://mgloot.com').replace(/\/+$/, '');
    await fetch(B + '/api/send-push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: uid, title: title, body: body, url: '/' })
    });
  } catch (e) {}
}
let _mailMod = null;
function mailMod() { if (!_mailMod) { try { _mailMod = require('./_email.js'); } catch (e) { _mailMod = { sendEmail: async () => false, wrap: (x) => x }; } } return _mailMod; }
async function sendMail(to, subject, html) { return mailMod().sendEmail(to, subject, html); }
function mailWrap(inner) { return mailMod().wrap(inner); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!FZR_KEY) return res.status(500).json({ error: 'FAZERCARDS_API_KEY manquant (variable Vercel)' });
    getApp();
    const db = admin.firestore();
    const FieldValue = admin.firestore.FieldValue;

    let payload = req.body;
    if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = {}; } }
    const orderId = (payload && payload.orderId || '').trim();
    if (!orderId) return res.status(400).json({ error: 'orderId requis' });

    const orderRef = db.collection('orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) return res.status(404).json({ error: 'Commande introuvable' });
    const order = snap.data() || {};

    if (order.ftStatus === 'success') return res.status(200).json({ ok: true, note: 'déjà livrée' });
    if (['paid', 'delivered', 'processing', 'shipped'].indexOf(order.status) < 0) {
      return res.status(400).json({ error: 'Commande non payée (statut: ' + (order.status || '—') + ')' });
    }

    const target = String(order.playerId || (order.account && (order.account.userId || order.account.konamiId)) || '').trim();
    if (!target) return res.status(400).json({ error: 'ID joueur manquant sur la commande' });
    const serverId = String(order.serverId || (order.account && order.account.serverId) || '').trim();

    // Construit les tâches depuis les articles + le mapping produit FazerCards
    const items = order.items || [];
    const tasks = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let cat = it.fzrCat || '', offer = it.fzrOffer || '';
      if ((!cat || !offer) && it.id) {
        try {
          const p = await db.collection('products').doc(it.id).get();
          if (p.exists) { const pd = p.data() || {}; cat = cat || pd.fzrCat || ''; offer = offer || pd.fzrOffer || ''; }
        } catch (e) {}
      }
      if (!cat || !offer) continue; // article non mappé → ignoré
      const qty = Math.max(1, it.qty || 1);
      for (let q = 0; q < qty; q++) {
        tasks.push({ cat: cat, offer: offer, idem: orderId + '-' + i + '-' + q });
      }
    }
    if (!tasks.length) return res.status(400).json({ error: 'Aucun article mappé (renseignez category_id + offer_id FazerCards dans l\'admin)' });

    // 1) Passe les commandes FazerCards (idempotent via Idempotency-Key)
    const orders = [];
    for (let t = 0; t < tasks.length; t++) {
      const fields = { player_id: target };
      if (serverId) fields.server_id = serverId;
      const r = await fzr('POST', '/topups/order', { category_id: tasks[t].cat, offer_id: tasks[t].offer, fields: fields }, tasks[t].idem);
      const o = (r.data && r.data.order) || {};
      orders.push({
        id: o.id || '',
        status: String(o.status || (r.ok ? 'processing' : 'failed')).toLowerCase(),
        ok: r.ok,
        msg: (r.data && r.data.error) || '',
        code: r.ok ? '' : ('HTTP_' + r.http)
      });
    }

    // 2) Sonde le statut jusqu'à ~1 minute
    let allDone = false;
    for (let attempt = 0; attempt < 19 && !allDone; attempt++) {
      await sleep(3000);   // 19 × 3s ≈ 57s
      allDone = true;
      for (let k = 0; k < orders.length; k++) {
        if (DONE.indexOf(orders[k].status) >= 0) continue;
        if (FAILED.indexOf(orders[k].status) >= 0) continue;
        if (!orders[k].id) { allDone = false; continue; }
        const s = await fzr('GET', '/orders/' + encodeURIComponent(orders[k].id));
        const so = (s.data && s.data.order) || {};
        if (so.status) orders[k].status = String(so.status).toLowerCase();
        if (DONE.indexOf(orders[k].status) < 0 && FAILED.indexOf(orders[k].status) < 0) allDone = false;
      }
    }

    const anyFailed = orders.some(r => FAILED.indexOf(r.status) >= 0 || (!r.ok && !r.id));
    const allSuccess = orders.length > 0 && orders.every(r => DONE.indexOf(r.status) >= 0);

    // 3) Met à jour la commande + notifie (même format qu'avant → UI/paiements compatibles)
    const update = {
      ftRefs: orders.map(r => r.id),
      ftLastStatus: orders.map(r => r.status).join(','),
      ftProvider: 'fazercards',
      ftCheckedAt: FieldValue.serverTimestamp()
    };
    if (allSuccess) { update.status = 'delivered'; update.ftStatus = 'success'; update.deliveredAt = FieldValue.serverTimestamp(); }
    else if (anyFailed) { update.ftStatus = 'failed'; }
    else { update.ftStatus = 'pending'; }
    const problem = orders.find(function (r) { return r.code || FAILED.indexOf(r.status) >= 0; });
    if (problem) update.ftError = ((problem.code ? problem.code + ': ' : '') + (problem.msg || '')).slice(0, 300);
    await orderRef.set(update, { merge: true });

    if (allSuccess && order.userId) {
      const cref = 'CMD-' + String(orderId).slice(0, 6).toUpperCase();
      const bodyTxt = 'Votre recharge (' + cref + ') a été livrée automatiquement sur l\'ID ' + target + '.';
      try {
        await db.collection('users').doc(order.userId).collection('notifications').add({
          icon: '✅', title: 'Commande livrée !', body: bodyTxt,
          type: 'order', link: 'payments', refId: orderId, read: false,
          createdAt: FieldValue.serverTimestamp()
        });
      } catch (e) {}
      try { await pushToUser(db, order.userId, '✅ Commande livrée !', bodyTxt); } catch (e) {}
      try {
        const em = order.email || '';
        if (em) {
          const list = (order.items || []).map(function (it) { return '• ' + (it.qty || 1) + '× ' + (it.name || ''); }).join('<br>');
          const html = mailWrap(
            '<h2 style="color:#e8c766;margin:0 0 10px">✅ Commande livrée</h2>'
            + '<p>Bonjour ' + (order.userName || '') + ',</p>'
            + '<p>Votre commande <b>' + cref + '</b> a été livrée automatiquement.</p>'
            + '<div style="background:#141418;border-radius:10px;padding:14px;margin:12px 0">'
            + (list ? ('<b>Articles :</b><br>' + list + '<br><br>') : '')
            + '<b>ID joueur :</b> ' + target + '<br>'
            + '<b>Total :</b> ' + ((+order.total || 0).toFixed(2)) + ' €'
            + '</div><p>Merci pour votre confiance ! 🎮</p>'
          );
          await sendMail(em, 'Commande ' + cref + ' livrée — MgLoot', html);
        }
      } catch (e) {}
    }

    return res.status(200).json({
      ok: true, orderId: orderId, delivered: allSuccess,
      status: allSuccess ? 'delivered' : (anyFailed ? 'failed' : 'pending'),
      error: problem ? ((problem.code ? problem.code + ': ' : '') + (problem.msg || '')) : null,
      orders: orders
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
