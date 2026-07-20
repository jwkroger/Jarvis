// ============================================================
// POST /api/company-research
// Body: { name: 'Acme Manufacturing', context: '...' }
// Outreach CRM's company-research helper — uses Claude's server-side
// web search tool to research a prospect company for a BDR at Evotix.
// ANTHROPIC_API_KEY stays server-side only (never sent to the browser).
// Returns { summary, useCases: [...], recentNews: [{headline, note}],
//           suggestedContacts: [{name, title, note, url}], sources: [...] }.
// suggestedContacts is best-effort from public search (company site,
// press, conference bios, indexed LinkedIn results) — the model is
// instructed to leave `name` blank rather than invent one it can't verify.
// ============================================================
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
    'You are a B2B sales research assistant helping a BDR (business development rep) at Evotix, an EHS&S ' +
    '(Environmental, Health, Safety & Sustainability) software company. Evotix\'s Assure platform helps mid-market ' +
    'companies (roughly 500-10,000+ employees) in industries like manufacturing, construction, food & drink, ' +
    'transport & logistics, utilities, municipalities, healthcare, education, and housing manage incidents, risk, ' +
    'audits/inspections, training, and compliance — mobile-first, replacing paper-based systems.\n\n' +
    'Research the company "' + String(name).trim() + '"' +
    (context && String(context).trim() ? (' — additional context from the rep: ' + String(context).trim()) : '') +
    ' using web search.\n\n' +
    'Produce:\n' +
    '1. A 2-3 sentence company summary (industry, approximate size, what they do).\n' +
    '2. 3-5 specific EHS/safety/compliance use cases where Evotix\'s Assure platform would likely help THIS company, ' +
    'grounded in their actual industry, operations, and scale — not generic pitches.\n' +
    '3. 2-4 recent, real news items (last 6-12 months) relevant to a sales outreach conversation — e.g. safety ' +
    'incidents, expansions, new facilities, leadership changes, regulatory news, sustainability initiatives. Only ' +
    'include real items found via search; do not invent news. If nothing recent turns up, return an empty array.\n' +
    '4. 2-5 likely EHS/Safety decision-makers at this company — titles like VP of Safety, Director of EHS, Head of ' +
    'Health & Safety, EHS Manager, Director of Risk/Compliance. Search the company\'s own site (leadership/about/team ' +
    'pages), press releases, conference speaker bios, industry articles, and indexed LinkedIn search results for REAL, ' +
    'CURRENT names in these roles. Do not invent a person\'s name under any circumstances — you cannot log into ' +
    'LinkedIn or see private profiles, so only report a name if it\'s corroborated by an actual page you found. If you ' +
    'can\'t confirm a specific name for a relevant title, still include the title with an empty "name" so the rep knows ' +
    'what role to look for, and note where you\'d suggest looking (e.g. "search LinkedIn for \'VP Safety\' at this ' +
    'company"). For each entry include a one-line note on where/how you found it (or why you\'re suggesting the title) ' +
    'and a source URL if you have a real one.\n\n' +
    'Return ONLY JSON in this exact shape, no preamble, no markdown fences:\n' +
    '{"summary":"...","useCases":["...","..."],"recentNews":[{"headline":"...","note":"why this matters for outreach"}],' +
    '"suggestedContacts":[{"name":"... or empty string if unconfirmed","title":"...","note":"...","url":"... or empty string"}],' +
    '"sources":["url1","url2"]}\n\n' +
    'Your final message must contain nothing but that JSON object — no narration of your search process, no summary ' +
    'sentence before or after it.';

  try {
    const content = await callClaudeWithSearch(apiKey, prompt, 3000);
    const jsonStr = extractLastJson(content);
    let data;
    try { data = JSON.parse(jsonStr); } catch (e) { throw new Error('could not parse research from the model'); }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'company research failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

// Claude may narrate its search process in earlier text blocks (or, rarely,
// wrap the final JSON in a stray sentence). Take only the LAST text block —
// the actual final answer — and slice out the {...} substring from it so a
// wrapping sentence or markdown fence can't break JSON.parse.
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
    return data.content;
  }
  throw new Error('research did not finish after several search rounds — try again');
}
