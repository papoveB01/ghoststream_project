// Market Watch scheduling math — shared by watch.js, the scheduler, and the
// companies/portfolio update paths. Dependency-light (no DB/AI) so any module
// can require it without pulling in the agent.
//
// A schedule runs at 08:00 on the chosen day in the entity's OWN timezone:
//   daily   → tomorrow
//   weekly  → next occurrence of day-of-week `day` (0=Sun … 6=Sat)
//   monthly → next occurrence of day-of-month `day` (1..28)

const RUN_HOUR = 8;
const FREQ_DAYS = { daily: 1, weekly: 7, monthly: 30 }; // membership = valid frequency

function isValidFrequency(freq) {
  return Object.prototype.hasOwnProperty.call(FREQ_DAYS, String(freq || '').toLowerCase());
}

function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Validate/normalize a day for a frequency. weekly → 0..6, monthly → 1..28,
// daily → 1 (ignored). Returns null if out of range / non-integer.
function normalizeWatchDay(freq, day) {
  const n = parseInt(day, 10);
  if (!Number.isInteger(n)) return null;
  if (freq === 'weekly') return n >= 0 && n <= 6 ? n : null;
  if (freq === 'monthly') return n >= 1 && n <= 28 ? n : null;
  return 1; // daily — day is irrelevant
}

// Offset (ms) of `tz` at `instant`, i.e. localWallClock - UTC.
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(instant)) p[part.type] = part.value;
  const asIfUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUTC - instant.getTime();
}

// A wall-clock (y, m=1..12, d, h) in `tz` → the corresponding UTC Date.
function zonedWallToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0);
  const off = tzOffsetMs(new Date(guess), tz);
  return new Date(guess - off);
}

// Current wall-clock in `tz` as plain fields (weekday 0=Sun … 6=Sat).
function wallNow(tz) {
  const now = new Date();
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(now)) p[part.type] = part.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { now, year: +p.year, month: +p.month, day: +p.day, weekday: wd };
}

// Next run timestamp (ISO) for a cadence + chosen day, at RUN_HOUR local time.
function nextRunISO(frequency, day, timezone) {
  const tz = isValidTz(timezone) ? timezone : 'UTC';
  const freq = String(frequency || 'weekly').toLowerCase();
  const w = wallNow(tz);
  const cal = new Date(Date.UTC(w.year, w.month - 1, w.day)); // calendar holder for y/m/d math
  const at = () => zonedWallToUtc(cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), RUN_HOUR, tz);

  if (freq === 'daily') {
    cal.setUTCDate(cal.getUTCDate() + 1);
    return at().toISOString();
  }
  if (freq === 'monthly') {
    const dom = Math.max(1, Math.min(28, parseInt(day, 10) || 1));
    let y = w.year, m = w.month;
    let cand = zonedWallToUtc(y, m, dom, RUN_HOUR, tz);
    if (cand <= w.now) { m += 1; if (m > 12) { m = 1; y += 1; } cand = zonedWallToUtc(y, m, dom, RUN_HOUR, tz); }
    return cand.toISOString();
  }
  // weekly
  let dow = parseInt(day, 10); if (!Number.isInteger(dow)) dow = 1; // default Monday
  dow = Math.max(0, Math.min(6, dow));
  const delta = (dow - w.weekday + 7) % 7;
  cal.setUTCDate(cal.getUTCDate() + delta);
  let cand = at();
  if (delta === 0 && cand <= w.now) { cal.setUTCDate(cal.getUTCDate() + 7); cand = at(); }
  return cand.toISOString();
}

// The next_run_at for a (possibly partial) schedule: null when disabled.
function computeNextRun({ enabled, frequency, day, timezone }) {
  if (!enabled) return null;
  return nextRunISO(frequency, day, timezone);
}

// Merge a camelCase patch of watch fields over a current entity row, validate,
// and compute the resulting column values (including watch_next_run_at).
// `current` is the existing row (snake_case watch_* fields); `patch` may set any
// of watchEnabled/watchFrequency/watchDay/watchTimezone/watchEmailDigest.
// Returns { changed:false } when no watch field is present, { error } on bad
// input, else { changed:true, values:{ ...snake_case columns... } }.
function mergeWatchSchedule(current, patch) {
  const cur = current || {};
  const has = (k) => patch[k] !== undefined;
  if (!['watchEnabled', 'watchFrequency', 'watchDay', 'watchTimezone', 'watchEmailDigest'].some(has)) {
    return { changed: false };
  }
  const enabled = has('watchEnabled') ? !!patch.watchEnabled : !!cur.watch_enabled;
  const frequency = has('watchFrequency') ? String(patch.watchFrequency).toLowerCase() : (cur.watch_frequency || 'weekly');
  if (!isValidFrequency(frequency)) return { error: 'frequency must be daily, weekly or monthly' };
  const timezone = has('watchTimezone') ? String(patch.watchTimezone) : (cur.watch_timezone || 'UTC');
  if (!isValidTz(timezone)) return { error: 'timezone must be a valid IANA name (e.g. America/New_York)' };
  const emailDigest = has('watchEmailDigest') ? !!patch.watchEmailDigest : (cur.watch_email_digest !== false);

  let day;
  if (has('watchDay')) {
    day = normalizeWatchDay(frequency, patch.watchDay);
    if (day === null) return { error: frequency === 'monthly' ? 'day must be 1–28 for monthly' : 'day must be 0 (Sun) – 6 (Sat) for weekly' };
  } else {
    const reuse = normalizeWatchDay(frequency, cur.watch_day); // keep current if valid for the cadence
    day = reuse === null ? 1 : reuse;
  }

  return {
    changed: true,
    values: {
      watch_enabled: enabled,
      watch_frequency: frequency,
      watch_day: day,
      watch_timezone: timezone,
      watch_email_digest: emailDigest,
      watch_next_run_at: computeNextRun({ enabled, frequency, day, timezone }),
    },
  };
}

module.exports = {
  RUN_HOUR, FREQ_DAYS,
  isValidFrequency, isValidTz, normalizeWatchDay,
  nextRunISO, computeNextRun, mergeWatchSchedule,
};
