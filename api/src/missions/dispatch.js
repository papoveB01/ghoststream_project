// Mission → Recall.ai bot dispatch.
//
// Single code path used by both:
//   - the T-N-min auto-dispatch tick (scheduler.js)
//   - the manual "Send bot now" button (POST /missions/:id/dispatch-bot)
//
// Idempotency: if mission.recall_bot_id is already set we treat it as a
// no-op success unless `force` is passed. Both callers want this — the cron
// fires every minute and we don't want to spawn 30 bots, and a double-click
// on the button shouldn't either.
//
// That idempotency used to be pure check-then-act (read recall_bot_id, act
// on what we read) with nothing claiming the row in between, which is a
// classic TOCTOU race: the cron and a "Send bot now" click firing in the
// same second both read NULL and both call Recall, or a crash between
// createBot and the recall_bot_id write leaves the column NULL so the cron
// re-dispatches every minute for the rest of its window. `claimForDispatch`
// below closes that gap with a single conditional UPDATE (sentinel value
// 'dispatching') BEFORE we ever call Recall — see its header for the
// force/non-force claim rules and `clearClaim` for how we release it again.

const db       = require('../db');
const recall   = require('../recall');
const costs    = require('../costs');
const store    = require('../store');
const service  = require('./service');
const integrations = require('../integrations');
const recordingSettings = require('../recordingSettings');

const APP_BASE_URL = process.env.APP_BASE_URL || '';

function isHttpUrl(s) { return typeof s === 'string' && /^https?:\/\//i.test(s); }

// Recall.ai bot dispatcher recognises these hosts. Anything else (Calendly
// redirect pages, raw "google_meet" labels, etc.) will fail at Recall's end.
const RECALL_HOSTS = /(meet\.google\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|gotomeet(ing)?\.com|whereby\.com|chime\.aws)$/i;

function isRecallReadyUrl(url) {
  if (!isHttpUrl(url)) return false;
  try { return RECALL_HOSTS.test(new URL(url).hostname); }
  catch { return false; }
}

// Atomically claim a mission row for dispatch. Returns true iff THIS call
// won the claim (and is therefore the only one allowed to call Recall).
//
//   - non-force: only claim when recall_bot_id IS NULL — a mission that
//     already has a real bot id, or is already mid-dispatch under the
//     'dispatching' sentinel, is left untouched (the caller falls back to
//     the alreadyDispatched/raced path).
//   - force: claim regardless of the CURRENT recall_bot_id (a real id from
//     a prior dispatch is a legitimate override target — that's the whole
//     point of force), as long as it isn't the 'dispatching' sentinel
//     itself. That still serializes two overlapping force calls against
//     each other while preserving force's "re-dispatch even if already
//     sent" semantics.
async function claimForDispatch(tenantId, missionId, force) {
  const notClaiming = force ? `recall_bot_id IS DISTINCT FROM 'dispatching'` : `recall_bot_id IS NULL`;
  const r = await db.query(
    `UPDATE scheduled_meetings
        SET recall_bot_id = 'dispatching', updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND ${notClaiming}
      RETURNING id`,
    [missionId, tenantId]
  );
  return r.rowCount > 0;
}

// Release a claim this call took out but did not finish (validation error,
// Recall rejected the bot, the post-createBot write failed, etc.) — resets
// the sentinel back to NULL so the mission isn't permanently stuck (the cron
// would otherwise see 'dispatching' forever and never retry it). Guarded by
// `recall_bot_id = 'dispatching'` so this can never clobber a real bot id
// that a *different* dispatch already wrote in the meantime.
async function clearClaim(tenantId, missionId) {
  await db.query(
    `UPDATE scheduled_meetings
        SET recall_bot_id = NULL, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND recall_bot_id = 'dispatching'`,
    [missionId, tenantId]
  );
}

// Spawn a Recall bot for a mission. Returns { meeting, bot, alreadyDispatched }.
// Throws with .status set so the route handler can surface a clean HTTP code.
async function dispatchBot(tenantId, missionId, { force = false, botName } = {}) {
  if (!process.env.RECALL_AI_API_KEY) {
    const e = new Error('RECALL_AI_API_KEY is not set — configure it in .env and restart api');
    e.status = 503; e.code = 'RECALL_NOT_CONFIGURED'; throw e;
  }

  const mission = await service.get(tenantId, missionId);
  if (!mission) { const e = new Error('mission not found'); e.status = 404; throw e; }

  if (mission.recall_bot_id && !force) {
    return { alreadyDispatched: true, botId: mission.recall_bot_id, mission };
  }

  // Claim the row BEFORE doing anything else, including the meeting-url
  // validation below — see claimForDispatch's header comment for the
  // force/non-force rules. This is the fix for the TOCTOU race described at
  // the top of the file: only the caller that wins this UPDATE is allowed to
  // reach recall.createBot.
  const claimed = await claimForDispatch(tenantId, missionId, force);
  if (!claimed) {
    // Lost the race — another caller (the cron, another click, or another
    // overlapping force call) already claimed this mission. Report it the
    // same way the idempotency short-circuit above does; `raced: true` lets
    // the route handler know NO bot was created on this call, so a `force`
    // capacity charge should be refunded rather than billed for nothing.
    return { alreadyDispatched: true, botId: mission.recall_bot_id || null, mission, raced: true };
  }

  try {
    // Resolve any lingering Calendly redirect URL on the fly — old rows that
    // existed before resolveMeetingUrl was wired in will still hit this branch.
    let meetingUrl = mission.meeting_url;
    if (meetingUrl && /(^|\.)calendly\.com$/i.test(safeHost(meetingUrl))) {
      try { meetingUrl = await integrations.resolveMeetingUrl(meetingUrl); }
      catch { /* fall through, validation below will reject */ }
    }

    if (!isRecallReadyUrl(meetingUrl)) {
      const e = new Error(meetingUrl
        ? `Recall.ai can't dispatch a bot to "${meetingUrl}" — needs a meet.google.com / zoom.us / teams URL`
        : 'mission has no meeting_url');
      e.status = 422; e.code = 'BAD_MEETING_URL'; throw e;
    }

    // Create the meetings store record FIRST so the Recall webhook (which
    // arrives moments after createBot) can resolve botId → meetingId via
    // findMeetingByBotId. The bot is spawned with metadata.meetingId so the
    // capture/api processors can route the transcript back to this mission.
    //
    // 2026-05-14: missionCompanyId is now carried in meta so the analysis
    // pipeline's PROSPECT_MEMORY retrieval tier (which scopes KB chunks by
    // the prospect company) can fire. Without it, /_internal/process saw
    // missionCompanyId=null and skipped the prospect-scoped retrieval —
    // exactly what made today's portals come back with kbReady=false. (H9.)
    const missionCompanyId = mission.company_id || null;
    // Recording privacy settings for this tenant — drives video capture + the
    // participant notice. captureVideo is stashed in meta so the post-call
    // processor knows whether to ingest/store the recording.
    const rec = await recordingSettings.get(tenantId);
    const meeting = await store.createMeeting({
      source: 'recall',
      meetingUrl,
      status: 'creating',
      meta: { missionId, missionCompanyId, tenantId, dispatchedBy: 'mission', captureVideo: rec.videoEnabled },
    });

    const webhookUrl = `${APP_BASE_URL}/webhooks/recall`;
    let bot;
    try {
      bot = await recall.createBot({
        meetingUrl,
        botName: botName || 'DealScope Notetaker',
        webhookUrl,
        metadata: { meetingId: meeting.id, missionId, missionCompanyId, tenantId, app: 'ghoststream' },
        captureVideo: rec.videoEnabled,
        noticeMessage: recordingSettings.noticeMessageFor(rec),
      });
    } catch (err) {
      // Roll the meetings record into a 'failed' state so it doesn't sit in
      // 'creating' forever; surface Recall's own message back to the caller.
      await store.updateMeeting(meeting.id, {
        status: 'failed',
        meta: { ...meeting.meta, lastError: String(err.message || err).slice(0, 500) },
      }).catch(() => { /* best-effort */ });
      const e = new Error(`Recall.ai rejected the bot dispatch: ${err.message}`);
      e.status = err.status && err.status < 600 ? err.status : 502;
      e.code = 'RECALL_DISPATCH_FAILED';
      throw e;
    }

    await store.updateMeeting(meeting.id, {
      botId: bot.id,
      status: bot.status_changes?.slice(-1)[0]?.code || 'pending',
      meta: { ...meeting.meta, bot },
    });

    costs.recordRecallDispatch(tenantId, 'missions.dispatch', { missionId, botId: bot.id });
    // Overwrite the 'dispatching' sentinel with the real bot id — same write
    // as before the claim protocol existed, just now guaranteed to be the
    // only writer touching this row.
    await service.setRecallBotId(tenantId, missionId, bot.id);

    return { alreadyDispatched: false, botId: bot.id, meeting, bot, mission };
  } catch (err) {
    // Whatever failed above, we still hold the 'dispatching' sentinel from
    // the claim — release it so this mission isn't locked out of every
    // future dispatch attempt (including the cron's) just for having failed
    // once. See clearClaim's header for why this can't clobber someone
    // else's real bot id.
    await clearClaim(tenantId, missionId).catch(() => { /* best-effort */ });
    throw err;
  }
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return ''; } }

module.exports = { dispatchBot, isRecallReadyUrl };
