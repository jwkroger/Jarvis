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

  // Posting-format cadence, cross-referenced from multiple 2026 sources
  // (Buffer's 2M-post study, Hopper HQ, Dash Social, TrueFuture Media,
  // CreatorFlow): Reels drive discovery (60%+ of views are non-followers,
  // 4+/week grows followers 2.8x faster than 1-2/week). Carousels drive
  // engagement/saves (~10% engagement vs 6-7% for single photos/Reels) and
  // are best for save-worthy education. Stories are a cheap daily
  // relationship-builder, not a discovery format. Photos are low-lift
  // filler, not a primary growth driver.
  const FORMAT_GUIDE = [
    { name: 'Reel', desc: 'Primary growth/discovery engine (60%+ of views come from non-followers). Post most often — target ~4-5/week. Best for hooks, transformations, quick tips, trending audio.' },
    { name: 'Carousel', desc: 'Highest engagement + save rate of any format (~10% vs 6-7% for single photos/Reels). Best for educational listicles, step-by-step breakdowns, myth-busting — content worth swiping through and saving. Target ~2-3/week.' },
    { name: 'Photo', desc: 'Low-lift filler — single-image moments (before/after stills, quotes, quick BTS snapshots). Use sparingly to round out the week, not as a primary growth driver.' },
    { name: 'Story', desc: 'Daily relationship-builder, not a discovery format — polls, BTS, countdowns, Q&As. Cheap to produce; can run alongside a Reel/Carousel on the same day.' }
  ];
  const FORMAT_LIST_TEXT = FORMAT_GUIDE.map((f) => '- ' + f.name + ': ' + f.desc).join('\n');

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
        'You are a social media strategist helping a personal trainer grow an Instagram presence. They want to post ' +
        'every day to kickstart growth. They currently run in-person group training at BFT and are starting to build ' +
        'an online coaching offer, so every idea should ultimately funnel viewers toward that online program — either ' +
        'directly (a coaching-pitch idea) or by building the trust that earns the DM (education, results, group-' +
        'training energy). ' +
        'Aim for a content mix close to 60% educational/tips, 30% social proof (client wins, group energy, behind the ' +
        'scenes), 10% direct promotional, spread across these pillars: ' + pillarList.join(', ') + '.\n\n' +
        'Every idea must open with a hook built from ONE of these proven high-converting formulas — pick whichever fits ' +
        'the idea best, and don\'t reuse the same formula for all 5:\n' + HOOK_LIST_TEXT + '\n\n' +
        'Every idea must also be assigned a posting format, based on this cadence research (posting daily means most ' +
        'days are a Reel or a Carousel, with a Story layered on top — Photo is rare filler, not a primary driver):\n' +
        FORMAT_LIST_TEXT + '\n' +
        'Across this batch of 5, skew toward Reel and Carousel to match the weekly target (~4-5 Reels, ~2-3 Carousels ' +
        'per week) — roughly 3 Reels and 2 Carousels is a good split, using Photo or Story only when an idea genuinely ' +
        'fits that format better than video.\n\n' +
        'Generate 5 short-form content ideas (a concrete hook line + one short sentence on the content angle — no full ' +
        'scripts yet). ' +
        'Avoid repeating these existing ideas: ' + ((Array.isArray(existing) && existing.length) ? existing.join(' | ') : 'none yet') + '. ' +
        'Return ONLY a JSON array of 5 objects like {"pillar":"...","hook":"<formula name from the list above>",' +
        '"format":"<Reel|Carousel|Photo|Story>","idea":"..."}. No preamble, no markdown fences.';

      const text = await callClaude(prompt, 900);
      const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
      let ideas;
      try { ideas = JSON.parse(cleaned); } catch (e) { throw new Error('could not parse ideas from the model'); }
      if (!Array.isArray(ideas)) throw new Error('unexpected ideas format');
      return res.status(200).json({ ideas: ideas });
    }

    if (type === 'script') {
      const { idea, pillar, format } = req.body || {};
      if (!idea) return res.status(400).json({ error: 'idea required' });

      const fmt = ['Reel', 'Carousel', 'Photo', 'Story'].includes(format) ? format : 'Reel';
      const ctaRule =
        'The CTA is the most important line — it must drive toward signing up for the trainer\'s ONLINE coaching ' +
        'program, not generic engagement. Use a comment-to-DM call to action (comment-to-DM converts far better than ' +
        '"link in bio" because it triggers a DM conversation), e.g. "Comment \'ONLINE\' and I\'ll send you how to join ' +
        'my online program" or "DM me \'COACH\' to apply." Make it specific to this idea\'s topic, not boilerplate.';

      const shapeByFormat = {
        Reel:
          'This is a Reel (30-45 seconds). Format exactly as plain text:\n' +
          'HOOK: ...\nBEATS:\n- ...\n- ...\nCTA: ...\nCAPTION: ...\nHASHTAGS: ...\n\n' +
          ctaRule + ' The CAPTION should reinforce the same CTA in its final line.',
        Carousel:
          'This is a Carousel (feed swipe post, 6-8 slides). Format exactly as plain text:\n' +
          'SLIDE 1 (cover/hook text on-image): ...\nSLIDE 2: ...\nSLIDE 3: ...\n(continue slides as needed, each one ' +
          'short enough to read in ~2 seconds)\nFINAL SLIDE (CTA): ...\nCAPTION: ...\nHASHTAGS: ...\n\n' +
          ctaRule + ' The final slide AND the caption should both carry the CTA — carousels get saved and re-served, ' +
          'so the CTA needs to work whether someone reads the caption or not.',
        Photo:
          'This is a single Photo post. Format exactly as plain text:\n' +
          'IMAGE: (one-line description of the shot)\nOVERLAY TEXT: (short text to put on the image, if any)\n' +
          'CAPTION: ...\nHASHTAGS: ...\n\n' +
          ctaRule + ' Since there\'s no video to build up to it, the CTA has to land inside the caption itself.',
        Story:
          'This is an Instagram Story (2-4 frames, low production). Format exactly as plain text:\n' +
          'FRAME 1: ...\nFRAME 2: ...\n(continue frames as needed)\nSTICKER: (suggest a poll, question, or quiz ' +
          'sticker that fits, or "none")\nCTA: ...\n\n' +
          ctaRule + ' Keep it casual and quick — Stories are for daily relationship-building, not polish.'
      };

      const prompt =
        'Write Instagram content for a personal trainer\'s content idea.\n' +
        'Idea: "' + idea + '"\n' +
        'Content pillar: ' + (pillar || 'General') + '\n' +
        'Posting format: ' + fmt + '\n\n' +
        shapeByFormat[fmt] + '\n' +
        'No markdown, no extra commentary.';

      const text = await callClaude(prompt, 800);
      return res.status(200).json({ text: text });
    }

    return res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    return res.status(500).json({ error: 'pt-content call failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
