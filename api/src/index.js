const express = require('express');
const personas = require('./personas');
const gemini = require('./gemini');
const analysis = require('./analysis');
const recall = require('./recall');
const stream = require('./stream');
const store = require('./store');
const arena = require('./arena');
const arenaHistory = require('./arenaHistory');
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
const authTokens = require('./auth-tokens');
const plans = require('./plans');
const gating = require('./gating');
const billing = require('./billing');
const entitlements = require('./entitlements');
const credits = require('./credits');
const devices = require('./devices');
const loginGuard = require('./loginGuard');
const sessions = require('./sessions');
const audit = require('./audit');
const erasure = require('./erasure');
const platformAdmin = require('./platformAdmin');
const tenants = require('./tenants');
const watch = require('./watch');

const app = express();

// This service serves ONLY dynamic, per-user JSON (static assets are served by
// the nginx proxy). Express's default ETag makes these responses conditionally
// cacheable, so a browser reload revalidates and the server answers
// `304 Not Modified` with an EMPTY body — which the SPA's fetch() then renders
// as blank, e.g. a battlecard that "appears once then loses its content on
// refresh". Disable ETag and mark every response no-store so each load gets a
// fresh 200 with a body.
app.set('etag', false);
app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Capture the raw request body alongside JSON parsing so webhook receivers
// (e.g. Calendly) can verify HMAC signatures over the exact bytes sent.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Subscription gate (global): attaches req.entitlements for authenticated
// callers and enforces read-only when the subscription is inactive. Public and
// PAT-authenticated requests pass through (see gating.js).
app.use(gating.billingGate);

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

// Gemini context-cache management is a platform-admin operation (the UI for it
// was retired); require a superadmin session rather than leaving it open.
app.get('/gemini/caches', auth.authMiddleware, auth.requireSuperadmin, async (_req, res, next) => {
  try {
    res.json({ caches: await gemini.listCachedRecords() });
  } catch (err) { next(err); }
});

app.post('/gemini/caches/persona/:slug', auth.authMiddleware, auth.requireSuperadmin, async (req, res, next) => {
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

app.post('/gemini/caches', auth.authMiddleware, auth.requireSuperadmin, async (req, res, next) => {
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

app.delete('/gemini/caches/:name', auth.authMiddleware, auth.requireSuperadmin, async (req, res, next) => {
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
    const missionId = (m.meta && m.meta.missionId) || null;

    let engagementProfile = null;
    let missionCompanyId = (m.meta && m.meta.missionCompanyId) || null;
    if (missionId) {
      try {
        let mission = await missionsService.get(tenantId, missionId);
        if (mission) {
          // Last-chance brief generation: if the mission still PENDING by the
          // time the call has finished, the pre-call pipeline never ran (cron
          // missed it / same-day booking outside the (now+23h, now+25h] window
          // / Gemini outage at brief time). Generate synchronously now so the
          // Stage-1 analysis prompt has the predictions to compare against
          // (the brief→analysis pass-through in analysis.js#runPipeline will
          // pick up the freshly-written pre_call_briefs row).
          if (mission.status === 'PENDING') {
            try {
              const brief = require('./missions/brief');
              console.log(`[process] mission ${missionId} still PENDING at bot.done — generating brief synchronously`);
              await brief.generate(missionId, tenantId);
              mission = await missionsService.get(tenantId, missionId) || mission;
            } catch (err) {
              // brief.generate already records setBriefError. Proceed without
              // the brief — analysis still runs (KB-only), and the operator
              // sees the failure on the mission detail panel.
              console.warn(`[process] last-chance brief generation failed for mission ${missionId}: ${err.message}`);
            }
          }
          engagementProfile = missionsService.profileFromMission(mission);
          // H9: dispatch.js used to omit missionCompanyId from meta. Pull
          // it from the mission row so PROSPECT_MEMORY tier retrieval lights
          // up for legacy meetings without needing them to be re-dispatched.
          if (!missionCompanyId && mission.company_id) missionCompanyId = mission.company_id;
        }
      } catch { /* no mission found / db hiccup → run unfiltered */ }
    } else {
      // Manual `POST /meetings` (e.g. paste-a-Zoom-link) creates a meeting
      // with no mission link, so no brief is ever generated and analysis
      // runs against the tenant's KB without engagement scope. Intentional,
      // but worth flagging so operators can audit how often this path fires.
      console.warn(`[process] orphan-meeting: meeting ${m.id} has no missionId — running analysis without a brief or engagement profile`);
    }

    // STEP 2 — Gemini analysis. If this throws the transcript is still safe.
    let pipeline;
    try {
      pipeline = await analysis.runPipeline(transcript, {
        tenantId,
        engagementProfile,
        currentMissionId: missionId,
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
    // Close the loop: a linked engagement becomes COMPLETED and learns its
    // portal_id, so the Engagements → Past tab can surface this recording.
    // Best-effort — must never fail the webhook pipeline.
    if (missionId) {
      try { await missionsService.markCompleted(tenantId, missionId, portal.id); }
      catch (e) { console.warn('[process] markCompleted failed:', (e && e.message) || e); }
    }
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
// optionalAuth: the portal practice flow is usually anonymous, but when a
// logged-in user launches a session we capture their id for per-rep coaching.
app.post('/arena/start', auth.optionalAuth, async (req, res, next) => {
  try {
    const { portalId, persona } = req.body || {};
    if (!portalId) return res.status(400).json({ error: 'portalId required' });
    const repUserId = (req.user && req.user.sub) || null;
    const session = await arena.startSession({ portalId, persona, repUserId });
    res.json({
      ok: true,
      sessionId: session.id,
      session,
      arenaUrl: `${APP_BASE_URL}/arena/?id=${session.id}`,
    });
  } catch (err) { next(err); }
});

// POST /arena/:id/end — finalize the session and return its coaching scorecard.
app.post('/arena/:id/end', async (req, res, next) => {
  try {
    const result = await arena.endSession({ sessionId: req.params.id });
    res.json(result);
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

// Issue the session cookie + standard login response for a verified user.
function grantSession(res, publicUser) {
  res.cookie(auth.COOKIE_NAME, auth.signToken(publicUser), auth.cookieOptions());
  res.json({ ok: true, user: publicUser });
}

app.post('/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    // Brute-force guard: block (and don't even check the password) once the
    // per-account or per-IP failure budget is spent.
    const gate = await loginGuard.check(req, email);
    if (gate.locked) {
      res.set('Retry-After', String(gate.retryAfter));
      audit.log({ req, action: 'auth.login.locked', result: 'failure', actorEmail: email, meta: { scope: gate.scope } });
      return res.status(429).json({ error: 'Too many failed sign-in attempts. Try again later.' });
    }

    const user = await auth.verifyCredentials(email, password);
    if (!user) {
      await loginGuard.recordFailure(req, email);
      audit.log({ req, action: 'auth.login.failure', result: 'failure', actorEmail: email });
      return res.status(401).json({ error: 'invalid credentials' });
    }
    await loginGuard.clear(email); // correct password — reset the account counter

    // Suspended org → refuse the session entirely (true lockout).
    const loginTenant = await tenants.get(user.tenantId);
    if (loginTenant && loginTenant.suspended_at) {
      audit.log({ req, action: 'auth.login.suspended', result: 'failure', actorUserId: user.id, actorEmail: user.email, tenantId: user.tenantId });
      return res.status(403).json({ error: 'This organization has been suspended.', code: 'TENANT_SUSPENDED' });
    }

    // New-device check: trusted device → straight in; otherwise email a code and
    // hold the session until /auth/verify-device. (Password is already correct,
    // so a challenge is never created for an unknown/wrong account.)
    const fp = devices.deviceFingerprint(req, user.id);
    if (await devices.isTrusted(user.id, fp.hash)) {
      await userModel.touchLogin(user.id);
      audit.log({ req, action: 'auth.login.success', result: 'success', actorUserId: user.id, actorEmail: user.email, tenantId: user.tenantId, meta: { trustedDevice: true } });
      return grantSession(res, user);
    }

    const ch = await devices.createChallenge({ userId: user.id, email: user.email, fp });
    if (ch.throttled) {
      return res.status(429).json({ error: 'Too many codes requested. Wait a few minutes and try again.' });
    }
    const sent = await devices.sendOtpEmail(user.email, ch.code);
    audit.log({ req, action: 'auth.login.otp_required', actorUserId: user.id, actorEmail: user.email, tenantId: user.tenantId });
    return res.status(202).json({
      code: 'OTP_REQUIRED',
      challengeId: ch.challengeId,
      emailHint: devices.emailHint(user.email),
      ...(sent ? {} : { devCode: ch.code }), // dev fallback when email unconfigured
    });
  } catch (err) { next(err); }
});

// Complete a new-device login by submitting the emailed code.
app.post('/auth/verify-device', async (req, res, next) => {
  try {
    const { challengeId, code, trust } = req.body || {};
    const result = await devices.verifyChallenge(challengeId, code, req);
    if (!result.ok) {
      if (result.reason === 'bad_code') {
        return res.status(401).json({ error: 'Incorrect code.', attemptsLeft: result.attemptsLeft });
      }
      if (result.reason === 'too_many') {
        return res.status(429).json({ error: 'Too many attempts. Start over and request a new code.' });
      }
      if (result.reason === 'wrong_device') {
        return res.status(400).json({ error: 'This code was issued for a different device or network.' });
      }
      return res.status(410).json({ error: 'This code has expired. Request a new one.' });
    }
    // Re-load the user fresh (name/role may have changed; also confirms still exists).
    const u = await userModel.findById(result.userId);
    if (!u) return res.status(401).json({ error: 'account not found' });
    const vdTenant = await tenants.get(u.tenantId);
    if (vdTenant && vdTenant.suspended_at) {
      return res.status(403).json({ error: 'This organization has been suspended.', code: 'TENANT_SUSPENDED' });
    }
    if (trust) {
      await devices.trustDevice(u.id, result.fp);
      audit.log({ req, action: 'auth.device.trusted', result: 'success', actorUserId: u.id, actorEmail: u.email, tenantId: u.tenantId });
    }
    await userModel.touchLogin(u.id);
    audit.log({ req, action: 'auth.login.success', result: 'success', actorUserId: u.id, actorEmail: u.email, tenantId: u.tenantId, meta: { viaOtp: true } });
    return grantSession(res, {
      id: u.id, tenantId: u.tenantId, email: u.email,
      name: u.name, role: u.role, isAdmin: u.isAdmin, emailVerified: u.emailVerified,
    });
  } catch (err) { next(err); }
});

// Re-send the code for an in-flight challenge.
app.post('/auth/resend-otp', async (req, res, next) => {
  try {
    const { challengeId } = req.body || {};
    const r = await devices.refreshChallenge(challengeId);
    if (r.throttled) return res.status(429).json({ error: 'Too many codes requested. Wait a few minutes.' });
    if (!r.ok) return res.status(410).json({ error: 'This sign-in attempt has expired. Start over.' });
    await devices.sendOtpEmail(r.email, r.code);
    return res.json({ ok: true });
  } catch (err) { next(err); }
});

app.post('/auth/logout', async (_req, res) => {
  // Revoke this exact session server-side (a copied token can't outlive logout),
  // not just clear the client cookie.
  try {
    const claims = auth.verifyToken(auth.tokenFromRequest(_req));
    if (claims) {
      await sessions.denyToken(claims);
      audit.log({ req: _req, action: 'auth.logout', result: 'success', actorUserId: claims.sub, actorEmail: claims.email, tenantId: claims.tid });
    }
  } catch { /* best-effort */ }
  res.clearCookie(auth.COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// Sign out of every session everywhere (invalidates all of this user's tokens).
app.post('/auth/sessions/revoke-all', auth.authMiddleware, async (req, res, next) => {
  try {
    await sessions.revokeAllForUser(req.user.sub);
    audit.log({ req, action: 'auth.sessions.revoked_all', result: 'success', actorUserId: req.user.sub, actorEmail: req.user.email, tenantId: req.user.tid });
    res.clearCookie(auth.COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Security audit log (superadmin). ?tenant=<id> scopes to one tenant; omit for
// the cross-tenant view. ?limit caps the page (default 100, max 500).
app.get('/admin/audit', auth.authMiddleware, auth.requireSuperadmin, async (req, res, next) => {
  try {
    res.json({ events: await audit.recent({ tenantId: req.query.tenant || null, limit: req.query.limit }) });
  } catch (err) { next(err); }
});

// Trusted devices — list + revoke (lost-laptop kill switch). Behind authMiddleware.
app.get('/auth/devices', auth.authMiddleware, async (req, res, next) => {
  try {
    const fp = devices.deviceFingerprint(req, req.user.sub);
    res.json({ devices: await devices.listDevices(req.user.sub, fp.hash) });
  } catch (err) { next(err); }
});

app.delete('/auth/devices/:id', auth.authMiddleware, async (req, res, next) => {
  try {
    const ok = await devices.revokeDevice(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'device not found' });
    audit.log({ req, action: 'auth.device.revoked', result: 'success', actorUserId: req.user.sub, actorEmail: req.user.email, tenantId: req.user.tid, target: req.params.id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

app.get('/auth/me', auth.authMiddleware, async (req, res, next) => {
  try {
    // Live add-on credit balance, so the sidebar can show it next to the plan
    // without a separate /billing round-trip (best-effort — never block /me).
    let creditBalance = null;
    try { creditBalance = await credits.summary(req.user.tid); } catch { /* ignore */ }
    res.json({
      user: {
        id: req.user.sub,
        email: req.user.email,
        name: req.user.name || null,
        role: req.user.role,
        tenantId: req.user.tid,
        isAdmin: !!req.user.adm,
      },
      // Set by the global billingGate — lets the SPA render the trial banner and
      // gate UI affordances without an extra round-trip.
      entitlements: req.entitlements ? entitlements.toJson(req.entitlements) : null,
      credits: creditBalance,
    });
  } catch (err) { next(err); }
});

// GET /auth/profile — the full profile record (from the DB, so it includes the
// structured first/last name the JWT doesn't carry). Backs the Profile page.
app.get('/auth/profile', auth.authMiddleware, async (req, res, next) => {
  try {
    const u = await userModel.findById(req.user.sub);
    if (!u) return res.status(404).json({ error: 'user not found' });
    res.json({
      profile: {
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        name: u.name || null,
        email: u.email,
        role: u.role,
        emailVerified: u.emailVerified,
        createdAt: u.createdAt,
      },
    });
  } catch (err) { next(err); }
});

// PATCH /auth/me — update the signed-in user's own name. Re-issues the auth
// cookie so the JWT-baked display name refreshes without a re-login.
app.patch('/auth/me', auth.authMiddleware, async (req, res, next) => {
  try {
    const firstName = String((req.body && req.body.firstName) || '').trim();
    const lastName = String((req.body && req.body.lastName) || '').trim();
    if (!firstName || firstName.length > 100) return res.status(400).json({ error: 'first name required' });
    if (!lastName || lastName.length > 100) return res.status(400).json({ error: 'last name required' });
    const u = await userModel.updateProfile(req.user.sub, { firstName, lastName });
    res.cookie(auth.COOKIE_NAME, auth.signToken({
      id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, isAdmin: u.isAdmin,
    }), auth.cookieOptions());
    res.json({ ok: true, profile: { firstName: u.firstName, lastName: u.lastName, name: u.name } });
  } catch (err) { next(err); }
});

// POST /auth/change-password — change the signed-in user's own password.
// Requires the current password. The session stays valid afterwards.
app.post('/auth/change-password', auth.authMiddleware, async (req, res, next) => {
  try {
    const currentPassword = (req.body && req.body.currentPassword) || '';
    const newPassword = (req.body && req.body.newPassword) || '';
    if (typeof newPassword !== 'string' || newPassword.length < 12) {
      return res.status(400).json({ error: 'New password must be at least 12 characters.', code: 'WEAK_PASSWORD' });
    }
    // findByEmail returns the (internal) password hash; findById does not.
    const me = await userModel.findByEmail(req.user.email);
    if (!me || !me.passwordHash) return res.status(404).json({ error: 'user not found' });
    const ok = await userModel.verifyPassword(currentPassword, me.passwordHash);
    if (!ok) return res.status(400).json({ error: 'Current password is incorrect.', code: 'BAD_CURRENT_PASSWORD' });
    const hash = await userModel.hashPassword(newPassword);
    await userModel.setPassword(me.id, hash);
    // Invalidate all existing sessions (CC6.7), then re-issue a fresh cookie so
    // the user changing their password isn't logged out of the current tab.
    await sessions.revokeAllForUser(me.id);
    res.cookie(auth.COOKIE_NAME, auth.signToken({
      id: me.id, tenantId: me.tenantId, email: me.email, name: me.name, role: me.role, isAdmin: me.isAdmin,
    }), auth.cookieOptions());
    audit.log({ req, action: 'auth.password.changed', result: 'success', actorUserId: me.id, actorEmail: me.email, tenantId: me.tenantId });
    res.json({ ok: true });
  } catch (err) { next(err); }
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

// /admin/portals — DEPRECATED per ADR-003 Phase 3 step 5. Use /admin/calls.
// Endpoint stays functional for one release so any consumers (none known
// outside the admin UI, which has been migrated to /admin/calls in this PR)
// have time to migrate. Slated for removal in a follow-up.
app.get('/admin/portals', auth.authMiddleware, async (_req, res, next) => {
  try {
    res.set('X-Deprecated', 'use /admin/calls — see docs/architecture/assessment-003-portals-meetings-consolidation.md');
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

// Arena practice history — durable, tenant-scoped (data firewall). Replaces the
// old Redis live-session scan; rows now persist past the 1h TTL with an AI
// coaching scorecard. Optional ?rep= and ?status= filters.
app.get('/admin/sessions', auth.authMiddleware, async (req, res, next) => {
  try {
    const sessions = await arenaHistory.listForTenant(req.tenantId, {
      limit: req.query.limit,
      rep: req.query.rep,
      status: req.query.status,
    });
    res.json({ sessions });
  } catch (err) { next(err); }
});

// Arena practice detail — full transcript + scorecard for one session.
app.get('/admin/sessions/:id', auth.authMiddleware, async (req, res, next) => {
  try {
    const session = await arenaHistory.getOne(req.tenantId, req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found' });
    res.json({ session });
  } catch (err) { next(err); }
});

// /admin/meetings — DEPRECATED per ADR-003 Phase 3 step 5. Use /admin/calls.
// Same migration timeline as /admin/portals above.
app.get('/admin/meetings', auth.authMiddleware, async (_req, res, next) => {
  try {
    res.set('X-Deprecated', 'use /admin/calls — see docs/architecture/assessment-003-portals-meetings-consolidation.md');
    res.json({ meetings: await store.listMeetings(100) });
  } catch (err) { next(err); }
});

// /admin/tenants — superadmin-only tenant list for the Calls page tenant
// selector (ADR-003 §6 Decision #5). Minimal { id, name } projection.
app.get('/admin/tenants', auth.authMiddleware, auth.requireSuperadmin, async (_req, res, next) => {
  try {
    const r = await db.query('SELECT id, name FROM tenants ORDER BY name NULLS LAST, id');
    res.json({ tenants: r.rows });
  } catch (err) { next(err); }
});

// Platform Admin Console — read-only superadmin cross-tenant observability.
app.use('/admin/platform', auth.authMiddleware, auth.requireSuperadmin, platformAdmin.router);

// Erase a tenant and ALL its data across every store (right-to-be-forgotten /
// offboarding). Superadmin only; irreversible. ?dryRun=1 reports the manifest
// without deleting. A real erase requires confirm=<tenantId> (body or query) to
// guard against accidents. The Founders tenant is refused (in erasure.js).
app.delete('/admin/tenants/:id', auth.authMiddleware, auth.requireSuperadmin, async (req, res, next) => {
  try {
    const tenantId = req.params.id;
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    if (!dryRun) {
      const confirm = (req.body && req.body.confirm) || req.query.confirm;
      if (confirm !== tenantId) {
        return res.status(400).json({ error: 'confirmation required', code: 'CONFIRM_REQUIRED', hint: 'pass confirm=<tenantId> (matching :id) in the body or query' });
      }
    }
    const manifest = await erasure.eraseTenant(tenantId, { dryRun });
    if (!dryRun) {
      audit.log({ req, action: 'tenant.erased', result: 'success', actorUserId: req.user.sub, actorEmail: req.user.email, tenantId, target: tenantId, meta: manifest });
    }
    res.json({ ok: true, dryRun, manifest });
  } catch (err) { next(err); }
});

// Unified Calls view — assessment-003 Phase 1 (additive; /admin/portals and
// /admin/meetings remain untouched). Joins all meeting records with their
// portal (if any), buckets lifecycle status, and returns filtered +
// faceted + paginated results.
//
// Auth:
//   superadmin    → may pass tenant=<uuid> (CSV) to scope across tenants
//   non-superadmin → force-scoped to req.tenantId; tenant= param ignored
app.get('/admin/calls', auth.authMiddleware, async (req, res, next) => {
  try {
    const isSuperadmin = !!(req.user && req.user.adm);
    // req.tenantId is guaranteed non-null here: authMiddleware calls
    // verifyToken() (auth.js), which explicitly rejects any JWT where
    // !claims.tid — including legacy pre-multitenancy tokens — returning
    // null → 401 before next() fires. So the non-superadmin branch below
    // can never silently drop the tenant filter due to an absent tid claim.
    const result = await store.buildCallsList({
      status:     req.query.status,
      source:     req.query.source,
      // Superadmin passes tenant= freely; non-superadmin is hard-scoped.
      tenant:     isSuperadmin ? (req.query.tenant || null) : req.tenantId,
      mission_id: req.query.mission_id,
      company_id: req.query.company_id,
      has_gaps:   req.query.has_gaps,
      has_portal: req.query.has_portal,
      from:       req.query.from,
      to:         req.query.to,
      q:          req.query.q,
      cursor:     req.query.cursor,
      limit:      req.query.limit,
      // Decision #6 — samples are hidden by default unless explicitly
      // requested. Forwarded as-is; store.js does the truthy check.
      include_samples: req.query.include_samples,
    });
    res.json(result);
  } catch (err) { next(err); }
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
app.use('/crm', auth.authMiddleware, gating.requireFeatureWrite(plans.FEATURES.CRM), auth.requireRoleWrite('manager'), require('./crm').router);
app.use('/dashboard', auth.authMiddleware, require('./dashboard').router);

// Billing — the Stripe webhook is PUBLIC (signature-verified) and must sit
// before the authMiddleware'd billing router so Stripe (no cookie) can reach it.
app.post('/billing/webhook', billing.webhook);
app.use('/billing', auth.authMiddleware, auth.requireRoleWrite('owner'), billing.router);

// =========================================================================
// Companies + Missions (sales scheduler).
// =========================================================================

app.use('/companies', auth.authMiddleware, companies.router);
app.use('/contacts',  auth.authMiddleware, require('./contacts').router);
app.use('/missions',  auth.authMiddleware, missions.router);

// =========================================================================
// Knowledge Base — Dynamic Context Layer (RAG over Postgres + pgvector)
// =========================================================================

app.use('/knowledge', auth.authMiddleware, knowledge.router);

// Market Watch — agentic monitoring of watched prospects/competitors (premium).
app.use('/watch', auth.authMiddleware, watch.router);

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
// Microsoft 365 (direct) — per-user calendar callback. Cookieless return from
// login.microsoftonline.com, so it sits before the authMiddleware'd
// integrations router. State binds (tenantId, userId) server-side.
// See ADR-0002 §4.2 (and §8 for why the admin-consent callback was dropped).
app.get('/integrations/microsoft/callback', integrations.handleMicrosoftCallback);
app.use('/integrations', auth.authMiddleware, integrations.router);

// API tokens — long-lived PATs for non-browser clients (Lili MCP server,
// scripts). See docs/rfcs/0001-lili-integration.md. Routes require an
// authenticated session (cookie-JWT or another PAT); minting/listing/revoking
// always acts on req.user.sub within req.tenantId.
app.use('/auth/tokens', auth.authMiddleware, gating.requireFeatureWrite(plans.FEATURES.API_TOKENS), auth.requireRoleWrite('manager'), authTokens.router);

// PUBLIC (Calendly calls it) — signature-verified. Multi-tenant: each tenant's
// subscription is registered at /webhooks/calendly/<routeToken>, which maps back
// to the connecting tenant (see integrations.resolveCalendlyRoute). The legacy
// tokenless /webhooks/calendly is kept for any pre-existing subscription and
// falls back to the Founders tenant.
async function handleCalendlyBooking(req, res, tenantId) {
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
    const mission = await missionsService.schedule(tenantId, fields);
    res.json({ ok: true, missionId: mission.id });
  } catch (err) {
    console.error('[calendly-webhook]', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
}

// Per-tenant callback (the URL every new subscription is registered with).
app.post('/webhooks/calendly/:routeToken', async (req, res) => {
  const route = await integrations.resolveCalendlyRoute(req.params.routeToken);
  if (!route || !route.tenantId) {
    return res.status(404).json({ error: 'unknown webhook route' });
  }
  return handleCalendlyBooking(req, res, route.tenantId);
});

// Legacy tokenless path — Founders fallback for any subscription created before
// per-tenant routing existed.
app.post('/webhooks/calendly', (req, res) =>
  handleCalendlyBooking(req, res, userModel.FOUNDERS_TENANT_ID));

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
    // Provision the restricted RLS role (idempotent) AFTER the schema exists so
    // the GRANT ON ALL TABLES covers everything. Migration 0027 enables the
    // policies; enforcement is gated by RLS_ENFORCE.
    await db.ensureAppRole();
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

  const { TIERS } = require('./models');
  app.listen(PORT, () => {
    console.log(
      `ghost-api listening on :${PORT} ` +
      `(model tiers — lite=${TIERS.lite}, flash=${TIERS.flash}, pro=${TIERS.pro}, content=${TIERS.content}, ` +
      `embedding=${process.env.GEMINI_EMBEDDING_MODEL || 'text-embedding-004'}, ` +
      `recall=${recall.region}, ` +
      `stream=${stream.isConfigured() ? 'live' : 'mock'})`
    );
  });
}

boot();
