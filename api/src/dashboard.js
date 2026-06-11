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
    const [usedSummary, prospectsR, prodR, persR, compR, compIntelR, intelR, engCountR, profR, oppR, engR, crmR, trendR] = await Promise.all([
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

    res.json({
      tenant: { name: tenant.name || 'your company', plan: tenant.subscription_status || 'TRIAL', planName: entJson.planName, trialEndsAt: tenant.trial_ends_at || null, daysLeft },
      kpis: {
        prospects: prospectsR.rows[0].total,
        prospectsNewWeek: prospectsR.rows[0].new_week,
        openSignals,
        competitors: compR.rows[0].n,
        engagementsNext7d: engCountR.rows[0].n,
      },
      opportunities,
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

module.exports = { router };
