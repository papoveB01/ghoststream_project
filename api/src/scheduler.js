// In-api cron scheduler.
//
// Fires the Pre-Call Brief pipeline for missions whose scheduled_at falls
// inside the T-24h window AND haven't been briefed yet. The window is
// (now+23h, now+25h] — 2h of slack so a single cron miss (e.g. container
// restart) doesn't skip a brief.
//
// Concurrency safety: each fire flips status to BRIEFED (or FAILED) inside
// the brief pipeline, so the next tick's SELECT excludes already-handled
// missions. No advisory locks needed.

const cron = require('node-cron');
const db = require('./db');
const brief = require('./missions/brief');
const dispatch = require('./missions/dispatch');
const watch = require('./watch');
const watchSchedule = require('./watchSchedule');
const store = require('./store');
const stream = require('./stream');

// Market Watch — separate low-frequency pass (default hourly). Picks tenants
// whose cadence has come due (watch_next_run_at <= now) and fires runTenant
// fire-and-forget so the web/LLM work never blocks the tick.
const WATCH_CRON = process.env.WATCH_CRON || '0 * * * *';

// Recording retention purge — deletes stored meeting video older than each
// tenant's recording_retention_days (migration 0043). Transcript + portal text
// are kept; only the Cloudflare Stream recording + its clip are removed. Hourly
// at :17 so it doesn't pile onto the top-of-hour watch tick.
const PURGE_CRON = process.env.RECORDING_PURGE_CRON || '17 * * * *';

const CRON_EXPR = process.env.MISSIONS_CRON || '* * * * *'; // every minute
const LOOKAHEAD_START_HOURS = parseFloat(process.env.BRIEF_LOOKAHEAD_START_HOURS || '23');
const LOOKAHEAD_END_HOURS   = parseFloat(process.env.BRIEF_LOOKAHEAD_END_HOURS   || '25');
// Auto-dispatch a Recall bot N minutes before the meeting starts. Default
// 2 min — Recall takes ~30s to spawn and join, so 2 min comfortably puts
// the bot in the room before the host. Set BOT_LEAD_MINUTES=0 to disable.
const BOT_LEAD_MINUTES = parseFloat(process.env.BOT_LEAD_MINUTES || '2');

async function findDueMissions() {
  // PENDING only — a previously FAILED brief stays FAILED until a manual
  // re-run via POST /api/missions/:id/brief. Auto-retrying a broken brief
  // would burn Gemini credits on the same failure shape.
  //
  // System-wide query (no tenant scope) — the scheduler runs across all
  // tenants. Each row carries tenant_id so brief generation can scope to it.
  const r = await db.query(
    `SELECT id, tenant_id, scheduled_at
       FROM scheduled_meetings
      WHERE status = 'PENDING'
        AND scheduled_at BETWEEN now() + ($1 || ' hours')::interval
                              AND now() + ($2 || ' hours')::interval
      ORDER BY scheduled_at ASC
      LIMIT 5`,
    [String(LOOKAHEAD_START_HOURS), String(LOOKAHEAD_END_HOURS)]
  );
  return r.rows;
}

// Missions whose meeting starts within the next BOT_LEAD_MINUTES and which
// don't yet have a bot dispatched. Excludes CANCELLED/COMPLETED so we don't
// resurrect old rows. Includes a small back-window (5 min) so a missed cron
// tick (container restart) still catches recently-started meetings.
async function findMissionsDueForBot() {
  if (!(BOT_LEAD_MINUTES > 0)) return [];
  const r = await db.query(
    `SELECT id, tenant_id, scheduled_at, meeting_url
       FROM scheduled_meetings
      WHERE status NOT IN ('CANCELLED', 'COMPLETED', 'FAILED')
        AND recall_bot_id IS NULL
        AND meeting_url IS NOT NULL
        AND scheduled_at BETWEEN now() - interval '5 minutes'
                              AND now() + ($1 || ' minutes')::interval
      ORDER BY scheduled_at ASC
      LIMIT 10`,
    [String(BOT_LEAD_MINUTES)]
  );
  return r.rows;
}

let running = false;

async function tick() {
  if (running) return; // single-instance guard
  running = true;
  try {
    // 1. Pre-Call Briefs at T-24h.
    const due = await findDueMissions();
    if (due.length > 0) {
      console.log(`[scheduler] ${due.length} mission(s) due for brief generation`);
      for (const m of due) {
        try {
          const result = await brief.generate(m.id, m.tenant_id);
          console.log(`[scheduler] brief ${result.briefId} generated for mission ${m.id} (${result.chunkCount} chunks)`);
        } catch (err) {
          console.error(`[scheduler] brief failed for mission ${m.id}: ${err.message}`);
          // Service flips to FAILED with the error string for surfacing in the UI.
          try {
            const service = require('./missions/service');
            await service.setBriefError(m.tenant_id, m.id, err.message);
          } catch (e2) { /* swallow — we already logged */ }
        }
      }
    }

    // 2. Recall.ai bot dispatch at T-BOT_LEAD_MINUTES.
    //    Disabled by setting BOT_LEAD_MINUTES=0. Failures here DON'T flip
    //    the mission to FAILED — the mission's primary state machine is
    //    about briefs, not bot dispatch. We log + leave recall_bot_id NULL
    //    so the next tick retries until scheduled_at + 5min back-window.
    const dueBots = await findMissionsDueForBot();
    if (dueBots.length > 0) {
      console.log(`[scheduler] ${dueBots.length} mission(s) due for Recall.ai bot dispatch`);
      for (const m of dueBots) {
        try {
          const r = await dispatch.dispatchBot(m.tenant_id, m.id);
          if (r.alreadyDispatched) continue;
          console.log(`[scheduler] bot ${r.botId} dispatched for mission ${m.id} → ${m.meeting_url}`);
        } catch (err) {
          console.error(`[scheduler] bot dispatch failed for mission ${m.id}: ${err.message}`);
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] tick failed:', err.message);
  } finally {
    running = false;
  }
}

let watchRunning = false;

async function watchTick() {
  if (watchRunning) return; // single-instance guard
  watchRunning = true;
  try {
    // Per-entity: any watched prospect/competitor whose own schedule is due,
    // across all tenants. The entitlement/active/cap re-check lives inside
    // watch.runEntityScheduled. Both tables joined to their tenant.
    const due = (await db.query(
      `SELECT * FROM (
         SELECT 'PROSPECT'::text AS scope, c.id::text AS id, c.name,
                c.watch_frequency, c.watch_day, c.watch_timezone, c.watch_email_digest, c.watch_next_run_at,
                t.id AS tenant_id, t.plan, t.subscription_status, t.trial_ends_at, t.current_period_end
           FROM companies c JOIN tenants t ON t.id = c.tenant_id
          WHERE c.watch_enabled AND (c.watch_next_run_at IS NULL OR c.watch_next_run_at <= now())
         UNION ALL
         SELECT 'COMPETITOR'::text AS scope, c.id::text AS id, c.name,
                c.watch_frequency, c.watch_day, c.watch_timezone, c.watch_email_digest, c.watch_next_run_at,
                t.id AS tenant_id, t.plan, t.subscription_status, t.trial_ends_at, t.current_period_end
           FROM competitors c JOIN tenants t ON t.id = c.tenant_id
          WHERE c.watch_enabled AND (c.watch_next_run_at IS NULL OR c.watch_next_run_at <= now())
       ) q
       ORDER BY watch_next_run_at ASC NULLS FIRST
       LIMIT 25`
    )).rows;
    if (!due.length) return;
    console.log(`[scheduler] ${due.length} watched entit(ies) due for Market Watch`);
    const TBL = { PROSPECT: 'companies', COMPETITOR: 'competitors' };
    for (const e of due) {
      // Claim up-front: push this entity's watch_next_run_at to its next slot so
      // a long-running pass isn't re-picked by the next tick. runEntityScheduled
      // re-sets it precisely when it completes.
      await db.query(
        `UPDATE ${TBL[e.scope]} SET watch_next_run_at = $3 WHERE id = $1 AND tenant_id = $2`,
        [e.id, e.tenant_id, watchSchedule.nextRunISO(e.watch_frequency, e.watch_day, e.watch_timezone)]
      ).catch(() => {});
      // Fire-and-forget — never block the tick on web/LLM work.
      watch.runEntityScheduled(e).catch((err) => console.error(`[scheduler] market watch failed for ${e.scope}/${e.id}: ${(err && err.message) || err}`));
    }
  } catch (err) {
    console.error('[scheduler] watch tick failed:', err.message);
  } finally {
    watchRunning = false;
  }
}

let purgeRunning = false;

// Delete stored meeting video past each tenant's retention window. Meetings
// live in Redis (store); per-tenant retention lives in Postgres. We scan recent
// meetings, and for any with a stored video older than its tenant's window we
// delete the Cloudflare Stream source + objection clip and clear the uids
// (leaving transcript + portal text intact). A tenant with NULL retention keeps
// recordings indefinitely (explicit opt-in) and is skipped.
async function purgeTick() {
  if (purgeRunning) return; // single-instance guard
  purgeRunning = true;
  try {
    if (!stream.isConfigured()) return; // no Stream → nothing stored to purge
    const rows = (await db.query(
      `SELECT id, recording_retention_days FROM tenants WHERE recording_retention_days IS NOT NULL`
    )).rows;
    if (!rows.length) return;
    const retention = new Map(rows.map((r) => [String(r.id), Number(r.recording_retention_days)]));

    const meetings = await store.listMeetings(2000); // recent-first; bounded scan
    const now = Date.now();
    let purged = 0;
    for (const m of meetings) {
      if (!m || !m.videoUid || !m.videoIngestedAt || m.videoPurgedAt) continue;
      const tid = m.meta && m.meta.tenantId;
      const days = tid ? retention.get(String(tid)) : null;
      if (!days) continue; // tenant keeps indefinitely, or meeting has no tenant
      const ageDays = (now - new Date(m.videoIngestedAt).getTime()) / 86400000;
      if (!(ageDays >= days)) continue;
      try {
        await stream.deleteVideo(m.videoUid);
      } catch (e) {
        console.error(`[scheduler] retention: stream delete ${m.videoUid} failed: ${e.message}`);
        continue; // leave the marker so we retry next tick
      }
      if (m.objectionClipUid) {
        try { await stream.deleteVideo(m.objectionClipUid); } catch (e) { /* best-effort */ }
      }
      await store.updateMeeting(m.id, {
        videoUid: null, objectionClipUid: null, videoPurgedAt: new Date().toISOString(),
      }).catch(() => {});
      // Flag the linked portal so its viewer shows a graceful "recording
      // expired" state instead of a broken player (transcript/insights kept).
      if (m.portalId) {
        await store.updatePortal(m.portalId, {
          recordingExpired: true, videoUid: null, objectionClip: null,
        }).catch(() => {});
      }
      purged++;
    }
    if (purged) console.log(`[scheduler] recording retention: purged ${purged} expired recording(s)`);
  } catch (err) {
    console.error('[scheduler] recording purge tick failed:', err.message);
  } finally {
    purgeRunning = false;
  }
}

function start() {
  cron.schedule(CRON_EXPR, tick);
  cron.schedule(WATCH_CRON, watchTick);
  cron.schedule(PURGE_CRON, purgeTick);
  console.log(`[scheduler] mission cron started (expression: "${CRON_EXPR}", brief window: T-${LOOKAHEAD_END_HOURS}h to T-${LOOKAHEAD_START_HOURS}h, bot lead: ${BOT_LEAD_MINUTES > 0 ? `T-${BOT_LEAD_MINUTES}min` : 'disabled'})`);
  console.log(`[scheduler] market watch cron started (expression: "${WATCH_CRON}")`);
  console.log(`[scheduler] recording retention purge started (expression: "${PURGE_CRON}")`);
}

module.exports = { start, tick, watchTick, purgeTick, findDueMissions, findMissionsDueForBot };
