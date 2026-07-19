// ============================================================
// POST /api/outreach-content
// Body: { type: 'email'|'linkedin', company: {name, summary, useCases, recentNews},
//         contact: {name, title}, framework: '...', touchCount: N, priorMessages: [{subject, body}] }
// Outreach CRM's email / LinkedIn message generator — personalized to a specific
// contact and aware of how many times they've already been touched, so the
// message stages appropriately (cold open -> follow-up -> break-up) instead of
// repeating the same pitch. Calls Claude with ANTHROPIC_API_KEY held server-side
// only (never sent to the browser). Returns { subject, body } (email) or { body } (linkedin).
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { type, company, contact, framework, touchCount, priorMessages } = req.body || {};
  if (!company || !company.name) return res.status(400).json({ error: 'company required' });
  if (!contact || !contact.name) return res.status(400).json({ error: 'contact required' });

  // Research-backed B2B cold-outreach benchmarks (2026): short, specific subject
  // lines roughly double reply rates over generic ones; short bodies (50-125
  // words) outreply long ones by ~50%; enterprise sequences run 4-7+ touches
  // over 60-90 days, staged from "educate" to "direct ask" to a break-up close.
  const SUBJECT_RULES = [
    'Keep it roughly 36-50 characters, or about 2-4 words — short subject lines get meaningfully higher opens.',
    'Reference something specific and real about the company (a recent news item, initiative, or trigger) — generic subjects underperform badly.',
    'A number (a stat, a timeframe, a count) or a genuine question in the subject measurably lifts opens.',
    'Use the company name or the contact\'s first name when it fits naturally — personalized subjects roughly double reply rates over generic ones.'
  ];
  const BODY_RULES = [
    '50-125 words total, ideally under 80 for a first-touch email — short emails reply about 50% higher than long ones.',
    'Personalize with something specific to THIS company (an initiative, a recent hire, a piece of news, a regulatory pressure in their industry) — generic "I noticed you\'re in manufacturing" personalization does not move the needle.',
    'One clear, low-friction CTA — a quick question or a short call, never "let\'s book a 30-minute demo" on an early touch.'
  ];

  const n = Math.max(0, parseInt(touchCount, 10) || 0);
  function sequenceStage() {
    if (n <= 0) {
      return 'This is the FIRST touch to this contact — a cold open. Reference something specific and real (a recent news ' +
        'item, initiative, or trigger) in the subject and opener. Educate rather than pitch — the ask should be low-friction ' +
        '(a quick question or a short call), not a demo request.';
    }
    if (n <= 2) {
      return 'This is an EARLY follow-up (touch #' + (n + 1) + ' with this contact). Do not repeat the angle of previous ' +
        'messages — add a new piece of value (a relevant insight, a benchmark, a different use case) rather than a plain ' +
        '"just checking in."';
    }
    if (n <= 5) {
      return 'This is a MID-SEQUENCE touch (touch #' + (n + 1) + '). Be more direct about the value and make the ask ' +
        'clearer, while staying low-pressure.';
    }
    return 'This is a LATE-STAGE touch (touch #' + (n + 1) + '). Use a "break-up" tone: acknowledge you haven\'t heard ' +
      'back, express understanding, offer to stop reaching out, and leave the door open. This style often prompts replies ' +
      'from people who were interested but hadn\'t prioritized responding.';
  }

  const researchBlock =
    'Company: ' + company.name + '\n' +
    (company.summary ? ('Summary: ' + company.summary + '\n') : '') +
    (Array.isArray(company.useCases) && company.useCases.length
      ? ('Relevant EHS use cases: ' + company.useCases.join('; ') + '\n') : '') +
    (Array.isArray(company.recentNews) && company.recentNews.length
      ? ('Recent news: ' + company.recentNews.map((n2) => (n2 && n2.headline || '') + (n2 && n2.note ? (' — ' + n2.note) : '')).join('; ') + '\n')
      : '') +
    'Contact: ' + contact.name + (contact.title ? (', ' + contact.title) : '') + '\n';

  const priorBlock = (Array.isArray(priorMessages) && priorMessages.length)
    ? ('Previous messages already sent to this contact (do not repeat these angles — build on them or take a new one):\n' +
       priorMessages.map((m, i) => (i + 1) + '. ' + (m.subject ? (m.subject + ' — ') : '') + (m.body || '')).join('\n') + '\n')
    : '';

  const frameworkBlock = framework && String(framework).trim()
    ? ('Follow this framework/structure the rep provided — adapt it to this contact and stage, don\'t just fill in blanks mechanically:\n---\n' + String(framework).trim() + '\n---\n')
    : '';

  let prompt, maxTokens;
  if (type === 'email') {
    prompt =
      'Write a cold outreach email from a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
      'software company, to the contact below.\n\n' + researchBlock + '\n' +
      sequenceStage() + '\n\n' +
      'Subject line rules (2026 B2B benchmarks):\n' + SUBJECT_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      'Body rules:\n' + BODY_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      frameworkBlock + priorBlock +
      'Address it to ' + contact.name.split(' ')[0] + ' by first name. Professional but conversational — not salesy or ' +
      'generic. Return ONLY JSON: {"subject":"...","body":"..."}. No preamble, no markdown fences.';
    maxTokens = 700;
  } else if (type === 'linkedin') {
    const isConnectionNote = n <= 0;
    prompt =
      'Write a LinkedIn outreach message from a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
      'software company, to the contact below.\n\n' + researchBlock + '\n' +
      sequenceStage() + '\n\n' +
      (isConnectionNote
        ? 'This is a LinkedIn CONNECTION REQUEST note — keep it under 300 characters, warm and low-pressure, reference ' +
          'something specific and real about their company. Do not pitch yet, just earn the connection.\n'
        : 'This is a LinkedIn FOLLOW-UP message after connecting — keep it under 80 words, casual and low-pressure, ' +
          'reference something specific and real about their company.\n') +
      frameworkBlock + priorBlock +
      'Return ONLY JSON: {"body":"..."}. No preamble, no markdown fences.';
    maxTokens = 400;
  } else {
    return res.status(400).json({ error: 'unknown type' });
  }

  try {
    const text = await callClaude(apiKey, prompt, maxTokens);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) throw new Error('no JSON object found in response');
    let data;
    try { data = JSON.parse(text.slice(start, end + 1)); } catch (e) { throw new Error('could not parse response from the model'); }
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
