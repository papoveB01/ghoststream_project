(async function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  const params = new URLSearchParams(window.location.search);
  const portalId = params.get('id');
  const isManagerView = params.get('view') === 'manager';
  if (!portalId) return showError('Missing portal id in URL.');

  let data;
  try {
    const res = await fetch(`/api/portals/${encodeURIComponent(portalId)}`);
    if (!res.ok) {
      const errPayload = await res.json().catch(() => ({}));
      return showError(errPayload.error || `HTTP ${res.status}`);
    }
    const payload = await res.json();
    data = payload.portal;
  } catch (err) {
    return showError(err.message);
  }

  render(data);

  function showError(msg) {
    hide('loading');
    show('error');
    $('error-msg').textContent = msg;
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function speakerName(role, participants) {
    const p = (participants || []).find((x) => x.role === role);
    if (!p) return role;
    return p.name + (p.title ? ` (${p.title})` : '');
  }

  function render(p) {
    hide('loading');
    show('body');

    // Head
    $('title').textContent = p.title || 'Sales Portal';
    $('summary').textContent = (p.moments && p.moments.summary) || '';

    const participants = p.participants || [];
    const metaParts = [];
    if (participants.length) {
      metaParts.push(`<strong>${participants.length}</strong> participants`);
    }
    if (p.createdAt) {
      const d = new Date(p.createdAt);
      metaParts.push(`Delivered <strong>${d.toLocaleString()}</strong>`);
    }
    $('meta').innerHTML = metaParts.join('<span class="meta-bar"></span>');

    // Objection
    if (p.moments && p.moments.objection) {
      const o = p.moments.objection;
      $('objection-category').textContent = o.category || 'objection';
      $('objection-quote').textContent = `"${o.quote}"`;
      $('objection-speaker').textContent = speakerName('prospect', participants);
      $('objection-timestamp').textContent = `${fmtTime(o.startSeconds)} – ${fmtTime(o.endSeconds)}`;
      const status = $('objection-status');
      status.textContent = o.resolved ? '✓ Resolved' : '⚠ Open';
      status.className = o.resolved ? 'resolved' : 'unresolved';
      if (o.repResponseQuote) {
        show('rep-response');
        $('rep-response-text').textContent = o.repResponseQuote;
      }
    }

    // Agreement
    if (p.moments && p.moments.agreement) {
      const a = p.moments.agreement;
      document.querySelectorAll('#agreement-quote').forEach(el => el.textContent = `"${a.quote}"`);
      $('agreement-commitment').textContent = a.commitment || '—';
    }

    // Video clip. Three no-video cases degrade to a placeholder instead of a
    // broken/blank player:
    //   - recordingExpired: purged by the workspace's retention policy
    //   - no clip + not a demo: meeting was captured transcript-only (no video)
    // The objection quote / speaker / status text below are populated
    // separately, so the insight survives even with no clip.
    const clip = p.objectionClip || {};
    const video = $('video');
    const showVideoPlaceholder = (msg) => {
      if (video) video.style.display = 'none';
      hide('video-mock-tag');
      const tx = $('video-placeholder-text');
      if (tx) tx.textContent = msg;
      show('video-placeholder');
    };
    if (p.recordingExpired) {
      showVideoPlaceholder('This recording was deleted under the workspace’s retention policy. The summary, highlights and insights below are kept.');
    } else if (clip.playbackUrl) {
      video.src = clip.playbackUrl;
      if (!clip.mock) hide('video-mock-tag');
    } else if (clip.mock) {
      // Demo / mock environment — keep the sample asset + the DEMO CLIP tag.
      video.src = 'https://www.w3.org/2010/05/sintel/trailer.mp4';
    } else {
      showVideoPlaceholder('No video recording was kept for this meeting. The insights below come from the live transcript.');
    }

    // Email
    if (p.email) {
      $('email-subject').textContent = p.email.subject || '';
      $('email-body').textContent = p.email.bodyPlainText || '';
    }
    const copyBtn = $('copy-email');
    copyBtn.addEventListener('click', async () => {
      const text = `Subject: ${p.email?.subject || ''}\n\n${p.email?.bodyPlainText || ''}`;
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('done');
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('done');
      }, 1800);
    });

    // Consolidated report — current `report` shape, with a fallback mapping
    // for legacy portals that still carry the old SOW fields.
    const report = p.report || (p.sowSummary ? {
      overview: p.sowSummary.scopeOneLine,
      discussionPoints: [],
      commitments: p.sowSummary.commitments || [],
      risksAndObjections: [p.sowSummary.outcomeMetric, p.sowSummary.termAndExit].filter(Boolean).join(' · '),
    } : null);
    if (report) {
      const fillList = (el, items) => {
        const ul = document.createElement('ul');
        (items || []).forEach((c) => {
          const li = document.createElement('li');
          li.textContent = c;
          ul.appendChild(li);
        });
        el.innerHTML = '';
        el.appendChild(ul);
      };
      $('report-overview').textContent = report.overview || '—';
      $('report-risks').textContent = report.risksAndObjections || '—';
      fillList($('report-commitments'), report.commitments);
      if ((report.discussionPoints || []).length) {
        fillList($('report-points'), report.discussionPoints);
      } else {
        $('report-points-label').style.display = 'none';
        $('report-points').style.display = 'none';
      }
    }

    // Next steps
    const ns = $('next-steps');
    ns.innerHTML = '';
    (p.moments?.nextSteps || []).forEach((s) => {
      const li = document.createElement('li');
      li.textContent = s;
      ns.appendChild(li);
    });

    // Report actions: download is open to anyone with the link (same access
    // as the portal); saving to prospect intel is a workspace action and
    // only appears for signed-in admin viewers.
    if (report) {
      const dl = $('download-report-btn');
      dl.classList.remove('hidden');
      dl.addEventListener('click', () => {
        window.open(`/api/portals/${encodeURIComponent(p.id)}/report.docx`, '_blank');
      });
      if (p.viewerRole === 'admin') {
        const saveBtn = $('save-intel-btn');
        saveBtn.classList.remove('hidden');
        saveBtn.addEventListener('click', async () => {
          const status = $('report-status');
          saveBtn.disabled = true;
          const label = saveBtn.textContent;
          saveBtn.textContent = 'Saving…';
          status.classList.add('hidden');
          try {
            const r = await fetch(`/api/portals/${encodeURIComponent(p.id)}/save-intel`, {
              method: 'POST', credentials: 'include',
            });
            const body = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
            saveBtn.textContent = 'Saved to intel ✓';
            status.textContent = `Saved as “${body.title}” on the prospect's profile — it now feeds briefs, research and proposals.`;
            status.classList.remove('hidden');
          } catch (err) {
            saveBtn.disabled = false;
            saveBtn.textContent = label;
            status.textContent = `Couldn't save: ${err.message}`;
            status.classList.remove('hidden');
          }
        });
      }
    }

    // Step 8: Verified Deal Intelligence + Knowledge Gap rendering.
    renderKnowledgeAudit(p);
    wireDrawer();
    if (isManagerView && p.viewerRole === 'admin') {
      renderEngagementPanel(p);
    }

    // Practice in the Arena
    const practiceBtn = $('practice-btn');
    if (practiceBtn) {
      practiceBtn.addEventListener('click', async () => {
        practiceBtn.disabled = true;
        const originalLabel = practiceBtn.querySelector('span:nth-child(2)').textContent;
        practiceBtn.querySelector('span:nth-child(2)').textContent = 'Spinning up the Arena…';
        try {
          const res = await fetch('/api/arena/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ portalId: p.id }),
          });
          const payload = await res.json();
          if (!res.ok || !payload.arenaUrl) {
            throw new Error(payload.error || `HTTP ${res.status}`);
          }
          window.location.href = payload.arenaUrl;
        } catch (err) {
          practiceBtn.disabled = false;
          practiceBtn.querySelector('span:nth-child(2)').textContent = originalLabel;
          alert(`Could not start practice session: ${err.message}`);
        }
      });
    }
  }

  // ===================================================================
  // VERIFIED DEAL INTELLIGENCE
  // ===================================================================
  //
  // Renders four interrelated UI elements driven by the `grounding` block
  // that analysis.js attaches to the portal record and the `knowledgeGaps`
  // field on `moments`:
  //
  //   1. Verified Intelligence banner   — always shown when grounding exists
  //   2. Fact-Check shield badges       — placed on each Moment-of-Truth card
  //   3. Knowledge Gap callouts         — manager-view only (?view=manager)
  //   4. HIGH-severity gap warning on the report (download stays available)

  function shieldSvg(size = 14) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2 4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z" fill="currentColor"/>
      <path d="m8.5 12.5 2.5 2.5 4.5-5" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function severityRank(s) {
    return { HIGH: 3, MEDIUM: 2, LOW: 1 }[String(s || '').toUpperCase()] || 0;
  }

  function renderKnowledgeAudit(p) {
    const grounding = p.grounding || null;
    const knowledgeGaps = (p.moments && Array.isArray(p.moments.knowledgeGaps))
      ? p.moments.knowledgeGaps : [];

    const hasGrounding = grounding && grounding.kbReady;
    const citations = (grounding && grounding.citations) || [];
    const verifiedCount = citations.length;

    // Trust the server-side computed audit flag — knowledgeGaps may be
    // stripped from the response for non-admin viewers, so a local
    // .some() check would falsely report "no high severity" and let the
    // download CTA leak through. The audit block is always present.
    const audit = p.audit || { hasHighSeverity: false, gapCount: 0 };
    const hasHighSeverity = audit.hasHighSeverity === true;
    const isAdminViewer = p.viewerRole === 'admin';

    // 1. Verified Intelligence banner ------------------------------------
    if (hasGrounding && verifiedCount > 0) {
      const banner = $('verified-banner');
      const sub = $('verified-banner-sub');
      const distinctDocs = new Set(citations.map((c) => c.documentId)).size;
      const breakdown = streamBreakdownLabel(citations);
      sub.textContent =
        `${verifiedCount} ${verifiedCount === 1 ? 'claim' : 'claims'} cross-referenced against ` +
        `${distinctDocs} Knowledge Base ${distinctDocs === 1 ? 'source' : 'sources'}` +
        (breakdown ? ` — ${breakdown}.` : '.');
      banner.classList.remove('hidden');
      $('verified-banner-cta').addEventListener('click', () => {
        openDrawer({
          title: 'Sources the AI consulted',
          subtitle: `${verifiedCount} chunks across ${distinctDocs} documents${breakdown ? ' · ' + breakdown : ''}`,
          chunks: citations,
        });
      });
    }

    // 2. Fact-Check shield badges ---------------------------------------
    if (hasGrounding && verifiedCount > 0) {
      document.querySelectorAll('.fact-check-slot').forEach((slot) => {
        const which = slot.dataset.factCheck;
        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'fact-check-badge';
        badge.setAttribute('aria-label', `View Knowledge Base sources for the ${which}`);
        badge.title = `Verified against ${verifiedCount} KB chunk${verifiedCount === 1 ? '' : 's'}. Click for sources.`;
        badge.innerHTML = `${shieldSvg(14)}<span>Verified</span>`;
        badge.addEventListener('click', () => {
          openDrawer({
            title: `Sources for the ${prettyAuditTarget(which)}`,
            subtitle: 'Knowledge Base chunks the AI consulted while analysing this section.',
            chunks: citations,
          });
        });
        slot.appendChild(badge);
      });
    }

    // 3. Knowledge Gap callouts — MANAGER VIEW ONLY ---------------------
    //
    // Three conditions must all hold to render the gap section:
    //   - the URL carries ?view=manager (UI signal to enable manager mode)
    //   - the API returned viewerRole=admin (server-side auth gate)
    //   - there's at least one gap to display
    //
    // The middle check is defense-in-depth: if `viewerRole !== 'admin'` then
    // the server has already zeroed `knowledgeGaps`, so the third check would
    // also fail. But making the auth requirement explicit means a future code
    // change that accidentally retains gap data for non-admins still can't
    // render the manager UI.
    if (isManagerView && isAdminViewer && knowledgeGaps.length > 0) {
      const section = $('gap-section');
      const list = $('gap-list');
      $('gap-section-meta').textContent =
        `${knowledgeGaps.length} ${knowledgeGaps.length === 1 ? 'gap' : 'gaps'} · ` +
        knowledgeGaps.filter((g) => severityRank(g.severity) >= 3).length + ' high severity';

      list.innerHTML = '';
      knowledgeGaps.forEach((g) => {
        const card = document.createElement('div');
        card.className = `gap-card sev-${String(g.severity || 'LOW').toLowerCase()}`;
        card.innerHTML = `
          <div class="gap-card-head">
            <span class="gap-severity-pill">${escapeHtml(String(g.severity || 'LOW'))}</span>
            <span class="gap-citation">${escapeHtml(g.kbCitation || '—')}</span>
          </div>
          <div class="gap-rep">
            <div class="gap-label">Rep said</div>
            <blockquote class="gap-quote">"${escapeHtml(g.repQuote || '')}"</blockquote>
          </div>
          <div class="gap-kb">
            <div class="gap-label">Knowledge Base says</div>
            <p class="gap-contradiction">${escapeHtml(g.contradiction || '')}</p>
          </div>
          <button type="button" class="gap-source-btn" data-citation="${escapeHtml(g.kbCitation || '')}">View source ↗</button>
        `;
        list.appendChild(card);
      });

      // Wire each "View source" button to open the drawer focused on that citation
      list.querySelectorAll('.gap-source-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const target = btn.dataset.citation;
          const focused = citations.filter((c) => c.citation === target);
          openDrawer({
            title: `Source for ${target}`,
            subtitle: focused.length > 0
              ? `From ${focused[0].documentTitle}`
              : 'AI cited a chunk not included in the retrieved set — likely a paraphrase. See all sources below.',
            chunks: focused.length > 0 ? focused : citations,
            focusCitation: target,
          });
        });
      });

      section.classList.remove('hidden');
    }

    // 4. High-severity gap warning on the report ------------------------
    // The report stays downloadable (it's a record of the meeting, not a
    // contract), but a HIGH-severity Knowledge Gap is surfaced loudly so a
    // manager reviews the flagged claims before sharing it onward.
    if (hasGrounding && hasHighSeverity) {
      const status = $('report-status');
      status.textContent =
        '⚠ HIGH-severity Knowledge Gap detected on this call — review the flagged claims below before sharing this report.';
      status.classList.remove('hidden');
    }
  }

  function prettyAuditTarget(which) {
    return ({ objection: 'Moment of Truth', agreement: 'Agreement', report: 'Meeting Report' })[which] || which;
  }

  // "2 PDFs, 1 Website, 1 Social Post" — Omni-Sync source-type breakdown.
  function streamBreakdownLabel(citations) {
    const counts = { FILE: 0, WEB: 0, SOCIAL: 0 };
    for (const c of citations) {
      const st = String(c.streamType || 'FILE').toUpperCase();
      if (counts[st] !== undefined) counts[st]++;
    }
    const parts = [];
    if (counts.FILE)   parts.push(`${counts.FILE} ${counts.FILE === 1 ? 'PDF/Doc' : 'PDFs/Docs'}`);
    if (counts.WEB)    parts.push(`${counts.WEB} ${counts.WEB === 1 ? 'Website' : 'Websites'}`);
    if (counts.SOCIAL) parts.push(`${counts.SOCIAL} ${counts.SOCIAL === 1 ? 'Social Post' : 'Social Posts'}`);
    return parts.join(', ');
  }

  function fmtEffectiveDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // ===================================================================
  // KB SOURCE DRAWER
  // ===================================================================

  function wireDrawer() {
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-backdrop').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('drawer').classList.contains('hidden')) closeDrawer();
    });
  }

  function openDrawer({ title, subtitle, chunks, focusCitation }) {
    $('drawer-title').textContent = title || 'Knowledge Source';

    const body = $('drawer-body');
    const blocks = [];
    if (subtitle) {
      blocks.push(`<div class="drawer-subtitle">${escapeHtml(subtitle)}</div>`);
    }

    if (!chunks || chunks.length === 0) {
      blocks.push('<div class="drawer-empty">No source chunks recorded for this portal.</div>');
    } else {
      chunks.forEach((c) => {
        const isFocused = focusCitation && c.citation === focusCitation;
        const pageRef = c.metadata && c.metadata.page ? ` · p.${c.metadata.page}` : '';
        const streamType = String(c.streamType || 'FILE').toUpperCase();
        const dateLabel = fmtEffectiveDate(c.effectiveDate);
        // Slim citations from grounding.citations don't include `text`; fall back
        // to a "title-only" card pointing at the source document.
        const text = c.text
          ? `<pre class="drawer-chunk-text">${escapeHtml(c.text)}</pre>`
          : `<div class="drawer-chunk-fallback">The full chunk text isn't included in this portal record — only the citation, document, and category. Open the Knowledge Base admin panel for the original.</div>`;
        const sourceLink = c.sourceUrl
          ? `<a class="drawer-chunk-source" href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
          : '';
        // Tri-Tiered tier badge. BASIS docs are the default product/battlecard
        // material; PROSPECT_MEMORY is "this exact account" intel; LIVE_PULSE
        // is fresh scrape from this call's window. The badge gives the
        // prospect a credibility signal without needing to read the chunk.
        const tier = String(c.tier || 'BASIS').toUpperCase();
        const tierLabel = tier === 'LIVE_PULSE'
          ? 'Live Pulse'
          : tier === 'PROSPECT_MEMORY'
            ? 'Prospect Memory'
            : 'Basis';
        const tierBadge = `<span class="drawer-tier-pill tier-${tier.toLowerCase()}" title="Source tier — ${escapeHtml(tierLabel)}">${escapeHtml(tierLabel)}</span>`;
        blocks.push(`
          <article class="drawer-chunk ${isFocused ? 'focused' : ''}">
            <header class="drawer-chunk-head">
              <span class="drawer-chunk-citation mono">${escapeHtml(c.citation || '—')}</span>
              ${tierBadge}
              <span class="drawer-stream-pill stream-${streamType.toLowerCase()}">${streamType}</span>
            </header>
            <div class="drawer-chunk-meta">
              <span>${escapeHtml(c.category || '—')}${pageRef}</span>
              ${dateLabel ? `<span class="drawer-chunk-date">as of ${escapeHtml(dateLabel)}</span>` : ''}
            </div>
            <div class="drawer-chunk-title">${escapeHtml(c.documentTitle || 'Untitled document')}</div>
            ${text}
            <footer class="drawer-chunk-foot">
              ${typeof c.distance === 'number' ? `<span>Semantic distance: ${c.distance.toFixed(3)}</span>` : ''}
              ${sourceLink}
            </footer>
          </article>
        `);
      });
    }
    body.innerHTML = blocks.join('');

    $('drawer').classList.remove('hidden');
    $('drawer-backdrop').classList.remove('hidden');
    // Scroll the focused chunk into view if there is one.
    requestAnimationFrame(() => {
      const focused = body.querySelector('.drawer-chunk.focused');
      if (focused) focused.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function closeDrawer() {
    $('drawer').classList.add('hidden');
    $('drawer-backdrop').classList.add('hidden');
  }

  // ===================================================================
  // ENGAGEMENT PANEL (manager view only)
  // ===================================================================

  async function renderEngagementPanel(p) {
    const panel = $('engagement-panel');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Populate dropdowns from /api/portfolio/* and pre-select the portal's
    // current engagement (prior override > meeting snapshot > none).
    let portfolio;
    try {
      const [pr, pe, co] = await Promise.all([
        fetch('/api/portfolio/products',    { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/portfolio/personas',    { credentials: 'include' }).then((r) => r.json()),
        fetch('/api/portfolio/competitors', { credentials: 'include' }).then((r) => r.json()),
      ]);
      portfolio = { products: pr.products || [], personas: pe.personas || [], competitors: co.competitors || [] };
    } catch (err) {
      console.warn('engagement panel: portfolio fetch failed:', err.message);
      portfolio = { products: [], personas: [], competitors: [] };
    }

    const current = p.engagement
      || (p.grounding && p.grounding.engagementProfile)
      || {};

    fillEnSelect($('engagement-product'),    portfolio.products,    current.productId,    'No product filter');
    fillEnSelect($('engagement-persona'),    portfolio.personas,    current.personaId,    'No persona filter');
    fillEnSelect($('engagement-competitor'), portfolio.competitors, current.competitorId, 'No competitor filter');

    $('engagement-current').textContent = describeEngagement(current);

    $('engagement-save').addEventListener('click',      () => saveEngagement(p, false));
    $('engagement-reanalyze').addEventListener('click', () => saveEngagement(p, true));
  }

  function fillEnSelect(el, items, selected, emptyLabel) {
    if (!el) return;
    el.innerHTML = [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...items.map((it) => `<option value="${escapeHtml(it.id)}" ${it.id === selected ? 'selected' : ''}>${escapeHtml(it.name)}</option>`),
    ].join('');
  }

  function describeEngagement(e) {
    if (!e || (!e.productId && !e.personaId && !e.competitorId)) {
      return 'No scope set — retrieval ran against the full KB';
    }
    const parts = [];
    if (e.productId)    parts.push(`product=${e.productId}`);
    if (e.personaId)    parts.push(`persona=${e.personaId}`);
    if (e.competitorId) parts.push(`competitor=${e.competitorId}`);
    return parts.join(' · ');
  }

  async function saveEngagement(p, reanalyze) {
    const status = $('engagement-status');
    const profile = {
      productId:    $('engagement-product').value    || null,
      personaId:    $('engagement-persona').value    || null,
      competitorId: $('engagement-competitor').value || null,
    };

    status.classList.remove('hidden', 'error', 'success');
    status.textContent = reanalyze ? 'Saving + re-running the AI analysis…' : 'Saving…';

    try {
      // 1. Save the override on the portal record.
      const r1 = await fetch(`/api/portals/${encodeURIComponent(p.id)}/engagement`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      });
      const b1 = await r1.json();
      if (!r1.ok) throw new Error(b1.error || `HTTP ${r1.status}`);

      if (!reanalyze) {
        status.classList.add('success');
        status.textContent = `Override saved. Re-run analysis to refresh the fact-check.`;
        $('engagement-current').textContent = describeEngagement(profile);
        return;
      }

      // 2. Re-run analysis pipeline.
      const r2 = await fetch(`/api/portals/${encodeURIComponent(p.id)}/reanalyze`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engagementProfile: profile }),
      });
      const b2 = await r2.json();
      if (!r2.ok) throw new Error(b2.error || `HTTP ${r2.status}`);
      status.classList.add('success');
      status.textContent = 'Re-analysis complete. Reloading…';
      setTimeout(() => window.location.reload(), 1000);
    } catch (err) {
      status.classList.add('error');
      status.textContent = err.message;
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
})();
