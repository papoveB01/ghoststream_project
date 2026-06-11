// Dashboard — the tenant "sales cockpit" aggregate behind the Overview page.
// One round-trip: KPIs + priority opportunities + upcoming engagements + a
// foundation-health snapshot. All queries are scoped by req.tenantId.

const express = require('express');
const db = require('./db');
const tenants = require('./tenants');
const entitlements = require('./entitlements');
const usage = require('./usage');

const router = express.Router();

const STRENGTH_RANK = { strong: 3, tie: 2, weak: 1 };
const CRM_LABELS = { hubspot: 'HubSpot', salesforce: 'Salesforce', zoho: 'Zoho CRM', pipedrive: 'Pipedrive', dynamics: 'Dynamics 365' };

// Metered features → human label, in display order. The meter set follows the
// tenant's plan-catalog version: v2 (ADR-0004) merges discovery + competitor
// research into one `research` pool — the gauges must read the SAME keys the
// caps and usage counters use, or the dashboard shows 0/∞ while the tenant is
// actually capped out (the original bug).
const METER_LABELS = {
  research: 'Research',
  discovery: 'Discovery',
  competitor_research: 'Competitor research',
  engagements: 'Engagements',
  arena: 'Arena practice',
  market_monitoring: 'Market Watch',
};
const METER_ORDER_V1 = ['discovery', 'competitor_research', 'engagements', 'arena', 'market_monitoring'];
const METER_ORDER_V2 = ['research', 'engagements', 'arena', 'market_monitoring'];

router.get('/', async (req, res, next) => {
  try {
    const t = req.tenantId;
    // Tenant row first (resolves plan/caps + parent inheritance for the usage
    // gauges); cached, so this is effectively free on the hot path.
    const tenantRow = await tenants.get(t);
    const ent = await entitlements.resolveEntitlementsFor(tenantRow);
    const [usedSummary, prospectsR, prodR, persR, compR, compIntelR, intelR, engCountR, profR, oppR, engR, crmR, upcR, freshR, namesR, setupR, contactsByCoR, trendR] = await Promise.all([
      usage.summary(t, { lifetime: ent.lifetimeCaps }),
      db.query(`SELECT count(*)::int AS total,
                       count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_week
                  FROM companies WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM personas WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM competitors WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(DISTINCT j.competitor_id)::int AS n
                  FROM kb_document_competitors j JOIN kb_documents d ON d.id = j.document_id
                 WHERE d.tenant_id = $1 AND d.status = 'READY'
                   AND COALESCE(d.metadata->>'competitorProductId', '') = ''
                   AND COALESCE(d.metadata->>'relevanceVerified', 'true') <> 'false'
                   AND COALESCE(d.metadata->>'isBattlecardSnapshot', '') <> 'true'`, [t]),
      db.query(`SELECT count(*)::int AS n FROM kb_documents WHERE tenant_id = $1 AND scope = 'TENANT' AND status = 'READY'`, [t]),
      db.query(`SELECT count(*)::int AS n FROM scheduled_meetings
                 WHERE tenant_id = $1 AND status IN ('PENDING','BRIEFED')
                   AND scheduled_at >= now() AND scheduled_at < now() + interval '7 days'`, [t]),
      db.query(`SELECT positioning, objectives FROM tenant_profiles WHERE tenant_id = $1`, [t]),
      db.query(`SELECT DISTINCT ON (pr.company_id) pr.company_id, c.name AS company_name, pr.opportunities, pr.created_at
                  FROM prospect_research pr JOIN companies c ON c.id = pr.company_id
                 WHERE pr.tenant_id = $1 AND pr.status = 'DONE' AND jsonb_array_length(pr.opportunities) > 0
                 ORDER BY pr.company_id, pr.created_at DESC`, [t]),
      db.query(`SELECT sm.id, sm.scheduled_at, sm.status, sm.company_id, sm.prospect_emails, c.name AS company_name
                  FROM scheduled_meetings sm LEFT JOIN companies c ON c.id = sm.company_id
                 WHERE sm.tenant_id = $1 AND sm.status IN ('PENDING','BRIEFED') AND sm.scheduled_at >= now()
                 ORDER BY sm.scheduled_at ASC LIMIT 8`, [t]),
      db.query(`SELECT provider, status FROM crm_connections WHERE tenant_id = $1 ORDER BY updated_at DESC`, [t]),
      // Per-company upcoming engagements + unreviewed market developments —
      // inputs to the Top prospects "account heat" composite.
      db.query(`SELECT company_id, count(*)::int AS n FROM scheduled_meetings
                 WHERE tenant_id = $1 AND status IN ('PENDING','BRIEFED') AND scheduled_at >= now()
                   AND company_id IS NOT NULL
                 GROUP BY company_id`, [t]),
      db.query(`SELECT subject_id, count(*)::int AS n FROM watch_findings
                 WHERE tenant_id = $1 AND scope = 'PROSPECT' AND status = 'NEW'
                 GROUP BY subject_id`, [t]),
      db.query(`SELECT id, name FROM companies WHERE tenant_id = $1`, [t]),
      // Setup-checklist facts: any completed research, any saved contact, any
      // engagement ever scheduled, any Market Watch enabled anywhere.
      db.query(`SELECT
          (SELECT count(*)::int FROM prospect_research WHERE tenant_id = $1 AND status = 'DONE') AS research_done,
          (SELECT count(*)::int FROM prospect_contacts WHERE tenant_id = $1) AS contacts,
          (SELECT count(*)::int FROM scheduled_meetings WHERE tenant_id = $1) AS meetings_ever,
          ((SELECT count(*) FROM companies   WHERE tenant_id = $1 AND watch_enabled)
         + (SELECT count(*) FROM competitors WHERE tenant_id = $1 AND watch_enabled))::int AS watched,
          (SELECT count(*)::int FROM watch_findings WHERE tenant_id = $1 AND status = 'NEW') AS new_alerts`, [t]),
      db.query(`SELECT company_id, count(*)::int AS n FROM prospect_contacts WHERE tenant_id = $1 GROUP BY company_id`, [t]),
      // New prospects per ISO week for the last 8 weeks (gaps filled with 0 so
      // the sparkline always has a fixed-width 8-bar series).
      db.query(`SELECT to_char(g.wk, 'YYYY-MM-DD') AS week, COALESCE(c.n, 0)::int AS count
                  FROM generate_series(date_trunc('week', now()) - interval '7 weeks',
                                       date_trunc('week', now()), interval '1 week') AS g(wk)
                  LEFT JOIN (
                    SELECT date_trunc('week', created_at) AS wk, count(*)::int AS n
                      FROM companies
                     WHERE tenant_id = $1 AND created_at >= date_trunc('week', now()) - interval '7 weeks'
                     GROUP BY 1
                  ) c ON c.wk = g.wk
                 ORDER BY g.wk`, [t]),
    ]);

    const tenant = tenantRow || {};
    let daysLeft = null;
    if (tenant.trial_ends_at) {
      daysLeft = Math.max(0, Math.ceil((new Date(tenant.trial_ends_at).getTime() - Date.now()) / 86400000));
    }

    // Flatten the latest-per-company opportunities into a single ranked feed.
    const allOpps = [];
    for (const row of oppR.rows) {
      const opps = Array.isArray(row.opportunities) ? row.opportunities : [];
      for (const o of opps) {
        if (!o) continue;
        allOpps.push({
          companyId: row.company_id,
          companyName: row.company_name,
          title: o.title || 'Opportunity',
          strength: o.strength || null,
          analysis: o.analysis || '',
          products: Array.isArray(o.products) ? o.products : [],
          pinned: !!o.pinned,
          at: row.created_at,
        });
      }
    }
    const openSignals = allOpps.length;
    // Strength mix for the opportunity donut.
    const strengthBreakdown = { strong: 0, tie: 0, weak: 0 };
    for (const o of allOpps) { if (strengthBreakdown[o.strength] != null) strengthBreakdown[o.strength]++; }
    allOpps.sort((a, b) => {
      const ra = (a.pinned ? 10 : 0) + (STRENGTH_RANK[a.strength] || 0);
      const rb = (b.pinned ? 10 : 0) + (STRENGTH_RANK[b.strength] || 0);
      if (rb !== ra) return rb - ra;
      return new Date(b.at).getTime() - new Date(a.at).getTime();
    });
    const opportunities = allOpps.slice(0, 12);

    // Top prospects — composite "account heat": strong signals weigh 3, other
    // signals 1, upcoming engagements 2, fresh (unreviewed) developments 2.
    const heatBy = new Map();
    const heatRow = (id) => {
      if (!heatBy.has(id)) heatBy.set(id, { companyId: id, signals: 0, strong: 0, upcoming: 0, fresh: 0 });
      return heatBy.get(id);
    };
    for (const o of allOpps) {
      if (!o.companyId) continue;
      const h = heatRow(o.companyId);
      h.signals++; if (o.strength === 'strong') h.strong++;
    }
    for (const r of upcR.rows) heatRow(r.company_id).upcoming = r.n;
    for (const r of freshR.rows) heatRow(r.subject_id).fresh = r.n;
    const nameById = new Map(namesR.rows.map((r) => [r.id, r.name]));
    const topProspects = [...heatBy.values()]
      .map((h) => ({ ...h, name: nameById.get(h.companyId) || 'Unknown', heat: h.strong * 3 + (h.signals - h.strong) + h.upcoming * 2 + h.fresh * 2 }))
      .filter((h) => h.heat > 0 && nameById.has(h.companyId))
      .sort((a, b) => b.heat - a.heat || b.strong - a.strong)
      .slice(0, 6);

    const engagements = engR.rows.map((r) => ({
      id: r.id,
      companyId: r.company_id,
      scheduledAt: r.scheduled_at,
      status: r.status,
      companyName: r.company_name || (Array.isArray(r.prospect_emails) && r.prospect_emails[0]) || 'Prospect',
    }));

    const prof = profR.rows[0] || {};
    const crmRow = (crmR.rows || []).find((r) => r.status === 'connected') || (crmR.rows || [])[0] || null;

    // Usage gauges — one per metered feature the plan unlocks. cap === null
    // means unlimited (Enterprise/Internal) → the client shows a count, not a gauge.
    const entJson = entitlements.toJson(ent);
    // A meter is shown when the plan actually defines capacity for it
    // (cap > 0, or null = unlimited). Filtering by feature flags broke on v2,
    // where `research` is a meter but not a feature.
    const order = (ent.planVersion || 1) >= 2 ? METER_ORDER_V2 : METER_ORDER_V1;
    const meters = order
      .filter((m) => entJson.caps[m] === null || entJson.caps[m] > 0)
      .map((m) => ({ key: m, label: METER_LABELS[m], used: usedSummary[m] || 0, cap: entJson.caps[m] }));

    // "Get set up" checklist — the visible journey. Each step is derivable, so
    // it stays truthful without any per-user state to maintain.
    const su = setupR.rows[0] || {};
    const profileSet = !!((prof.positioning && prof.positioning.trim()) || (prof.objectives && prof.objectives.trim()));
    const checklist = [
      { key: 'foundation', label: 'Ground your workspace — positioning + products', done: profileSet && prodR.rows[0].n > 0, goto: 'company' },
      { key: 'discover',   label: 'Find your first prospects',                      done: prospectsR.rows[0].total > 0,       goto: 'prospects', pmode: 'discover' },
      { key: 'research',   label: 'Research one prospect (signals & why-now)',      done: (su.research_done || 0) > 0,        goto: 'prospects' },
      { key: 'contacts',   label: 'Find the decision-makers',                       done: (su.contacts || 0) > 0,             goto: 'prospects' },
      { key: 'engage',     label: 'Schedule your first AI-joined call',             done: (su.meetings_ever || 0) > 0,        goto: 'missions', mtab: 'schedule' },
      { key: 'watch',      label: 'Turn on Market Watch for a key account',         done: (su.watched || 0) > 0,              goto: 'prospects' },
    ];

    // Next best action — ONE computed move, picked by value. Only offered once
    // the basic journey is underway (the checklist owns the cold start).
    let nextAction = null;
    {
      const contactsByCo = new Map(contactsByCoR.rows.map((r) => [r.company_id, r.n]));
      const watchedRows = (await db.query(`SELECT id FROM companies WHERE tenant_id = $1 AND watch_enabled`, [t])).rows;
      const watchedSet = new Set(watchedRows.map((r) => r.id));
      const hot = topProspects[0] || null;
      const strongNoContacts = topProspects.find((h) => h.strong > 0 && !(contactsByCo.get(h.companyId) > 0));
      const strongNoCall = topProspects.find((h) => h.strong > 0 && (contactsByCo.get(h.companyId) > 0) && h.upcoming === 0);
      if (strongNoContacts) {
        nextAction = { text: `${strongNoContacts.name} has ${strongNoContacts.strong} strong signal${strongNoContacts.strong === 1 ? '' : 's'} and no contacts on file.`, label: 'Find decision-makers →', goto: 'prospects', companyId: strongNoContacts.companyId };
      } else if (strongNoCall) {
        nextAction = { text: `${strongNoCall.name} is hot (${strongNoCall.strong} strong signal${strongNoCall.strong === 1 ? '' : 's'}) with contacts ready — no call scheduled yet.`, label: 'Schedule the call →', goto: 'missions', mtab: 'schedule' };
      } else if ((su.new_alerts || 0) > 0) {
        nextAction = { text: `${su.new_alerts} new market development${su.new_alerts === 1 ? '' : 's'} await review.`, label: 'Review alerts →', goto: 'market-signals' };
      } else if (hot && !watchedSet.has(hot.companyId)) {
        nextAction = { text: `${hot.name} is your hottest account but isn't being monitored.`, label: 'Turn on Market Watch →', goto: 'prospects', companyId: hot.companyId };
      } else if (prospectsR.rows[0].total > 0 && prospectsR.rows[0].total < 10) {
        nextAction = { text: 'Your pipeline is thin — discovery finds buyers matched to your ICP.', label: 'Discover prospects →', goto: 'prospects', pmode: 'discover' };
      }
    }

    res.json({
      tenant: { name: tenant.name || 'your company', plan: tenant.subscription_status || 'TRIAL', planName: entJson.planName, trialEndsAt: tenant.trial_ends_at || null, daysLeft },
      checklist,
      nextAction,
      kpis: {
        prospects: prospectsR.rows[0].total,
        prospectsNewWeek: prospectsR.rows[0].new_week,
        openSignals,
        competitors: compR.rows[0].n,
        engagementsNext7d: engCountR.rows[0].n,
      },
      opportunities,
      topProspects,
      engagements,
      usage: { lifetime: ent.lifetimeCaps, meters },
      strengthBreakdown,
      prospectTrend: trendR.rows,
      foundation: {
        profileSet: !!((prof.positioning && prof.positioning.trim()) || (prof.objectives && prof.objectives.trim())),
        products: prodR.rows[0].n,
        personas: persR.rows[0].n,
        competitors: compR.rows[0].n,
        competitorsWithIntel: compIntelR.rows[0].n,
        intelDocs: intelR.rows[0].n,
        crm: crmRow ? (CRM_LABELS[crmRow.provider] || crmRow.provider) : null,
      },
    });
  } catch (err) { next(err); }
});

// GET /dashboard/setup — the "Get up to speed" gate state. Light version of
// the Overview checklist (keep step definitions in sync with the route above):
// the first FOUR steps gate the app for new workspaces; 5-6 stay advisory.
router.get('/setup', async (req, res, next) => {
  try {
    const t = req.tenantId;
    const [prof, prods, prospects, research, contacts] = await Promise.all([
      db.query(`SELECT positioning, objectives FROM tenant_profiles WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM companies WHERE tenant_id = $1`, [t]),
      db.query(`SELECT count(*)::int AS n FROM prospect_research WHERE tenant_id = $1 AND status = 'DONE'`, [t]),
      db.query(`SELECT count(*)::int AS n FROM prospect_contacts WHERE tenant_id = $1`, [t]),
    ]);
    const p = prof.rows[0] || {};
    const profileSet = !!((p.positioning && p.positioning.trim()) || (p.objectives && p.objectives.trim()));
    const steps = [
      { key: 'foundation', label: 'Ground your workspace — positioning + products', done: profileSet && prods.rows[0].n > 0 },
      { key: 'discover',   label: 'Find your first prospects',                      done: prospects.rows[0].n > 0 },
      { key: 'research',   label: 'Research one prospect (signals & why-now)',      done: research.rows[0].n > 0 },
      { key: 'contacts',   label: 'Find the decision-makers',                       done: contacts.rows[0].n > 0 },
    ];
    res.json({ steps, gateComplete: steps.every((x) => x.done) });
  } catch (err) { next(err); }
});

module.exports = { router };
