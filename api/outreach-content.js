// ============================================================
// POST /api/outreach-content
// Body: { type: 'email'|'linkedin', company: {name, summary, useCases, recentNews},
//         framework: '...', priorMessages: [...] }
// Outreach CRM's email / LinkedIn message generator. Calls Claude with
// ANTHROPIC_API_KEY held server-side only (never sent to the browser).
// Returns { subject, body } (email) or { body } (linkedin).
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { type, company, framework, priorMessages } = req.body || {};
  if (!company || !company.name) return res.status(400).json({ error: 'company required' });

  const researchBlock =
    'Company: ' + company.name + '\n' +
    (company.summary ? ('Summary: ' + company.summary + '\n') : '') +
    (Array.isArray(company.useCases) && company.useCases.length
      ? ('Relevant EHS use cases: ' + company.useCases.join('; ') + '\n') : '') +
    (Array.isArray(company.recentNews) && company.recentNews.length
      ? ('Recent news: ' + company.recentNews.map((n) => (n && n.headline || '') + (n && n.note ? (' — ' + n.note) : '')).join('; ') + '\n')
      : '');

  const priorBlock = (Array.isArray(priorMessages) && priorMessages.length)
    ? ('Avoid repeating the angle of these previous messages to this company: ' + priorMessages.join(' | ') + '\n')
    : '';

  const frameworkBlock = framework && String(framework).trim()
    ? ('Follow this framework/structure the rep provided — adapt it to this company\'s specifics, don\'t just fill in blanks mechanically:\n---\n' + String(framework).trim() + '\n---\n')
    : '';

  let prompt, maxTokens;
  if (type === 'email') {
    prompt =
      'Write a cold outreach email from a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
      'software company, to a prospect at the company below.\n\n' + researchBlock + '\n' + frameworkBlock +
      (frameworkBlock ? '' :
        'Use a proven cold-email structure: a specific, research-grounded opener that references something real about ' +
        'their company, a bridge to a relevant EHS/safety pain point, and a soft, low-friction CTA (e.g. a quick call) ' +
        'rather than a hard sell.\n') +
      priorBlock +
      'Keep it under 150 words, professional but conversational — not salesy or generic. ' +
      'Return ONLY JSON: {"subject":"...","body":"..."}. No preamble, no markdown fences.';
    maxTokens = 700;
  } else if (type === 'linkedin') {
    prompt =
      'Write a LinkedIn outreach message from a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
      'software company, to a prospect at the company below.\n\n' + researchBlock + '\n' + frameworkBlock +
      (frameworkBlock ? '' :
        'Reference something specific and real about their company. Keep it short, casual, and low-pressure — this is ' +
        'LinkedIn, not email. If this reads like a connection request note, keep it under 300 characters; if it reads ' +
        'like a follow-up message after connecting, keep it under 80 words.\n') +
      priorBlock +
      'Return ONLY JSON: {"body":"..."}. No preamble, no markdown fences.';
    maxTokens = 400;
  } else {
    return res.status(400).json({ error: 'unknown type' });
  }

  try {
    const text = await callClaude(apiKey, prompt, maxTokens);
    const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    let data;
    try { data = JSON.parse(cleaned); } catch (e) { throw new Error('could not parse response from the model'); }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: 'outreach content failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

async function callClaude(apiKey, prompt, maxTokens) {
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
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
    throw new Error(msg);
  }
  const text = (data.content || [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  if (!text) throw new Error('empty response');
  return text;
}
