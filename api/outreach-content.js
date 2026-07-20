// ============================================================
// POST /api/outreach-content
// Body: { type: 'email'|'linkedin'|'callscript', company: {name, summary, useCases, recentNews, notes},
//         contact: {name, title, notes}, framework: '...', touchCount: N, priorMessages: [{subject, body}] }
// Outreach CRM's email / LinkedIn / cold-call-script generator — personalized to
// a specific contact and aware of how many times they've already been touched, so
// the message stages appropriately (cold open -> follow-up -> break-up) instead of
// repeating the same pitch. Calls Claude with ANTHROPIC_API_KEY held server-side
// only (never sent to the browser). Returns { subject, body } (email), { body }
// (linkedin), or { opener, questions: [{category, items}], close } (callscript).
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { type, company, contact, framework, touchCount, priorMessages, variantRequest } = req.body || {};
  if (!company || !company.name) return res.status(400).json({ error: 'company required' });
  if (!contact || !contact.name) return res.status(400).json({ error: 'contact required' });

  // Reps were sending copy that called a 2024 news item "last month" — the
  // model has no reliable sense of "today" on its own, so it's grounded here
  // and every relative-time phrase downstream has to be checked against it.
  const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const dateRule =
    'Today\'s actual date is ' + todayStr + '. If you reference a news item with a relative time phrase ("last ' +
    'month", "a few weeks ago", "earlier this year", "last year"), that phrase MUST be arithmetically correct given ' +
    'the item\'s date above versus today\'s date — do not assume a search result is recent just because you found ' +
    'it, and do not guess. If a news item\'s date is missing or "date unknown", or if you\'re not sure the relative ' +
    'phrase would be accurate, either state the actual month/year instead (e.g. "back in March") or drop the time ' +
    'reference entirely rather than risk saying "recently" about something over a year old.\n';

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

  // Applies MEDDPICC selling to short-form copy: an email/LinkedIn message only
  // has room for ONE MEDDPICC-relevant angle (unlike the call script's full
  // multi-category discovery list), and it should never name the framework or
  // read like a checklist to the prospect. Pick the pillar suited to the
  // current touch stage so early messages surface pain and later ones can
  // start touching decision process/economic buyer.
  function meddpiccAngle() {
    if (n <= 0) {
      return 'MEDDPICC angle for this touch (apply it invisibly, never name the framework): lead with PAIN (Identify ' +
        'Pain) — reference a real, specific operational pain this role would recognize in their industry. Don\'t bring ' +
        'up budget, process, or other decision-makers yet.';
    }
    if (n <= 2) {
      return 'MEDDPICC angle for this touch (apply it invisibly, never name the framework): build on the pain by hinting ' +
        'at a METRIC or outcome this role would care about, or by inviting them to loop in a colleague who should see ' +
        'this (a potential CHAMPION) — pick whichever fits better, not both.';
    }
    if (n <= 5) {
      return 'MEDDPICC angle for this touch (apply it invisibly, never name the framework): it\'s fair to softly touch ' +
        'on how a decision like this typically gets evaluated at a company their size (DECISION PROCESS), or who\'d ' +
        'ultimately need to sign off (ECONOMIC BUYER) — a light, curious mention, not a direct budget/procurement ask.';
    }
    return 'This is a break-up touch — skip MEDDPICC discovery framing entirely and focus purely on the relationship close.';
  }

  // Titles vary too much to hardcode a lookup table, so bucket by seniority
  // keywords and let the model reason about the specific title within that
  // frame — this is what actually changes between a VP and an EHS Manager:
  // what they personally care about, not just a friendlier greeting.
  function roleAngle(title) {
    const t = (title || '').toLowerCase().trim();
    if (!t) return '';
    const isExecutive = /\b(vp|vice president|chief|head of|cxo|ceo|coo|cfo)\b/.test(t);
    const isDirector = /\bdirector\b/.test(t);
    if (isExecutive) {
      return 'This contact is EXECUTIVE-LEVEL (' + title + '). Frame the message around organizational risk exposure ' +
        'and liability, the cost of incidents/non-compliance at scale, board- and audit-level visibility, and ROI — ' +
        'not day-to-day tool mechanics. They think in terms of risk reduction and budget, not workflows.';
    }
    if (isDirector) {
      return 'This contact is DIRECTOR-LEVEL (' + title + '). Frame the message around program-wide risk/compliance ' +
        'outcomes and how this makes their team more effective and audit-ready, with a lighter touch on operational ' +
        'detail than you\'d use for a frontline manager, and less pure strategy than you\'d use for a VP.';
    }
    return 'This contact is at the MANAGER/OPERATIONAL level (' + title + '). Frame the message around reducing their ' +
      'day-to-day administrative burden — incident reporting, audit prep, inspections, paperwork — and making their ' +
      'field team\'s job easier. This is the person doing the work, not setting strategy; speak to their actual daily ' +
      'pain, not boardroom risk framing.';
  }

  // Evotix sells two distinct platforms (Assure for mid-market, 360 for
  // enterprise) — getting the wrong one, or the wrong segment label, in front
  // of a real prospect is a credibility problem, so this is spelled out
  // explicitly rather than left for the model to infer from the summary text.
  const seg = (company.segment && String(company.segment).trim().toLowerCase()) || '';
  const segmentBlock =
    seg === 'enterprise'
      ? 'Segment: ENTERPRISE. If a platform is named, it MUST be Evotix 360, not Assure. Never describe this account ' +
        'as "mid-market."\n'
      : seg === 'mid-market'
      ? 'Segment: MID-MARKET. If a platform is named, it MUST be Evotix Assure, not 360. Never describe this account ' +
        'as "enterprise."\n'
      : 'Segment: not confidently determined from research. Do not assert this account is "mid-market" or ' +
        '"enterprise" — if a platform needs naming, keep it general (e.g. "Evotix\'s platform") rather than committing ' +
        'to Assure or 360.\n';

  const researchBlock =
    'Company: ' + company.name + '\n' +
    (company.summary ? ('Summary: ' + company.summary + '\n') : '') +
    segmentBlock +
    (Array.isArray(company.useCases) && company.useCases.length
      ? ('Relevant EHS use cases: ' + company.useCases.join('; ') + '\n') : '') +
    (Array.isArray(company.recentNews) && company.recentNews.length
      ? ('Recent news items (each with the date it was actually published, if known) — pick whichever is MOST relevant ' +
         'to THIS contact\'s specific role rather than defaulting to the first one regardless of who it\'s for (a ' +
         'safety incident matters most to a Safety/EHS contact, a regulatory item matters most to a Risk/Compliance ' +
         'contact, an expansion or new facility could matter to any of them but connect it to whichever operational ' +
         'challenge it creates that THIS role would personally care about): ' +
         company.recentNews.map((n2) => (n2 && n2.headline || '') + (n2 && n2.date ? (' [dated: ' + n2.date + ']') : '') + (n2 && n2.note ? (' — ' + n2.note) : '')).join('; ') + '\n' +
         dateRule)
      : '') +
    'Contact: ' + contact.name + (contact.title ? (', ' + contact.title) : '') + '\n' +
    (contact.title ? (roleAngle(contact.title) + '\n') : '') +
    (company.notes && String(company.notes).trim()
      ? ('Rep\'s notes on this COMPANY (apply to outreach with ANY contact here — e.g. tools they use, org facts, ' +
         'timing): ' + String(company.notes).trim() + '\n')
      : '') +
    (contact.notes && String(contact.notes).trim()
      ? ('Rep\'s notes on THIS SPECIFIC CONTACT (personalize only their messages with this — e.g. something said on a ' +
         'call): ' + String(contact.notes).trim() + '\n')
      : '');

  const notesRepeatRule = (company.notes || contact.notes)
    ? 'If a note above states a fact (e.g. a tool they use, something said on a call), you may reference it — but check ' +
      'the prior-messages list below first: if that exact fact was already mentioned in an earlier message to this ' +
      'contact, do NOT restate it again. Either build on it from a new angle or leave it out this time.\n'
    : '';

  const priorBlock = (Array.isArray(priorMessages) && priorMessages.length)
    ? ((n <= 0
         ? 'Previously drafted (but not yet sent) versions of this SAME initial touch — the rep didn\'t like these and ' +
           'wants a genuinely different take, not a follow-up: use a different specific detail (a different news item, ' +
           'use case, or angle) so this doesn\'t read like a near-duplicate:\n'
         : 'Previous messages already sent to this contact (do not repeat these angles — build on them or take a new one):\n') +
       priorMessages.map((m, i) => (i + 1) + '. ' + (m.subject ? (m.subject + ' — ') : '') + (m.body || '')).join('\n') + '\n')
    : '';

  const frameworkBlock = framework && String(framework).trim()
    ? ('Follow this framework/structure the rep provided — adapt it to this contact and stage, don\'t just fill in blanks mechanically:\n---\n' + String(framework).trim() + '\n---\n')
    : '';

  // Explicit "give me another take" trigger (the call script's dedicated
  // Different Version button) rather than relying only on the implicit n<=0
  // branch of priorBlock above — this fires regardless of touch count.
  const variantBlock = variantRequest
    ? 'The rep explicitly asked for a DIFFERENT VERSION, not a near-duplicate: use a different specific news item or ' +
      'detail than any referenced in the prior versions above (if the company has more than one), and use a genuinely ' +
      'different opening angle/pattern-interrupt style than any prior version below, not just a reworded restatement ' +
      'of the same one.\n'
    : '';

  // The rep asked for this explicitly: generated copy was reading as obviously
  // AI-written. Em dashes as a clause separator and a handful of stock phrases
  // are the biggest tells, so ban them outright rather than just asking for
  // "natural" tone in the abstract.
  const HUMANIZE_RULES = [
    'Never use an em dash, en dash, or double hyphen (—, –, --) as a clause separator. Write it as two short sentences, or join the clause with "and", "but", "so", or a comma instead. Hyphens are fine only inside an actual compound word, like "follow-up" or "self-service".',
    'Do not use AI-sounding stock phrases or filler, e.g. "I hope this finds you well", "in today\'s fast-paced/ever-evolving world", "delve into", "leverage", "seamless", "game-changer", "unlock", "streamline", "robust", "furthermore", "moreover", "at the end of the day".',
    'Write the way this rep would actually type it at their desk: contractions are fine, sentence length should vary, and don\'t force a "rule of three" list or perfectly parallel structure in every line.',
    'No markdown formatting, no bullet symbols, no em-dash-separated asides — plain sentences a real person would send.'
  ];

  // Cold-call opener technique, drawn from Jeremy Miner/NEPQ-style pattern
  // interrupts and 2026 B2B cold-calling data: openers that state the specific
  // reason for calling convert ~2.1x better than jumping straight into a pitch,
  // and a single personalized detail in the first 10 seconds roughly doubles
  // the odds the prospect keeps talking. "How are you today?" is a scripted-
  // telemarketer tell that triggers the screening reflex before you get a word
  // in — the fix is either an honest pattern interrupt ("this is a cold call —
  // do you want to hang up, or give me 30 seconds?") or leading immediately
  // with the specific, researched reason for the call, never small talk first.
  const CALL_OPENER_RULES = [
    'Structure: Hook (~10-15 sec) -> Bridge (~10-15 sec) -> Reason/value (~15-20 sec) -> Soft ask for permission to continue (~10 sec). Whole opener should be well under 60 seconds spoken aloud, ending in a question that hands the floor back.',
    'Open with a genuine pattern interrupt, NOT "Hi, how are you today?" or "Do you have a minute?" as the very first line — either name the cold call honestly and disarmingly, or lead straight into the specific, researched reason you\'re calling.',
    'Weave in ONE specific, real detail about this company or contact in the first 10-15 seconds (a recent news item, an initiative, something from the rep\'s notes, or their industry\'s specific risk exposure) — vague industry-level personalization ("I work with companies like yours") does not land.',
    'State the specific reason for the call plainly before asking for time — reps who do this convert roughly 2x better than reps who pitch immediately or ask "got a sec?" cold.',
    'End the opener with a low-pressure, curiosity-based question that earns permission to keep talking rather than a yes/no gate they can easily shut down.',
    'Write the opener as an ACTUAL word-for-word script the rep can read or memorize verbatim — natural spoken language, contractions, short sentences — not a description of what the opener should do.'
  ];

  // Post-opener discovery uses NEPQ-style question sequencing (problem
  // awareness -> consequence -> solution awareness) layered onto the MEDDPICC
  // qualification pillars most relevant to a cold call: surfacing pain and
  // finding a champion come first, economic buyer/metrics/competition get
  // asked once the prospect is engaged, not interrogation-style up front.
  const MEDDPICC_CATEGORIES = [
    { category: 'Pain / Problem Awareness', guidance: 'Open-ended NEPQ-style questions ("what/how") that get the prospect to describe their own current pain in this contact\'s specific role/industry, in their own words — not a leading or closed question.' },
    { category: 'Consequence', guidance: 'Questions that get the prospect to state OUT LOUD what happens if this pain stays unfixed (cost, risk, audit exposure, time, headcount strain) — this is what creates urgency, not the rep stating it for them.' },
    { category: 'Champion & Decision Process', guidance: 'Curious, non-interrogating questions surfacing who else cares about this, how a change like this would typically get evaluated/approved at their company, and whether this contact would be the one driving it.' },
    { category: 'Economic Buyer & Metrics', guidance: 'Soft, natural questions about what success/ROI would look like or who\'d ultimately sign off on budget — framed as curiosity about their world, not a budget interrogation this early.' },
    { category: 'Competition / Current State', guidance: 'Questions about what they use today (paper, spreadsheets, a competing tool) and what\'s working or not — if the rep\'s notes mention a specific tool the company already uses, reference it naturally here instead of asking blind.' }
  ];

  let prompt, maxTokens;
  if (type === 'email') {
    prompt =
      'Write a cold outreach email from a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
      'software company, to the contact below.\n\n' + researchBlock + '\n' +
      sequenceStage() + '\n\n' +
      'Subject line rules (2026 B2B benchmarks):\n' + SUBJECT_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      'Body rules:\n' + BODY_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      meddpiccAngle() + ' If it doesn\'t fit naturally for this specific message, skip it rather than forcing it.\n\n' +
      'Sound like a real person, not an AI:\n' + HUMANIZE_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      frameworkBlock + notesRepeatRule + priorBlock +
      'Address it to ' + contact.name.split(' ')[0] + ' by first name. The value prop and CTA MUST reflect this ' +
      'specific person\'s role and seniority (see the framing note above), not a generic pitch that would read the ' +
      'same regardless of who it\'s addressed to. Professional but conversational — not salesy or generic.';
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
      (isConnectionNote ? '' : (meddpiccAngle() + ' If it doesn\'t fit naturally for this specific message, skip it rather than forcing it.\n\n')) +
      'Sound like a real person, not an AI:\n' + HUMANIZE_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      frameworkBlock + notesRepeatRule + priorBlock +
      'The angle MUST reflect this specific person\'s role and seniority (see the framing note above) — not a generic ' +
      'pitch that would read the same regardless of who it\'s addressed to.';
    maxTokens = 400;
  } else if (type === 'callscript') {
    prompt =
      'Write a cold-call script for a BDR at Evotix, an EHS&S (Environmental, Health, Safety & Sustainability) ' +
      'software company, calling the contact below. Use current best-in-class B2B cold-calling technique: Jeremy ' +
      'Miner/NEPQ-style pattern interrupts for the opener, and MEDDPICC-style qualification (adapted into natural, ' +
      'curious spoken questions, never interrogation-style) for the discovery bullets that follow.\n\n' +
      researchBlock + '\n' + sequenceStage() + '\n\n' +
      'OPENER — write this as an ACTUAL word-for-word script, not a description:\n' +
      CALL_OPENER_RULES.map((r) => '- ' + r).join('\n') + '\n' +
      meddpiccAngle() + ' If it doesn\'t fit naturally in the opener itself, it\'s fine for it to show up in the ' +
      'discovery questions instead.\n\n' +
      'DISCOVERY QUESTIONS — bullet points only (not full scripted lines), tailored specifically to this contact\'s ' +
      'role, industry, and the company research/notes above. For EACH category below, write 2-4 tailored questions:\n' +
      MEDDPICC_CATEGORIES.map((c) => '- ' + c.category + ': ' + c.guidance).join('\n') + '\n' +
      'Sequence matters: Pain and Consequence questions come first while rapport is still being built; Champion/' +
      'Decision Process, Economic Buyer/Metrics, and Competition questions come later once the prospect is engaged, ' +
      'never all at once. Use language and use-case buzzwords a real EHS/Safety buyer in this contact\'s industry ' +
      'would recognize, not generic software-speak.\n\n' +
      'CLOSE — one short, low-pressure line that transitions from discovery into asking for a meeting, referencing ' +
      'what would have just been uncovered rather than a generic "can we set up a call?"\n\n' +
      'Sound like a real person talking, not an AI:\n' + HUMANIZE_RULES.map((r) => '- ' + r).join('\n') + '\n\n' +
      frameworkBlock + notesRepeatRule + variantBlock + priorBlock +
      'Everything MUST reflect this specific person\'s role, seniority, and industry (see the framing note above) — ' +
      'not a generic script that would read the same for any prospect.';
    maxTokens = 1600;
  } else {
    return res.status(400).json({ error: 'unknown type' });
  }

  try {
    const data = await callClaude(apiKey, prompt, maxTokens, TOOL_SCHEMAS[type]);
    return res.status(200).json(humanizeOutput(type, data));
  } catch (e) {
    return res.status(500).json({ error: 'outreach content failed: ' + (e && e.message ? e.message : String(e)) });
  }
}

// Backstop for the em-dash/AI-tell instructions above — the model mostly
// complies, but a deterministic pass catches the cases it doesn't, rather
// than relying purely on the prompt.
function humanizeText(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+--\s+/g, ', ')
    .replace(/^[-*]\s+/gm, '')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function humanizeOutput(type, data) {
  if (type === 'email') {
    return { subject: humanizeText(data.subject), body: humanizeText(data.body) };
  }
  if (type === 'linkedin') {
    return { body: humanizeText(data.body) };
  }
  if (type === 'callscript') {
    return {
      opener: humanizeText(data.opener),
      close: humanizeText(data.close),
      questions: (Array.isArray(data.questions) ? data.questions : []).map((g) => ({
        category: g && g.category,
        items: Array.isArray(g && g.items) ? g.items.map(humanizeText) : []
      }))
    };
  }
  return data;
}

// Free-text-then-parse-the-JSON was fragile: multi-beat script content (the
// call script opener especially) tempted the model into unescaped newlines
// or quoted dialogue that broke JSON.parse. Using tool-use forces the model's
// output through Anthropic's schema-constrained decoding instead, so the API
// itself guarantees the shape and we get back a parsed object directly.
const TOOL_SCHEMAS = {
  email: {
    name: 'draft_email',
    description: 'The drafted cold outreach email.',
    input_schema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'The email subject line.' },
        body: { type: 'string', description: 'The email body.' }
      },
      required: ['subject', 'body']
    }
  },
  linkedin: {
    name: 'draft_linkedin_message',
    description: 'The drafted LinkedIn outreach message.',
    input_schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The LinkedIn message text.' }
      },
      required: ['body']
    }
  },
  callscript: {
    name: 'draft_call_script',
    description: 'The drafted cold-call script.',
    input_schema: {
      type: 'object',
      properties: {
        opener: { type: 'string', description: 'The word-for-word opener script.' },
        questions: {
          type: 'array',
          description: 'Discovery question groups, in the order they should be asked.',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              items: { type: 'array', items: { type: 'string' } }
            },
            required: ['category', 'items']
          }
        },
        close: { type: 'string', description: 'The short meeting-ask close line.' }
      },
      required: ['opener', 'questions', 'close']
    }
  }
};

async function callClaude(apiKey, prompt, maxTokens, tool) {
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
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = (data && data.error && data.error.message) || ('Anthropic API error (' + r.status + ')');
    throw new Error(msg);
  }
  const toolUse = (data.content || []).find((b) => b && b.type === 'tool_use');
  if (!toolUse || !toolUse.input) throw new Error('model did not return structured output');
  return toolUse.input;
}
