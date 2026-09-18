// ════════════════════════════════════════════════════════════════
//  MgLoot — /api/flashtopup-services  (CATALOGUE FazerCards)
//  Outil admin ouvrable dans le navigateur pour trouver les IDs :
//    /api/flashtopup-services            → liste des JEUX (category_id + nom)
//    /api/flashtopup-services?cat=<id>   → OFFRES d'un jeu (offer_id + prix)
//  Var Vercel : FAZERCARDS_API_KEY
// ════════════════════════════════════════════════════════════════
const FZR_BASE = (process.env.FAZERCARDS_BASE_URL || 'https://api.fzr.cards/api/v2').replace(/\/+$/, '');
const FZR_KEY = process.env.FAZERCARDS_API_KEY || '';
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function fzr(endpoint) {
  const r = await fetch(FZR_BASE + endpoint, { headers: { 'X-API-Key': FZR_KEY, 'Accept': 'application/json' } });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { http: r.status, data: j };
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!FZR_KEY) return res.status(200).send('<h3>❌ FAZERCARDS_API_KEY manquant (variable Vercel)</h3>');
  try {
    const cat = (req.query && (req.query.cat || req.query.category_id) || '').trim();
    const style = '<style>body{font-family:system-ui;background:#0b0b0d;color:#eee;padding:16px}a{color:#00b0ff}code{background:#1c1c22;padding:2px 6px;border-radius:6px;color:#e8c766}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #333;padding:8px;text-align:left;font-size:13px}h2{color:#e8c766}</style>';

    if (cat) {
      const r = await fzr('/topups/offers?category_id=' + encodeURIComponent(cat));
      const d = r.data || {};
      const offers = (d.offers || []);
      let html = style + '<h2>🎮 ' + esc(d.name || cat) + '</h2><p>category_id : <code>' + esc(cat) + '</code></p><p><a href="/api/flashtopup-services">← Tous les jeux</a></p>';
      html += '<table><tr><th>Offre</th><th>offer_id (à copier)</th><th>Prix USD</th></tr>';
      offers.forEach(function (o) {
        html += '<tr><td>' + esc(o.name) + '</td><td><code>' + esc(o.offer_id) + '</code></td><td>' + esc(o.price_usd || '') + '</td></tr>';
      });
      html += '</table>';
      if (!offers.length) html += '<p>Aucune offre (HTTP ' + esc(r.http) + ').</p><pre style="white-space:pre-wrap;font-size:11px;color:#888">' + esc(JSON.stringify(d, null, 2)) + '</pre>';
      return res.status(200).send(html);
    }

    const r = await fzr('/topups?limit=500');
    const d = r.data || {};
    const items = (d.items || []);
    let html = style + '<h2>🎮 Jeux FazerCards (recharges)</h2><p>Cliquez un jeu pour voir ses offres et copier les IDs.</p>';
    html += '<table><tr><th>Jeu</th><th>category_id</th><th>Offres</th></tr>';
    items.forEach(function (g) {
      html += '<tr><td>' + esc(g.name) + '</td><td><code>' + esc(g.category_id) + '</code></td><td><a href="/api/flashtopup-services?cat=' + encodeURIComponent(g.category_id) + '">voir les offres →</a></td></tr>';
    });
    html += '</table>';
    if (!items.length) html += '<p>Aucun jeu (HTTP ' + esc(r.http) + ').</p><pre style="white-space:pre-wrap;font-size:11px;color:#888">' + esc(JSON.stringify(d, null, 2)) + '</pre>';
    return res.status(200).send(html);
  } catch (e) {
    return res.status(200).send('<h3>❌ ' + esc(e.message) + '</h3>');
  }
};
