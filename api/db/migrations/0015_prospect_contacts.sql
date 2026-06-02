-- Prospect contacts: the actual humans on the buyer side of a deal.
--
-- Today the system knows:
--   - WHICH company the rep is selling to (companies row, scope=PROSPECT)
--   - WHAT abstract persona types exist (personas table — "CFO", "Head of
--     Fraud") — used for KB tagging
--
-- It does NOT know who specifically the rep is meeting with. Every mission
-- carries scheduled_meetings.prospect_emails as a bare text[], which means
-- the rep retypes the same emails on every call, the brief pipeline has no
-- way to address attendees by name, and there's no place to manage the
-- buyer-side roster.
--
-- prospect_contacts fills the gap: one row per (company, person), with
-- Name / Email / Role per the product requirement. role is free-text
-- ("Head of Procurement") but we also store an optional persona_id FK so a
-- CFO contact can pull persona-scoped KB chunks for free during retrieval.
-- The link is auto-inferred from the role text (case-insensitive match
-- against personas.name) at write time and surfaceable in the UI for the
-- rep to override.
--
-- mission_contacts joins specific contacts to specific missions, so portals
-- and post-call analytics can answer "what % of CFO meetings closed".
--
-- See docs/adr/0002 §11 (forthcoming).

CREATE TABLE prospect_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id)   ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  email       text NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role        text NOT NULL DEFAULT 'Unknown' CHECK (char_length(role) BETWEEN 1 AND 100),
  persona_id  text REFERENCES personas(id) ON DELETE SET NULL,
  title       text,
  notes       text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One email per tenant — same person at two prospect companies in the same
-- tenant collapses to one record. Tenant-scoped so two tenants can each
-- have a Jane Smith without colliding.
CREATE UNIQUE INDEX prospect_contacts_tenant_email
  ON prospect_contacts (tenant_id, lower(email));
CREATE INDEX prospect_contacts_company ON prospect_contacts (company_id);
CREATE INDEX prospect_contacts_persona ON prospect_contacts (persona_id)
  WHERE persona_id IS NOT NULL;

-- Bridge: which contacts were on each scheduled meeting. Replaces (over
-- time) the meaning of scheduled_meetings.prospect_emails — the text[]
-- stays as a denormalised cache for legacy callers but the canonical answer
-- becomes "join scheduled_meetings → mission_contacts → prospect_contacts".
CREATE TABLE mission_contacts (
  meeting_id uuid NOT NULL REFERENCES scheduled_meetings(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES prospect_contacts(id)  ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, contact_id)
);
CREATE INDEX mission_contacts_contact ON mission_contacts (contact_id);

-- Backfill: for every existing mission, create a stub contact for each
-- unique email in prospect_emails and link it. The stub has name = local
-- part of the email and role = 'Unknown' so the Prospects UI doesn't
-- render an empty roster on day one. The rep can edit names/roles later.
--
-- Note the ON CONFLICT clause: if a mission has two emails with the same
-- (tenant, lower(email)) — e.g. same person on two missions — we reuse the
-- existing contact and just add the mission_contacts join row.
INSERT INTO prospect_contacts (tenant_id, company_id, name, email, role, created_at, updated_at)
SELECT DISTINCT
  m.tenant_id,
  m.company_id,
  split_part(em, '@', 1) AS name,
  em AS email,
  'Unknown' AS role,
  now(), now()
FROM scheduled_meetings m
CROSS JOIN LATERAL unnest(m.prospect_emails) AS em
WHERE m.company_id IS NOT NULL
  AND em IS NOT NULL
  AND em ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
ON CONFLICT (tenant_id, lower(email)) DO NOTHING;

INSERT INTO mission_contacts (meeting_id, contact_id)
SELECT m.id, pc.id
FROM scheduled_meetings m
CROSS JOIN LATERAL unnest(m.prospect_emails) AS em
JOIN prospect_contacts pc
  ON pc.tenant_id = m.tenant_id
 AND lower(pc.email) = lower(em)
WHERE m.company_id IS NOT NULL
  AND em IS NOT NULL
  AND em ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
ON CONFLICT DO NOTHING;
