// Arena session history + AI coaching scorecard — the durable counterpart to
// the ephemeral Redis sessions in store.js.
//
// Lifecycle:
//   start  → upsertActive()  inserts an `active` row
//   turn   → upsertActive()  refreshes turns/turn_count (survives the 1h TTL)
//   end    → finalize()      scores the transcript, marks `completed`
//   stale  → reconcileStale() flips long-idle `active` rows to `abandoned`
//
// Scoring is a single Gemini call that grades the rep against a fixed rubric.
// It is best-effort: if the model call or JSON parse fails, the session still
// finalizes with a scorecard that records the error, so a row is never stuck
// in `active` because the LLM hiccuped.

const db = require('./db');
const gemini = require('./gemini');
const { modelFor } = require('./models');

// Fixed coaching rubric. Dimension maxes sum to 100 = the overall score.
const DIMENSIONS = [
  { key: 'discovery', label: 'Discovery',         max: 25 },
  { key: 'objection', label: 'Objection handling', max: 30 },
  { key: 'tone',      label: 'Tone',               max: 20 },
  { key: 'close',     label: 'Close',              max: 25 },
];

const STALE_AFTER = "interval '1 hour'"; // matches the Redis session TTL

function repTurnCount(turns) {
  return (turns || []).filter((t) => t.role === 'rep').length;
}

// Insert on start; update turns/turn_count on every subsequent turn. Tenant and
// rep attribution are written once (on insert) and never overwritten — they
// live on the session record (set in arena.startSession) so we don't re-derive
// them per turn.
async function upsertActive(session) {
  if (!session || !session.id || !session.tenantId) return;
  await db.query(
    `INSERT INTO arena_sessions
       (id, tenant_id, portal_id, persona, rep_name, rep_user_id,
        status, objection, turns, turn_count, model, cache_mode, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$10,$11, now())
     ON CONFLICT (id) DO UPDATE SET
       turns      = EXCLUDED.turns,
       turn_count = EXCLUDED.turn_count,
       updated_at = now()
     WHERE arena_sessions.status = 'active'`,
    [
      session.id,
      session.tenantId,
      session.portalId,
      session.persona,
      session.repName || null,
      session.repUserId || null,
      JSON.stringify(session.objection || null),
      JSON.stringify(session.turns || []),
      repTurnCount(session.turns),
      session.model || null,
      session.cacheMode || null,
    ]
  );
}

// Transcript → "REP:/PROSPECT:" plain text, skipping the internal grounding.
function transcriptText(turns) {
  return (turns || [])
    .filter((t) => t.role === 'rep' || t.role === 'prospect')
    .map((t) => `${t.role === 'rep' ? 'REP' : 'PROSPECT'}: ${t.content}`)
    .join('\n\n');
}

function clampScore(n, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, Math.round(v)));
}

// Build a scorecard for a finished session. Returns the JSON we persist.
async function scoreSession(session) {
  const turns = session.turns || [];
  const repTurns = repTurnCount(turns);
  // Nothing to grade — the rep never responded. Skip the LLM call.
  if (repTurns === 0) {
    return { overall: null, incomplete: true, dimensions: [],
             feedback: 'No rep responses to evaluate.' };
  }

  const rubric = DIMENSIONS
    .map((d) => `- ${d.key} ("${d.label}", out of ${d.max})`)
    .join('\n');

  const prompt = [
    'You are a sales coach grading a rep\'s objection-handling practice session.',
    'The PROSPECT is an AI playing a skeptical buyer; grade only the REP.',
    '',
    'Score each rubric dimension on its own scale (higher = better):',
    rubric,
    '',
    'Return ONLY valid JSON, no markdown, in exactly this shape:',
    '{',
    '  "dimensions": { "discovery": {"score": <int>, "note": "<one sentence>"},',
    '                  "objection": {"score": <int>, "note": "..."},',
    '                  "tone": {"score": <int>, "note": "..."},',
    '                  "close": {"score": <int>, "note": "..."} },',
    '  "feedback": "<2-3 sentence overall coaching summary>",',
    '  "strengths": ["<short>", "..."],',
    '  "improvements": ["<short>", "..."]',
    '}',
    '',
    '--- TRANSCRIPT ---',
    transcriptText(turns),
  ].join('\n');

  const model = session.model || modelFor('personas');
  const ai = gemini.getClient();
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      temperature: 0.4,
      maxOutputTokens: 900,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse((response.text || '').trim());
  } catch {
    // Last-ditch: pull the first {...} block out of the response.
    const m = (response.text || '').match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  const dims = parsed.dimensions || {};
  const dimensions = DIMENSIONS.map((d) => ({
    key: d.key,
    name: d.label,
    max: d.max,
    score: clampScore(dims[d.key] && dims[d.key].score, d.max),
    note: (dims[d.key] && String(dims[d.key].note || '')) || '',
  }));
  const overall = dimensions.reduce((sum, d) => sum + d.score, 0);

  return {
    overall,
    dimensions,
    feedback: String(parsed.feedback || ''),
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    improvements: Array.isArray(parsed.improvements) ? parsed.improvements.map(String) : [],
  };
}

// Finalize a session: score it, mark completed. `endReason` is inferred from
// the turn count when not given (hit the limit → max_turns, else rep_ended).
// Idempotent — re-finalizing an already-completed session is a no-op that
// returns the stored scorecard.
async function finalize(session, { endReason, maxTurns } = {}) {
  if (!session || !session.id) return null;

  const existing = await db.query(
    'SELECT scorecard, status FROM arena_sessions WHERE id = $1 AND tenant_id = $2',
    [session.id, session.tenantId]
  );
  if (existing.rows[0] && existing.rows[0].status === 'completed') {
    return existing.rows[0].scorecard;
  }

  // Make sure the latest transcript is on the row before we grade it.
  await upsertActive(session);

  let scorecard;
  try {
    scorecard = await scoreSession(session);
  } catch (err) {
    console.warn('[arenaHistory] scoring failed:', err.message);
    scorecard = { overall: null, error: 'scoring_failed', dimensions: [],
                  feedback: 'Scorecard could not be generated.' };
  }

  const reason = endReason ||
    ((maxTurns && (session.turns || []).length >= maxTurns) ? 'max_turns' : 'rep_ended');

  await db.query(
    `UPDATE arena_sessions
        SET status = 'completed', scorecard = $1, end_reason = $2,
            ended_at = now(), updated_at = now()
      WHERE id = $3 AND tenant_id = $4 AND status <> 'completed'`,
    [JSON.stringify(scorecard), reason, session.id, session.tenantId]
  );
  return scorecard;
}

// Flip `active` rows that have been idle past the Redis TTL to `abandoned`.
// Cheap write-on-read so the history list never shows perpetually-"active"
// ghosts from reps who walked away mid-session. No scoring for these.
async function reconcileStale(tenantId) {
  await db.query(
    `UPDATE arena_sessions
        SET status = 'abandoned', end_reason = 'abandoned', updated_at = updated_at
      WHERE tenant_id = $1 AND status = 'active'
        AND updated_at < now() - ${STALE_AFTER}`,
    [tenantId]
  );
}

// List rows for the admin history page. Tenant-scoped (data firewall). Light
// projection — no transcript blob.
async function listForTenant(tenantId, { limit = 100, rep, status } = {}) {
  await reconcileStale(tenantId);
  const params = [tenantId];
  let where = 'tenant_id = $1';
  if (rep) { params.push(rep); where += ` AND rep_name = $${params.length}`; }
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));

  const r = await db.query(
    `SELECT id, portal_id, persona, rep_name, status, turn_count,
            objection, scorecard, started_at, ended_at, end_reason
       FROM arena_sessions
      WHERE ${where}
      ORDER BY started_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows.map(rowToListItem);
}

function rowToListItem(row) {
  const sc = row.scorecard || null;
  return {
    id: row.id,
    portalId: row.portal_id,
    persona: row.persona,
    repName: row.rep_name,
    status: row.status,
    turnCount: row.turn_count,
    objectionCategory: (row.objection && row.objection.category) || null,
    score: sc && typeof sc.overall === 'number' ? sc.overall : null,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    durationSeconds: row.ended_at
      ? Math.round((new Date(row.ended_at) - new Date(row.started_at)) / 1000)
      : null,
  };
}

// Full detail — transcript + scorecard — for the drill-down view.
async function getOne(tenantId, id) {
  const r = await db.query(
    `SELECT id, portal_id, persona, rep_name, rep_user_id, status, turn_count,
            objection, turns, scorecard, model, cache_mode,
            started_at, ended_at, end_reason
       FROM arena_sessions
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    portalId: row.portal_id,
    persona: row.persona,
    repName: row.rep_name,
    repUserId: row.rep_user_id,
    status: row.status,
    turnCount: row.turn_count,
    objection: row.objection,
    // Strip the internal grounding turn from what we hand the UI.
    turns: (row.turns || []).filter((t) => t.role !== 'system'),
    scorecard: row.scorecard,
    model: row.model,
    cacheMode: row.cache_mode,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

module.exports = { upsertActive, finalize, listForTenant, getOne, scoreSession, DIMENSIONS };
