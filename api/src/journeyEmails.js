// Activation drip emails — gentle, data-grounded nudges for young workspaces.
// Runs from the scheduler (hourly is fine: the journey_emails ledger makes each
// nudge exactly-once per tenant). Internal/inactive workspaces are skipped.
//
//   day2_foundation — workspace is ≥2 days old and the foundation is still
//                     sparse (no positioning or no products): one-click enrich.
//   day7_signals    — workspace is ≥7 days old, research has surfaced strong
//                     buying signals, but no engagement has ever been scheduled.

const db = require('./db');
const email = require('./email');

const BASE = (process.env.APP_BASE_URL || 'https://dealscope.io').replace(/\/+$/, '');

function shell(title, bodyHtml, ctaLabel, ctaHref) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#15181b">
    <div style="padding:22px 0 14px"><span style="display:inline-block;background:#1e7d45;color:#fff;font-weight:800;border-radius:7px;padding:6px 11px">D</span>
      <span style="font-size:18px;font-weight:700;margin-left:8px">DealScope</span></div>
    <h1 style="font-size:20px;margin:6px 0 8px">${title}</h1>
    ${bodyHtml}
    <a href="${ctaHref}" style="display:inline-block;background:#1e7d45;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:6px;padding:10px 18px;margin-top:6px">${ctaLabel}</a>
    <p style="font-size:12px;color:#8c9197;margin:22px 0 8px">Questions? Just reply — a human reads these.</p>
  </div>`;
}

async function owners(tenantId) {
  return (await db.query(
    `SELECT email FROM users WHERE tenant_id = $1 AND role = 'owner' AND email IS NOT NULL`, [tenantId]
  )).rows.map((r) => r.email);
}

async function alreadySent(tenantId, kind) {
  const r = await db.query(`SELECT 1 FROM journey_emails WHERE tenant_id = $1 AND kind = $2`, [tenantId, kind]);
  return !!r.rows[0];
}
async function markSent(tenantId, kind) {
  await db.query(
    `INSERT INTO journey_emails (tenant_id, kind) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [tenantId, kind]
  );
}

async function tick() {
  if (!email.isConfigured()) return;
  try {
    // Candidate tenants: real (non-internal) workspaces between 2 and 30 days old.
    const tenants = (await db.query(
      `SELECT id, name, created_at FROM tenants
        WHERE plan <> 'internal'
          AND created_at < now() - interval '2 days'
          AND created_at > now() - interval '30 days'`
    )).rows;

    for (const t of tenants) {
      const ageDays = (Date.now() - new Date(t.created_at).getTime()) / 86400000;

      // day2_foundation
      if (!(await alreadySent(t.id, 'day2_foundation'))) {
        const prof = (await db.query(`SELECT positioning FROM tenant_profiles WHERE tenant_id = $1`, [t.id])).rows[0] || {};
        const prods = (await db.query(`SELECT count(*)::int AS n FROM products WHERE tenant_id = $1`, [t.id])).rows[0].n;
        if (!(prof.positioning || '').trim() || prods === 0) {
          const to = await owners(t.id);
          if (to.length) {
            await email.send({
              to,
              subject: 'One click makes DealScope dramatically smarter',
              html: shell(
                'Your workspace is still running on an empty foundation',
                `<p style="font-size:14.5px;line-height:1.6;color:#54595f;margin:0 0 14px">
                   Every discovery run, brief and battlecard is grounded in your company foundation —
                   and ${t.name ? `<strong>${t.name}</strong>'s` : 'yours'} is still sparse. On the
                   <strong>Company</strong> page, hit <strong>“Enrich from web”</strong> and we'll build your
                   positioning, products and buyer personas from your own website in about a minute.</p>`,
                'Enrich my foundation', `${BASE}/admin/#company`
              ),
              text: `Your DealScope workspace is still running on an empty foundation.\n\nOn the Company page, hit "Enrich from web" — we build your positioning, products and buyer personas from your own website in about a minute. Every discovery run, brief and battlecard gets sharper.\n\n${BASE}/admin/#company`,
              categories: ['journey-day2'],
            });
            await markSent(t.id, 'day2_foundation');
            console.log(`[journey] day2_foundation sent to ${to.join(', ')} (${t.id})`);
          }
        } else {
          await markSent(t.id, 'day2_foundation'); // foundation already good — never nag
        }
      }

      // day7_signals
      if (ageDays >= 7 && !(await alreadySent(t.id, 'day7_signals'))) {
        const strong = (await db.query(
          `SELECT count(*)::int AS n
             FROM prospect_research pr, jsonb_array_elements(pr.opportunities) o
            WHERE pr.tenant_id = $1 AND pr.status = 'DONE' AND o->>'strength' = 'strong'`, [t.id]
        )).rows[0].n;
        const meetings = (await db.query(`SELECT count(*)::int AS n FROM scheduled_meetings WHERE tenant_id = $1`, [t.id])).rows[0].n;
        if (strong > 0 && meetings === 0) {
          const to = await owners(t.id);
          if (to.length) {
            await email.send({
              to,
              subject: `${strong} strong buying signal${strong === 1 ? '' : 's'} are waiting on a call`,
              html: shell(
                'Your research found buyers — the next step is a call',
                `<p style="font-size:14.5px;line-height:1.6;color:#54595f;margin:0 0 14px">
                   DealScope's research surfaced <strong>${strong} strong-fit buying signal${strong === 1 ? '' : 's'}</strong>
                   across your prospects, but no engagement has been scheduled yet. Schedule one and the AI
                   joins the call: a prep brief beforehand, recording and analysis after.</p>`,
                'Schedule an engagement', `${BASE}/admin/#engagements`
              ),
              text: `DealScope's research surfaced ${strong} strong-fit buying signal${strong === 1 ? '' : 's'} across your prospects, but no engagement has been scheduled yet.\n\nSchedule one and the AI joins the call — prep brief beforehand, recording and analysis after.\n\n${BASE}/admin/#engagements`,
              categories: ['journey-day7'],
            });
            await markSent(t.id, 'day7_signals');
            console.log(`[journey] day7_signals sent to ${to.join(', ')} (${t.id})`);
          }
        } else if (meetings > 0) {
          await markSent(t.id, 'day7_signals'); // already engaging — never nag
        }
      }
    }
  } catch (err) {
    console.error('[journey] drip tick failed:', err.message);
  }
}

module.exports = { tick };
