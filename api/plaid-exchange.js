// ============================================================
// POST /api/plaid-exchange
// Body: { public_token, institution_name }
// Exchanges the public_token from a successful Plaid Link flow for a
// long-lived access_token, and stores it server-side in the
// plaid_items Supabase table (protected by RLS with NO anon policy —
// only this function's SUPABASE_SERVICE_ROLE_KEY can read/write it).
// The access_token NEVER goes back to the browser.
// ============================================================
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !secret) return res.status(500).json({ error: 'Plaid is not configured' });
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Supabase service role is not configured (set SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });

  const { public_token, institution_name } = req.body || {};
  if (!public_token) return res.status(400).json({ error: 'public_token required' });

  try {
    const r = await fetch('https://' + env + '.plaid.com/item/public_token/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret: secret, public_token: public_token }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error_message || 'token exchange failed' });

    const supabase = createClient(supabaseUrl, serviceKey);
    const { error } = await supabase.from('plaid_items').insert({
      item_id: data.item_id,
      access_token: data.access_token,
      institution_name: institution_name || null,
    });
    if (error) return res.status(500).json({ error: 'failed to save connection: ' + error.message });

    return res.status(200).json({ ok: true, item_id: data.item_id });
  } catch (e) {
    return res.status(500).json({ error: 'exchange failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
