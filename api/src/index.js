const express = require('express');
const personas = require('./personas');
const gemini = require('./gemini');
const analysis = require('./analysis');
const recall = require('./recall');
const stream = require('./stream');
const store = require('./store');
const arena = require('./arena');
const auth = require('./auth');
const sampleTranscript = require('./sample-transcript');
const db = require('./db');
const migrate = require('../db/migrate');
const knowledge = require('./knowledge');
const portfolio = require('./portfolio');
const companies = require('./companies');
const missions = require('./missions');
const missionsService = require('./missions/service');
const scheduler = require('./scheduler');
const email = require('./email');
const userModel = require('./users');
const onboarding = require('./onboarding');
const integrations = require('./integrations');

const app = express();
// Capture the raw request body alongside JSON parsing so webhook receivers
// (e.g. Calendly) can verify HMAC signatures over the exact bytes sent.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

const PORT = parseInt(process.env.PORT || '3000', 10);
const APP_BASE_URL =
  process.env.APP_BASE_URL || 'https://ghoststream.exact-it.net';

// =========================================================================
// Health
// =========================================================================

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ghost-api' });
});

// =========================================================================
// Email (SendGrid) — connection status + live verify probe
// =========================================================================

// GET /email/status[?probe=1] — when probe=1, hits SendGrid /v3/scopes to
// validate the API key without sending mail. Behind admin auth so we don't
// leak whether the connection is up to anonymous callers.
app.get('/email/status', auth.authMiddleware, async (req, res, next) => {
  try {
    const probe = req.query.probe === '1' || req.query.probe === 'true';
    res.json(await email.getStatus({ probe }));
  } catch (err) { next(err); }
});

// =========================================================================
// Gemini Context Caching
// =========================================================================

app.get('/gemini/caches', async (_req, res, next) => {
  try {
    res.json({ caches: await gemini.listCachedRecords() });
  } catch (err) { next(err); }
});

app.post('/gemini/caches/persona/:slug', async (req, res, next) => {
  try {
    const seed = personas[req.params.slug];
    if (!seed) return res.status(404).json({ error: 'unknown persona', slug: req.params.slug, available: Object.keys(personas) });
    const record = await gemini.getOrCreateCache({
      name: `persona:${req.params.slug}`,
      model: seed.model,
      systemInstruction: seed.systemInstruction,
      contents: seed.contents,
      ttlSec: seed.ttlSec,
    });
    res.json({ ok: true, cache: record });
  } catch (err) { next(err); }
});

app.post('/gemini/caches', async (req, res, next) => {
  try {
    const { name, model, systemInstruction, contents, ttlSec } = req.body || {};
    if (!name || !systemInstruction) return res.status(400).json({ error: 'name and systemInstruction required' });
    const record = await gemini.getOrCreateCache({
      name,
      model: model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      systemInstruction,
      contents,
      ttlSec,
    });
    res.json({ ok: true, cache: record });
  } catch (err) { next(err); }
});

app.delete('/gemini/caches/:name', async (req, res, next) => {
  try {
    res.json({ ok: await gemini.invalidate(req.params.name), name: req.params.name });
  } catch (err) { next(err); }
});

app.post('/gemini/roleplay/:slug', async (req, res, next) => {
  try {
    const seed = personas[req.params.slug];
    if (!seed) return res.status(404).json({ error: 'unknown persona', slug: req.params.slug });
    const message = req.body && req.body.message;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message (string) required' });
    const cacheRecord = await gemini.getOrCreateCache({
      name: `persona:${req.params.slug}`,
      model: seed.model,
      systemInstruction: seed.systemInstruction,
      contents: seed.contents,
      ttlSec: seed.ttlSec,
    });
    const result = await gemini.generateForRecord({
      record: cacheRecord, message,
      temperature: 0.85, maxOutputTokens: 600,
    });
    res.json({
      persona: req.params.slug,
      reply: result.text,
      usage: result.usage,
      mode: result.mode,
      cacheName: result.cacheName,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// Meetings (Recall.ai bot lifecycle)
// =========================================================================

// POST /meetings  { meetingUrl, botName? }
// Creates a Recall.ai bot that joins the call with real-time transcription.
app.post('/meetings', async (req, res, next) => {
  try {
    const { meetingUrl, botName } = req.body || {};
    if (!meetingUrl) return res.status(400).json({ error: 'meetingUrl required' });

    // Engagement scoping (the per-rep "active profile" Redis key) was retired
    // 2026-05-11 in favour of mission-driven scoping. A meeting's filter
    // context now comes from the linked mission's tags (via meeting.meta.
    // missionId) at analysis time; meetings with no mission run unfiltered.
    const meeting = await store.createMeeting({
      source: 'recall',
      meetingUrl,
      status: 'creating',
      meta: {},
    });

    const webhookUrl = `${APP_BASE_URL}/webhooks/recall`;
    const bot = await recall.createBot({
      meetingUrl, botName,
      webhookUrl,
      metadata: { meetingId: meeting.id, app: 'ghoststream' },
    });

    const updated = await store.updateMeeting(meeting.id, {
      botId: bot.id,
      status: bot.status_changes?.slice(-1)[0]?.code || 'pending',
      meta: { ...meeting.meta, bot },
    });
    res.json({ ok: true, meeting: updated });
  } catch (err) { next(err); }
});

app.get('/meetings/:id', async (req, res, next) => {
  try {
    const m = await store.getMeeting(req.params.id);
    if (!m) return res.status(404).json({ error: 'not found' });
    res.json({ meeting: m });
  } catch (err) { next(err); }
});

// Internal hook: capture calls this after a Recall webhook event so the brain
// (Gemini analysis) runs in the api service that owns the GEMINI_API_KEY.
//
// Failure-mode contract (after 2026-05-14 fix for the lost-transcript bug):
//   1. Persist the transcript BEFORE running any external API call. If Gemini
//      / Stream / R2 dies mid-pipeline the transcript is safe and a re-POST
//      from capture (or a manual replay) finishes the job — capture's signed
//      Recall S3 URLs expire in ~7 days.
//   2. Already-completed meetings (portalId set) short-circuit so Recall's
//      webhook retries don't duplicate the Cloudflare Stream ingest or the
//      portal record.
app.post('/_internal/meetings/:id/process', async (req, res, next) => {
  try {
    const m = await store.getMeeting(req.params.id);
    if (!m) return res.status(404).json({ error: 'meeting not found' });
    const transcript = req.body && req.body.transcript;
    const videoUrl = req.body && req.body.videoUrl;
    if (!transcript) return res.status(400).json({ error: 'transcript required' });

    // Idempotency: capture (or a debugger curl) may re-deliver the same
    // bot.done. If we already built a portal for this meeting, return it
    // instead of re-ingesting the video and re-burning Gemini quota.
    if (m.portalId && m.status === 'done') {
      return res.json({
        ok: true,
        portalId: m.portalId,
        portalUrl: `${APP_BASE_URL}/portal/?id=${m.portalId}`,
        replay: true,
      });
    }

    // STEP 1 — persist the transcript immediately, before any external call.
    // /portals/:id/reanalyze and a future operator-triggered replay both
    // depend on this being durable even when downstream analysis fails.
    await store.updateMeeting(m.id, { transcript, status: 'analyzing' });

    // Engagement scoping comes from the linked mission's tags (if any). The
    // per-rep engagement profile + per-meeting snapshot were both retired
    // 2026-05-11; only mission tags drive retrieval scoping now.
    //
    // 2026-05-14: tenantId now flows from meeting.meta.tenantId (set by
    // dispatch.js when the bot was created) instead of being hardcoded to
    // FOUNDERS. The Founders fallback covers legacy meetings whose meta
    // predates the multitenancy retrofit. Without this fix, every analysis
    // queried the Founders KB instead of the meeting owner's KB → no
    // grounding chunks ever matched. (H4 in the review.)
    const tenantId = (m.meta && m.meta.tenantId) || userModel.FOUNDERS_TENANT_ID;

    let engagementProfile = null;
    let missionCompanyId = (m.meta && m.meta.missionCompanyId) || null;
    if (m.meta && m.meta.missionId) {
      try {
        const mission = await missionsService.get(tenantId, m.meta.missionId);
        if (mission) {
          engagementProfile = missionsService.profileFromMission(mission);
          // H9: dispatch.js used to omit missionCompanyId from meta. Pull
          // it from the mission row so PROSPECT_MEMORY tier retrieval lights
          // up for legacy meetings without needing them to be re-dispatched.
          if (!missionCompanyId && mission.company_id) missionCompanyId = mission.company_id;
        }
      } catch { /* no mission found / db hiccup → run unfiltered */ }
    }

    // STEP 2 — Gemini analysis. If this throws the transcript is still safe.
    let pipeline;
    try {
      pipeline = await analysis.runPipeline(transcript, {
        tenantId,
        engagementProfile,
        currentMissionId: (m.meta && m.meta.missionId) || null,
        missionCompanyId,
      });
    } catch (err) {
      // Surface the failure on the meeting record so operators can see why
      // the portal never showed up, then re-raise for the response.
      await store.updateMeeting(m.id, {
        status: 'analysis_failed',
        analysisError: { message: err.message, at: new Date().toISOString() },
      }).catch(() => { /* best-effort marker; original error still wins */ });
      throw err;
    }

    // STEP 3 — video ingest + clip. Same try/catch story: transcript stays.
    const videoUid = videoUrl ? (await stream.ingestFromUrl(videoUrl, transcript.meetingTitle)).uid : null;
    const objectionClip = videoUid
      ? await stream.createClip({
          videoUid,
          startSeconds: pipeline.moments.objection.startSeconds,
          endSeconds: pipeline.moments.objection.endSeconds,
          label: 'Moment of Truth — Objection',
        })
      : null;

    // STEP 4 — portal + final meeting state. Order matters: createPortal first
    // so we can record the portalId in the same updateMeeting that flips
    // status → 'done'. analysisError is cleared on success in case this was
    // a retry after an earlier Gemini failure.
    const portal = await store.createPortal({
      meetingId: m.id,
      title: transcript.meetingTitle,
      participants: transcript.participants,
      moments: pipeline.moments,
      email: pipeline.email,
      sowSummary: pipeline.sowSummary,
      grounding: pipeline.grounding,
      objectionClip,
      videoUid,
      models: pipeline.models,
      usage: pipeline.usage,
    });
    await store.updateMeeting(m.id, {
      portalId: portal.id,
      status: 'done',
      analysis: pipeline,
      analysisError: null,
    });
    res.json({ ok: true, portalId: portal.id, portalUrl: `${APP_BASE_URL}/portal/?id=${portal.id}` });
  } catch (err) { next(err); }
});

// =========================================================================
// First Loop — full pipeline on the sample 5-minute call
// =========================================================================

app.post('/first-loop', async (req, res, next) => {
  try {
    const transcript = (req.body && req.body.transcript) || sampleTranscript;

    // First-loop is an unauth demo endpoint scoped to the Founders tenant
    // (it exercises the recall.ai → portal flow against the seeded demo KB).
    // Runs unfiltered (no engagement profile, no mission tags).
    const meeting = await store.createMeeting({
      source: 'first-loop',
      meetingUrl: '(mock 5-minute call)',
      status: 'analyzing',
      meta: {
        title: transcript.meetingTitle,
        durationSeconds: transcript.durationSeconds,
      },
    });

    const pipeline = await analysis.runPipeline(transcript, {
      tenantId: userModel.FOUNDERS_TENANT_ID,
      engagementProfile: null,
    });

    // No real video in the First Loop — Stream client returns mock clip with a
    // public demo video URL so the portal page has something to play.
    const ingest = await stream.ingestFromUrl(
      `${APP_BASE_URL}/portal/sample.mp4`,
      transcript.meetingTitle
    );
    const clip = await stream.createClip({
      videoUid: ingest.uid,
      startSeconds: pipeline.moments.objection.startSeconds,
      endSeconds: pipeline.moments.objection.endSeconds,
      label: 'Moment of Truth — Objection',
    });

    const portal = await store.createPortal({
      meetingId: meeting.id,
      title: transcript.meetingTitle,
      participants: transcript.participants,
      moments: pipeline.moments,
      email: pipeline.email,
      sowSummary: pipeline.sowSummary,
      grounding: pipeline.grounding,
      objectionClip: clip,
      videoUid: ingest.uid,
      models: pipeline.models,
      usage: pipeline.usage,
    });

    await store.updateMeeting(meeting.id, {
      portalId: portal.id,
      status: 'done',
      analysis: pipeline,
      transcript,
    });

    res.json({
      ok: true,
      meetingId: meeting.id,
      portalId: portal.id,
      portalUrl: `${APP_BASE_URL}/portal/?id=${portal.id}`,
      pipeline,
    });
  } catch (err) { next(err); }
});

// =========================================================================
// Portals
// =========================================================================

// Portal data is split into two trust tiers:
//   - CUSTOMER tier (no auth): moments+email+sow+grounding citations are
//     visible (these are the customer-facing "Verified" trust signal), but
//     `moments.knowledgeGaps` is stripped — those are internal performance
//     observations and could be a liability if a prospect sees them.
//   - MANAGER tier (valid admin cookie): full payload including gap content.
//
// `audit` is ALWAYS included with the count + a hasHighSeverity flag computed
// server-side. That lets the client gate the "Download Verified SOW" button
// without ever seeing the gap contents — a client-only gate could be
// bypassed by a customer toggling `?view=manager`.
app.get('/portals/:id', async (req, res, next) => {
  try {
    const p = await store.getPortal(req.params.id);
    if (!p) return res.status(404).json({ error: 'portal not found' });

    const allGaps = (p.moments && Array.isArray(p.moments.knowledgeGaps))
      ? p.moments.knowledgeGaps : [];
    const audit = {
      gapCount: allGaps.length,
      hasHighSeverity: allGaps.some(
        (g) => String(g.severity || '').toUpperCase() === 'HIGH'
      ),
    };

    // Anonymous viewers see a stripped meeting ref (no botId / tenantId /
    // missionId) — those are operator metadata, not customer-facing.
    const meeting = meetingRefFromRecord(await store.getMeeting(p.meetingId));
    const claims = auth.verifyToken(auth.tokenFromRequest(req));
    const meetingForViewer = meeting && (claims
      ? meeting
      : {
          id: meeting.id,
          source: meeting.source,
          meetingUrl: meeting.meetingUrl,
          durationSeconds: meeting.durationSeconds,
          createdAt: meeting.createdAt,
        });

    const safe = claims
      ? p
      : { ...p, moments: { ...(p.moments || {}), knowledgeGaps: [] } };

    res.json({
      portal: {
        ...safe,
        meeting: meetingForViewer,
        audit,
        viewerRole: claims ? 'admin' : 'public',
      },
    });
  } catch (err) { next(err); }
});

// =========================================================================
// Arena — roleplay grounded in a portal's actual objection
// =========================================================================

// POST /arena/start  { portalId, persona? }
app.post('/arena/start', async (req, res, next) => {
  try {
    const { portalId, persona } = req.body || {};
    if (!portalId) return res.status(400).json({ error: 'portalId required' });
    const session = await arena.startSession({ portalId, persona });
    res.json({
      ok: true,
      sessionId: session.id,
      session,
      arenaUrl: `${APP_BASE_URL}/arena/?id=${session.id}`,
    });
  } catch (err) { next(err); }
});

// POST /arena/:id/turn  { message }
app.post('/arena/:id/turn', async (req, res, next) => {
  try {
    const result = await arena.takeTurn({
      sessionId: req.params.id,
      message: (req.body && req.body.message) || '',
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /arena/:id
app.get('/arena/:id', async (req, res, next) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found or expired' });
    res.json({ session });
  } catch (err) { next(err); }
});

// =========================================================================
// Admin auth + dashboard
// =========================================================================

app.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const result = await auth.attemptLogin(email, password);
    if (!result) return res.status(401).json({ error: 'invalid credentials' });
    res.cookie(auth.COOKIE_NAME, result.token, auth.cookieOptions());
    res.json({ ok: true, user: result.user });
  } catch (err) { next(err); }
});

app.post('/auth/logout', (_req, res) => {
  res.clearCookie(auth.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/auth/me', auth.authMiddleware, (req, res) => {
  res.json({
    user: {
      id: req.user.sub,
      email: req.user.email,
      role: req.user.role,
      tenantId: req.user.tid,
      isAdmin: !!req.user.adm,
    },
  });
});

// The caller's own tenant — name / domain / subscription. Drives the
// "Company Profile" view in the admin UI (the company whose intel lives under
// scope=TENANT in the Knowledge Base).
app.get('/tenant', auth.authMiddleware, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, name, domain, subscription_status, trial_ends_at, created_at, updated_at
         FROM tenants WHERE id = $1`,
      [req.tenantId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'tenant not found' });
    res.json({ tenant: r.rows[0] });
  } catch (err) { next(err); }
});

app.get('/admin/overview', auth.authMiddleware, async (_req, res, next) => {
  try {
    const [counts, cachesList] = await Promise.all([
      store.getCounts(),
      gemini.listCachedRecords(),
    ]);
    res.json({
      counts: { ...counts, caches: cachesList.length },
      caches: {
        total: cachesList.length,
        cached: cachesList.filter((c) => c.mode === 'cached').length,
        inline: cachesList.filter((c) => c.mode === 'inline').length,
      },
      env: {
        analysisModel: process.env.GEMINI_ANALYSIS_MODEL || null,
        contentModel: process.env.GEMINI_CONTENT_MODEL || null,
        roleplayModel: process.env.GEMINI_MODEL || null,
        recallRegion: recall.region,
        streamConfigured: stream.isConfigured(),
        appBaseUrl: APP_BASE_URL,
      },
    });
  } catch (err) { next(err); }
});

// Compact reference to the meeting that produced a portal. Surfaces in
// /admin/portals rows and on /portals/:id so the portal viewer + admin
// table can show "From meeting m_xxxx, recorded YYYY-MM-DD, mm:ss long"
// without a second round-trip per portal.
function meetingRefFromRecord(m) {
  if (!m) return null;
  return {
    id: m.id,
    source: m.source || null,
    meetingUrl: m.meetingUrl || null,
    botId: m.botId || null,
    status: m.status || null,
    missionId: (m.meta && m.meta.missionId) || null,
    tenantId: (m.meta && m.meta.tenantId) || null,
    durationSeconds: (m.transcript && m.transcript.durationSeconds) || null,
    createdAt: m.createdAt || null,
  };
}

app.get('/admin/portals', auth.authMiddleware, async (_req, res, next) => {
  try {
    const portals = await store.listPortals(100);
    // Batched MGET avoids N+1 — one Redis call for all parent meetings.
    const meetings = await store.getMeetingsByIds(portals.map((p) => p.meetingId));
    const enriched = portals.map((p) => ({
      ...p,
      meeting: meetingRefFromRecord(meetings.get(p.meetingId)),
    }));
    res.json({ portals: enriched });
  } catch (err) { next(err); }
});

app.get('/admin/sessions', auth.authMiddleware, async (_req, res, next) => {
  try { res.json({ sessions: await store.listSessions(100) }); }
  catch (err) { next(err); }
});

app.get('/admin/meetings', auth.authMiddleware, async (_req, res, next) => {
  try { res.json({ meetings: await store.listMeetings(100) }); }
  catch (err) { next(err); }
});

// Platform-superadmin only — list of all tenants. Used by the KB upload
// form's "Tenant" picker so a Founders admin can do concierge KB setup.
app.get('/tenants', auth.authMiddleware, auth.requireSuperadmin, async (_req, res, next) => {
  try {
    const r = await db.query(
      `SELECT id, name, domain, subscription_status, created_at FROM tenants ORDER BY created_at`
    );
    res.json({ tenants: r.rows });
  } catch (err) { next(err); }
});

app.get('/admin/caches', auth.authMiddleware, async (_req, res, next) => {
  try { res.json({ caches: await gemini.listCachedRecords() }); }
  catch (err) { next(err); }
});

// =========================================================================
// Engagement scoping — the per-rep "active profile" page was retired
// 2026-05-11. Mission-driven scoping is the only mechanism: a mission's tags
// drive its brief; a portal can still be re-scoped manually by a manager via
// the override endpoint below. /engagement/me (GET/PUT/DELETE) is gone.
// =========================================================================

// Sanitize an engagement-profile payload into the array shape the retrieval
// layer expects. Used by the portal-override endpoint and by reanalyze.
function sanitizeEngagementPayload(input) {
  const arr = (v) => Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, 32)
    : (typeof v === 'string' && v.trim() ? [v.trim()] : []);
  const p = input || {};
  return {
    productIds:    arr(p.productIds    !== undefined ? p.productIds    : p.productId),
    personaIds:    arr(p.personaIds    !== undefined ? p.personaIds    : p.personaId),
    competitorIds: arr(p.competitorIds !== undefined ? p.competitorIds : p.competitorId),
    industry:      typeof p.industry === 'string' ? p.industry : null,
    updatedAt:     new Date().toISOString(),
  };
}

// Per-portal override. Manager triages a portal and rescopes the engagement
// without changing anything else. Stored on the portal record itself.
app.put('/portals/:id/engagement', auth.authMiddleware, async (req, res, next) => {
  try {
    const p = await store.getPortal(req.params.id);
    if (!p) return res.status(404).json({ error: 'portal not found' });
    const profile = sanitizeEngagementPayload(req.body || {});
    p.engagement = profile;
    // Re-save the whole portal record via setJson-style overwrite.
    const redis = require('./redis');
    await redis.set(`portal:${p.id}`, JSON.stringify(p));
    res.json({ ok: true, engagement: profile });
  } catch (err) { next(err); }
});

// Re-run the analysis pipeline against the stored transcript with an
// optional new engagement profile. Replaces moments/email/sow/grounding on
// the portal record. Requires that the meeting's transcript was persisted
// — fixture portals (inserted directly into Redis) won't have one and the
// endpoint refuses with 422.
app.post('/portals/:id/reanalyze', auth.authMiddleware, async (req, res, next) => {
  try {
    const p = await store.getPortal(req.params.id);
    if (!p) return res.status(404).json({ error: 'portal not found' });
    const meeting = p.meetingId ? await store.getMeeting(p.meetingId) : null;
    const transcript = meeting && meeting.transcript;
    if (!transcript) {
      return res.status(422).json({
        error: 'no transcript on file for this portal — reanalyze is only available for portals created from real call ingestion',
      });
    }

    // 2026-05-14: tenantId now flows from meeting.meta.tenantId. See the
    // matching fix in /_internal/meetings/:id/process for the why. Founders
    // remains a last-resort fallback for legacy meetings (H4 in the review).
    const tenantId = (meeting.meta && meeting.meta.tenantId) || userModel.FOUNDERS_TENANT_ID;

    // Profile precedence:
    //   1. explicit body.engagementProfile (manager re-scopes mid-review)
    //   2. portal.engagement (prior manager override)
    //   3. linked mission's tags (the snapshot that drove the original brief)
    //   4. null (run unfiltered)
    let engagementProfile =
      (req.body && req.body.engagementProfile && sanitizeEngagementPayload(req.body.engagementProfile)) ||
      (p.engagement && sanitizeEngagementPayload(p.engagement)) ||
      null;
    let missionCompanyId = (meeting.meta && meeting.meta.missionCompanyId) || null;
    if (meeting.meta && meeting.meta.missionId) {
      try {
        const mission = await missionsService.get(tenantId, meeting.meta.missionId);
        if (mission) {
          if (!engagementProfile) engagementProfile = missionsService.profileFromMission(mission);
          // H9 backfill: pull company id from the mission row when the
          // meeting was dispatched before missionCompanyId was added to meta.
          if (!missionCompanyId && mission.company_id) missionCompanyId = mission.company_id;
        }
      } catch { /* mission gone → run unfiltered */ }
    }

    const pipeline = await analysis.runPipeline(transcript, {
      tenantId,
      engagementProfile,
      currentMissionId: (meeting.meta && meeting.meta.missionId) || null,
      missionCompanyId,
    });

    // Merge new analysis onto the portal record. Keep the original id,
    // createdAt, video clip — replace the AI-generated fields.
    p.moments    = pipeline.moments;
    p.email      = pipeline.email;
    p.sowSummary = pipeline.sowSummary;
    p.grounding  = pipeline.grounding;
    p.models     = pipeline.models;
    p.usage      = pipeline.usage;
    p.reanalyzedAt = new Date().toISOString();
    p.engagement = engagementProfile || null;

    const redis = require('./redis');
    await redis.set(`portal:${p.id}`, JSON.stringify(p));
    res.json({ ok: true, portal: p });
  } catch (err) { next(err); }
});

// =========================================================================
// Portfolio Manager — Products / Personas / Competitors CRUD.
// =========================================================================

app.use('/portfolio', auth.authMiddleware, portfolio.router);

// =========================================================================
// Companies + Missions (sales scheduler).
// =========================================================================

app.use('/companies', auth.authMiddleware, companies.router);
app.use('/missions',  auth.authMiddleware, missions.router);

// =========================================================================
// Knowledge Base — Dynamic Context Layer (RAG over Postgres + pgvector)
// =========================================================================

app.use('/knowledge', auth.authMiddleware, knowledge.router);

// =========================================================================
// Free-trial onboarding — PUBLIC (no auth; these endpoints are how a
// not-yet-customer creates their tenant + first user).
// =========================================================================

app.use('/onboarding', onboarding.router);

// =========================================================================
// Calendar integrations — status/connect endpoints (admin Integrations page)
// + the Calendly webhook receiver (auto-creates a mission on `invitee.created`).
// =========================================================================

// OAuth callbacks (Nylas, Calendly) are hit by the provider redirecting the
// browser; they authenticate via the short-lived `state` token (Redis), not
// the session cookie — so they must sit BEFORE the authMiddleware-protected
// router below.
app.get('/integrations/calendar/callback', integrations.handleCalendarCallback);
app.get('/integrations/calendly/callback', integrations.handleCalendlyCallback);
app.use('/integrations', auth.authMiddleware, integrations.router);

// PUBLIC (Calendly calls it) — signature-verified. "Internal use" booking
// links land on the Founders tenant for now, consistent with the recall.ai
// Phase-1 scoping. Multi-tenant routing of inbound bookings is a follow-on
// (would key off which Calendly org/account the webhook came from).
app.post('/webhooks/calendly', async (req, res) => {
  try {
    if (!integrations.isConfigured('calendly')) {
      return res.status(503).json({ error: 'Calendly not configured (set CALENDLY_WEBHOOK_SIGNING_KEY)' });
    }
    const sig = req.get('Calendly-Webhook-Signature') || '';
    if (!integrations.verifyCalendlyWebhook(req.rawBody, sig)) {
      return res.status(401).json({ error: 'invalid signature' });
    }
    const ev = req.body || {};
    if (ev.event !== 'invitee.created') {
      return res.json({ ok: true, ignored: ev.event || null });
    }
    const fields = integrations.missionFromCalendlyEvent(ev.payload || {});
    if (!fields) {
      return res.status(422).json({ error: 'could not map the Calendly payload to a mission (missing start time?)' });
    }
    // Resolve Calendly's google_meet/zoom redirect page to the canonical
    // meet.google.com / zoom.us URL so Recall.ai can dispatch a bot. Best-
    // effort — falls through to the original URL if Calendly's redirect is
    // unreachable.
    if (fields.meetingUrl) {
      try { fields.meetingUrl = await integrations.resolveMeetingUrl(fields.meetingUrl); }
      catch (e) { console.warn('[calendly-webhook] resolveMeetingUrl failed:', e.message); }
    }
    const mission = await missionsService.schedule(userModel.FOUNDERS_TENANT_ID, fields);
    res.json({ ok: true, missionId: mission.id });
  } catch (err) {
    console.error('[calendly-webhook]', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

// =========================================================================
// Error handler
// =========================================================================

app.use((err, _req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({ error: err.message, code: err.code || null });
});

async function boot() {
  // Run pending migrations BEFORE binding the listener so the schema is at
  // HEAD when the first request lands. Migration failures abort startup —
  // serving requests against a half-migrated schema is worse than downtime.
  try {
    await migrate.run();
    const ok = await db.ping();
    if (!ok) throw new Error('postgres ping returned non-1');
    console.log('[boot] postgres ready');
  } catch (err) {
    console.error('[boot] database init failed:', err.message);
    process.exit(1);
  }

  // Ensure the Founders-tenant admin exists / is in sync with ADMIN_PASSWORD.
  // Non-fatal: if it fails (e.g. ADMIN_* unset), the app still boots — login
  // just won't work until a user row exists.
  try { await userModel.bootstrapFoundersAdmin(); }
  catch (err) { console.error('[boot] founders admin bootstrap failed:', err.message); }

  // Start the T-24h mission-brief cron. Safe to call before listen() —
  // node-cron just registers the schedule, doesn't block.
  try { scheduler.start(); }
  catch (err) { console.error('[boot] scheduler start failed:', err.message); }

  app.listen(PORT, () => {
    console.log(
      `ghost-api listening on :${PORT} ` +
      `(roleplay=${process.env.GEMINI_MODEL || 'gemini-2.5-flash'}, ` +
      `analysis=${process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-pro'}, ` +
      `content=${process.env.GEMINI_CONTENT_MODEL || 'gemini-2.5-flash'}, ` +
      `embedding=${process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004'}, ` +
      `recall=${recall.region}, ` +
      `stream=${stream.isConfigured() ? 'live' : 'mock'})`
    );
  });
}

boot();
