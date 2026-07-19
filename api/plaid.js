// ============================================================
// /api/plaid?action=accounts | link-token | exchange | remove
//
// Consolidates the 4 former plaid-*.js functions into one file —
// Vercel's Hobby plan caps a deployment at 12 Serverless Functions,
// and this repo was over that limit. Behavior/contracts are unchanged,
// only the route shape (query param instead of separate file paths).
//
//   GET  /api/plaid?action=accounts              (was /api/plaid-accounts)
//   POST /api/plaid?action=link-token             (was /api/plaid-link-token)
//   POST /api/plaid?action=exchange   { public_token, institution_name }
//   POST /api/plaid?action=remove     { item_id }
// ============================================================
import { createClient } from '@supabase/supabase-js';

async function handleAccounts(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!clientId || !secret) return res.status(500).json({ error: 'Plaid is not configured' });
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: 'Supabase service role is not configured' });

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: items, error } = await supabase.from('plaid_items').select('*');
  if (error) return res.status(500).json({ error: 'failed to load connections: ' + error.message });
  if (!items || !items.length) return res.status(200).json({ institutions: [] });

  const institutions = await Promise.all(items.map(async (item) => {
    try {
      const [balData, liabData] = await Promise.all([
        fetch('https://' + env + '.plaid.com/accounts/balance/get', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, secret: secret, access_token: item.access_token }),
        }).then(r => r.json()),
        fetch('https://' + env + '.plaid.com/liabilities/get', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: clientId, secret: secret, access_token: item.access_token }),
        }).then(r => r.json()).catch(() => null),
      ]);

      if (balData.error_code) {
        return { item_id: item.item_id, institution_name: item.institution_name, error: balData.error_message || balData.error_code, accounts: [] };
      }

      const liabByAccount = {};
      const liabilities = liabData && liabData.liabilities;
      if (liabilities) {
        (liabilities.credit || []).forEach(l => {
          liabByAccount[l.account_id] = {
            apr: (l.aprs && l.aprs[0] && l.aprs[0].apr_percentage) || null,
            minimumPayment: l.minimum_payment_amount != null ? l.minimum_payment_amount : null,
            statementBalance: l.last_statement_balance != null ? l.last_statement_balance : null,
            nextDueDate: l.next_payment_due_date || null,
          };
        });
        (liabilities.student || []).forEach(l => {
          liabByAccount[l.account_id] = {
            apr: l.interest_rate_percentage != null ? l.interest_rate_percentage : null,
            minimumPayment: l.minimum_payment_amount != null ? l.minimum_payment_amount : null,
            nextDueDate: l.next_payment_due_date || null,
          };
        });
        (liabilities.mortgage || []).forEach(l => {
          liabByAccount[l.account_id] = {
            apr: (l.interest_rate && l.interest_rate.percentage != null) ? l.interest_rate.percentage : null,
            nextDueDate: l.next_monthly_payment || null,
          };
        });
      }

      const accounts = (balData.accounts || []).map(a => ({
        account_id: a.account_id,
        name: a.name,
        officialName: a.official_name,
        mask: a.mask,
        type: a.type,          // depository | credit | loan | investment
        subtype: a.subtype,    // checking | savings | credit card | ...
        currency: (a.balances && a.balances.iso_currency_code) || 'USD',
        current: a.balances && a.balances.current,
        available: a.balances && a.balances.available,
        limit: a.balances && a.balances.limit,
        ...(liabByAccount[a.account_id] || {}),
      }));

      return {
        item_id: item.item_id,
        institution_name: item.institution_name || 'Bank',
        accounts: accounts,
      };
    } catch (e) {
      return { item_id: item.item_id, institution_name: item.institution_name, error: e && e.message ? e.message : String(e), accounts: [] };
    }
  }));

  return res.status(200).json({ institutions: institutions });
}

async function handleLinkToken(req, res) {
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

async function handleExchange(req, res) {
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

async function handleRemove(req, res) {
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const action = req.query && req.query.action;
  if (action === 'accounts') return handleAccounts(req, res);
  if (action === 'link-token') return handleLinkToken(req, res);
  if (action === 'exchange') return handleExchange(req, res);
  if (action === 'remove') return handleRemove(req, res);
  return res.status(400).json({ error: 'unknown or missing action (expected accounts | link-token | exchange | remove)' });
}
