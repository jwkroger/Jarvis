// ============================================================
// POST /api/jarvis
// Body: { messages: [{role, content}], dashboard: {...} }
// Jarvis — the spoken voice assistant for the dashboard home page.
// Calls Claude with ANTHROPIC_API_KEY held server-side only (never
// sent to the browser). Grounds every reply in the full dashboard
// localStorage snapshot the client sends (goals, health, water,
// gym, finance, etc). Replies are read aloud via the browser's
// speech synthesis, so responses are written to be spoken, not read.
// Returns { text }.
// ============================================================
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

  const system =
    "You are Jarvis, the voice assistant built into the user's personal life-tracking "
    + "dashboard (goals, fitness, health, water, finance, income, etc). A JSON snapshot of "
    + "everything they've saved in the dashboard is included below — use it to give specific, "
    + "grounded answers about their own life.\n\n"
    + "How to respond — this matters, your reply is read aloud by text-to-speech, not displayed:\n"
    + "- Plain spoken sentences only. No markdown, no bullet points, no asterisks, no headers, "
    + "no numbered lists, no emoji.\n"
    + "- Short and natural, like a real spoken answer: usually 1-4 sentences. Only go longer if "
    + "they explicitly ask for detail.\n"
    + "- Warm, direct, capable — a trusted aide, not a chatbot. A touch of dry wit is fine, never "
    + "forced.\n"
    + "- Ground every claim in their actual data. Cite real numbers naturally in sentence form. "
    + "If the snapshot doesn't have what you'd need, say so plainly and ask one focused follow-up.\n"
    + "- Never invent data that isn't in the snapshot.\n"
    + "- Reply with your final answer only — no internal reasoning, no preamble like \"Based on...\".\n\n"
    + "Dashboard snapshot (JSON):\n" + JSON.stringify(dashboard || {});

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
        max_tokens: 512,
        system: system,
        messages: messages,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
      return res.status(r.status).json({ error: msg });
    }
    const text = (data.content || [])
      .filter(b => b && b.type === 'text').map(b => b.text).join('').trim() || "I don't have anything to say to that.";
    return res.status(200).json({ text: text });
  } catch (e) {
    return res.status(500).json({ error: 'jarvis call failed: ' + (e && e.message ? e.message : String(e)) });
  }
}
