// ============================================================
// POST /api/company-research
// Body: { type: 'company'|'contacts', name: 'Acme Manufacturing', context: '...' }
// Outreach CRM's research helper — uses Claude's server-side web search
// tool to research a prospect company for a BDR at Evotix.
// ANTHROPIC_API_KEY stays server-side only (never sent to the browser).
//
// Two modes, dispatched by `type` (same pattern as api/outreach-content.js):
//   'company'  -> { summary, useCases: [...], recentNews: [{headline, note}], sources: [...] }
//   'contacts' -> { suggestedContacts: [{name, title, note, url}] }
// These used to be two separate serverless functions, but the Vercel Hobby
// plan caps a deployment at 12 functions (see the "Consolidate Plaid and
// WHOOP endpoints" fix for the exact same problem) -- adding a 13th function
// broke every deploy. One function, two request shapes, called in parallel
// by the client, keeps the "split the work so neither call times out"
// benefit without adding a function.
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

  const { type, name, context } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'company name required' });

  const prompt = type === 'contacts' ? buildContactsPrompt(name, context) : buildCompanyPrompt(name, context);
  const errPrefix = type === 'contacts' ? 'contact research failed: ' : 'company research failed: ';

  // Hard cap on tool invocations, enforced by the API itself rather than a
  // prompt request the model can (and did) ignore — contacts search kept
  // 504ing even after being told "at most 2 searches" in plain English.
  const maxUses = type === 'contacts' ? 2 : 4;

  try {
    const result = await callClaudeWithSearch(apiKey, prompt, type === 'contacts' ? 1800 : 2500, maxUses);
    const jsonStr = extractLastJson(result.content);
    let data;
    try {
      data = JSON.parse(jsonStr);
    } catch (e) {
      throw new Error(result.truncated
        ? 'the model\'s answer got cut off before finishing — try again'
        : 'could not parse the research from the model');
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: errPrefix + (e && e.message ? e.message : String(e)) });
  }
}

function buildCompanyPrompt(name, context) {
  return (
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
    'include real items found via search; do not invent news. If nothing recent turns up, return an empty array.\n\n' +
    'This has a hard time limit — work efficiently. 3-4 targeted searches total is enough to cover all three points ' +
    'above; don\'t keep searching to be exhaustive once you have enough to answer.\n\n' +
    'Return ONLY JSON in this exact shape, no preamble, no markdown fences:\n' +
    '{"summary":"...","useCases":["...","..."],"recentNews":[{"headline":"...","note":"why this matters for outreach"}],"sources":["url1","url2"]}\n\n' +
    'Your final message must contain nothing but that JSON object — no narration of your search process, no summary ' +
    'sentence before or after it.'
  );
}

function buildContactsPrompt(name, context) {
  return (
    'You are prospecting research for a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
    'software company, ahead of outreach to "' + String(name).trim() + '"' +
    (context && String(context).trim() ? (' (context from the rep: ' + String(context).trim() + ')') : '') + '.\n\n' +
    'Find up to 3 likely EHS/Safety decision-makers at this company — titles like VP of Safety, Director of EHS, Head ' +
    'of Health & Safety, EHS Manager, Director of Risk/Compliance.\n\n' +
    'IMPORTANT — work fast, this has a hard time limit: do AT MOST 2 web searches total, then answer with whatever ' +
    'you\'ve found. Do not try to check every possible source. Two well-chosen searches is enough, e.g. ' +
    '\'"[company]" "VP of Safety" OR "Director of EHS"\' and, if that doesn\'t turn up a name, ' +
    '\'site:linkedin.com "[company]" safety director\'. Stop after that and answer — do not keep searching to be ' +
    'thorough.\n\n' +
    'Do not invent a person\'s name under any circumstances — you cannot log into LinkedIn or see private profiles, so ' +
    'only report a name if it\'s corroborated by an actual page you found. If your 2 searches don\'t confirm a name for ' +
    'a relevant title, still include the title with an empty "name" so the rep knows what role to look for, and use ' +
    '"note" to suggest where to look manually (e.g. "search LinkedIn for \'VP Safety\' at this company"). For each ' +
    'entry, "note" should say where/how you found it (or why you\'re suggesting the title), and include a source URL ' +
    'if you have a real one.\n\n' +
    'Return ONLY JSON in this exact shape, no preamble, no markdown fences:\n' +
    '{"suggestedContacts":[{"name":"... or empty string if unconfirmed","title":"...","note":"...","url":"... or empty string"}]}\n\n' +
    'Your final message must contain nothing but that JSON object — no narration of your search process.'
  );
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

async function callClaudeWithSearch(apiKey, prompt, maxTokens, maxUses) {
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
        // Sonnet 5, not Opus, deliberately: this call is timing out around
        // 10-15s in production (Vercel's actual enforced limit, regardless
        // of the maxDuration: 60 configured above — likely because Fluid
        // Compute isn't enabled on the project, which is the one place that
        // config actually needs a dashboard toggle, not a code change).
        // Sonnet 5 is built for this speed/quality tradeoff and meaningfully
        // cuts tool-loop latency without giving up much on a task this size.
        model: 'claude-sonnet-5',
        max_tokens: maxTokens,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }],
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
