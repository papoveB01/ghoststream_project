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
// How many watched entities may be researched at once. Each one fans out into
// ~6 searches + 3 scrapes + 1 model call, so this is the real throttle on the
// hourly burst against the search/scrape providers.
const WATCH_CONCURRENCY = Math.max(1, parseInt(process.env.WATCH_CONCURRENCY || '4', 10));
// Hard ceiling on one entity's research pass. Awaiting the pool (below) is what
// makes the watchRunning guard meaningful, but it also means an entity that
// never settles would hold that guard for the life of the process — and NOTHING
// in the path is time-bounded: gemini.js builds GoogleGenAI with no
// httpOptions.timeout, so a hung model call hangs forever. That is the same
// failure shape as the briefRunning incident this file already carries a
// regression test for (test/schedulerPhases.test.js): one stuck call silently
// starved every tenant until a restart. Per-entity rather than per-pool, so a
// single bad entity doesn't cost the other 24 their run.
// Floor is 1s, not a minute: it exists to stop a typo'd 0/NaN from disabling the
// bound entirely, not to mandate a realistic value — tests need to drive it low.
const WATCH_ENTITY_TIMEOUT_MS = Math.max(1000, parseInt(process.env.WATCH_ENTITY_TIMEOUT_MS || '600000', 10) || 600000);

// Note: this bounds how long we WAIT, not the work itself — Promise.race can't
// cancel the underlying call, so a hung request still dangles until the process
// exits. That's acceptable (it's exactly what fire-and-forget did with every
// run); what matters is that the pool advances and the guard is released.
// The timer is deliberately NOT unref'd. An unref'd timer doesn't hold the event
// loop open, so if the hung call is the only thing left in flight the loop drains
// and the timeout never fires — the guard-release this exists for would silently
// not happen. It is cleared as soon as the work settles, so the only case where
// it holds the process is the hang it is there to break, and only until it fires.
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    }),
  ]);
}

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

// Two INDEPENDENT guards, not one shared `running` flag. Bot dispatch is the
// phase with real money on it (a paid engagement unit) and a hard 5-minute
// back-window — it must never queue behind brief generation. Briefs do a
// Firecrawl scrape + retrieval + an LLM call per mission, run serially, up to
// 5 per tick; if one of those hangs (even with the generateContent timeout
// above, a slow-but-not-timed-out call can still eat most of a tick), a single
// shared flag would leave bot dispatch starved platform-wide until the brief
// phase finally clears. Splitting the guard means a stuck/slow brief tick
// simply skips itself (still returns early on its OWN flag) while the next
// per-minute tick's bot-dispatch phase runs regardless.
let briefRunning = false;
let botRunning = false;

async function runBriefPhase() {
  if (briefRunning) return; // single-instance guard, briefs only
  briefRunning = true;
  try {
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
  } catch (err) {
    console.error('[scheduler] brief phase failed:', err.message);
  } finally {
    briefRunning = false;
  }
}

async function runBotPhase() {
  if (botRunning) return; // single-instance guard, bot dispatch only
  botRunning = true;
  try {
    // Recall.ai bot dispatch at T-BOT_LEAD_MINUTES. Disabled by setting
    // BOT_LEAD_MINUTES=0. Failures here DON'T flip the mission to FAILED —
    // the mission's primary state machine is about briefs, not bot dispatch.
    // We log + leave recall_bot_id NULL so the next tick retries until
    // scheduled_at + 5min back-window.
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
    console.error('[scheduler] bot dispatch phase failed:', err.message);
  } finally {
    botRunning = false;
  }
}

// Fire both phases concurrently every tick (not one `await`ed after the
// other) — otherwise a brief phase that's still working through its serial
// batch would delay THIS tick's bot-dispatch phase from even starting.
// allSettled (not all) because each phase already catches its own errors
// internally; this is just a defensive backstop.
async function tick() {
  await Promise.allSettled([runBriefPhase(), runBotPhase()]);
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
                t.id AS tenant_id, t.plan, t.plan_version, t.subscription_status, t.trial_ends_at, t.current_period_end
           FROM companies c JOIN tenants t ON t.id = c.tenant_id
          WHERE c.watch_enabled AND (c.watch_next_run_at IS NULL OR c.watch_next_run_at <= now())
         UNION ALL
         SELECT 'COMPETITOR'::text AS scope, c.id::text AS id, c.name,
                c.watch_frequency, c.watch_day, c.watch_timezone, c.watch_email_digest, c.watch_next_run_at,
                -- plan_version is load-bearing: entitlementsFor() defaults a missing
                -- one to 1, so omitting it here evaluated every v2 tenant's scheduled
                -- watch run against the v1 catalog (v1 Pro 500 vs v2 Pro 250 — double
                -- the paid allowance). The manual-run path already selects it.
                t.id AS tenant_id, t.plan, t.plan_version, t.subscription_status, t.trial_ends_at, t.current_period_end
           FROM competitors c JOIN tenants t ON t.id = c.tenant_id
          WHERE c.watch_enabled AND (c.watch_next_run_at IS NULL OR c.watch_next_run_at <= now())
       ) q
       ORDER BY watch_next_run_at ASC NULLS FIRST
       LIMIT 25`
    )).rows;
    if (!due.length) return;
    console.log(`[scheduler] ${due.length} watched entit(ies) due for Market Watch (concurrency ${WATCH_CONCURRENCY})`);
    const TBL = { PROSPECT: 'companies', COMPETITOR: 'competitors' };
    for (const e of due) {
      // Claim up-front: push this entity's watch_next_run_at to its next slot so
      // a long-running pass isn't re-picked by the next tick. runEntityScheduled
      // re-sets it precisely when it completes.
      await db.query(
        `UPDATE ${TBL[e.scope]} SET watch_next_run_at = $3 WHERE id = $1 AND tenant_id = $2`,
        [e.id, e.tenant_id, watchSchedule.nextRunISO(e.watch_frequency, e.watch_day, e.watch_timezone)]
      ).catch(() => {});
    }

    // Bounded worker pool, NOT fire-and-forget. Each entity run makes ~6 search
    // calls (itself capped at 4 concurrent) plus 3 parallel scrapes plus a Gemini
    // call, so launching all 25 at once put ~100 searches and ~75 scrapes in
    // flight on the hour — defeating the per-entity cap that exists precisely to
    // avoid that, and tripping rate limits that withRetry then amplifies.
    // Awaiting the pool also makes the watchRunning guard mean something: a pass
    // that overruns the hour can no longer stack a second one on top of itself.
    let next = 0;
    const worker = async () => {
      while (next < due.length) {
        const e = due[next++];
        try { await withTimeout(watch.runEntityScheduled(e), WATCH_ENTITY_TIMEOUT_MS, `watch ${e.scope}/${e.id}`); }
        catch (err) { console.error(`[scheduler] market watch failed for ${e.scope}/${e.id}: ${(err && err.message) || err}`); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(WATCH_CONCURRENCY, due.length) }, worker));
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
  // Activation drip emails — hourly check; the journey_emails ledger makes
  // each nudge exactly-once per tenant, so the cadence is safe.
  cron.schedule('10 * * * *', () => require('./journeyEmails').tick());
  console.log(`[scheduler] mission cron started (expression: "${CRON_EXPR}", brief window: T-${LOOKAHEAD_END_HOURS}h to T-${LOOKAHEAD_START_HOURS}h, bot lead: ${BOT_LEAD_MINUTES > 0 ? `T-${BOT_LEAD_MINUTES}min` : 'disabled'})`);
  console.log(`[scheduler] market watch cron started (expression: "${WATCH_CRON}")`);
  console.log(`[scheduler] recording retention purge started (expression: "${PURGE_CRON}")`);
}

module.exports = { start, tick, watchTick, purgeTick, findDueMissions, findMissionsDueForBot };
