-- Google counterpart to 0014's Microsoft linkage. Persists the link between a
-- scheduled_meetings row and the Google Calendar event we created on the rep's
-- calendar (via the "Generate Google Meet" modal). With these columns we can:
--   - PATCH /calendars/primary/events/{g_event_id} to update from GhostStream
--   - DELETE the event to cancel it
--   - Send proper RFC 5545 update / cancel .ics files (g_ical_uid for the UID,
--     g_sequence for the SEQUENCE bump that tells calendars "this is an update,
--     replace your previous copy")
--   - Set Reply-To on the SendGrid invite to the original organizer
--
-- Mirrors 0014_scheduled_meetings_ms_linkage.sql exactly (see ADR-0002 §10/§11
-- for the branded-sender architecture). A mission carries AT MOST one of the
-- ms_* / g_* sets — whichever provider generated the meeting. Both are nullable
-- because most missions carry neither (rep pasted a URL, Calendly import, etc.).
--
-- g_attendee_emails carries the list the rep typed at create time so a later
-- "cancel" can deliver the cancellation .ics even if prospect_emails changed.

ALTER TABLE scheduled_meetings
  ADD COLUMN g_event_id         text,
  ADD COLUMN g_ical_uid         text,
  ADD COLUMN g_organizer_email  text,
  ADD COLUMN g_attendee_emails  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN g_sequence         int    NOT NULL DEFAULT 0;

-- Lookup index for mapping a Google event id back to a mission (edit/cancel).
-- Partial so the index only holds rows that actually carry a Google linkage.
CREATE INDEX scheduled_meetings_g_event ON scheduled_meetings (g_event_id)
  WHERE g_event_id IS NOT NULL;
