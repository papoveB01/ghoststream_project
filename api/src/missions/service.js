// Mission ("scheduled meeting") CRUD — per-tenant. Each mission carries:
//   - a company reference (find-or-created within the tenant)
//   - the scheduled-at timestamp
//   - the meeting URL (Zoom/Meet/Teams — pasted by the rep)
//   - prospect emails for future social-handle resolution
//   - engagement scope as 3 junction tables (products/personas/competitors)
//
// Every query is scoped by tenant_id. The service does NOT generate briefs —
// that lives in brief.js, triggered by the T-24h scheduler or on-demand.

const db = require('../db');
const companies = require('../companies');

// Mirror of the kb_documents tag-agg JOIN — pulls product/persona/competitor
// arrays for a mission row without an N+1.
const TAG_AGG_JOIN = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(product_id ORDER BY product_id), '[]') AS product_ids
      FROM scheduled_meeting_products WHERE meeting_id = m.id
  ) pj ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(persona_id ORDER BY persona_id), '[]') AS persona_ids
      FROM scheduled_meeting_personas WHERE meeting_id = m.id
  ) sj ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(json_agg(competitor_id ORDER BY competitor_id), '[]') AS competitor_ids
      FROM scheduled_meeting_competitors WHERE meeting_id = m.id
  ) cj ON TRUE
`;

const SELECT_COLUMNS = `
  m.id, m.tenant_id, m.scheduled_at, m.meeting_url, m.prospect_emails, m.status,
  m.recall_bot_id, m.portal_id, m.brief_id, m.brief_error, m.notes,
  m.created_at, m.updated_at,
  m.ms_event_id, m.ms_ical_uid, m.ms_organizer_email, m.ms_attendee_emails, m.ms_sequence,
  c.id AS company_id, c.name AS company_name, c.domain AS company_domain,
  pj.product_ids, sj.persona_ids, cj.competitor_ids
`;

// Public-mail providers we never want to use as a "company domain" — the
// person `bill@gmail.com` doesn't tell us anything about Acme. If every
// attendee email is from a public provider, we just leave the domain blank.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me', 'pm.me', 'gmx.com', 'gmx.de',
  'zoho.com', 'fastmail.com', 'tutanota.com', 'mail.com', 'yandex.com',
  'qq.com', '163.com', '126.com', 'sina.com',
]);

// Pick the first non-public domain from a list of attendee emails. Returns
// null if every email is from a public provider (or the list is empty).
function deriveDomainFromEmails(emails) {
  for (const e of emails) {
    const at = e.lastIndexOf('@');
    if (at < 0) continue;
    const dom = e.slice(at + 1).toLowerCase().trim();
    if (dom && !PUBLIC_EMAIL_DOMAINS.has(dom)) return dom;
  }
  return null;
}

async function schedule(tenantId, {
  companyName, companyDomain, primaryContact,
  scheduledAt, meetingUrl, prospectEmails,
  productIds, personaIds, competitorIds,
  notes,
  // Optional Microsoft Graph linkage — set when the rep generated the Teams
  // meeting from the "🎥 Generate Teams meeting" modal. Lets edit/cancel
  // operate on the mission later. See ADR-0002 §10/§11.
  msEventId, msIcalUid, msOrganizerEmail,
}) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  if (!companyName) {
    const err = new Error('companyName required'); err.status = 400; throw err;
  }
  if (!scheduledAt) {
    const err = new Error('scheduledAt required (ISO timestamp)'); err.status = 400; throw err;
  }

  const emails = Array.isArray(prospectEmails)
    ? prospectEmails.filter((e) => typeof e === 'string' && e.includes('@'))
    : [];

  // If the rep didn't type a domain but gave attendee emails, derive it from
  // the first non-public-provider address — saves the typing AND unlocks the
  // Live Pulse scrape (brief.js needs a domain to fire it).
  const effectiveDomain = (companyDomain && companyDomain.trim())
    || deriveDomainFromEmails(emails)
    || null;

  const company = await companies.findOrCreate(tenantId, {
    name: companyName,
    domain: effectiveDomain,
    primaryContact,
  });

  let missionId;
  await db.withTx(async (client) => {
    // ms_attendee_emails defaults to prospect_emails at create time so a
    // later "cancel" still knows whom to notify even if the rep edited
    // prospect_emails in between.
    const r = await client.query(
      `INSERT INTO scheduled_meetings
         (tenant_id, company_id, scheduled_at, meeting_url, prospect_emails, notes,
          ms_event_id, ms_ical_uid, ms_organizer_email, ms_attendee_emails)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        tenantId, company.id, scheduledAt, meetingUrl || null, emails, notes || null,
        msEventId || null, msIcalUid || null, msOrganizerEmail || null,
        msEventId ? emails : [],
      ]
    );
    missionId = r.rows[0].id;
    await insertTags(client, 'scheduled_meeting_products',    'product_id',    missionId, productIds);
    await insertTags(client, 'scheduled_meeting_personas',    'persona_id',    missionId, personaIds);
    await insertTags(client, 'scheduled_meeting_competitors', 'competitor_id', missionId, competitorIds);
  });

  // Auto-create stub contacts for any prospect emails that don't have one,
  // and link them to the mission. The Prospects UI surfaces them as
  // editable rows so the rep can fill in name/role later. Lazy-require to
  // avoid an import cycle with contacts.js → db.js → … (none today but
  // keeps the door open).
  if (emails.length > 0) {
    const contacts = require('../contacts');
    const linked = [];
    for (const em of emails) {
      try {
        const c = await contacts.findOrCreateStub(tenantId, company.id, em);
        if (c) linked.push(c.id);
      } catch (e) { /* non-fatal — mission still saves */ }
    }
    if (linked.length) {
      try { await contacts.linkContactsToMission(tenantId, missionId, linked); }
      catch (e) { /* non-fatal */ }
    }
  }

  // Same-day briefing: the T-24h cron (scheduler.js#findDueMissions) only fires
  // for missions whose scheduled_at falls inside (now+23h, now+25h]. A mission
  // booked for <23h from now would otherwise NEVER be picked up — the cron
  // window has already moved past it. Fire-and-forget here so the HTTP
  // response isn't blocked on Gemini (~10-30s). brief.generate is async-safe:
  // it manages its own status transitions (PENDING → BRIEFED|FAILED) and
  // records errors via setBriefError so the admin UI surfaces failures.
  //
  // We use `< LOOKAHEAD_END_HOURS` to match the upper bound of the cron's
  // window — anything closer than that, we eagerly handle ourselves. If the
  // mission is also in the cron's [23h, 25h] band, the cron may also fire;
  // a duplicate run produces a second pre_call_briefs row (the table is
  // 1:many by design) and is harmless beyond a wasted Gemini call.
  const inlineLookaheadHours = parseFloat(process.env.BRIEF_LOOKAHEAD_END_HOURS || '25');
  const hoursUntilCall = (new Date(scheduledAt).getTime() - Date.now()) / 3600000;
  if (Number.isFinite(hoursUntilCall) && hoursUntilCall < inlineLookaheadHours) {
    // Lazy require to dodge the missions/brief → missions/service circular import.
    const brief = require('./brief');
    brief.generate(missionId, tenantId).catch((err) => {
      console.warn(`[missions] inline brief generation failed for mission ${missionId}: ${err.message}`);
    });
  }

  return get(tenantId, missionId);
}

async function insertTags(client, table, idColumn, missionId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const unique = [...new Set(ids.filter((v) => typeof v === 'string' && v.length > 0))];
  for (const id of unique) {
    await client.query(
      `INSERT INTO ${table} (meeting_id, ${idColumn})
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [missionId, id]
    );
  }
}

async function get(tenantId, id) {
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM scheduled_meetings m
       LEFT JOIN companies c ON c.id = m.company_id
       ${TAG_AGG_JOIN}
      WHERE m.id = $1 AND m.tenant_id = $2`,
    [id, tenantId]
  );
  return r.rows[0] || null;
}

async function list(tenantId, { status, when = 'all', limit = 100 } = {}) {
  if (!tenantId) { const e = new Error('tenantId required'); e.status = 400; throw e; }
  const where = ['m.tenant_id = $1'];
  const params = [tenantId];
  if (status) {
    params.push(status);
    where.push(`m.status = $${params.length}`);
  }
  if (when === 'upcoming') {
    where.push(`m.scheduled_at >= now() AND m.status NOT IN ('CANCELLED','COMPLETED')`);
  } else if (when === 'past') {
    where.push(`(m.scheduled_at < now() OR m.status IN ('COMPLETED','CANCELLED'))`);
  }
  params.push(limit);
  const r = await db.query(
    `SELECT ${SELECT_COLUMNS}
       FROM scheduled_meetings m
       LEFT JOIN companies c ON c.id = m.company_id
       ${TAG_AGG_JOIN}
      WHERE ${where.join(' AND ')}
      ORDER BY m.scheduled_at ASC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

async function cancel(tenantId, id) {
  const r = await db.query(
    `UPDATE scheduled_meetings
        SET status = 'CANCELLED', updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('COMPLETED','CANCELLED')
      RETURNING id`,
    [id, tenantId]
  );
  return r.rowCount > 0;
}

async function setBrief(tenantId, missionId, briefId) {
  await db.query(
    `UPDATE scheduled_meetings
        SET brief_id = $1, status = 'BRIEFED', brief_error = NULL, updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [briefId, missionId, tenantId]
  );
}

async function setBriefError(tenantId, missionId, message) {
  await db.query(
    `UPDATE scheduled_meetings
        SET status = 'FAILED', brief_error = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [String(message).slice(0, 1000), missionId, tenantId]
  );
}

async function setRecallBotId(tenantId, missionId, botId) {
  await db.query(
    `UPDATE scheduled_meetings
        SET recall_bot_id = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [botId, missionId, tenantId]
  );
}

// Close the loop when a call's analysis portal is created: flip the engagement to
// COMPLETED and record the portal_id, so a past engagement knows about (and can
// surface) its recording. (Previously never written — status stuck at BRIEFED.)
async function markCompleted(tenantId, missionId, portalId) {
  await db.query(
    `UPDATE scheduled_meetings
        SET status = 'COMPLETED', portal_id = $1, updated_at = now()
      WHERE id = $2 AND tenant_id = $3`,
    [portalId, missionId, tenantId]
  );
}

// Engagement-profile triplet derived from THIS mission's tags. Pure function
// — no DB. Used to scope retrieval during brief generation. Returns arrays;
// empty arrays mean "no filter" on that dimension at retrieval time. The
// per-rep "engagement profile" page is gone — a mission's own tags are the
// only source of scoping, supplemented by the schedule form's "Snap"
// auto-fill from the last mission against the same prospect.
function profileFromMission(mission) {
  return {
    productIds:    Array.isArray(mission.product_ids)    ? mission.product_ids    : [],
    personaIds:    Array.isArray(mission.persona_ids)    ? mission.persona_ids    : [],
    competitorIds: Array.isArray(mission.competitor_ids) ? mission.competitor_ids : [],
  };
}

module.exports = {
  schedule, get, list, cancel,
  setBrief, setBriefError, setRecallBotId, markCompleted,
  profileFromMission,
};
