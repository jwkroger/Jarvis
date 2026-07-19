// ============================================================
// POST /api/jarvis
// Body: { messages: [{role, content}], dashboard: {...} }
// Jarvis — the spoken voice assistant for the dashboard home page.
// Calls Claude with ANTHROPIC_API_KEY held server-side only (never
// sent to the browser). Grounds every reply in the full dashboard
// localStorage snapshot the client sends (goals, health, water,
// gym, finance, etc). Replies are read aloud via the browser's
// speech synthesis, so responses are written to be spoken, not read.
//
// Always replies via FORCED TOOL USE so the client gets a clean
// structured shape it can act on directly — logging food, adding an
// Evotix opportunity, adding a to-do, logging water, or updating a
// Life Goal all happen from a single turn instead of requiring the
// user to go to that page. Returns:
//   { text, action, foodName, foodCalories, foodProteinG, foodCarbsG,
//     foodFatG, opportunityNote, goalText, goalWhen, waterUnits,
//     lifeGoalId, lifeGoalValue }
// The client applies the action to localStorage itself (this endpoint
// never touches the client's data directly).
// ============================================================

// Keep this list in sync with DEFAULT_LIFE_GOALS in main.html — these
// ids are the only valid values for lifeGoalId.
const LIFE_GOAL_IDS = `
weight (Bodyweight, lbs, metric), bodyfat (Body Fat %, metric, lower is better),
bench (Bench Press, lbs, metric), squat (Squat, lbs, metric),
muscleups (Muscle-Ups unbroken, reps, metric), mile (Mile Time, min, metric, lower is better),
creditscore (Credit Score, pts, metric), savings (Savings, $, metric),
roth (Roth IRA, $, metric), invest (Investment Account, $, metric),
opp10 (Opportunities/Month at Evotix, counter), opp50 (Opportunities by EOY at Evotix, counter),
clienttouch (Client 1-on-1 Touches/Week, counter), guitarart (Guitar/Art Practice, counter),
books (Books Read, counter), trips (Fun Trips, counter), incomestreams (Additional Income Streams, counter),
hyrox / cpt / spartan / bdrlead / ptsocials / ascend / ccdebt / familydebt / quitvaping / teeth / apartment / bside (all milestones — done/not done only)
`.trim();

const JARVIS_TOOL = {
  name: 'jarvis_reply',
  description: 'Reply to the user in the Jarvis voice/chat widget, and perform exactly one dashboard action if they clearly asked for one.',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'The spoken reply. Plain sentences only, no markdown. 1-4 sentences unless asked for more detail.'
      },
      action: {
        type: 'string',
        enum: ['none', 'log_food', 'log_opportunity', 'add_goal', 'log_water', 'update_life_goal'],
        description: 'Which single dashboard action to perform this turn. "none" for a plain question/chat with no data change.'
      },
      foodName:     { type: 'string', description: 'Short name for what they ate/drank. Empty unless action is log_food.' },
      foodCalories: { type: 'number', description: 'Estimated kcal. 0 unless action is log_food.' },
      foodProteinG: { type: 'number', description: 'Estimated grams of protein. 0 unless action is log_food.' },
      foodCarbsG:   { type: 'number', description: 'Estimated grams of carbohydrate. 0 unless action is log_food.' },
      foodFatG:     { type: 'number', description: 'Estimated grams of fat. 0 unless action is log_food.' },
      opportunityNote: { type: 'string', description: 'Brief note (client/company name) for the Evotix opportunity being logged. Empty unless action is log_opportunity.' },
      goalText: { type: 'string', description: 'The to-do text to add. Empty unless action is add_goal.' },
      goalWhen: { type: 'string', enum: ['today', 'tomorrow', ''], description: 'Which list to add the to-do to. Empty unless action is add_goal.' },
      waterUnits: { type: 'number', description: 'Number of water units (bottles/glasses — whatever the user has configured) to add, default 1. 0 unless action is log_water.' },
      lifeGoalId: { type: 'string', description: 'Exact id (from the known list below) of the life goal being updated. Empty unless action is update_life_goal.' },
      lifeGoalValue: {
        type: 'number',
        description: 'For metric goals, the new current value (e.g. new bodyweight). For counter goals, the amount to add (usually 1). For milestone goals, ignored (any update marks it done). 0 unless action is update_life_goal.'
      }
    },
    required: ['reply', 'action', 'foodName', 'foodCalories', 'foodProteinG', 'foodCarbsG', 'foodFatG',
      'opportunityNote', 'goalText', 'goalWhen', 'waterUnits', 'lifeGoalId', 'lifeGoalValue']
  }
};

function buildSystem(dashboard) {
  return "You are Jarvis, the voice assistant built into the user's personal life-tracking "
    + "dashboard (goals, fitness, health, water, finance, income, etc). A JSON snapshot of "
    + "everything they've saved in the dashboard is included below — use it to give specific, "
    + "grounded answers about their own life.\n\n"
    + "How to respond — this matters, your reply is read aloud by text-to-speech, not displayed:\n"
    + "- Plain spoken sentences only. No markdown, no bullet points, no asterisks, no headers, "
    + "no numbered lists, no emoji.\n"
    + "- Short and natural, like a real spoken answer: usually 1-4 sentences. Only go longer if "
    + "they explicitly ask for detail.\n"
    + "- Speak like Jarvis from Iron Man: unfailingly composed, precise, quietly capable, with a "
    + "dry, understated wit that shows up occasionally, never forced. Address the user as \"sir\" "
    + "now and then (an opener or a closer, not every line — it should read as habit, not a tic). "
    + "Prefer measured, economical phrasing over enthusiasm; you inform and advise, you don't cheerlead.\n"
    + "- Ground every claim in their actual data. Cite real numbers naturally in sentence form. "
    + "If the snapshot doesn't have what you'd need, say so plainly and ask one focused follow-up.\n"
    + "- Never invent data that isn't in the snapshot.\n"
    + "- Reply with your final answer only — no internal reasoning, no preamble like \"Based on...\".\n\n"

    + "ACTIONS — you can perform exactly ONE per reply, only when the user is clearly asking for "
    + "it (not for hypothetical questions like \"what if I had...\" or \"how many calories in...\"). "
    + "Default to action=none for plain questions or chat. When you do perform an action, mention "
    + "what you logged/added and its numbers in your reply, so it reads as confirmation.\n\n"

    + "log_food — the user says they ate or drank something specific (\"I just had a chicken "
    + "burrito\", \"had 3 eggs and toast\"). Estimate calories/protein/carbs/fat for a typical "
    + "portion using common nutrition knowledge, the same way you'd size up a photo of it. Combine "
    + "multiple items mentioned together into one entry under one descriptive foodName. Round "
    + "calories to the nearest 10 and grams to the nearest 1. If portion size is ambiguous, make a "
    + "reasonable assumption and note it briefly rather than asking first — they can delete the "
    + "entry if it's off.\n\n"

    + "log_opportunity — the user says to log/add a sales opportunity, SAO, or client win for their "
    + "Evotix job (\"log an opportunity with Acme Corp\", \"add a SAO\"). Set opportunityNote to a "
    + "short description (company/client name if given).\n\n"

    + "add_goal — the user asks to add a to-do/goal/reminder for today or tomorrow. Default "
    + "goalWhen to 'today' unless they say tomorrow.\n\n"

    + "log_water — the user says they drank water (\"log a bottle of water\", \"I had 2 glasses\"). "
    + "waterUnits defaults to 1 if not specified.\n\n"

    + "update_life_goal — the user reports real progress on one of their named 2026 life goals "
    + "(a new bodyweight, a new lift number, a credit score check, a savings balance, marking a "
    + "milestone like the CPT certification or Spartan Race complete, etc). You MUST use one of "
    + "these exact ids for lifeGoalId — never invent one:\n" + LIFE_GOAL_IDS + "\n"
    + "For metric goals, lifeGoalValue is the new absolute number (e.g. \"I'm 178 now\" -> "
    + "lifeGoalId='weight', lifeGoalValue=178). For counter goals, lifeGoalValue is the amount to "
    + "add (default 1). For milestone goals, lifeGoalValue is ignored — any mention of completing "
    + "it marks it done. If the goal they mean isn't in the list above, use action=none and say so "
    + "rather than guessing an id.\n\n"

    + "Dashboard snapshot (JSON):\n" + JSON.stringify(dashboard || {});
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { messages, dashboard } = req.body || {};
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
        max_tokens: 768,
        system: buildSystem(dashboard),
        tools: [JARVIS_TOOL],
        tool_choice: { type: 'tool', name: 'jarvis_reply' },
        messages: messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
      return res.status(r.status).json({ error: msg });
    }
    const block = (data.content || []).find(b => b && b.type === 'tool_use' && b.name === 'jarvis_reply');
    if (!block || !block.input) return res.status(502).json({ error: 'model did not return structured data' });
    const out = Object.assign({}, block.input, { text: block.input.reply || "I don't have anything to say to that." });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: 'jarvis call failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
