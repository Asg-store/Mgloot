// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/reset-password  (Fonction serverless Vercel, Node.js)
//
//  Réinitialisation du mot de passe client avec un CODE À 4 CHIFFRES
//  envoyé par e-mail.
//
//  Body attendu (POST JSON) :
//    { action:'send',    email }                          → génère + envoie le code
//    { action:'verify',  email, code }                    → vérifie le code saisi
//    { action:'confirm', email, code, newPassword }       → change le mot de passe
//
//  ⚙️ Variables d'environnement REQUISES sur Vercel :
//    FIREBASE_SERVICE_ACCOUNT = contenu JSON complet de la clé de compte
//                               de service Firebase
//    GMAIL_USER               = ton adresse Gmail (ex : abgstored@gmail.com)
//    GMAIL_APP_PASSWORD       = "mot de passe d'application" Google (16 caractères)
//                               → Google → Sécurité → Validation en 2 étapes →
//                                 Mots de passe des applications
//    MAIL_FROM (optionnel)    = expéditeur affiché, ex : "MgLoot <abgstored@gmail.com>"
//                               (par défaut : "MgLoot <GMAIL_USER>")
// ════════════════════════════════════════════════════════════════
const admin  = require('firebase-admin');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const CODE_TTL_MIN  = 10;  // durée de validité du code (minutes)
const MAX_ATTEMPTS  = 5;   // essais maximum par code
const RESEND_WAIT_S = 40;  // délai minimum entre deux envois (secondes)

function getApp() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant (variable d\'environnement Vercel)');
  const cred = JSON.parse(raw);
  if (cred.private_key && cred.private_key.indexOf('\\n') >= 0) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }
  return admin.initializeApp({ credential: admin.credential.cert(cred) });
}

const norm    = (e) => String(e || '').trim().toLowerCase();
const docId   = (e) => Buffer.from(norm(e)).toString('hex').slice(0, 480);
const hash    = (c, e) => crypto.createHash('sha256').update(String(c) + '|' + norm(e)).digest('hex');
const gen4    = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

// ── Gabarit e-mail (HTML) ──
function emailHtml(code, name) {
  const digits = String(code).split('').map((d) => `
    <td style="padding:0 5px">
      <div style="width:52px;height:62px;line-height:62px;text-align:center;border-radius:12px;
        background:#0f1830;border:1px solid #2a3a5e;color:#ffc83d;font-size:30px;
        font-weight:800;font-family:'Courier New',monospace">${d}</div>
    </td>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#070b16">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#070b16;padding:28px 12px">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#0b1224;border:1px solid #1e2d4a;border-radius:20px;overflow:hidden">
        <tr><td style="padding:24px 26px 8px;text-align:center">
          <div style="font-size:22px;font-weight:800;color:#ffc83d;font-family:Arial,Helvetica,sans-serif">MGLOOT</div>
          <div style="font-size:12px;color:#8ea0c0;font-family:Arial,Helvetica,sans-serif;margin-top:4px">Boutique gaming</div>
        </td></tr>
        <tr><td style="padding:14px 26px 0;text-align:center">
          <div style="font-size:18px;font-weight:700;color:#ffffff;font-family:Arial,Helvetica,sans-serif">🔑 Réinitialisation du mot de passe</div>
          <p style="font-size:14px;color:#b9c6dd;line-height:1.6;font-family:Arial,Helvetica,sans-serif">
            Bonjour ${name ? String(name).replace(/[<>]/g, '') : ''},<br>
            Voici votre <b>code de vérification</b> à saisir dans l'application :
          </p>
        </td></tr>
        <tr><td align="center" style="padding:6px 20px 4px">
          <table cellpadding="0" cellspacing="0"><tr>${digits}</tr></table>
        </td></tr>
        <tr><td style="padding:10px 26px 24px;text-align:center">
          <p style="font-size:12.5px;color:#8ea0c0;line-height:1.6;font-family:Arial,Helvetica,sans-serif">
            Ce code expire dans <b>${CODE_TTL_MIN} minutes</b>.<br>
            Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail —
            votre mot de passe reste inchangé.
          </p>
        </td></tr>
      </table>
      <div style="font-size:11px;color:#5c6c8a;margin-top:14px;font-family:Arial,Helvetica,sans-serif">© MgLoot · Mali</div>
    </td></tr>
  </table></body></html>`;
}

// ── Envoi de l'e-mail via Gmail (SMTP + mot de passe d'application) ──
let _mailer = null;
function getMailer() {
  if (_mailer) return _mailer;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Service e-mail non configuré (GMAIL_USER / GMAIL_APP_PASSWORD manquants sur Vercel).');
  }
  _mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') } // on retire les espaces du mot de passe d'application
  });
  return _mailer;
}

async function sendMail(to, code, name) {
  const user = process.env.GMAIL_USER;
  const from = process.env.MAIL_FROM || ('MgLoot <' + user + '>');
  try {
    await getMailer().sendMail({
      from,
      to,
      subject: `${code} — votre code de vérification MgLoot`,
      html: emailHtml(code, name)
    });
  } catch (e) {
    throw new Error('Échec de l\'envoi de l\'e-mail. ' + ((e && e.message) ? e.message : '').slice(0, 160));
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  p = p || {};
  const action = p.action || 'send';
  const email  = norm(p.email);

  if (!email || email.indexOf('@') < 0) return res.status(400).json({ error: 'Adresse e-mail invalide.' });

  try {
    getApp();
    const db  = admin.firestore();
    const ref = db.collection('passwordResets').doc(docId(email));
    const sref = db.collection('signupCodes').doc(docId(email));

    // ─────────── INSCRIPTION : ENVOI DU CODE (email peut ne pas encore exister) ───────────
    if (action === 'signup-send') {
      // Si un compte existe déjà avec cet email → on refuse (il doit se connecter)
      try { await admin.auth().getUserByEmail(email); return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail. Connectez-vous.' }); }
      catch (e) { /* pas de compte = OK pour inscription */ }
      const prev = await sref.get();
      if (prev.exists) {
        const last = (prev.data().sentAt || 0);
        const wait = RESEND_WAIT_S * 1000 - (Date.now() - last);
        if (wait > 0) return res.status(429).json({ error: 'Patientez ' + Math.ceil(wait / 1000) + 's avant de redemander un code.' });
      }
      const code = gen4();
      await sendMail(email, code, (p.name || ''));
      await sref.set({ email, codeHash: hash(code, email), expiresAt: Date.now() + CODE_TTL_MIN * 60 * 1000, attempts: 0, verified: false, sentAt: Date.now() });
      return res.status(200).json({ ok: true, sent: true, ttl: CODE_TTL_MIN });
    }
    // ─────────── INSCRIPTION : VÉRIFICATION DU CODE ───────────
    if (action === 'signup-verify') {
      const c = String(p.code || '').replace(/\D/g, '');
      if (c.length !== 4) return res.status(400).json({ error: 'Le code doit contenir 4 chiffres.' });
      const snap = await sref.get();
      if (!snap.exists) return res.status(400).json({ error: 'Aucun code en cours. Demandez un nouveau code.' });
      const d = snap.data();
      if (Date.now() > (d.expiresAt || 0)) { await sref.delete().catch(() => {}); return res.status(400).json({ error: 'Code expiré. Demandez un nouveau code.' }); }
      if ((d.attempts || 0) >= MAX_ATTEMPTS) { await sref.delete().catch(() => {}); return res.status(429).json({ error: 'Trop de tentatives. Demandez un nouveau code.' }); }
      if (d.codeHash !== hash(c, email)) { await sref.set({ attempts: (d.attempts || 0) + 1 }, { merge: true }); return res.status(400).json({ error: 'Code incorrect.' }); }
      await sref.set({ verified: true }, { merge: true });
      return res.status(200).json({ ok: true, verified: true });
    }

    // ─────────── ENVOI DU CODE ───────────
    if (action === 'send') {
      let user;
      try { user = await admin.auth().getUserByEmail(email); }
      catch (e) { return res.status(404).json({ error: 'Aucun compte n\'est associé à cette adresse e-mail.' }); }

      // Anti-spam : un envoi toutes les 40 secondes maximum
      const prev = await ref.get();
      if (prev.exists) {
        const last = (prev.data().sentAt || 0);
        const wait = RESEND_WAIT_S * 1000 - (Date.now() - last);
        if (wait > 0) return res.status(429).json({ error: 'Patientez ' + Math.ceil(wait / 1000) + 's avant de redemander un code.' });
      }

      const code = gen4();
      await sendMail(email, code, user.displayName || '');
      await ref.set({
        email,
        uid: user.uid,
        codeHash: hash(code, email),
        expiresAt: Date.now() + CODE_TTL_MIN * 60 * 1000,
        attempts: 0,
        verified: false,
        sentAt: Date.now()
      });
      return res.status(200).json({ ok: true, sent: true, ttl: CODE_TTL_MIN });
    }

    // ─────────── VÉRIFICATION / CONFIRMATION ───────────
    const code = String(p.code || '').replace(/\D/g, '');
    if (code.length !== 4) return res.status(400).json({ error: 'Le code doit contenir 4 chiffres.' });

    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'Aucun code en cours. Demandez un nouveau code.' });
    const d = snap.data();

    if (Date.now() > (d.expiresAt || 0)) {
      await ref.delete().catch(() => {});
      return res.status(400).json({ error: 'Code expiré. Demandez un nouveau code.' });
    }
    if ((d.attempts || 0) >= MAX_ATTEMPTS) {
      await ref.delete().catch(() => {});
      return res.status(429).json({ error: 'Trop de tentatives. Demandez un nouveau code.' });
    }
    if (d.codeHash !== hash(code, email)) {
      await ref.update({ attempts: (d.attempts || 0) + 1 });
      const left = MAX_ATTEMPTS - ((d.attempts || 0) + 1);
      return res.status(400).json({ error: 'Code incorrect.' + (left > 0 ? ' Il vous reste ' + left + ' tentative(s).' : '') });
    }

    if (action === 'verify') {
      await ref.update({ verified: true, attempts: 0 });
      return res.status(200).json({ ok: true, verified: true });
    }

    if (action === 'confirm') {
      const np = String(p.newPassword || '');
      if (np.length < 6) return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
      await admin.auth().updateUser(d.uid, { password: np });
      await ref.delete().catch(() => {});
      // Déconnecte les sessions existantes par sécurité
      await admin.auth().revokeRefreshTokens(d.uid).catch(() => {});
      return res.status(200).json({ ok: true, updated: true });
    }

    return res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erreur serveur.' });
  }
};
