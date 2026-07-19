// ============================================================
// /api/whoop?action=data | refresh
//
// Consolidates the former whoop-data.js + whoop-refresh.js into one
// file — Vercel's Hobby plan caps a deployment at 12 Serverless
// Functions, and this repo was over that limit. Behavior/contracts
// are unchanged, only the route shape. (whoop-callback.js stays a
// separate file — it's the exact redirect_uri registered with WHOOP's
// OAuth app, so its path can't change without also updating that.)
//
//   GET  /api/whoop?action=data&path=/recovery&limit=1   (was /api/whoop-data)
//        Authorization: Bearer <user's WHOOP access_token>
//   POST /api/whoop?action=refresh   { refresh_token }    (was /api/whoop-refresh)
// ============================================================
async function handleData(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'missing bearer token' });

  const path = (req.query && req.query.path) || '';
  if (!path || !path.startsWith('/')) return res.status(400).json({ error: 'path required (must start with /)' });

  // Forward all query params except `path`/`action` themselves.
  const fwd = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (k !== 'path' && k !== 'action') fwd.set(k, String(v));
  }
  const qs = fwd.toString();
  // WHOOP moved most endpoints to v2; cycle is still on v1.
  const base = path.startsWith('/cycle')
    ? 'https://api.prod.whoop.com/developer/v1'
    : 'https://api.prod.whoop.com/developer/v2';
  const url = base + path + (qs ? '?' + qs : '');

  try {
    const r = await fetch(url, {
      headers: { 'Authorization': auth, 'Accept': 'application/json' },
    });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(500).json({ error: 'proxy fetch failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

async function handleRefresh(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const refresh = body && body.refresh_token;
  if (!refresh) return res.status(400).json({ error: 'refresh_token required' });

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return res.status(500).json({ error: 'server not configured' });

  try {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'offline',
    });
    const r = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const text = await r.text();
    if (!r.ok) return res.status(500).json({ error: 'refresh failed: ' + text });
    try { return res.status(200).json(JSON.parse(text)); }
    catch { return res.status(500).json({ error: 'non-JSON response from WHOOP' }); }
  } catch (e) {
    return res.status(500).json({ error: 'fetch error: ' + (e && e.message ? e.message : String(e)) });
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query && req.query.action;
  if (action === 'data') return handleData(req, res);
  if (action === 'refresh') return handleRefresh(req, res);
  return res.status(400).json({ error: 'unknown or missing action (expected data | refresh)' });
}
