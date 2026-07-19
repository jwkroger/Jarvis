// ============================================================
// POST /api/nutrition-coach
// Body: { messages: [{role, content}], profile: {...}, targets: {...}, today: {...} }
// The nutrition dashboard's AI macro coach. Calls Claude with
// ANTHROPIC_API_KEY held server-side only. Always replies via FORCED
// TOOL USE so the client gets a clean { reply, hasSuggestion, calories,
// protein_g, carbs_g, fat_g } shape — a suggestion is only ever applied
// when the user clicks "Apply" on it client-side.
// ============================================================
const COACH_TOOL = {
  name: 'nutrition_coach_reply',
  description: 'Reply to the user in the nutrition chat, optionally proposing new daily macro targets.',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'The chat reply shown to the user. Warm, direct, concise — a few sentences or a short list, never an essay.' },
      hasSuggestion: { type: 'boolean', description: 'True only if you are proposing a full new set of daily targets in this reply.' },
      calories:   { type: 'number', description: 'Suggested daily calorie target (kcal). 0 if hasSuggestion is false.' },
      protein_g:  { type: 'number', description: 'Suggested daily protein target in grams. 0 if hasSuggestion is false.' },
      carbs_g:    { type: 'number', description: 'Suggested daily carbohydrate target in grams. 0 if hasSuggestion is false.' },
      fat_g:      { type: 'number', description: 'Suggested daily fat target in grams. 0 if hasSuggestion is false.' }
    },
    required: ['reply', 'hasSuggestion', 'calories', 'protein_g', 'carbs_g', 'fat_g']
  }
};

function buildSystem(profile, targets, today) {
  return "You are the built-in macro coach for a personal nutrition dashboard. A JSON snapshot "
    + "of the user's own profile, current targets and today's logged food is included below — "
    + "use it to give specific, grounded guidance.\n\n"
    + "How to respond:\n"
    + "- Be warm, direct and concise. Lead with the answer, then a short reason. A few sentences "
    + "or a tight bulleted list — never an essay.\n"
    + "- Ground every claim in their actual data. Quote real numbers instead of speaking in "
    + "generalities. If the snapshot is missing something you'd need (e.g. no weight logged), say "
    + "so and ask one focused follow-up instead of guessing.\n"
    + "- Never invent data that isn't in the snapshot.\n"
    + "- You give general nutrition education and guidance, not medical advice. For anything "
    + "involving a medical condition, remind them to check with a doctor or dietitian.\n\n"
    + "When asked to set / update / suggest macro targets (or on a first-run request), compute "
    + "them with these exact formulas so your numbers are reproducible, and set hasSuggestion=true:\n"
    + "1. BMR (Mifflin-St Jeor): men = 10*weightKg + 6.25*heightCm - 5*age + 5; "
    + "women = 10*weightKg + 6.25*heightCm - 5*age - 161. If height is missing, estimate BMR from "
    + "weight and age alone using 22*weightKg as a fallback base.\n"
    + "2. TDEE = BMR * activity multiplier from weekly active hours: 0-2h -> 1.2, 2-5h -> 1.375, "
    + "5-8h -> 1.55, 8-12h -> 1.725, 12h+ -> 1.9.\n"
    + "3. If a weightGoal.perWeek pace (lbs/week, positive = gain, negative = loss) is present in "
    + "the snapshot, adjust calories by perWeek * 500, clamped to +/-1000 kcal/day, and explain the "
    + "resulting surplus/deficit in your reply. If there's no weight goal pace, suggest maintenance "
    + "(TDEE) and say so.\n"
    + "4. Protein = 1g per lb of bodyweight (convert weightKg accordingly). Fat = 27% of total "
    + "calories / 9 kcal per gram. Carbs = remaining calories / 4 kcal per gram (floor at 0).\n"
    + "5. Round calories to the nearest 10 and grams to the nearest 1.\n"
    + "If the user is just chatting or asking a question with no target change needed, set "
    + "hasSuggestion=false and leave the numeric fields at 0.\n\n"
    + "Reply with your final answer only — no internal reasoning, no \"Based on...\" preamble.\n\n"
    + "Profile (JSON): " + JSON.stringify(profile || {}) + "\n"
    + "Current targets (JSON): " + JSON.stringify(targets || {}) + "\n"
    + "Today so far (JSON): " + JSON.stringify(today || {});
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages, profile, targets, today } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }

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
        system: buildSystem(profile, targets, today),
        tools: [COACH_TOOL],
        tool_choice: { type: 'tool', name: 'nutrition_coach_reply' },
        messages: messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
      return res.status(r.status).json({ error: msg });
    }
    const block = (data.content || []).find(b => b && b.type === 'tool_use' && b.name === 'nutrition_coach_reply');
    if (!block || !block.input) return res.status(502).json({ error: 'model did not return structured data' });
    return res.status(200).json(block.input);
  } catch (e) {
    return res.status(500).json({ error: 'nutrition coach call failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
