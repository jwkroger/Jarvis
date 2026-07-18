// ============================================================
// POST /api/plaid-link-token
// Creates a Plaid Link token so the browser can open Plaid Link and
// let the user connect a bank (Wells Fargo, etc). No request body
// needed — this is a single-user dashboard.
// Requires PLAID_CLIENT_ID / PLAID_SECRET (PLAID_ENV defaults to
// 'sandbox' — use 'production' once your Plaid app is approved for
// real bank data).
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';
  if (!clientId || !secret) {
    return res.status(500).json({ error: 'Plaid is not configured (set PLAID_CLIENT_ID / PLAID_SECRET in Vercel env vars)' });
  }

  try {
    const r = await fetch('https://' + env + '.plaid.com/link/token/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        secret: secret,
        client_name: 'Jarvis Finance',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: 'jarvis-dashboard-user' },
        products: ['auth', 'liabilities'],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error_message || 'Plaid link token creation failed' });
    }
    return res.status(200).json({ link_token: data.link_token });
  } catch (e) {
    return res.status(500).json({ error: 'link token failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
