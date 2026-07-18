// ============================================================
// POST /api/receipt
// Body: { image: base64, mediaType }
// Reads ANY financial image (receipt, bill, invoice, bank/fintech app
// screenshot, balance, statement, transaction list) via Claude vision
// with forced tool-use, so the response is always clean structured JSON.
// ANTHROPIC_API_KEY stays server-side only. Returns the tool input directly:
//   { readable, kind, source, currency, amount, date, items }
// ============================================================
const SCAN_TOOL = {
  name: 'read_finance_image',
  description: 'Record the financial figures read from an image: a receipt, bill, invoice, bank / fintech app screenshot, account balance, transaction list or statement.',
  input_schema: {
    type: 'object',
    properties: {
      readable: { type: 'boolean', description: 'True if the image contains any legible monetary amount at all.' },
      kind:     { type: 'string', enum: ['balance', 'expense', 'income', 'other'], description: 'balance = an account balance/total on a banking screen; expense = money spent; income = money received; other = anything else.' },
      source:   { type: 'string', description: 'Best label: the bank/app/account name for a balance (e.g. Revolut), or the merchant/payee for a transaction (e.g. Migros). Empty if unknown.' },
      currency: { type: 'string', description: 'ISO 4217 code (CHF, USD, EUR, GBP, ...). Infer from symbols (Fr/CHF, $, €, £) or language. Default CHF if unclear.' },
      amount:   { type: 'number', description: 'The single most important amount: the account balance on a balance screen, or the total on a receipt/transaction. Always positive. 0 if none.' },
      date:     { type: 'string', description: 'Date as YYYY-MM-DD if visible, else empty string.' },
      items:    { type: 'array', description: 'Individual transactions or line items if the image is a list/receipt. Best effort, omit if none.', items: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' } }, required: ['name', 'amount'] } }
    },
    required: ['readable', 'kind', 'source', 'currency', 'amount']
  }
};

const SCAN_SYSTEM =
  "You read ANY image that contains financial information — receipts, bills, invoices, "
  + "bank or fintech app screenshots, account balances, transaction lists and statements — "
  + "and extract its figures.\n"
  + "- Always call the read_finance_image tool exactly once with your best reading. Do NOT "
  + "refuse just because the image isn't a paper receipt; a screenshot of a bank balance is valid.\n"
  + "- \"amount\" is the single headline figure: the account balance on a balance/home screen, "
  + "or the grand total on a receipt or transaction. Use a positive number.\n"
  + "- Set \"kind\" to balance for an account balance/total, expense for money spent, income for "
  + "money received, otherwise other.\n"
  + "- \"source\" is the bank/app/account name for a balance, or the merchant/payee for a purchase.\n"
  + "- Numbers must be plain (no symbols or thousands separators). Read \"Fr 199.54\" as 199.54 / CHF.\n"
  + "- Only set readable=false if there is genuinely no monetary amount anywhere in the image.";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, mediaType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image required' });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: SCAN_SYSTEM,
        tools: [SCAN_TOOL],
        tool_choice: { type: 'tool', name: 'read_finance_image' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Read this image and record any financial figures.' }
          ]
        }]
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
      return res.status(r.status).json({ error: msg });
    }
    const block = (data.content || []).find(b => b && b.type === 'tool_use' && b.name === 'read_finance_image');
    if (!block || !block.input) return res.status(502).json({ error: 'model did not return structured data' });
    return res.status(200).json(block.input);
  } catch (e) {
    return res.status(500).json({ error: 'receipt scan failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
