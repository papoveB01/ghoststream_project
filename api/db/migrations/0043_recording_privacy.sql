-- Recording privacy controls (a beta customer flagged indefinite video
-- retention as a privacy concern). Per-tenant settings:
--
--   recording_video_enabled  — when false, the notetaker still joins and
--                              transcribes (sales intel is unaffected) but NO
--                              video is stored on our side. "Capture the
--                              meeting without keeping a recording."
--   recording_notice_enabled — post a recording/transcription notice to
--                              participants when the bot joins (consent/notice).
--   recording_notice         — custom notice text; NULL → the default message.
--   recording_retention_days — auto-purge stored video older than N days
--                              (transcript + portal text are kept). Default 30
--                              replaces the previous indefinite retention; NULL
--                              means keep indefinitely (explicit opt-in).
ALTER TABLE tenants
  ADD COLUMN recording_video_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN recording_notice_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN recording_notice         text,
  ADD COLUMN recording_retention_days integer DEFAULT 30;
