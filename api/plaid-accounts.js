// ============================================================
// GET /api/plaid-accounts
// Loads every connected item from Supabase (service role only — the
// access_tokens never leave the server), fetches live balances via
// Plaid's /accounts/balance/get, and liability details (APR, minimum
// payment, statement balance, due date) via /liabilities/get for
// credit cards, student loans and mortgages.
// Returns { institutions: [{ item_id, institution_name, accounts: [...] }] }
// ============================================================
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
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
