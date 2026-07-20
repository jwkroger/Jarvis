// ============================================================
// POST /api/company-contacts
// Body: { name: 'Acme Manufacturing', context: '...' }
// Outreach CRM's contact-prospecting helper — a focused web-search call
// (split out of api/company-research.js, which was timing out trying to
// do this plus company research in one turn) that looks for likely
// EHS/Safety decision-makers at a prospect company.
// ANTHROPIC_API_KEY stays server-side only (never sent to the browser).
// Returns { suggestedContacts: [{name, title, note, url}] }.
// Best-effort from public search (company site, press, conference bios,
// indexed LinkedIn results) — the model is instructed to leave `name`
// blank rather than invent one it can't verify.
// ============================================================
export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { name, context } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'company name required' });

  const prompt =
    'You are prospecting research for a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
    'software company, ahead of outreach to "' + String(name).trim() + '"' +
    (context && String(context).trim() ? (' (context from the rep: ' + String(context).trim() + ')') : '') + '.\n\n' +
    'Find 2-5 likely EHS/Safety decision-makers at this company — titles like VP of Safety, Director of EHS, Head of ' +
    'Health & Safety, EHS Manager, Director of Risk/Compliance. Search the company\'s own site (leadership/about/team ' +
    'pages), press releases, conference speaker bios, industry articles, and indexed LinkedIn search results for REAL, ' +
    'CURRENT names in these roles. Do not invent a person\'s name under any circumstances — you cannot log into ' +
    'LinkedIn or see private profiles, so only report a name if it\'s corroborated by an actual page you found. If you ' +
    'can\'t confirm a specific name for a relevant title, still include the title with an empty "name" so the rep knows ' +
    'what role to look for, and use "note" to say where you\'d suggest looking (e.g. "search LinkedIn for \'VP Safety\' ' +
    'at this company"). For each entry, "note" should say where/how you found it (or why you\'re suggesting the title), ' +
    'and include a source URL if you have a real one.\n\n' +
    'Return ONLY JSON in this exact shape, no preamble, no markdown fences:\n' +
    '{"suggestedContacts":[{"name":"... or empty string if unconfirmed","title":"...","note":"...","url":"... or empty string"}]}\n\n' +
    'Your final message must contain nothing but that JSON object — no narration of your search process.';

  try {
    const result = await callClaudeWithSearch(apiKey, prompt, 1800);
    const jsonStr = extractLastJson(result.content);
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(result.truncated
        ? 'the model\'s answer got cut off before finishing — try again'
        : 'could not parse contacts from the model');
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'contact research failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

function extractLastJson(content) {
  const textBlocks = (content || []).filter((b) => b && b.type === 'text' && b.text);
  if (!textBlocks.length) throw new Error('empty response');
  const raw = textBlocks[textBlocks.length - 1].text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('no JSON object found in response');
  return raw.slice(start, end + 1);
}

async function callClaudeWithSearch(apiKey, prompt, maxTokens) {
  const messages = [{ role: 'user', content: prompt }];
  let attempts = 0;
  while (attempts < 4) {
    attempts++;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: maxTokens,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        messages: messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
      throw new Error(msg);
    }
    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: data.content });
      continue;
    }
    if (!data.content || !data.content.length) throw new Error('empty response');
    return { content: data.content, truncated: data.stop_reason === 'max_tokens' };
  }
  throw new Error('research did not finish after several search rounds — try again');
}
