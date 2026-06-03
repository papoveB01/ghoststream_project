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

// Market Watch — separate low-frequency pass (default hourly). Picks tenants
// whose cadence has come due (watch_next_run_at <= now) and fires runTenant
// fire-and-forget so the web/LLM work never blocks the tick.
const WATCH_CRON = process.env.WATCH_CRON || '0 * * * *';

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
    // Cross-tenant: any tenant that's enabled Market Watch and is now due.
    // The per-tenant entitlement/active re-check lives inside runTenant.
    const due = (await db.query(
      `SELECT t.id, t.plan, t.subscription_status, t.trial_ends_at, t.current_period_end,
              p.watch_frequency, p.watch_email_digest, true AS watch_enabled
         FROM tenant_profiles p
         JOIN tenants t ON t.id = p.tenant_id
        WHERE p.watch_enabled = true
          AND (p.watch_next_run_at IS NULL OR p.watch_next_run_at <= now())
        ORDER BY p.watch_next_run_at ASC NULLS FIRST
        LIMIT 10`
    )).rows;
    if (!due.length) return;
    console.log(`[scheduler] ${due.length} tenant(s) due for Market Watch`);
    for (const t of due) {
      // Claim the tenant up-front: push watch_next_run_at forward by one
      // cadence so a long-running pass isn't re-picked by the next tick.
      // runTenant re-sets it precisely (now + cadence) when it completes.
      const days = { daily: 1, weekly: 7, monthly: 30 }[String(t.watch_frequency || 'weekly').toLowerCase()] || 7;
      await db.query(
        `UPDATE tenant_profiles SET watch_next_run_at = now() + ($2 || ' days')::interval WHERE tenant_id = $1`,
        [t.id, String(days)]
      ).catch(() => {});
      // Fire-and-forget — never block the tick on web/LLM work.
      watch.runTenant(t).catch((err) => console.error(`[scheduler] market watch failed for tenant ${t.id}: ${(err && err.message) || err}`));
    }
  } catch (err) {
    console.error('[scheduler] watch tick failed:', err.message);
  } finally {
    watchRunning = false;
  }
}

function start() {
  cron.schedule(CRON_EXPR, tick);
  cron.schedule(WATCH_CRON, watchTick);
  console.log(`[scheduler] mission cron started (expression: "${CRON_EXPR}", brief window: T-${LOOKAHEAD_END_HOURS}h to T-${LOOKAHEAD_START_HOURS}h, bot lead: ${BOT_LEAD_MINUTES > 0 ? `T-${BOT_LEAD_MINUTES}min` : 'disabled'})`);
  console.log(`[scheduler] market watch cron started (expression: "${WATCH_CRON}")`);
}

module.exports = { start, tick, watchTick, findDueMissions, findMissionsDueForBot };
