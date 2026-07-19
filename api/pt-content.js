// ============================================================
// POST /api/pt-content
// Body: { type: 'ideas', pillars: [...], existing: [...] }
//    or { type: 'script', idea: '...', pillar: '...' }
// PT content pipeline's AI helper — idea batches + script drafts.
// Calls Claude with ANTHROPIC_API_KEY held server-side only (never
// sent to the browser). Returns { ideas: [...] } or { text: '...' }.
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { type } = req.body || {};

  async function callClaude(prompt, maxTokens) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
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

  try {
    if (type === 'ideas') {
      const { pillars, existing } = req.body || {};
      const pillarList = Array.isArray(pillars) && pillars.length
        ? pillars
        : ['Transformation', 'BFT Highlight', 'Online Coaching', 'Education / Tips', 'Behind the Scenes', 'Personal Brand'];
      const prompt =
        'You are a social media strategist helping a personal trainer grow an Instagram presence. ' +
        'They currently run in-person group training at BFT and are starting to build an online coaching offer, ' +
        'so mix awareness content (group training energy, client wins, education) with online-coaching-pitch ideas. ' +
        'Generate 5 short-form video content ideas (one-line hooks only, no scripts) spread across these content pillars: ' +
        pillarList.join(', ') + '. ' +
        'Avoid repeating these existing ideas: ' + ((Array.isArray(existing) && existing.length) ? existing.join(' | ') : 'none yet') + '. ' +
        'Return ONLY a JSON array of 5 objects like {"pillar":"...","idea":"..."} using pillar values exactly from the list above. No preamble, no markdown fences.';

      const text = await callClaude(prompt, 800);
      const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      let ideas;
      try { ideas = JSON.parse(cleaned); } catch (e) { throw new Error('could not parse ideas from the model'); }
      if (!Array.isArray(ideas)) throw new Error('unexpected ideas format');
      return res.status(200).json({ ideas: ideas });
    }

    if (type === 'script') {
      const { idea, pillar } = req.body || {};
      if (!idea) return res.status(400).json({ error: 'idea required' });
      const prompt =
        'Write a short-form Instagram Reel script and caption for a personal trainer\'s content idea.\n' +
        'Idea: "' + idea + '"\n' +
        'Content pillar: ' + (pillar || 'General') + '\n' +
        'Keep the reel 30-45 seconds. Format exactly as plain text:\n' +
        'HOOK: ...\nBEATS:\n- ...\n- ...\nCTA: ...\nCAPTION: ...\nHASHTAGS: ...\n' +
        'No markdown, no extra commentary.';

      const text = await callClaude(prompt, 700);
      return res.status(200).json({ text: text });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    return res.status(500).json({ error: 'pt-content call failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
