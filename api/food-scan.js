// ============================================================
// POST /api/food-scan
// Body: { image: base64, mediaType }
// Reads a photo of food, a plate/meal, or a nutrition-facts label via
// Claude vision with forced tool-use, so the response is always clean
// structured JSON. ANTHROPIC_API_KEY stays server-side only. Returns
// the tool input directly:
//   { readable, foodName, description, calories, protein_g, carbs_g, fat_g, confidence }
// ============================================================
const SCAN_TOOL = {
  name: 'log_food_image',
  description: 'Record the food and its nutritional estimate read from an image: a plate of food, a packaged snack, or a nutrition-facts label.',
  input_schema: {
    type: 'object',
    properties: {
      readable:    { type: 'boolean', description: 'True if the image shows any identifiable food or a nutrition-facts label.' },
      foodName:    { type: 'string', description: 'Short name for the food/meal (e.g. "Grilled chicken bowl", "Protein bar").' },
      description: { type: 'string', description: 'One short sentence describing what you see and the estimated serving size. Empty if reading an exact label.' },
      calories:    { type: 'number', description: 'Estimated total calories (kcal) for the visible serving. 0 if none.' },
      protein_g:   { type: 'number', description: 'Estimated grams of protein for the visible serving.' },
      carbs_g:     { type: 'number', description: 'Estimated grams of carbohydrate for the visible serving.' },
      fat_g:       { type: 'number', description: 'Estimated grams of fat for the visible serving.' },
      confidence:  { type: 'string', enum: ['high', 'medium', 'low'], description: 'high = exact numbers read off a nutrition-facts label; medium = a clearly identifiable, typical portion; low = a rough visual guess.' }
    },
    required: ['readable', 'foodName', 'calories', 'protein_g', 'carbs_g', 'fat_g', 'confidence']
  }
};

const SCAN_SYSTEM =
  "You read images of food for a nutrition-tracking app — a plate of food, a packaged snack, a "
  + "restaurant meal, or a nutrition-facts label — and estimate calories and macros for the "
  + "visible serving.\n"
  + "- Always call the log_food_image tool exactly once with your best reading. Do NOT refuse "
  + "just because it's a home-cooked or mixed dish — give your best estimate.\n"
  + "- If a nutrition-facts label is visible, use its exact printed numbers (scaled to the number "
  + "of servings shown, if stated) and set confidence=\"high\".\n"
  + "- If it's a recognizable food/meal with a typical portion, estimate calories and macros for "
  + "that portion using common nutrition knowledge and set confidence=\"medium\".\n"
  + "- If the food is unclear or the portion is hard to judge, give a rough best-effort estimate "
  + "and set confidence=\"low\" — never refuse outright.\n"
  + "- Only set readable=false if there is genuinely no food, meal, or nutrition label anywhere "
  + "in the image.\n"
  + "- Numbers must be plain numeric values (no units, symbols, or ranges).";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { image, mediaType } = req.body || {};
  if (!image) return res.status(400).json({ error: 'image required' });

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
        system: SCAN_SYSTEM,
        tools: [SCAN_TOOL],
        tool_choice: { type: 'tool', name: 'log_food_image' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image } },
            { type: 'text', text: 'Read this image and estimate calories and macros for the food shown.' }
          ]
        }]
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
      return res.status(r.status).json({ error: msg });
    }
    const block = (data.content || []).find(b => b && b.type === 'tool_use' && b.name === 'log_food_image');
    if (!block || !block.input) return res.status(502).json({ error: 'model did not return structured data' });
    return res.status(200).json(block.input);
  } catch (e) {
    return res.status(500).json({ error: 'food scan failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
