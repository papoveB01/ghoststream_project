-- Store the assembled global-cache text alongside the Gemini cache pointer so
-- the Arena can inject it inline into the persona grounding (which is needed
-- because Gemini only accepts ONE cachedContent per request, and the Arena
-- already uses its slot for the persona cache).

ALTER TABLE kb_global_cache
  ADD COLUMN content_text   text,
  ADD COLUMN char_count     bigint NOT NULL DEFAULT 0;
