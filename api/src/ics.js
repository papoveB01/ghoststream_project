// RFC 5545 .ics generator for calendar invites we send via SendGrid (instead
// of letting Microsoft Graph send them out from the rep's mailbox — that
// fight is lost the moment a tenant lands on Microsoft's outbound spam list,
// see ADR-0002 §10 + the 5.7.708 incident on 2026-05-29).
//
// Outlook is the strictest consumer; we target its quirks deliberately:
//   - CRLF line endings (\r\n), never bare \n
//   - line folding at 75 octets with a leading single space on continuation
//     lines (RFC 5545 §3.1)
//   - METHOD:REQUEST at VCALENDAR level so Outlook renders the
//     "Accept / Decline" affordance instead of treating it as a publish
//   - STATUS:CONFIRMED + DTSTAMP in UTC
//   - ORGANIZER as MAILTO with a CN= parameter
//   - ATTENDEE per recipient with PARTSTAT=NEEDS-ACTION + RSVP=TRUE +
//     ROLE=REQ-PARTICIPANT so Outlook surfaces the Tentative/Accept buttons
//   - SEQUENCE:0 on first send (bump if/when we ever support reschedule)
//
// Out of scope: VTIMEZONE blocks (we emit everything in UTC; clients render
// in the viewer's local zone), recurring events, attachments inside the ics.
// Anyone who needs a recurring series goes through Outlook directly.

// ── Primitive value escaping (RFC 5545 §3.3.11 TEXT value type) ───────────
// Order matters: escape backslashes first or they double up.
function escapeText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g,  '\\;')
    .replace(/,/g,  '\\,')
    .replace(/\r?\n/g, '\\n');
}

// ── UTC date-time format (RFC 5545 §3.3.5 — `YYYYMMDDTHHMMSSZ`) ───────────
function formatUTC(dt) {
  const d = (dt instanceof Date) ? dt : new Date(dt);
  if (isNaN(d.getTime())) throw new Error(`ics: invalid date ${dt}`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

// ── Line folding (RFC 5545 §3.1 — fold long lines at 75 octets) ──────────
// We fold by character (the inputs are ASCII-dominated so byte ≈ char in
// practice). Continuation lines begin with a single space.
function foldLine(line) {
  const max = 75;
  if (Buffer.byteLength(line, 'utf8') <= max) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    // Find the longest prefix whose UTF-8 byte length is <= max.
    let take = Math.min(max, line.length - i);
    while (Buffer.byteLength(line.slice(i, i + take), 'utf8') > max && take > 1) take--;
    out.push((i === 0 ? '' : ' ') + line.slice(i, i + take));
    i += take;
  }
  return out.join('\r\n');
}

// ── Address formatting ────────────────────────────────────────────────────
function addressLine(prop, params, email, name) {
  // CN parameter is optional but Outlook renders it nicely when present.
  const paramParts = [...params];
  if (name) paramParts.push(`CN=${escapeText(name)}`);
  const left = `${prop}${paramParts.length ? ';' + paramParts.join(';') : ''}`;
  const right = `MAILTO:${String(email).trim()}`;
  return foldLine(`${left}:${right}`);
}

// ── Build one VEVENT — the whole .ics body ────────────────────────────────
//
// opts shape:
//   uid          stable globally-unique identifier (e.g. graph eventId@host)
//   subject      event title (escaped)
//   description  long body (markdown-ish; we render line breaks)
//   location     usually the joinUrl so calendar UIs surface it as the link
//   start, end   Date | ISO string in any timezone — converted to UTC
//   organizer    { email, name }
//   attendees    [{ email, name? }]
//   sequence     bump on reschedule (default 0)
//   method       VCALENDAR METHOD (default REQUEST)
//   prodId       VCALENDAR PRODID (default our user agent)
//
function buildInvite(opts = {}) {
  const {
    uid,
    subject = 'GhostStream meeting',
    description = '',
    location = '',
    start,
    end,
    organizer,
    attendees = [],
    sequence = 0,
    method = 'REQUEST',
    prodId = '-//GhostStream//Meeting Invite//EN',
  } = opts;

  if (!uid) throw new Error('ics: uid is required');
  if (!start || !end) throw new Error('ics: start and end are required');
  if (!organizer || !organizer.email) throw new Error('ics: organizer.email is required');

  const lines = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push(`PRODID:${prodId}`);
  lines.push('CALSCALE:GREGORIAN');
  lines.push(`METHOD:${method}`);
  lines.push('BEGIN:VEVENT');
  lines.push(foldLine(`UID:${uid}`));
  lines.push(`DTSTAMP:${formatUTC(new Date())}`);
  lines.push(`DTSTART:${formatUTC(start)}`);
  lines.push(`DTEND:${formatUTC(end)}`);
  lines.push(`SEQUENCE:${sequence}`);
  // STATUS:CANCELLED is what tells Outlook + Gmail to remove the event from
  // the recipient's calendar when paired with METHOD:CANCEL. For
  // REQUEST/PUBLISH we use CONFIRMED so clients render the event normally.
  lines.push(`STATUS:${method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`);
  lines.push('TRANSP:OPAQUE');
  lines.push(foldLine(`SUMMARY:${escapeText(subject)}`));
  if (description) lines.push(foldLine(`DESCRIPTION:${escapeText(description)}`));
  // X-ALT-DESC carries an HTML version Outlook picks up when present —
  // useful for clickable Teams join button. Kept optional; only emit when the
  // description has any HTML-ish content (we render minimal HTML).
  if (description && /<[a-z]/i.test(description)) {
    lines.push(foldLine(`X-ALT-DESC;FMTTYPE=text/html:${escapeText(description)}`));
  }
  if (location) lines.push(foldLine(`LOCATION:${escapeText(location)}`));
  // URL property — distinct from LOCATION; some clients (Apple Calendar) show it.
  if (location && /^https?:\/\//i.test(location)) {
    lines.push(foldLine(`URL:${location}`));
  }
  lines.push(addressLine('ORGANIZER', [], organizer.email, organizer.name));
  for (const a of attendees) {
    if (!a || !a.email) continue;
    lines.push(addressLine('ATTENDEE',
      ['CUTYPE=INDIVIDUAL', 'ROLE=REQ-PARTICIPANT', 'PARTSTAT=NEEDS-ACTION', 'RSVP=TRUE'],
      a.email, a.name));
  }
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  // RFC 5545 mandates CRLF; bare \n in some clients silently drops trailing props.
  return lines.join('\r\n') + '\r\n';
}

// Convenience: wrap buildInvite into a SendGrid-compatible attachment shape.
function asAttachment(ics, filename = 'invite.ics') {
  return {
    filename,
    // SendGrid's REST API rejects MIME-type parameters in the attachment
    // `type` field ("The attachment type cannot contain ';', or CRLF
    // characters."), so we use a bare type here. That's fine — Outlook,
    // Gmail, and Apple Calendar all parse the METHOD from the VCALENDAR body
    // itself (we emit METHOD:REQUEST at line 5 of every invite), not from
    // the Content-Type parameter. The .ics extension is also a strong signal
    // that downstream clients rely on.
    type: 'text/calendar',
    content: Buffer.from(ics, 'utf8').toString('base64'),
    disposition: 'attachment',
  };
}

module.exports = {
  buildInvite,
  asAttachment,
  // Exported for unit testing.
  _internals: { escapeText, formatUTC, foldLine, addressLine },
};
