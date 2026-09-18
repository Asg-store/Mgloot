// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/flashtopup-checkid  (vérification d'ID joueur)
//  Utilise FazerCards : POST /topups/validate-id
//  Body (POST JSON) : { "userId":"123456789", "validationCode":"pubg_mobile", "serverId":"" }
//    validationCode = category_id FazerCards de validation (renseigné par jeu dans l'admin)
//  Réponse : { ok:true, name:"Pseudo" }  ou  { ok:false, error:"..." }
//
//  Var Vercel : FAZERCARDS_API_KEY  (+ FAZERCARDS_BASE_URL optionnel)
// ════════════════════════════════════════════════════════════════
const FZR_BASE = (process.env.FAZERCARDS_BASE_URL || 'https://api.fzr.cards/api/v2').replace(/\/+$/, '');
const FZR_KEY = process.env.FAZERCARDS_API_KEY || '';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    if (!FZR_KEY) return res.status(200).json({ ok: false, error: 'Config manquante' });
    let p = req.body;
    if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
    const userId = String((p && p.userId) || '').trim();
    const category = String((p && p.validationCode) || '').trim();
    const serverId = String((p && p.serverId) || '').trim();
    if (!userId || !category) return res.status(200).json({ ok: false, error: 'userId / validationCode requis' });

    const fields = { player_id: userId };
    if (serverId) fields.server_id = serverId;

    const r = await fetch(FZR_BASE + '/topups/validate-id', {
      method: 'POST',
      headers: { 'X-API-Key': FZR_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ category_id: category, fields: fields })
    });
    let d = null; try { d = await r.json(); } catch (e) { d = null; }

    if (d && d.ok && d.valid) {
      const name = d.player_name || d.playerName || d.name || '';
      return res.status(200).json({ ok: true, name: String(name || 'Joueur vérifié') });
    }
    const msg = (d && (d.error || d.message)) || (d && d.valid === false ? 'ID joueur introuvable' : 'Vérification impossible');
    return res.status(200).json({ ok: false, error: String(msg).slice(0, 160) });
  } catch (e) {
    return res.status(200).json({ ok: false, error: (e && e.message) ? e.message.slice(0, 160) : 'Erreur' });
  }
};
