-- Persist the link between a scheduled_meetings row and the Microsoft Graph
-- event we created on the rep's calendar (via the "Generate Teams meeting"
-- modal). With these columns we can:
--   - PATCH /me/events/{ms_event_id} to update the meeting from GhostStream
--   - DELETE the event to cancel it
--   - Send proper RFC 5545 update / cancel .ics files (need ms_ical_uid for
--     the UID + ms_sequence for the SEQUENCE bump that tells Outlook "this
--     is an update, replace your previous copy")
--   - Set Reply-To on the SendGrid invite to the original organizer
--
-- Nullable on every column — most missions don't carry an MS-created meeting
-- (rep pasted a URL, mission imported from Calendly, etc.). Edit/Cancel UI
-- only renders when ms_event_id IS NOT NULL.
--
-- ms_attendee_emails carries the list the rep typed at create time so a
-- later "cancel" can deliver the cancellation .ics even if the rep changed
-- prospect_emails afterwards. Without it we'd risk dropping a "your meeting
-- was cancelled" message on someone who's no longer in prospect_emails.
--
-- See docs/adr/0002-microsoft-graph-direct.md §10 for the branded-sender
-- architecture this hooks into; §11 (forthcoming) for edit/cancel.

ALTER TABLE scheduled_meetings
  ADD COLUMN ms_event_id         text,
  ADD COLUMN ms_ical_uid         text,
  ADD COLUMN ms_organizer_email  text,
  ADD COLUMN ms_attendee_emails  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN ms_sequence         int    NOT NULL DEFAULT 0;

-- Lookup index for the forthcoming Graph subscription webhook that needs to
-- map an incoming event-change notification back to a mission. Partial so
-- the index only holds rows we actually need (the vast majority of meetings
-- won't have a Graph linkage).
CREATE INDEX scheduled_meetings_ms_event ON scheduled_meetings (ms_event_id)
  WHERE ms_event_id IS NOT NULL;
