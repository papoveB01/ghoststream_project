// Dashboard — the tenant "sales cockpit" aggregate behind the Overview page.
// One round-trip: KPIs + priority opportunities + upcoming engagements + a
// foundation-health snapshot. All queries are scoped by req.tenantId.

const express = require('express');
const db = require('./db');

const router = express.Router();

const STRENGTH_RANK = { strong: 3, tie: 2, weak: 1 };
const CRM_LABELS = { hubspot: 'HubSpot', salesforce: 'Salesforce', zoho: 'Zoho CRM', pipedrive: 'Pipedrive', dynamics: 'Dynamics 365' };

router.get('/', async (req, res, next) => {
  try {
    const t = req.tenantId;
    const [tenantR, prospectsR, prodR, persR, compR, compIntelR, intelR, engCountR, profR, oppR, engR, crmR] = await Promise.all([
      db.query(`SELECT name, subscription_status, trial_ends_at FROM tenants WHERE id = $1`, [t]),
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
    ]);

    const tenant = tenantR.rows[0] || {};
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

    res.json({
      tenant: { name: tenant.name || 'your company', plan: tenant.subscription_status || 'TRIAL', trialEndsAt: tenant.trial_ends_at || null, daysLeft },
      kpis: {
        prospects: prospectsR.rows[0].total,
        prospectsNewWeek: prospectsR.rows[0].new_week,
        openSignals,
        competitors: compR.rows[0].n,
        engagementsNext7d: engCountR.rows[0].n,
      },
      opportunities,
      engagements,
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
