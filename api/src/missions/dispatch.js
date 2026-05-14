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

const recall   = require('../recall');
const store    = require('../store');
const service  = require('./service');
const integrations = require('../integrations');

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
  const meeting = await store.createMeeting({
    source: 'recall',
    meetingUrl,
    status: 'creating',
    meta: { missionId, missionCompanyId, tenantId, dispatchedBy: 'mission' },
  });

  const webhookUrl = `${APP_BASE_URL}/webhooks/recall`;
  let bot;
  try {
    bot = await recall.createBot({
      meetingUrl,
      botName: botName || 'GhostStream Notetaker',
      webhookUrl,
      metadata: { meetingId: meeting.id, missionId, missionCompanyId, tenantId, app: 'ghoststream' },
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

  await service.setRecallBotId(tenantId, missionId, bot.id);

  return { alreadyDispatched: false, botId: bot.id, meeting, bot, mission };
}

function safeHost(u) { try { return new URL(u).hostname; } catch { return ''; } }

module.exports = { dispatchBot, isRecallReadyUrl };
