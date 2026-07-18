// ============================================================
// POST /api/plaid-remove
// Body: { item_id }
// Disconnects a linked bank: tells Plaid to invalidate the access
// token (/item/remove), then deletes the row from plaid_items.
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
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Supabase service role is not configured' });

  const { item_id } = req.body || {};
  if (!item_id) return res.status(400).json({ error: 'item_id required' });

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: rows } = await supabase.from('plaid_items').select('access_token').eq('item_id', item_id).limit(1);
  const accessToken = rows && rows[0] && rows[0].access_token;

  if (accessToken && clientId && secret) {
    try {
      await fetch('https://' + env + '.plaid.com/item/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, secret: secret, access_token: accessToken }),
      });
    } catch (e) { /* best effort — still remove our record below */ }
  }

  const { error } = await supabase.from('plaid_items').delete().eq('item_id', item_id);
  if (error) return res.status(500).json({ error: 'failed to remove connection: ' + error.message });

  return res.status(200).json({ ok: true });
}
