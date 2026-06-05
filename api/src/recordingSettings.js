// Per-tenant recording privacy settings (migration 0043). Single source of
// truth for: whether we keep video, whether we post a recording notice to
// participants, the notice text, and how long stored video is retained.
//
// Read by the dispatch path (dispatch.js / POST /meetings) when spawning the
// bot, by the post-call processor (whether to ingest video), by the retention
// purge cron, and by the settings API/UI.

const db = require('./db');

// Shown to meeting participants in the bot's join message when notice is on
// and no custom text is set. Kept short — it's a chat line in the meeting.
const DEFAULT_NOTICE =
  'Heads up — this meeting is being recorded and transcribed by DealScope to create the summary and follow-up notes.';

// Hard ceiling on retention so a fat-fingered value can't mean "keep ~forever".
const MAX_RETENTION_DAYS = 3650; // 10 years

function rowToSettings(row) {
  row = row || {};
  const retention = row.recording_retention_days;
  return {
    videoEnabled:  row.recording_video_enabled !== false,   // default true
    noticeEnabled: row.recording_notice_enabled !== false,  // default true
    notice:        (row.recording_notice && row.recording_notice.trim()) || DEFAULT_NOTICE,
    noticeCustom:  (row.recording_notice && row.recording_notice.trim()) || null,
    // null → keep indefinitely; a positive integer → purge after N days.
    retentionDays: retention == null ? null : Number(retention),
  };
}

async function get(tenantId) {
  if (!tenantId) return rowToSettings(null);
  const r = await db.query(
    `SELECT recording_video_enabled, recording_notice_enabled, recording_notice, recording_retention_days
       FROM tenants WHERE id = $1`,
    [tenantId]
  );
  return rowToSettings(r.rows[0]);
}

// Partial update — only the keys present are changed. Returns the fresh settings.
async function update(tenantId, patch = {}) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (typeof patch.videoEnabled === 'boolean') { sets.push(`recording_video_enabled = $${i++}`); vals.push(patch.videoEnabled); }
  if (typeof patch.noticeEnabled === 'boolean') { sets.push(`recording_notice_enabled = $${i++}`); vals.push(patch.noticeEnabled); }
  if (patch.notice !== undefined) {
    const txt = patch.notice == null ? null : String(patch.notice).trim().slice(0, 2000) || null;
    sets.push(`recording_notice = $${i++}`); vals.push(txt);
  }
  if (patch.retentionDays !== undefined) {
    let days = patch.retentionDays;
    if (days === null || days === '' ) days = null;
    else {
      days = Math.round(Number(days));
      if (!Number.isFinite(days) || days < 1) { const e = new Error('retentionDays must be a positive integer or null'); e.status = 400; throw e; }
      days = Math.min(days, MAX_RETENTION_DAYS);
    }
    sets.push(`recording_retention_days = $${i++}`); vals.push(days);
  }
  if (!sets.length) return get(tenantId);
  vals.push(tenantId);
  await db.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  return get(tenantId);
}

// The message to post to participants on bot join — null when notice is off
// (callers omit the chat field entirely in that case).
function noticeMessageFor(settings) {
  return settings && settings.noticeEnabled ? settings.notice : null;
}

module.exports = { get, update, noticeMessageFor, DEFAULT_NOTICE, MAX_RETENTION_DAYS };
