// The Arena — roleplay sessions grounded in a specific Moment-of-Truth.
//
// Design:
//   - Base persona (Skeptical CFO) lives in the gemini.js cache layer. Every
//     Arena session reuses it (or falls back to inline if caching is gated).
//   - Session-specific GROUNDING is the first turn — quotes the prospect's
//     actual objection from the portal, instructs the AI to defend it.
//   - takeTurn replays the full conversation history each call. Cheap for short
//     sessions; when sessions get long, swap to thread-based stateful API.

const gemini = require('./gemini');
const personas = require('./personas');
const store = require('./store');
const globalCache = require('./knowledge/globalCache');
const history = require('./arenaHistory');
const userModel = require('./users');
const tenants = require('./tenants');
const entitlements = require('./entitlements');
const usage = require('./usage');

const MAX_TURNS = 24;            // 12 rep ↔ prospect rounds
const MAX_MESSAGE_LEN = 4000;
const DEFAULT_PERSONA = 'skeptical-cfo';

function fmtTime(sec) {
  const m = Math.floor((sec || 0) / 60);
  const s = Math.floor((sec || 0) % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function buildGrounding({ portal, objection, intelligenceText }) {
  const prospect = (portal.participants || []).find((p) => p.role === 'prospect') || {};
  const prospectName = prospect.name || 'the prospect';
  const company = prospect.company || 'their company';

  // When the Knowledge Base has Org Intelligence or Battlecards loaded, paste
  // them inline at the TOP of the grounding so the persona can weaponize them
  // (Gemini only accepts one cachedContent per call and that slot already
  // belongs to the persona character cache — see globalCache.js for context).
  const intelligenceBlock = intelligenceText && intelligenceText.trim().length > 0
    ? [
        `## COMPANY INTELLIGENCE & BATTLECARDS (use these to challenge the rep)`,
        ``,
        intelligenceText.trim(),
        ``,
        `When the rep mentions a competitor named in the BATTLECARDS section, deploy ` +
        `the documented punchlines/objections against them. When you reference ` +
        `policy, escalation, or pricing, defer to the ORG_INTELLIGENCE block — ` +
        `it overrides any generic assumptions you might otherwise make.`,
        ``,
        `---`,
        ``,
      ].join('\n')
    : '';

  // The grounding does three things:
  //   1. Anchors the AI to THIS specific objection from THIS specific call
  //   2. Tells the AI to hold its ground (the rep is practicing, not closing)
  //   3. Tells the AI to open the practice session by restating the objection
  const sessionBlock = [
    `## PRACTICE SESSION CONTEXT`,
    ``,
    `You are picking up where the real call left off. The rep you spoke with is back, alone, asking to practice the objection you raised. Stay fully in character — you are still Sara Chen, CFO. Address them as the rep, not as "the user."`,
    ``,
    `## THE OBJECTION YOU RAISED (verbatim, from the actual call):`,
    `"${objection.quote}"`,
    ``,
    `Category: ${objection.category}`,
    `Time on the original call: ${fmtTime(objection.startSeconds)}–${fmtTime(objection.endSeconds)}`,
    objection.resolved
      ? `On the actual call, the rep gave this response and you accepted it: "${objection.repResponseQuote || '(no quote captured)'}"`
      : `On the actual call, this objection was NOT resolved.`,
    ``,
    `## YOUR JOB IN THIS PRACTICE SESSION`,
    `Hold your ground. Even if you accepted a version of this answer on the real call, you are now stress-testing the rep. Push back harder. Vary your angle each turn. Probe the specifics they didn't justify the first time. Make the rep earn it.`,
    ``,
    `Open this session by restating your objection in your own words (don't copy the verbatim quote — paraphrase). Keep it under three sentences. End with a sharp follow-up question. Wait for the rep's response.`,
  ].join('\n');

  return intelligenceBlock + sessionBlock;
}

async function ensurePersonaCache(personaSlug) {
  const seed = personas[personaSlug];
  if (!seed) throw new Error(`unknown persona: ${personaSlug}`);
  return gemini.getOrCreateCache({
    name: `persona:${personaSlug}`,
    model: seed.model,
    systemInstruction: seed.systemInstruction,
    contents: seed.contents,
    ttlSec: seed.ttlSec,
  });
}

function turnsToContents(turns, includePersonaInline, personaSeed) {
  const contents = [];
  if (includePersonaInline && personaSeed) {
    contents.push(...personaSeed.contents);
  }
  for (const t of turns) {
    if (t.role === 'system' || t.role === 'rep') {
      contents.push({ role: 'user', parts: [{ text: t.content }] });
    } else if (t.role === 'prospect') {
      contents.push({ role: 'model', parts: [{ text: t.content }] });
    }
  }
  return contents;
}

async function callGemini({ cacheRecord, turns, newRepMessage, temperature = 0.85, maxOutputTokens = 600 }) {
  const personaSeed = personas[DEFAULT_PERSONA];
  const includePersonaInline = cacheRecord.mode === 'inline';

  const contents = turnsToContents(turns, includePersonaInline, personaSeed);
  if (newRepMessage) {
    contents.push({ role: 'user', parts: [{ text: newRepMessage }] });
  }

  const config = { temperature, maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } };
  if (cacheRecord.mode === 'cached') {
    config.cachedContent = cacheRecord.cacheName;
  } else if (cacheRecord.systemInstruction) {
    config.systemInstruction = cacheRecord.systemInstruction;
  }

  const ai = gemini.getClient();
  const response = await ai.models.generateContent({
    model: cacheRecord.model,
    contents,
    config,
  });

  return {
    text: response.text,
    usage: response.usageMetadata || null,
    finishReason: response.candidates?.[0]?.finishReason || null,
  };
}

// --- public API ----------------------------------------------------------

async function startSession({ portalId, persona = DEFAULT_PERSONA, repUserId = null }) {
  const portal = await store.getPortal(portalId);
  if (!portal) {
    const err = new Error('portal not found'); err.status = 404; throw err;
  }
  const objection = portal.moments && portal.moments.objection;
  if (!objection) {
    const err = new Error('portal has no objection to roleplay'); err.status = 400; throw err;
  }

  // Attribution for the durable history record. tenant_id flows from the
  // portal's parent meeting (meeting.meta.tenantId); rep_name is the call's
  // rep participant. Both are derived server-side — never trusted from the
  // client — so the anonymous portal practice flow needs no auth.
  const meeting = portal.meetingId ? await store.getMeeting(portal.meetingId) : null;
  const tenantId = (meeting && meeting.meta && meeting.meta.tenantId) ||
    userModel.FOUNDERS_TENANT_ID;
  const repParticipant = (portal.participants || []).find((p) => p.role === 'rep') || {};
  const repName = repParticipant.name || null;

  // Subscription gate — Arena is a Pro feature and requires an active plan. The
  // session is anonymous (portal link), so we gate by the owning tenant.
  const tenant = await tenants.get(tenantId);
  const ent = entitlements.entitlementsFor(tenant);
  if (!ent.active) {
    const err = new Error('This workspace’s subscription is inactive — practice is unavailable.'); err.status = 402; throw err;
  }
  if (!entitlements.hasFeature(ent, 'arena')) {
    const err = new Error('Arena practice is a Pro feature. Ask your admin to upgrade.'); err.status = 402; throw err;
  }
  // Meter the session against the plan's monthly Arena cap (Infinity = no-op for
  // Pro+; Starter gets a limited allowance). consume() throws 402 at the cap.
  await usage.consume(tenantId, 'arena', ent.caps ? ent.caps.arena : 0);

  const cacheRecord = await ensurePersonaCache(persona);

  // Pull Company Intelligence + Battlecards. Returns '' if no ORG_INTELLIGENCE
  // or BATTLECARDS docs are uploaded yet — grounding gracefully degrades.
  let intelligenceText = '';
  try { intelligenceText = await globalCache.getGlobalText(); }
  catch (err) { console.warn('[arena] global cache fetch failed:', err.message); }

  const grounding = buildGrounding({ portal, objection, intelligenceText });

  // Generate the prospect's opening message.
  const opener = await callGemini({
    cacheRecord,
    turns: [{ role: 'system', content: grounding }],
    newRepMessage: null,
    temperature: 0.9,
    maxOutputTokens: 400,
  });

  const turns = [
    { role: 'system', content: grounding, at: new Date().toISOString() },
    { role: 'prospect', content: opener.text, usage: opener.usage, at: new Date().toISOString() },
  ];

  const session = await store.createSession({
    portalId,
    persona,
    objection,
    grounding,
    cacheMode: cacheRecord.mode,
    cacheName: cacheRecord.cacheName || null,
    model: cacheRecord.model,
    turns,
    // Carried on the session so takeTurn can mirror to history without
    // re-deriving tenant/rep on every turn.
    tenantId,
    repName,
    repUserId,
  });

  // Mirror to the durable store. Best-effort: a Postgres hiccup must not break
  // the live practice loop, which runs entirely off Redis.
  try { await history.upsertActive(session); }
  catch (err) { console.warn('[arena] history upsert (start) failed:', err.message); }

  return session;
}

async function takeTurn({ sessionId, message }) {
  if (!message || typeof message !== 'string') {
    const err = new Error('message (string) required'); err.status = 400; throw err;
  }
  if (message.length > MAX_MESSAGE_LEN) {
    const err = new Error(`message too long (max ${MAX_MESSAGE_LEN} chars)`); err.status = 400; throw err;
  }

  const session = await store.getSession(sessionId);
  if (!session) {
    const err = new Error('session not found or expired'); err.status = 404; throw err;
  }
  if ((session.turns || []).length >= MAX_TURNS) {
    const err = new Error(`session turn limit reached (${MAX_TURNS})`); err.status = 409; throw err;
  }

  // Refresh the cache on every turn — getOrCreateCache no-ops if still valid,
  // recreates if expired/invalidated.
  const cacheRecord = await ensurePersonaCache(session.persona);

  const result = await callGemini({
    cacheRecord,
    turns: session.turns,
    newRepMessage: message,
    temperature: 0.85,
    maxOutputTokens: 500,
  });

  const updated = await store.appendSessionTurns(sessionId, [
    { role: 'rep', content: message, at: new Date().toISOString() },
    { role: 'prospect', content: result.text, usage: result.usage, at: new Date().toISOString() },
  ]);

  // Mirror the fresh transcript to the durable store so it survives the 1h TTL
  // even if the rep never explicitly ends the session.
  try { await history.upsertActive(updated); }
  catch (err) { console.warn('[arena] history upsert (turn) failed:', err.message); }

  const userTurns = (updated.turns || []).filter((t) => t.role === 'rep').length;
  return {
    sessionId,
    reply: result.text,
    usage: result.usage,
    mode: cacheRecord.mode,
    turnCount: updated.turns.length,
    maxTurns: MAX_TURNS,
    // True once the rep has used their last allowed exchange — the UI uses
    // this to auto-finalize and surface the scorecard.
    complete: updated.turns.length >= MAX_TURNS,
    repTurns: userTurns,
  };
}

// End a session and produce its coaching scorecard. Idempotent — finalize()
// returns the stored scorecard if the session was already completed. Reads the
// live session from Redis (still present unless the 1h TTL lapsed); falls back
// to whatever transcript was last mirrored to history.
async function endSession({ sessionId }) {
  const session = await store.getSession(sessionId);
  if (!session) {
    const err = new Error('session not found or expired'); err.status = 404; throw err;
  }
  const scorecard = await history.finalize(session, { maxTurns: MAX_TURNS });
  return {
    sessionId,
    status: 'completed',
    scorecard,
  };
}

module.exports = { startSession, takeTurn, endSession, MAX_TURNS };
