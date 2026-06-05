// Tenant settings API. Currently: recording privacy (video on/off, participant
// notice, retention window — see recordingSettings.js / migration 0043).
// Mounted at /api/settings behind authMiddleware; writes are gated to
// manager+ in index.js (requireRoleWrite).

const express = require('express');
const recordingSettings = require('./recordingSettings');

const router = express.Router();
router.use(express.json());

function shape(s) {
  return {
    videoEnabled:    s.videoEnabled,
    noticeEnabled:   s.noticeEnabled,
    notice:          s.noticeCustom,            // custom text, or null (→ default)
    defaultNotice:   recordingSettings.DEFAULT_NOTICE,
    effectiveNotice: s.notice,                  // what actually gets posted
    retentionDays:   s.retentionDays,           // null = keep indefinitely
  };
}

// GET /api/settings/recording — current recording privacy settings.
router.get('/recording', async (req, res, next) => {
  try { res.json(shape(await recordingSettings.get(req.tenantId))); }
  catch (err) { next(err); }
});

// PUT /api/settings/recording — partial update (manager+). Body keys are all
// optional: { videoEnabled, noticeEnabled, notice, retentionDays }.
router.put('/recording', async (req, res, next) => {
  try {
    const { videoEnabled, noticeEnabled, notice, retentionDays } = req.body || {};
    const updated = await recordingSettings.update(req.tenantId, {
      videoEnabled, noticeEnabled, notice, retentionDays,
    });
    res.json(shape(updated));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    next(err);
  }
});

module.exports = { router };
