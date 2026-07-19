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

  // Proven high-converting hook formulas (results-hook, numbered-list, tight
  // timeframe, problem-specific, belief-challenging, direct-tip) — every
  // generated idea must open with one of these, tagged so it's traceable.
  const HOOK_FORMULAS = [
    { name: 'Results Hook', pattern: '"I went from [bad number] to [good number] in [timeframe] using [thing]" — the single highest-converting hook archetype.' },
    { name: 'Numbered List Hook', pattern: '"[N] things I wish I knew before [decision]..." — viewers stay to get all of them.' },
    { name: 'Tight Timeframe Hook', pattern: '"My [metric] went from X to Y in 14 days — here\'s exactly what changed."' },
    { name: 'Problem-Specific Hook', pattern: '"If you\'re struggling with [very specific problem], you\'re probably making this mistake..."' },
    { name: 'Belief-Challenging Hook', pattern: '"[Common belief] is actually wrong. Here\'s what actually works..."' },
    { name: 'Direct Tip Hook', pattern: '"Stop doing this if you want [specific outcome]" — talking-head, one actionable tip delivered straight to camera.' }
  ];
  const HOOK_LIST_TEXT = HOOK_FORMULAS.map((h) => '- ' + h.name + ': ' + h.pattern).join('\n');

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
        'so every idea should ultimately funnel viewers toward that online program — either directly (a coaching-pitch ' +
        'idea) or by building the trust that earns the DM (education, results, group-training energy). ' +
        'Aim for a content mix close to 60% educational/tips, 30% social proof (client wins, group energy, behind the ' +
        'scenes), 10% direct promotional, spread across these pillars: ' + pillarList.join(', ') + '.\n\n' +
        'Every idea must open with a hook built from ONE of these proven high-converting formulas — pick whichever fits ' +
        'the idea best, and don\'t reuse the same formula for all 5:\n' + HOOK_LIST_TEXT + '\n\n' +
        'Generate 5 short-form video content ideas (a concrete hook line + one short sentence on the content angle — ' +
        'no full scripts yet). ' +
        'Avoid repeating these existing ideas: ' + ((Array.isArray(existing) && existing.length) ? existing.join(' | ') : 'none yet') + '. ' +
        'Return ONLY a JSON array of 5 objects like {"pillar":"...","hook":"<formula name from the list above>","idea":"..."}. ' +
        'No preamble, no markdown fences.';

      const text = await callClaude(prompt, 900);
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
        'HOOK: ...\nBEATS:\n- ...\n- ...\nCTA: ...\nCAPTION: ...\nHASHTAGS: ...\n\n' +
        'The CTA is the most important line — it must drive toward signing up for the trainer\'s ONLINE coaching ' +
        'program, not generic engagement. Use a comment-to-DM call to action (comment-to-DM converts far better than ' +
        '"link in bio" because it triggers a DM conversation), e.g. "Comment \'ONLINE\' and I\'ll send you how to join ' +
        'my online program" or "DM me \'COACH\' to apply." Make it specific to this idea\'s topic, not boilerplate. ' +
        'The CAPTION should reinforce the same CTA in its final line.\n' +
        'No markdown, no extra commentary.';

      const text = await callClaude(prompt, 700);
      return res.status(200).json({ text: text });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    return res.status(500).json({ error: 'pt-content call failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
