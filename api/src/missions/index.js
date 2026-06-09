// /api/missions router — mounted behind authMiddleware in src/index.js, so
// req.tenantId is always set. Every call is tenant-scoped.

const express = require('express');
const service = require('./service');
const brief = require('./brief');
const dispatch = require('./dispatch');
const gating = require('../gating');

const router = express.Router();
router.use(express.json());

// POST /missions — schedule a new mission.
//
// Body: {
//   companyName, companyDomain?, primaryContact?,
//   scheduledAt (ISO string),
//   meetingUrl?, prospectEmails: string[],
//   productIds[], personaIds[], competitorIds[],
//   notes?,
//   // Optional: set when the rep generated the meeting from the "Generate
//   // meeting" modal. Lets us PATCH / cancel the provider event later from the
//   // mission detail UI. ms_* = Microsoft Teams, google* = Google Meet (a
//   // mission carries at most one). See ADR-0002 §10/§11.
//   msEventId?, msIcalUid?, msOrganizerEmail?,
//   googleEventId?, googleIcalUid?, googleOrganizerEmail?,
// }
router.post('/', gating.requireFeature('engagements'), gating.requireCapacity('engagements'), async (req, res, next) => {
  try {
    const mission = await service.schedule(req.tenantId, req.body || {});
    res.status(201).json({ mission });
  } catch (err) {
    // requireCapacity charged one engagement before we ran; a failed schedule
    // (validation error, own-company, etc.) must give it back so the tenant
    // isn't billed for a meeting that never existed.
    await gating.refundCapacity(req);
    next(err);
  }
});

// GET /missions?when=upcoming|past&status=...
router.get('/', async (req, res, next) => {
  try {
    const rows = await service.list(req.tenantId, {
      status: req.query.status || null,
      when:   req.query.when   || 'all',
    });
    res.json({ missions: rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const mission = await service.get(req.tenantId, req.params.id);
    if (!mission) return res.status(404).json({ error: 'not found' });
    const latestBrief = await brief.getLatest(req.tenantId, req.params.id);
    res.json({ mission, brief: latestBrief });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const ok = await service.cancel(req.tenantId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found or already completed/cancelled' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// On-demand brief generation. Bypasses the T-24h scheduler — used by the
// admin "Generate brief now" button and the smoke test.
router.post('/:id/brief', async (req, res, next) => {
  try {
    // Verify the mission belongs to this tenant before generating (generate()
    // re-checks, but a clean 404 here is friendlier than a thrown error).
    const mission = await service.get(req.tenantId, req.params.id);
    if (!mission) return res.status(404).json({ error: 'not found' });
    const result = await brief.generate(req.params.id, req.tenantId);
    res.status(201).json({ ok: true, brief: result });
  } catch (err) { next(err); }
});

// On-demand Recall.ai bot dispatch. Bypasses the T-2min cron — used by the
// "Send bot now" button on the mission detail panel and for testing.
//   ?force=1 re-dispatches even if recall_bot_id is already set (useful when
//   the prior bot crashed; no attempt to revoke the old bot — Recall just
//   spawns a second one).
router.post('/:id/dispatch-bot', async (req, res, next) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const result = await dispatch.dispatchBot(req.tenantId, req.params.id, { force });
    if (result.alreadyDispatched) {
      return res.status(200).json({ ok: true, alreadyDispatched: true, botId: result.botId });
    }
    res.status(201).json({
      ok: true,
      botId: result.botId,
      meetingId: result.meeting && result.meeting.id,
      botStatus: result.bot && result.bot.status_changes?.slice(-1)[0]?.code || 'pending',
    });
  } catch (err) { next(err); }
});

module.exports = { router };
