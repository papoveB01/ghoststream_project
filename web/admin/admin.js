(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  const sections = ['overview', 'company', 'knowledge', 'missions', 'calls', 'calls-ops', 'sessions', 'integrations', 'caches', 'settings'];
  const loaders = {
    overview: loadOverview,
    company: loadCompany,
    knowledge: loadKnowledge,
    missions: loadMissions,
    calls: loadCalls,
    'calls-ops': loadCallsOps,
    sessions: loadSessions,
    integrations: loadIntegrations,
    caches: loadCaches,
    settings: loadSettings,
  };
  const loaded = {};
  let currentSection = 'overview';
  let kbCurrentTab = 'status';
  let missionsCurrentTab = 'upcoming';
  let isSuperadmin = false; // platform admin (Founders tenant) — set in init()

  init();

  async function init() {
    // Auth check first; redirect if no valid cookie.
    let me;
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) throw new Error('unauthorized');
      me = (await r.json()).user;
    } catch {
      window.location.href = '/admin/login.html';
      return;
    }

    $('user-email').textContent = me.email;
    $('user-avatar').textContent = (me.email || '?')[0].toUpperCase();
    isSuperadmin = !!me.isAdmin;

    // Reveal superadmin-only nav entries before rendering the initial section
    // so deep-linking to e.g. #calls-ops on a fresh load works.
    if (isSuperadmin) {
      document.querySelectorAll('.superadmin-only').forEach((el) => el.classList.remove('hidden'));
    }

    wireNav();
    wireLogout();
    wireRefresh();

    const initialRaw = window.location.hash.replace('#', '') || 'overview';
    const { section: initialSection, query: initialQuery } = parseHash(initialRaw);
    const redirected = legacyHashRedirect(initialSection, initialQuery);
    if (redirected) {
      history.replaceState(null, '', redirected.href);
      await switchSection(redirected.section, redirected.query);
    } else {
      await switchSection(sections.includes(initialSection) ? initialSection : 'overview', initialQuery);
    }

    hide('content-loading');
    show('content-body');
  }

  // Parse a hash like "calls?status=ready&q=foo" → { section, query }.
  function parseHash(raw) {
    if (!raw) return { section: 'overview', query: {} };
    const [section, qs] = raw.split('?');
    const query = {};
    if (qs) {
      const sp = new URLSearchParams(qs);
      sp.forEach((v, k) => { query[k] = v; });
    }
    return { section, query };
  }

  // #portals → #calls?status=ready (Decision #1 cascade — Portals were always
  // ready-only). #meetings → #calls (no filter). Returns null when no redirect.
  function legacyHashRedirect(section, query) {
    if (section === 'portals') {
      return { section: 'calls', query: { ...query, status: 'ready' }, href: '#calls?status=ready' };
    }
    if (section === 'meetings') {
      return { section: 'calls', query, href: '#calls' };
    }
    return null;
  }

  function wireNav() {
    document.querySelectorAll('#nav a').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const sec = a.dataset.section;
        switchSection(sec, {});
        history.replaceState(null, '', `#${sec}`);
      });
    });
    // In-content links like <a href="#integrations"> change the hash directly
    // (the sidebar handler uses replaceState, which doesn't fire hashchange) —
    // honour them so cross-section deep links work everywhere.
    window.addEventListener('hashchange', () => {
      const raw = window.location.hash.replace('#', '');
      const { section, query } = parseHash(raw);
      const redirected = legacyHashRedirect(section, query);
      if (redirected) {
        history.replaceState(null, '', redirected.href);
        switchSection(redirected.section, redirected.query);
        return;
      }
      if (sections.includes(section) && (section !== currentSection || Object.keys(query).length > 0)) {
        switchSection(section, query);
      }
    });
  }

  function wireLogout() {
    $('logout-btn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/admin/login.html';
    });
  }

  function wireRefresh() {
    $('refresh-btn').addEventListener('click', () => {
      loaded[currentSection] = false;
      switchSection(currentSection);
    });
  }

  async function switchSection(sec, query) {
    currentSection = sec;
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.section === sec);
    });
    sections.forEach((s) => {
      const el = $(`section-${s}`);
      if (!el) return;
      if (s === sec) el.classList.remove('hidden'); else el.classList.add('hidden');
    });
    $('page-title').textContent = titleFor(sec);
    if (!loaded[sec]) {
      try { await loaders[sec](query || {}); loaded[sec] = true; }
      catch (err) { console.error(err); }
    } else if (sec === 'calls' && query) {
      // Already-loaded Calls page — re-apply the query so deep-linked filter
      // changes (e.g. clicking a chip or external link) take effect.
      applyCallsQuery(query);
    }
  }

  function titleFor(sec) {
    return {
      overview: 'Overview',
      company: 'Company Profile',
      knowledge: 'Knowledge Base',
      missions: 'Missions',
      calls: 'Calls',
      'calls-ops': 'Calls — Operations',
      sessions: 'Arena Sessions',
      integrations: 'Integrations',
      caches: 'Gemini Caches',
      settings: 'Settings',
    }[sec];
  }

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (r.status === 401) {
      window.location.href = '/admin/login.html';
      throw new Error('unauthorized');
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function loadOverview() {
    const o = await fetchJson('/api/admin/overview');

    // ADR-003 Decision #1 cascade — Portals + Meetings collapse into a single
    // "Calls" pipeline. The overview now surfaces Ready (= analysed call you
    // can open) and Success rate (= ready / non-pending), which is the metric
    // the user actually reads when triaging the pipeline. Sessions/caches
    // remain in their own cards since they live on a different axis.
    const callsCounts = o.counts.calls || {};
    const ready = callsCounts.ready ?? o.counts.portals ?? 0;
    const total = callsCounts.total ?? ((callsCounts.pending || 0) + (callsCounts.analysing || 0) + (callsCounts.ready || 0) + (callsCounts.failed || 0));
    const denom = total - (callsCounts.pending || 0);
    const successRate = denom > 0 ? Math.round((ready / denom) * 100) : null;
    $('stat-cards').innerHTML = [
      statCard('Ready calls', ready),
      statCard('Success rate', successRate == null ? '—' : `${successRate}%`),
      statCard('Arena Sessions', o.counts.sessions),
      statCard('Active Caches', o.counts.caches),
    ].join('');

    $('cache-stats').innerHTML = `
      <dl class="kv-list">
        <div class="k">Total registered</div><div class="v">${o.caches.total}</div>
        <div class="k">Cached (paid tier)</div><div class="v">${o.caches.cached} ${o.caches.cached ? '<span class="pill pill-cached">live</span>' : ''}</div>
        <div class="k">Inline fallback (free tier)</div><div class="v">${o.caches.inline} ${o.caches.inline ? '<span class="pill pill-inline">inline</span>' : ''}</div>
      </dl>
    `;

    $('env-stats').innerHTML = `
      <dl class="kv-list">
        <div class="k">Roleplay model</div><div class="v mono">${o.env.roleplayModel || '—'}</div>
        <div class="k">Analysis model</div><div class="v mono">${o.env.analysisModel || '—'}</div>
        <div class="k">Content model</div><div class="v mono">${o.env.contentModel || '—'}</div>
        <div class="k">Recall.ai region</div><div class="v mono">${o.env.recallRegion || '—'}</div>
        <div class="k">Cloudflare Stream</div><div class="v">${o.env.streamConfigured ? '<span class="pill pill-ok">configured</span>' : '<span class="pill pill-warn">mock</span>'}</div>
        <div class="k">App base URL</div><div class="v mono">${escapeHtml(o.env.appBaseUrl || '')}</div>
      </dl>
    `;
  }

  // mm:ss for short calls, h:mm:ss for >= 1h. Returns '—' when missing.
  function fmtDuration(secs) {
    if (!Number.isFinite(secs) || secs <= 0) return '—';
    const s = Math.round(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  }

  // Strip the long auth tail from meeting URLs so the table cell stays short
  // but the full URL is still on the hover tooltip / link.
  function shortMeetingUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      const path = (u.pathname.split('/').filter(Boolean)[1] || '').slice(0, 18);
      return path ? `${u.hostname}/…/${path}` : u.hostname;
    } catch { return url.slice(0, 32) + (url.length > 32 ? '…' : ''); }
  }

  function meetingRefCell(meeting) {
    if (!meeting) return '<span class="muted">—</span>';
    const sourcePill = meeting.source
      ? `<span class="pill pill-${escapeHtml(meeting.source)}">${escapeHtml(meeting.source)}</span>`
      : '';
    const urlLink = meeting.meetingUrl
      ? `<a href="${escapeHtml(meeting.meetingUrl)}" target="_blank" rel="noopener" title="${escapeHtml(meeting.meetingUrl)}">${escapeHtml(shortMeetingUrl(meeting.meetingUrl))} ↗</a>`
      : '';
    const missionLink = meeting.missionId
      ? `<div class="mono muted" title="mission ${escapeHtml(meeting.missionId)}">mission · ${escapeHtml(meeting.missionId.slice(0, 8))}…</div>`
      : '';
    const botLink = meeting.botId
      ? `<div class="mono muted" title="Recall.ai bot ${escapeHtml(meeting.botId)}">bot · ${escapeHtml(meeting.botId.slice(0, 8))}…</div>`
      : '';
    return `
      <div class="meeting-ref">
        <div><span class="mono">${escapeHtml(meeting.id)}</span> ${sourcePill}</div>
        ${urlLink ? `<div class="truncate">${urlLink}</div>` : ''}
        ${missionLink}
        ${botLink}
      </div>`;
  }

  async function loadSessions() {
    const { sessions } = await fetchJson('/api/admin/sessions');
    $('sessions-table').innerHTML = sessions.length === 0
      ? '<div class="empty">No active sessions. Sessions expire after 1 hour.</div>'
      : `
        <table class="dt">
          <thead><tr><th>ID</th><th>Persona</th><th>Mode</th><th>Turns</th><th>Created</th><th></th></tr></thead>
          <tbody>${sessions.map(sessionRow).join('')}</tbody>
        </table>`;
  }

  function sessionRow(s) {
    const userTurns = (s.turns || []).filter((t) => t.role === 'rep').length;
    return `
      <tr>
        <td class="mono">${escapeHtml(s.id)}</td>
        <td>${escapeHtml((s.persona || '').replace(/-/g, ' '))}</td>
        <td><span class="pill pill-${s.cacheMode || 'inline'}">${s.cacheMode || 'inline'}</span></td>
        <td>${userTurns}</td>
        <td>${fmtDate(s.createdAt)}</td>
        <td><a href="/arena/?id=${encodeURIComponent(s.id)}" target="_blank">Open ↗</a></td>
      </tr>`;
  }

  async function loadCaches() {
    const { caches } = await fetchJson('/api/admin/caches');
    $('caches-table').innerHTML = caches.length === 0
      ? '<div class="empty">No caches in registry.</div>'
      : `
        <table class="dt">
          <thead><tr><th>Name</th><th>Model</th><th>Mode</th><th>Hash</th><th>Expires</th></tr></thead>
          <tbody>${caches.map(cacheRow).join('')}</tbody>
        </table>`;
  }

  function cacheRow(c) {
    return `
      <tr>
        <td class="mono">${escapeHtml(c.name || c.cacheName || '—')}</td>
        <td class="mono">${escapeHtml(c.model || '—')}</td>
        <td><span class="pill pill-${c.mode || 'inline'}">${c.mode || 'inline'}</span></td>
        <td class="mono">${escapeHtml(c.contentHash || '—')}</td>
        <td>${c.expiresAt ? fmtDate(c.expiresAt) : '—'}</td>
      </tr>`;
  }

  // ── Integrations (calendar) ──────────────────────────────────────────────
  async function loadIntegrations() {
    const host = $('integrations-body');
    if (!host) return;
    host.innerHTML = '<div class="kb-subtle">Loading…</div>';
    let providers = [];
    try {
      providers = (await fetchJson('/api/integrations/calendar')).providers || [];
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn't load integrations: ${escapeHtml(err.message)}</div>`;
      return;
    }
    // Flash from the Nylas callback redirect (?cal=connected / ?cal_error=…).
    const flash = readCalFlash();
    host.innerHTML =
      (flash || '') +
      `<div class="integration-grid">${providers.map(integrationCard).join('')}</div>`;
    host.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => copyToClipboard(b.dataset.copy, b)));
    host.querySelectorAll('[data-cal-connect]').forEach((b) =>
      b.addEventListener('click', () => { window.location.href = '/api/integrations/calendar/connect?provider=' + encodeURIComponent(b.dataset.calConnect || 'google'); }));
    host.querySelectorAll('[data-cal-disconnect]').forEach((b) =>
      b.addEventListener('click', () => calendarDisconnect(b)));
    host.querySelectorAll('[data-caly-connect]').forEach((b) =>
      b.addEventListener('click', () => { window.location.href = '/api/integrations/calendly/connect'; }));
    host.querySelectorAll('[data-caly-disconnect]').forEach((b) =>
      b.addEventListener('click', () => calendlyDisconnect(b)));
  }

  // Pull (and clear) the ?cal=… flash params the Nylas callback set, returning
  // a banner HTML string (or null). Cleans them off the URL so a refresh is quiet.
  function readCalFlash() {
    const q = new URLSearchParams(location.search);
    const ok = q.get('cal'), err = q.get('cal_error'), notice = q.get('cal_notice');
    if (!ok && !err && !notice) return null;
    q.delete('cal'); q.delete('cal_error'); q.delete('cal_notice');
    const clean = location.pathname + (q.toString() ? `?${q}` : '') + location.hash;
    history.replaceState(null, '', clean);
    if (err)    return `<div class="kb-result error"   style="margin-bottom:14px">Calendar connect failed: ${escapeHtml(err)}</div>`;
    if (notice) return `<div class="kb-result success" style="margin-bottom:14px">Calendar ${escapeHtml(notice)}</div>`;
    return `<div class="kb-result success" style="margin-bottom:14px">Calendar connected.</div>`;
  }

  async function calendarDisconnect(btn) {
    if (!confirm('Disconnect this calendar? The schedule form will stop offering its events (re-connect any time).')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
    try {
      const r = await fetch('/api/integrations/calendar/connection', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) { alert(`Couldn't disconnect: ${err.message}`); }
    loaded.integrations = false;
    await loadIntegrations();
  }

  async function calendlyDisconnect(btn) {
    if (!confirm('Disconnect Calendly? The invitee.created webhook subscription will be removed — new bookings will stop auto-creating missions.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
    try {
      const r = await fetch('/api/integrations/calendly/connection', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) { alert(`Couldn't disconnect: ${err.message}`); }
    loaded.integrations = false;
    await loadIntegrations();
  }

  function integrationCard(p) {
    const isCalendly = p.key === 'calendly';
    const uriLabel = isCalendly ? 'Redirect URI' : 'Callback URI';
    let badge, action;
    if (!p.configured) {
      badge = '<span class="pill pill-warn">Not configured</span>';
      action = `
        <div class="integration-setup">${escapeHtml(p.setup)}</div>
        <ul class="integration-env">${p.requires.map((r) =>
          `<li><code>${escapeHtml(r.name)}</code> ${r.set ? '<span class="pill pill-ok">set</span>' : '<span class="pill pill-warn">missing</span>'}</li>`).join('')}</ul>
        ${p.callbackUri ? `<div class="integration-url">${uriLabel} ${copyBtn(p.callbackUri)}<code>${escapeHtml(p.callbackUri)}</code></div>` : ''}
        ${p.webhookUrl  ? `<div class="integration-url">Webhook URL ${copyBtn(p.webhookUrl)}<code>${escapeHtml(p.webhookUrl)}</code></div>` : ''}`;
    } else if (isCalendly) {
      const conn = p.connection || {};
      if (conn.connected) {
        badge = conn.webhookActive ? '<span class="pill pill-ok">Connected</span>' : '<span class="pill pill-warn">Connected · no webhook</span>';
        action = `
          <div class="integration-connected">${conn.webhookActive
            ? 'Connected — the <code>invitee.created</code> webhook is registered. New bookings auto-create missions.'
            : 'Connected, but the webhook subscription isn\'t active (your Calendly plan may not allow webhooks) — bookings won\'t auto-create missions.'}${conn.connectedAt ? ` <span class="kb-subtle">· since ${escapeHtml(fmtDate(conn.connectedAt))}</span>` : ''}</div>
          <div class="integration-url">Webhook URL ${copyBtn(p.webhookUrl)}<code>${escapeHtml(p.webhookUrl || '')}</code></div>
          <div class="integration-actions"><button class="kb-secondary-btn" data-caly-disconnect>Disconnect</button></div>`;
      } else {
        badge = '<span class="pill pill-warn">Not connected</span>';
        action = `
          <div class="integration-setup">Make sure this redirect URI is registered in your Calendly OAuth app, then connect — we'll register the <code>invitee.created</code> webhook for you.</div>
          <div class="integration-url">${uriLabel} ${copyBtn(p.callbackUri)}<code>${escapeHtml(p.callbackUri || '')}</code></div>
          <div class="integration-url">Webhook URL ${copyBtn(p.webhookUrl)}<code>${escapeHtml(p.webhookUrl || '')}</code></div>
          <button class="primary-cta" data-caly-connect>Connect Calendly</button>`;
      }
    } else {
      // Read-calendar provider (Nylas). Configured → connect (per provider) / connected.
      const conn = p.connection || {};
      if (conn.connected) {
        badge = '<span class="pill pill-ok">Connected</span>';
        action = `
          <div class="integration-connected">Connected as <strong>${escapeHtml(conn.email || 'unknown')}</strong>${conn.provider ? ` <span class="kb-subtle">(${escapeHtml(conn.provider)})</span>` : ''}${conn.connectedAt ? ` <span class="kb-subtle">· since ${escapeHtml(fmtDate(conn.connectedAt))}</span>` : ''}</div>
          <div class="integration-actions">
            <button class="kb-secondary-btn" data-cal-disconnect>Disconnect</button>
            <span class="kb-subtle">Importing events on the <a href="#missions">schedule form</a> ↗</span>
          </div>`;
      } else {
        badge = '<span class="pill pill-warn">Not connected</span>';
        action = `
          <div class="integration-setup">${escapeHtml(p.setup)}</div>
          <div class="integration-url">${uriLabel} ${copyBtn(p.callbackUri)}<code>${escapeHtml(p.callbackUri || '')}</code></div>
          <div class="integration-actions">
            <button class="primary-cta" data-cal-connect="google">Connect Google</button>
            <button class="kb-secondary-btn" data-cal-connect="microsoft">Microsoft 365</button>
            <button class="kb-secondary-btn" data-cal-connect="imap">IMAP / iCloud</button>
          </div>`;
      }
    }
    return `
      <div class="integration-card">
        <div class="integration-h">
          <span class="integration-icon">${p.icon || '🔌'}</span>
          <span class="integration-name">${escapeHtml(p.name)}</span>
          <span class="integration-mode kb-subtle">${p.mode === 'webhook' ? 'inbound' : 'read calendar'}</span>
          ${badge}
        </div>
        <div class="integration-blurb">${escapeHtml(p.blurb)}</div>
        ${action}
      </div>`;
  }

  function copyBtn(text) {
    if (!text) return '';
    return `<button class="kb-link-btn integration-copy" data-copy="${escapeHtml(text)}" title="Copy">copy</button>`;
  }
  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const o = btn.textContent; btn.textContent = 'copied ✓'; setTimeout(() => { btn.textContent = o; }, 1400); }
    } catch { /* clipboard blocked — no-op */ }
  }

  // ── Schedule-form imports (calendar via Nylas, or Calendly) ──────────────
  // Two buttons in the schedule-import row: "📅 Import from calendar" (Nylas —
  // also offers Connect if configured-but-not-linked) and "🗓️ From Calendly"
  // (lists upcoming Calendly-booked events). Either opens the same picker
  // modal; choosing an event prefills the form from its `suggestion`.

  let _calPickerEvents = [];
  // What the Nylas "📅 …" button does: 'import' (calendar linked → picker),
  // 'connect' (Nylas configured, not linked → OAuth), or 'disabled'.
  let _calImportMode = 'disabled';

  async function refreshCalendarImportButton() {
    const nb = $('missions-import-btn'), cb = $('missions-calendly-btn'), hint = $('missions-import-hint');
    if (!nb && !cb) return;
    let nylasConn = null, calyConn = null, nylasCfg = false;
    try {
      const providers = (await fetchJson('/api/integrations/calendar')).providers || [];
      const nyl = providers.find((p) => p.key === 'nylas');
      const cly = providers.find((p) => p.key === 'calendly');
      nylasConn = nyl && nyl.connection; nylasCfg = !!(nyl && nyl.configured);
      calyConn  = cly && cly.connection;
    } catch { /* leave everything disabled */ }

    // Nylas button
    if (nb) {
      if (nylasConn && nylasConn.connected) {
        _calImportMode = 'import'; nb.disabled = false;
        nb.textContent = '📅 Import from calendar';
        nb.title = `Connected as ${nylasConn.email || 'your calendar'}`;
      } else if (nylasCfg) {
        _calImportMode = 'connect'; nb.disabled = false;
        nb.textContent = '📅 Connect a calendar';
        nb.title = 'Connect Google / Microsoft 365 / iCloud via Nylas';
      } else {
        _calImportMode = 'disabled'; nb.disabled = true;
        nb.textContent = '📅 Import from calendar';
        nb.title = 'Set up Nylas on the Integrations page first';
      }
    }
    // Calendly button — enabled only when connected (connect lives on the
    // Integrations page; it needs the redirect URI registered first).
    if (cb) {
      if (calyConn && calyConn.connected) {
        cb.disabled = false;
        cb.title = calyConn.webhookActive ? 'Pick an upcoming Calendly booking' : 'Connected (no webhook) — you can still pull upcoming bookings';
      } else {
        cb.disabled = true;
        cb.title = 'Connect Calendly on the Integrations page first';
      }
    }
    // Hint line
    if (hint) {
      const bits = [];
      if (nylasConn && nylasConn.connected) bits.push(`calendar (<strong>${escapeHtml(nylasConn.email || 'linked')}</strong>)`);
      if (calyConn && calyConn.connected) bits.push('Calendly');
      hint.innerHTML = bits.length
        ? `Pull a meeting from ${bits.join(' or ')} — date, link and attendees fill in. <a href="#integrations">Manage</a>`
        : `Connect a calendar or Calendly in <a href="#integrations">Integrations</a> to skip the typing — or just fill the fields below.`;
    }
  }

  function _calPickerEsc(e) { if (e.key === 'Escape') closeCalendarPicker(); }
  function closeCalendarPicker() { const o = $('cal-picker-overlay'); if (o) o.classList.add('hidden'); }

  // source: 'calendar' (Nylas /calendar/events) | 'calendly' (/calendly/events)
  async function openEventPicker(source) {
    const cfg = source === 'calendly'
      ? { title: 'Pick an upcoming Calendly meeting', url: '/api/integrations/calendly/events?days=30', loading: 'Loading your Calendly bookings…', empty: 'No upcoming Calendly bookings in the next 30 days.', manage: 'Manage Calendly' }
      : { title: 'Pick an upcoming meeting', url: '/api/integrations/calendar/events?days=21', loading: 'Loading your calendar…', empty: 'No upcoming meetings in the next 3 weeks.', manage: 'Manage calendar' };
    let overlay = $('cal-picker-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cal-picker-overlay';
      overlay.className = 'cal-picker-overlay';
      overlay.innerHTML = `
        <div class="cal-picker">
          <div class="cal-picker-h"><span class="cal-picker-title"></span><button type="button" class="kb-link-btn cal-picker-close">✕</button></div>
          <div class="cal-picker-body"></div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCalendarPicker(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', closeCalendarPicker);
      document.addEventListener('keydown', _calPickerEsc);
    }
    overlay.querySelector('.cal-picker-title').textContent = cfg.title;
    overlay.classList.remove('hidden');
    const body = overlay.querySelector('.cal-picker-body');
    body.innerHTML = `<div class="kb-subtle">${escapeHtml(cfg.loading)}</div>`;
    let events = [];
    try {
      events = (await fetchJson(cfg.url)).events || [];
    } catch (err) {
      body.innerHTML = `<div class="empty">Couldn't load events: ${escapeHtml(err.message)}. <a href="#integrations">${escapeHtml(cfg.manage)}</a></div>`;
      return;
    }
    if (events.length === 0) {
      body.innerHTML = `<div class="empty">${escapeHtml(cfg.empty)}</div>`;
      return;
    }
    _calPickerEvents = events;
    body.innerHTML = `<div class="cal-picker-list">${events.map(calEventRow).join('')}</div>`;
    body.querySelectorAll('[data-cal-pick]').forEach((el) => {
      const pick = () => { applyCalendarEvent(_calPickerEvents[parseInt(el.dataset.calPick, 10)]); closeCalendarPicker(); };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    });
  }

  function calEventRow(ev, i) {
    const when = ev.start
      ? new Date(ev.start).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : 'no time';
    const att = (ev.attendees || []);
    const attStr = att.slice(0, 3).join(', ') + (att.length > 3 ? ` +${att.length - 3}` : '');
    const sug = ev.suggestion || {};
    return `
      <div class="cal-event-row" role="button" tabindex="0" data-cal-pick="${i}">
        <div class="cal-event-title">${escapeHtml(ev.title || '(no title)')}</div>
        <div class="cal-event-meta">${escapeHtml(when)}${ev.url ? ' · 🔗 has link' : ''}${attStr ? ' · ' + escapeHtml(attStr) : ''}</div>
        ${sug.companyName ? `<div class="cal-event-sug">→ fills: <strong>${escapeHtml(sug.companyName)}</strong>${sug.companyDomain ? ` <span class="kb-subtle">(${escapeHtml(sug.companyDomain)})</span>` : ''}</div>` : ''}
      </div>`;
  }

  function applyCalendarEvent(ev) {
    if (!ev) return;
    const s = ev.suggestion || {};
    if (s.companyName) $('missions-company').value = s.companyName;
    if (s.scheduledAt) {
      const d = new Date(s.scheduledAt);
      if (!isNaN(d)) {
        const pad = (n) => String(n).padStart(2, '0');
        $('missions-scheduled-at').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }
    if (s.meetingUrl) $('missions-url').value = s.meetingUrl;
    const adv = $('missions-advanced');
    if (adv) adv.open = true;
    if (s.companyDomain && $('missions-domain')) $('missions-domain').value = s.companyDomain;
    if (s.primaryContact && $('missions-primary-contact')) $('missions-primary-contact').value = s.primaryContact;
    if (Array.isArray(s.prospectEmails) && s.prospectEmails.length && $('missions-emails')) $('missions-emails').value = s.prospectEmails.join('\n');
    if (s.notes && $('missions-notes')) {
      const cur = $('missions-notes').value.trim();
      $('missions-notes').value = cur ? `${cur}\n${s.notes}` : s.notes;
    }
    // Snap-autofill the tags from past missions against this company.
    snapAutofillForCompany($('missions-company').value);
    const result = $('missions-form-result');
    if (result) {
      result.classList.remove('hidden', 'error'); result.classList.add('success');
      result.innerHTML = `Pulled from your calendar: <strong>${escapeHtml(ev.title || 'meeting')}</strong>. Review and adjust below, then schedule.`;
    }
  }

  function statCard(label, value) {
    return `<div class="stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${value}</div></div>`;
  }

  // Stat card themed with a stream-type accent stripe (file/web/social).
  function streamStatCard(label, value, streamSlug) {
    return `<div class="stat-card stream-card stream-${escapeHtml(streamSlug)}">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${fmtNum(value)}</div>
    </div>`;
  }

  // Compact card showing both Omni-Sync provider statuses inline so it
  // occupies one stat-card slot instead of two.
  function providerStatCard(providers) {
    const fc = providers.firecrawl
      ? '<span class="pill pill-ok">live</span>'
      : '<span class="pill pill-warn">no key</span>';
    const ph = providers.phyllo
      ? '<span class="pill pill-ok">live</span>'
      : '<span class="pill pill-warn">no key</span>';
    return `<div class="stat-card provider-card">
      <div class="stat-label">Providers</div>
      <div class="provider-row"><span class="provider-name">Firecrawl</span>${fc}</div>
      <div class="provider-row"><span class="provider-name">Phyllo</span>${ph}</div>
    </div>`;
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function fmtNum(n) {
    return (n == null) ? '0' : Number(n).toLocaleString();
  }

  function fmtBytes(b) {
    if (!b) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / 1024 / 1024).toFixed(2)} MB`;
  }

  // =================== Missions ===================

  async function loadMissions() {
    wireMissionsTabs();
    wireMissionsForm();
    document.getElementById('missions-detail-back').addEventListener('click', () => switchMissionsTab(missionsCurrentTab));
    await switchMissionsTab('upcoming');
  }

  function wireMissionsTabs() {
    document.querySelectorAll('#missions-tabs .kb-tab').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => switchMissionsTab(btn.dataset.missionsTab));
    });
  }

  async function switchMissionsTab(tab) {
    missionsCurrentTab = tab;
    document.querySelectorAll('#missions-tabs .kb-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.missionsTab === tab);
    });
    ['upcoming', 'past', 'schedule', 'detail'].forEach((t) => {
      const el = $(`missions-pane-${t}`);
      if (!el) return;
      if (t === tab) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
    if (tab === 'upcoming') await loadMissionsList('upcoming');
    if (tab === 'past')     await loadMissionsList('past');
    if (tab === 'schedule') await populateScheduleForm();
  }

  async function loadMissionsList(when) {
    const data = await fetchJson(`/api/missions?when=${when}`);
    const rows = data.missions || [];
    const host = $(`missions-${when}-table`);
    if (rows.length === 0) {
      host.innerHTML = `<div class="empty">No ${when} missions. Go to Schedule to add one.</div>`;
      return;
    }
    host.innerHTML = `
      <table class="dt">
        <thead><tr>
          <th>Company</th><th>Scheduled</th><th>Engagement</th><th>Brief</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(missionRow).join('')}</tbody>
      </table>`;
    host.querySelectorAll('[data-mission-open]').forEach((el) => {
      el.addEventListener('click', () => openMissionDetail(el.dataset.missionOpen));
    });
    host.querySelectorAll('[data-mission-cancel]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Cancel this mission? Any generated brief is preserved.')) return;
        const r = await fetch(`/api/missions/${btn.dataset.missionCancel}`, { method: 'DELETE', credentials: 'include' });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          alert(b.error || `HTTP ${r.status}`);
          return;
        }
        await loadMissionsList(when);
      });
    });
  }

  function missionRow(m) {
    const status = String(m.status || 'PENDING');
    const pillClass = status === 'BRIEFED'    ? 'pill-cached'
                    : status === 'COMPLETED'  ? 'pill-ok'
                    : status === 'FAILED'     ? 'pill-warn'
                    : status === 'CANCELLED'  ? 'pill-inline'
                    : 'pill-warn';
    const engagement = [];
    if ((m.product_ids    || []).length) engagement.push(`prod: ${m.product_ids.join(',')}`);
    if ((m.persona_ids    || []).length) engagement.push(`pers: ${m.persona_ids.join(',')}`);
    if ((m.competitor_ids || []).length) engagement.push(`comp: ${m.competitor_ids.join(',')}`);
    const briefBadge = m.brief_id
      ? '<span class="pill pill-cached">ready</span>'
      : m.brief_error
        ? `<span class="pill pill-warn" title="${escapeHtml(m.brief_error)}">failed</span>`
        : '<span class="pill pill-inline">pending</span>';
    const when = m.scheduled_at ? new Date(m.scheduled_at).toLocaleString() : '—';
    return `
      <tr class="missions-row" data-mission-open="${escapeHtml(m.id)}">
        <td>
          <div><strong>${escapeHtml(m.company_name || '—')}</strong></div>
          <div class="kb-row-sub">${escapeHtml(m.company_domain || '')}</div>
        </td>
        <td>${escapeHtml(when)}</td>
        <td class="mono kb-row-sub">${escapeHtml(engagement.join(' · ') || '—')}</td>
        <td>${briefBadge}</td>
        <td><span class="pill ${pillClass}">${escapeHtml(status)}</span></td>
        <td>${status === 'COMPLETED' || status === 'CANCELLED' ? '' :
          `<button class="kb-link-btn" data-mission-cancel="${escapeHtml(m.id)}">Cancel</button>`}
        </td>
      </tr>`;
  }

  async function openMissionDetail(id) {
    document.querySelectorAll('#missions-tabs .kb-tab').forEach((b) => b.classList.remove('active'));
    ['upcoming', 'past', 'schedule', 'detail'].forEach((t) => {
      const el = $(`missions-pane-${t}`);
      if (!el) return;
      el.classList.toggle('hidden', t !== 'detail');
    });
    const host = $('missions-detail-body');
    host.innerHTML = '<div class="content-loading"><div class="spinner"></div></div>';

    let data;
    try {
      data = await fetchJson(`/api/missions/${id}`);
    } catch (err) {
      host.innerHTML = `<div class="kb-result error">${escapeHtml(err.message)}</div>`;
      return;
    }
    const m = data.mission;
    const brief = data.brief;
    $('missions-detail-title').textContent = `${m.company_name || 'Mission'} — ${m.scheduled_at ? new Date(m.scheduled_at).toLocaleString() : '(no time)'}`;

    const hasBrief = !!brief;
    const hasBot   = !!m.recall_bot_id;
    // Whether the meeting URL is one Recall.ai can actually dispatch to.
    // Mirrors the server-side RECALL_HOSTS check in missions/dispatch.js.
    const recallReady = (() => {
      if (!m.meeting_url) return false;
      try {
        const h = new URL(m.meeting_url).hostname;
        return /(meet\.google\.com|zoom\.us|zoom\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|gotomeet(ing)?\.com|whereby\.com|chime\.aws)$/i.test(h);
      } catch { return false; }
    })();
    host.innerHTML = `
      <dl class="kv-list missions-detail-kv">
        <div class="k">Company</div><div class="v">${escapeHtml(m.company_name || '—')}${m.company_domain ? ` <span class="kb-subtle">(${escapeHtml(m.company_domain)})</span>` : ''}</div>
        <div class="k">Meeting URL</div><div class="v">${m.meeting_url ? `<a href="${escapeHtml(m.meeting_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(m.meeting_url)} ↗</a>` : '—'}</div>
        <div class="k">Prospect emails</div><div class="v">${(m.prospect_emails || []).map(escapeHtml).join(', ') || '—'}</div>
        <div class="k">Engagement</div><div class="v mono">${[
          (m.product_ids    || []).map((x) => `product=${x}`).join(','),
          (m.persona_ids    || []).map((x) => `persona=${x}`).join(','),
          (m.competitor_ids || []).map((x) => `competitor=${x}`).join(','),
        ].filter(Boolean).join(' · ') || '—'}</div>
        <div class="k">Status</div><div class="v"><span class="pill">${escapeHtml(m.status)}</span> ${m.brief_error ? `<span class="kb-subtle">${escapeHtml(m.brief_error)}</span>` : ''}</div>
        <div class="k">Recall bot</div><div class="v">${hasBot
          ? `<span class="pill pill-ok">dispatched</span> <span class="mono kb-subtle">${escapeHtml(m.recall_bot_id)}</span>`
          : `<span class="pill">none</span> <span class="kb-subtle">${recallReady ? 'auto-dispatches at T-2min' : (m.meeting_url ? 'meeting URL not Recall-ready' : 'no meeting URL')}</span>`}</div>
      </dl>
      <div class="missions-detail-actions">
        <button class="primary-cta" id="missions-brief-now-btn">${hasBrief ? 'Re-generate brief' : 'Generate brief now'}</button>
        <button class="kb-secondary-btn" id="missions-bot-now-btn" ${recallReady ? '' : 'disabled'} title="${recallReady ? '' : 'Need a meet.google.com / zoom.us / teams URL on the mission'}">${hasBot ? 'Re-send bot now' : 'Send bot now'}</button>
        <span class="kb-action-hint">Brief: Firecrawl + Gemini Pro. Bot: spawns Recall.ai notetaker (~30s to join).</span>
      </div>
      ${hasBrief ? `
        <div class="missions-brief-frame">
          <div class="missions-brief-meta">Generated ${fmtDate(brief.generated_at)} · ${(brief.retrieved_citations || []).length} chunks retrieved · ${(brief.transient_doc_ids || []).length} transient docs</div>
          <article class="missions-brief-content" id="missions-brief-render"></article>
        </div>
      ` : `<div class="empty">No brief generated yet.</div>`}
    `;
    if (hasBrief) {
      $('missions-brief-render').innerHTML = renderMarkdown(brief.content_md);
    }
    document.getElementById('missions-brief-now-btn').addEventListener('click', async () => {
      const btn = document.getElementById('missions-brief-now-btn');
      btn.disabled = true; btn.textContent = 'Generating (calls Gemini)…';
      try {
        const r = await fetch(`/api/missions/${id}/brief`, { method: 'POST', credentials: 'include' });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) {
          const e = new Error(b.error || `HTTP ${r.status}`);
          e.code = b.code || null;
          throw e;
        }
        await openMissionDetail(id);
      } catch (err) {
        // Quota / billing errors get a friendlier formatting with an action
        // link — everything else falls back to plain text in the alert.
        if (err.code === 'GEMINI_QUOTA') {
          alert(`Brief failed — Gemini quota exhausted.\n\n${err.message}\n\nThe mission has been marked FAILED with this reason; click "Re-generate brief" once the quota resets or a new key is in place.`);
        } else {
          alert(`Brief failed: ${err.message}`);
        }
        btn.disabled = false;
        btn.textContent = hasBrief ? 'Re-generate brief' : 'Generate brief now';
      }
    });

    const botBtn = document.getElementById('missions-bot-now-btn');
    if (botBtn && !botBtn.disabled) {
      botBtn.addEventListener('click', async () => {
        // Re-dispatch only if a bot already exists — gate that behind a confirm
        // so an accidental click doesn't put two bots in the same room.
        if (hasBot && !confirm('A Recall bot has already been dispatched for this mission. Send another one?')) return;
        botBtn.disabled = true;
        botBtn.textContent = hasBot ? 'Re-dispatching…' : 'Dispatching bot…';
        try {
          const url = `/api/missions/${id}/dispatch-bot${hasBot ? '?force=1' : ''}`;
          const r = await fetch(url, { method: 'POST', credentials: 'include' });
          const b = await r.json().catch(() => ({}));
          if (!r.ok) {
            const e = new Error(b.error || `HTTP ${r.status}`);
            e.code = b.code || null;
            throw e;
          }
          if (b.alreadyDispatched) {
            alert(`A bot was already dispatched for this mission (${b.botId}). Use the Meetings page to view its status.`);
          } else {
            alert(`Recall.ai bot dispatched.\nBot id: ${b.botId}\nStatus: ${b.botStatus || 'pending'}\n\nIt should join within ~30s. Tracking row created on the Meetings page.`);
          }
          await openMissionDetail(id);
        } catch (err) {
          if (err.code === 'BAD_MEETING_URL') {
            alert(`Bot dispatch rejected: ${err.message}\n\nFix the meeting URL on this mission (must be meet.google.com / zoom.us / teams) and retry.`);
          } else if (err.code === 'RECALL_NOT_CONFIGURED') {
            alert(`Recall.ai isn't configured. Set RECALL_AI_API_KEY in .env and restart the api container.`);
          } else {
            alert(`Bot dispatch failed: ${err.message}`);
          }
          botBtn.disabled = false;
          botBtn.textContent = hasBot ? 'Re-send bot now' : 'Send bot now';
        }
      });
    }
  }

  // Tiny markdown renderer — enough for the brief format (headings, bold,
  // italic, lists, code, hr, links). No third-party dep.
  function renderMarkdown(md) {
    if (!md) return '';
    const lines = md.split('\n');
    let html = '';
    let inList = false, inCode = false, codeBuf = [];
    const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
    const inline = (s) => escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const raw of lines) {
      if (raw.startsWith('```')) {
        if (inCode) { html += `<pre>${escapeHtml(codeBuf.join('\n'))}</pre>`; codeBuf = []; inCode = false; }
        else        { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(raw); continue; }
      if (raw.trim() === '---') { closeList(); html += '<hr>'; continue; }
      const h = raw.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); const level = h[1].length; html += `<h${level}>${inline(h[2])}</h${level}>`; continue; }
      const li = raw.match(/^[-*]\s+(.*)$/) || raw.match(/^\d+\.\s+(.*)$/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
      if (raw.trim() === '') { closeList(); html += ''; continue; }
      closeList();
      html += `<p>${inline(raw)}</p>`;
    }
    closeList();
    if (inCode) html += `<pre>${escapeHtml(codeBuf.join('\n'))}</pre>`;
    return html;
  }

  // Cached company list for Snap autofill. Keyed by lower-case name. Refreshed
  // each time the Schedule form opens so newly created companies are pickable.
  let _missionsCompanyByName = new Map();

  async function populateScheduleForm() {
    // Companies datalist + entity multi-selects.
    try {
      const [comp, pr, pe, co] = await Promise.all([
        fetchJson('/api/companies'),
        fetchJson('/api/portfolio/products'),
        fetchJson('/api/portfolio/personas'),
        fetchJson('/api/portfolio/competitors'),
      ]);
      const dl = document.getElementById('missions-company-list');
      dl.innerHTML = (comp.companies || []).map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.domain || '')}</option>`).join('');
      _missionsCompanyByName = new Map(
        (comp.companies || []).map((c) => [c.name.toLowerCase(), c])
      );
      fillTagSelect($('missions-product'),    pr.products    || [], 'No products');
      fillTagSelect($('missions-persona'),    pe.personas    || [], 'No personas');
      fillTagSelect($('missions-competitor'), co.competitors || [], 'No competitors');
    } catch (err) {
      console.warn('schedule form population failed:', err.message);
    }
    // Enable / wire the "Import from calendar" button if a calendar is connected.
    refreshCalendarImportButton();
  }

  // Snap autofill: when the typed company name matches a known company, fetch
  // the last non-cancelled mission's tag triplet + the company domain, and
  // pre-populate the form. The rep can override before submitting. Idempotent
  // — keeps re-firing on every input change so picking from the datalist or
  // typing the exact name both trigger the fill.
  async function snapAutofillForCompany(typedName) {
    const key = String(typedName || '').trim().toLowerCase();
    if (!key) return;
    const match = _missionsCompanyByName.get(key);
    if (!match) return; // unknown company — leave form blank for the rep to fill
    try {
      const data = await fetchJson(`/api/companies/${match.id}/last-mission-tags`);
      const banner = $('missions-snap-banner');
      // Pre-fill domain if blank; never overwrite a value the rep typed.
      const domainEl = $('missions-domain');
      if (domainEl && !domainEl.value.trim() && data.company && data.company.domain) {
        domainEl.value = data.company.domain;
      }
      // Pre-select the multi-selects from the last mission's tags.
      applySelectedValues($('missions-product'),    data.productIds    || []);
      applySelectedValues($('missions-persona'),    data.personaIds    || []);
      applySelectedValues($('missions-competitor'), data.competitorIds || []);
      const adv = $('missions-advanced');
      if (banner) {
        if (data.lastMission) {
          const when = data.lastMission.scheduled_at
            ? new Date(data.lastMission.scheduled_at).toLocaleDateString()
            : 'an earlier mission';
          const tagBits = [
            (data.productIds    || []).length && `${data.productIds.length} product${data.productIds.length === 1 ? '' : 's'}`,
            (data.personaIds    || []).length && `${data.personaIds.length} persona${data.personaIds.length === 1 ? '' : 's'}`,
            (data.competitorIds || []).length && `${data.competitorIds.length} competitor${data.competitorIds.length === 1 ? '' : 's'}`,
          ].filter(Boolean).join(' · ');
          banner.innerHTML = `<span class="snap-icon">📋</span><div><strong>Reusing setup from your last meeting with ${escapeHtml(match.name)}</strong><div class="snap-sub">${escapeHtml(when)}${tagBits ? ` · pre-filled ${escapeHtml(tagBits)}` : ''} · <a href="#" data-snap-edit>edit pre-filled values</a></div></div>`;
          banner.classList.remove('hidden');
          // Repeat-prospect: keep advanced collapsed (the rep only needs Time + URL).
          if (adv) adv.open = false;
        } else {
          banner.innerHTML = `<span class="snap-icon">🆕</span><div><strong>First meeting with ${escapeHtml(match.name)}</strong><div class="snap-sub">Pre-filled the domain. Set the right tags below — from now on this form will remember.</div></div>`;
          banner.classList.remove('hidden');
          // First-time prospect: open the advanced section so the rep notices
          // the tag selectors. Otherwise the brief runs unfiltered.
          if (adv) adv.open = true;
        }
        // "edit pre-filled values" link → expand the advanced section + scroll.
        const editLink = banner.querySelector('[data-snap-edit]');
        if (editLink) {
          editLink.addEventListener('click', (ev) => {
            ev.preventDefault();
            if (adv) { adv.open = true; adv.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
          });
        }
      }
    } catch (err) {
      console.warn('snap autofill failed:', err.message);
    }
  }

  // Select <option>s whose value is in `ids`. Multi-selects retain any
  // already-selected options outside the set (the rep's manual additions are
  // preserved); for the Snap path that's a no-op on a fresh form.
  function applySelectedValues(el, ids) {
    if (!el || el.disabled) return;
    const set = new Set(ids);
    for (const opt of Array.from(el.options)) {
      if (set.has(opt.value)) opt.selected = true;
    }
  }

  function wireMissionsForm() {
    const form = $('missions-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';

    // Snap autofill — fires on every change of the company-name input. The
    // `input` event covers typing AND datalist selection (most browsers fire
    // input when the user picks an option). Debounced lightly so we don't
    // refire on every keystroke.
    const companyInput = $('missions-company');
    if (companyInput) {
      let snapTimer = null;
      companyInput.addEventListener('input', () => {
        if (snapTimer) clearTimeout(snapTimer);
        snapTimer = setTimeout(() => snapAutofillForCompany(companyInput.value), 200);
      });
      companyInput.addEventListener('change', () => snapAutofillForCompany(companyInput.value));
    }

    // Schedule-import buttons — wired once; enabled/disabled per connection
    // state by refreshCalendarImportButton() (called from populateScheduleForm).
    const importBtn = $('missions-import-btn');
    if (importBtn) importBtn.addEventListener('click', () => {
      if (_calImportMode === 'connect') { window.location.href = '/api/integrations/calendar/connect'; return; }
      if (_calImportMode === 'import') openEventPicker('calendar');
    });
    const calendlyBtn = $('missions-calendly-btn');
    if (calendlyBtn) calendlyBtn.addEventListener('click', () => openEventPicker('calendly'));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('missions-submit-btn');
      const result = $('missions-form-result');
      result.classList.add('hidden');
      result.classList.remove('error', 'success');
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Scheduling…';

      try {
        const body = {
          companyName:    $('missions-company').value.trim(),
          companyDomain:  $('missions-domain').value.trim() || null,
          primaryContact: $('missions-primary-contact').value.trim() || null,
          // datetime-local emits a naive local string; toISOString converts
          // to UTC so the scheduler queries it consistently.
          scheduledAt:    new Date($('missions-scheduled-at').value).toISOString(),
          meetingUrl:     $('missions-url').value.trim() || null,
          prospectEmails: $('missions-emails').value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
          productIds:     readSelectedValues($('missions-product')),
          personaIds:     readSelectedValues($('missions-persona')),
          competitorIds:  readSelectedValues($('missions-competitor')),
          notes:          $('missions-notes').value.trim() || null,
        };
        const r = await fetch('/api/missions', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
        result.classList.remove('hidden');
        result.classList.add('success');
        result.innerHTML = `<strong>Scheduled.</strong> Mission ID: <span class="mono">${escapeHtml(payload.mission.id.slice(0,8))}</span>. <a href="#" id="missions-go-detail">View detail</a>`;
        form.reset();
        document.getElementById('missions-go-detail').addEventListener('click', (ev) => {
          ev.preventDefault();
          openMissionDetail(payload.mission.id);
        });
      } catch (err) {
        result.classList.remove('hidden');
        result.classList.add('error');
        result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  }

  // =================== Company Profile ===================
  // The tenant's own company: a header (name / domain / plan), its product
  // lines, and every scope=TENANT Knowledge-Base document grouped by the
  // product line it's filed under (plus a "Company-wide" bucket for untagged
  // intel). Product lines are the same `products` rows the upload forms file
  // documents under.

  async function loadCompany() {
    wireCompanyForm();
    await refreshCompany();
  }

  function wireCompanyForm() {
    const form = $('company-product-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('company-product-name').value.trim();
      const description = $('company-product-desc').value.trim() || null;
      if (!name) return;
      try {
        // Slugify the name into the TEXT pk — same as the upload-form picker.
        const id = slugify(name);
        const r = await fetch('/api/portfolio/products', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, description }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        form.reset();
        loaded.knowledge = false; // upload-form product datalists are now stale
        await refreshCompany();
      } catch (err) {
        alert(`Add failed: ${err.message}`);
      }
    });
  }

  async function refreshCompany() {
    let tenant = {}, products = [], docs = [];
    try {
      const [t, p, d] = await Promise.all([
        fetchJson('/api/tenant'),
        fetchJson('/api/portfolio/products'),
        fetchJson('/api/knowledge/documents?scope=TENANT'),
      ]);
      tenant = t.tenant || {};
      products = p.products || [];
      docs = d.documents || [];
    } catch (err) {
      $('company-header').innerHTML = `<div class="empty">Couldn't load company profile: ${escapeHtml(err.message)}</div>`;
      return;
    }

    // ---- header ----
    const planLabel = String(tenant.subscription_status || 'TRIAL').toUpperCase();
    const planOk = planLabel === 'ACTIVE' || planLabel === 'INTERNAL';
    const planPill = `<span class="pill ${planOk ? 'pill-ok' : 'pill-warn'}">${escapeHtml(planLabel)}</span>`;
    $('company-header').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div>
          <div style="font-size:20px;font-weight:700">${escapeHtml(tenant.name || 'Your company')}</div>
          <div style="margin-top:3px">${tenant.domain ? escapeHtml(tenant.domain) : '<span class="kb-subtle">no domain set</span>'} <span class="kb-subtle">· joined ${escapeHtml(fmtDate(tenant.created_at))}</span></div>
        </div>
        <div>${planPill}</div>
      </div>`;

    // ---- stat cards (stream breakdown from the TENANT-scoped docs only) ----
    const byStream = { FILE: 0, WEB: 0, SOCIAL: 0 };
    for (const d of docs) {
      const st = String(d.stream_type || 'FILE').toUpperCase();
      byStream[st] = (byStream[st] || 0) + 1;
    }
    $('company-stat-cards').innerHTML = [
      statCard('Product lines', fmtNum(products.length)),
      statCard('Company-intel docs', fmtNum(docs.length)),
      streamStatCard('Files', byStream.FILE, 'file'),
      streamStatCard('Web pages', byStream.WEB, 'web'),
      streamStatCard('Social posts', byStream.SOCIAL, 'social'),
    ].join('');

    // ---- product lines table ----
    const host = $('company-product-list');
    if (products.length === 0) {
      host.innerHTML = `<div class="empty">No product lines yet. Add one above, or create one inline while uploading a document.</div>`;
    } else {
      host.innerHTML = `
        <table class="dt">
          <thead><tr><th>Product line</th><th>Description</th><th>Filed docs</th><th></th></tr></thead>
          <tbody>${products.map((p) => `
            <tr>
              <td class="pf-name-cell">${escapeHtml(p.name)} <span class="mono kb-subtle">${escapeHtml(p.id)}</span></td>
              <td class="pf-desc-cell truncate">${escapeHtml(p.description || '—')}</td>
              <td>${fmtNum(p.doc_count)}</td>
              <td class="pf-actions-cell"><button class="kb-link-btn" data-company-del-product="${escapeHtml(p.id)}">Delete</button></td>
            </tr>`).join('')}</tbody>
        </table>`;
      host.querySelectorAll('[data-company-del-product]').forEach((b) =>
        b.addEventListener('click', () => companyDeleteProduct(b.dataset.companyDelProduct)));
    }

    // ---- intel grouped by product line ----
    $('company-intel').innerHTML = renderCompanyIntel(docs, products);
  }

  // Group scope=TENANT docs by their (single) product line into card grids;
  // a "Company-wide" bucket holds untagged docs. Empty product lines are shown
  // too so the slot is visible.
  function renderCompanyIntel(docs, products) {
    if (docs.length === 0 && products.length === 0) {
      return `<div class="company-intel-empty">No company intel yet. Go to Knowledge → Intel, pick "Our company", and add a file or web page.</div>`;
    }
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    const buckets = new Map();          // key: product id, or '' for company-wide
    buckets.set('', []);
    for (const p of products) buckets.set(p.id, []);
    for (const d of docs) {
      const pid = (d.product_ids && d.product_ids[0]) || '';
      if (!buckets.has(pid)) buckets.set(pid, []); // doc tagged with a deleted product (shouldn't happen)
      buckets.get(pid).push(d);
    }
    const order = ['', ...products.map((p) => p.id)];
    for (const k of buckets.keys()) if (!order.includes(k)) order.push(k);
    return order.map((pid) => {
      const list = buckets.get(pid) || [];
      const label = pid === '' ? 'Company-wide' : (nameById.get(pid) || pid);
      const badge = pid === ''
        ? `<span class="kb-row-scope scope-tenant" title="Intel that spans the whole company">${escapeHtml(label)}</span>`
        : `<span class="kb-tag-chip kb-tag-product">${escapeHtml(label)}</span>`;
      const body = list.length === 0
        ? `<div class="company-intel-empty">No documents filed here yet.</div>`
        : `<div class="company-intel-grid">${list.map(companyIntelCard).join('')}</div>`;
      return `
        <div class="company-intel-group">
          <div class="company-intel-group-h">${badge}<span class="kb-subtle">${fmtNum(list.length)} doc${list.length === 1 ? '' : 's'}</span></div>
          ${body}
        </div>`;
    }).join('');
  }

  // A short, readable "brief" of a document's content. Prefers a curated
  // metadata description (set by the web/social ingest lanes); otherwise falls
  // back to the start of the first chunk. Strips markdown noise, collapses
  // whitespace, trims to ~220 chars on a word boundary.
  function intelBrief(d) {
    const md = d.metadata || {};
    let raw = String(md.description || md.ogDescription || md.summary || '').trim();
    if (!raw) raw = String(d.first_chunk || '');
    raw = raw
      .replace(/^\s*#{1,6}\s+[^\n]*\n+/, '')    // drop a leading heading line (usually the title)
      .replace(/^[#>\s*_-]+/, '')               // any remaining leading markdown junk
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')  // links → link text
      .replace(/[*_`]+/g, '')                   // emphasis / code marks
      .replace(/\s+/g, ' ')
      .trim();
    // Drop cookie/consent/privacy/legal boilerplate sentences web scrapes drag in.
    raw = raw.replace(/[^.!?]*\b(uses? cookies|we( and (our|selected) partners)? use cookies|cookie (policy|preferences|consent|notice|settings|banner)|similar (technologies|methods) to (recognize|recognise)|we (value|take|respect) your privacy|process your personal (information|data)|by continuing (to (use|browse)|you (agree|consent))|in accordance with .{0,40}? regulations?|privacy (policy|notice|statement|centre|center)|terms of (use|service)|all rights reserved)\b[^.!?]*[.!?]?/gi, '')
             .replace(/\s+/g, ' ').trim();
    if (!raw || raw.length < 30) return null;
    // If what's left is still consent-y (≥2 of these), give up on the brief.
    const consentHits = [/\bcookies?\b/i, /\bconsent\b/i, /\bprivacy\b/i, /\bpersonal (information|data)\b/i, /\bregulations?\b/i, /\bpreferences?\b/i].filter((re) => re.test(raw)).length;
    if (consentHits >= 2) return null;
    if (raw.length > 220) raw = raw.slice(0, 220).replace(/\s+\S*$/, '') + ' …';
    return raw;
  }

  // A document card. Primary content is the AI "key points" (competitive points
  // for competitor intel, opportunity points for prospect intel — extracted at
  // ingest time and stored on metadata.keyPoints), falling back to a raw content
  // brief when none have been generated yet.
  // opts: { deletable, keyPointsAction } — both used only by the Library.
  function companyIntelCard(d, opts = {}) {
    const streamType = String(d.stream_type || 'FILE').toUpperCase();
    const streamPill = `<span class="kb-stream-pill stream-${streamType.toLowerCase()}">${escapeHtml(streamType)}</span>`;
    const title = d.source_url
      ? `<a href="${escapeHtml(d.source_url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(d.source_url)}">${escapeHtml(d.title)} ↗</a>`
      : escapeHtml(d.title);
    const md = d.metadata || {};
    const points = Array.isArray(md.keyPoints) ? md.keyPoints.filter(Boolean) : [];
    let contentHtml;
    if (points.length) {
      const kindLabel = md.keyPointsKind === 'competitive' ? 'Competitive points'
                      : md.keyPointsKind === 'opportunity' ? 'Opportunity points'
                      : 'Key points';
      contentHtml = `<div class="ci-keypoints">
          <div class="ci-keypoints-h">${escapeHtml(kindLabel)}</div>
          <ul>${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </div>`;
    } else {
      const brief = intelBrief(d);
      contentHtml = brief
        ? `<div class="ci-brief">${escapeHtml(brief)}</div>`
        : `<div class="ci-brief is-empty">No preview text available.</div>`;
    }
    const actions = [];
    if (opts.keyPointsAction) {
      actions.push(`<button class="kb-link-btn ci-kp-btn" data-kb-keypoints="${escapeHtml(d.id)}">${points.length ? '↻ refresh key points' : '✨ generate key points'}</button>`);
    }
    if (opts.deletable) {
      actions.push(`<button class="kb-link-btn" data-kb-delete="${escapeHtml(d.id)}">Delete</button>`);
    }
    return `
      <div class="company-intel-card stream-${streamType.toLowerCase()}">
        <div class="ci-title">${title}</div>
        <div class="ci-meta">
          ${streamPill}
          <span>${escapeHtml(prettyCategory(d.category))}</span>
          <span>${fmtNum(d.chunk_count)} chunk${d.chunk_count === 1 ? '' : 's'}</span>
          <span>${escapeHtml(fmtDate(d.effective_date || d.created_at))}</span>
        </div>
        ${contentHtml}
        ${actions.length ? `<div class="ci-actions">${actions.join('')}</div>` : ''}
      </div>`;
  }

  async function kbRegenKeyPoints(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '… analyzing'; }
    try {
      const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(id)}/keypoints`, {
        method: 'POST', credentials: 'include',
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      await loadKbLibrary(); // re-renders the card with the fresh points
    } catch (err) {
      alert(`Couldn't generate key points: ${err.message}`);
      if (btn) btn.disabled = false;
    }
  }

  async function companyDeleteProduct(id) {
    if (!confirm(`Delete product line "${id}"? Documents filed under it must be re-filed first (the server refuses otherwise).`)) return;
    try {
      const r = await fetch(`/api/portfolio/products/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      loaded.knowledge = false;
      await refreshCompany();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  // The "My Engagements" admin page (per-rep active product/persona/competitor
  // profile, with `/api/engagement/me` GET/PUT/DELETE) was retired 2026-05-11.
  // Mission tags are now the only scoping signal — the schedule form's "Snap"
  // autofill copies tags from the rep's last mission against the same prospect,
  // which is the same convenience without the extra page to maintain.

  // =================== Knowledge Base ===================

  async function loadKnowledge() {
    wireKbTabs();
    await switchKbTab('status');
    wireKbSourceCards();
    wireKbUploadForm();
    wireKbWebForm();
    wireKbSocialForm();
    wireKbEntitySelectors();
    await populateUploadTagSelects();
  }

  // Caches keyed by lower-cased name → row, used by the Upload-form pickers to
  // resolve a typed-or-picked name into an id (find-or-creating if new).
  let _kbCompanyByName    = new Map(); // prospects
  let _kbCompetitorByName = new Map();
  let _kbProductByName    = new Map(); // product lines (Fraud Solution, Payment Gateway, …)
  let _kbPersonaByName    = new Map(); // buyer personas (CFO, Head of Fraud, …)
  let _kbTenants          = [];        // superadmin only
  // Per-lane selected entity mode: 'TENANT' | 'PROSPECT' | 'COMPETITOR'.
  const _kbEntityMode = { file: 'TENANT', web: 'TENANT', social: 'TENANT' };

  // Populate the upload forms' product-line / buyer-persona / prospect /
  // competitor datalists (all free-text find-or-create pickers), and (for
  // superadmins) the tenant pickers. Idempotent.
  async function populateUploadTagSelects() {
    try {
      const reqs = [
        fetchJson('/api/portfolio/products'),
        fetchJson('/api/portfolio/personas'),
        fetchJson('/api/portfolio/competitors'),
        fetchJson('/api/companies'),
      ];
      if (isSuperadmin) reqs.push(fetchJson('/api/tenants'));
      const [pr, pe, co, companies, tenantsResp] = await Promise.all(reqs);

      const companyList    = companies.companies   || [];
      const competitorList = co.competitors        || [];
      const productList    = pr.products           || [];
      const personaList    = pe.personas           || [];
      _kbTenants = (tenantsResp && tenantsResp.tenants) || [];
      _kbCompanyByName    = new Map(companyList.map((c) => [c.name.toLowerCase(), c]));
      _kbCompetitorByName = new Map(competitorList.map((c) => [c.name.toLowerCase(), c]));
      _kbProductByName    = new Map(productList.map((p) => [p.name.toLowerCase(), p]));
      _kbPersonaByName    = new Map(personaList.map((p) => [p.name.toLowerCase(), p]));

      for (const lane of ['file', 'web', 'social']) {
        // Product line: a free-text picker (datalist of existing lines, typing
        // a new one find-or-creates it on submit). Buyer persona: same, but it
        // lives inside the PROSPECT detail panel (persona = a property of the
        // prospect's org, so it only shows when "A prospect" is selected).
        const prdl = document.getElementById(`kb-${lane}-product-list`);
        if (prdl) prdl.innerHTML = productList.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join('');
        const pedl = document.getElementById(`kb-${lane}-persona-list`);
        if (pedl) pedl.innerHTML = personaList.map((p) => `<option value="${escapeHtml(p.name)}"></option>`).join('');
        const pdl = document.getElementById(`kb-${lane}-prospect-list`);
        if (pdl) pdl.innerHTML = companyList.map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.domain || '')}</option>`).join('');
        const cdl = document.getElementById(`kb-${lane}-competitor-list`);
        if (cdl) cdl.innerHTML = competitorList.map((c) => `<option value="${escapeHtml(c.name)}"></option>`).join('');
        // Tenant detail: superadmins get a dropdown of all tenants; everyone
        // else just sees the static "workspace intel" label already in the HTML.
        const tsel = document.getElementById(`kb-${lane}-tenant-select`);
        if (tsel && isSuperadmin && _kbTenants.length) {
          tsel.classList.remove('hidden');
          tsel.innerHTML = _kbTenants.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}${t.domain ? ` (${escapeHtml(t.domain)})` : ''}</option>`).join('');
          const lbl = document.getElementById(`kb-${lane}-tenant-label`);
          if (lbl) lbl.textContent = 'Workspace (pick which tenant this Basis doc belongs to):';
        }
      }
    } catch (err) {
      console.warn('upload-form population failed:', err.message);
    }
  }

  // Segmented entity selector: click a button → activate it, swap the detail
  // panel, remember the mode for that lane.
  function wireKbEntitySelectors() {
    document.querySelectorAll('.kb-entity-opt').forEach((btn) => {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', () => {
        const lane = btn.dataset.lane;
        const mode = btn.dataset.entity;
        _kbEntityMode[lane] = mode;
        document.querySelectorAll(`.kb-entity-opt[data-lane="${lane}"]`).forEach((b) => b.classList.toggle('active', b === btn));
        document.querySelectorAll(`.kb-entity-detail[data-lane="${lane}"]`).forEach((d) => d.classList.toggle('hidden', d.dataset.entityDetail !== mode));
        // "Product line" lives inside the TENANT panel; "Buyer persona" inside
        // the PROSPECT panel. Switching away hides the field — clear any typed
        // value so it doesn't ride along with the next upload.
        if (mode !== 'TENANT')   { const pl = document.getElementById(`kb-${lane}-product`);  if (pl) pl.value = ''; }
        if (mode !== 'PROSPECT') { const pe = document.getElementById(`kb-${lane}-persona`);  if (pe) pe.value = ''; }
      });
    });
  }

  function slugify(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'entity';
  }

  // After a successful upload, snap the lane's entity selector back to TENANT
  // (form.reset() clears inputs but not the button/panel state).
  function resetEntitySelector(lane) {
    _kbEntityMode[lane] = 'TENANT';
    document.querySelectorAll(`.kb-entity-opt[data-lane="${lane}"]`).forEach((b) => b.classList.toggle('active', b.dataset.entity === 'TENANT'));
    document.querySelectorAll(`.kb-entity-detail[data-lane="${lane}"]`).forEach((d) => d.classList.toggle('hidden', d.dataset.entityDetail !== 'TENANT'));
    const p = $(`kb-${lane}-prospect`); if (p) p.value = '';
    const c = $(`kb-${lane}-competitor`); if (c) c.value = '';
    const pe = $(`kb-${lane}-persona`); if (pe) pe.value = '';
  }

  // Resolve a typed prospect name → companies row id (find-or-create).
  async function resolveCompanyName(typed) {
    const name = String(typed || '').trim();
    if (!name) return null;
    const hit = _kbCompanyByName.get(name.toLowerCase());
    if (hit) return hit.id;
    const r = await fetch('/api/companies', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(payload.error || `Could not create prospect "${name}"`);
    _kbCompanyByName.set(name.toLowerCase(), payload.company);
    return payload.company.id;
  }

  // Resolve a typed competitor name → competitors row id (find-or-create).
  // Competitors have a TEXT slug PK; a new name is slugified. If the slug
  // collides with an existing competitor we re-fetch and match by name.
  async function resolveCompetitorName(typed) {
    const name = String(typed || '').trim();
    if (!name) return null;
    const hit = _kbCompetitorByName.get(name.toLowerCase());
    if (hit) return hit.id;
    const id = slugify(name);
    const r = await fetch('/api/portfolio/competitors', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    if (r.ok) {
      const created = (await r.json()).competitor;
      _kbCompetitorByName.set(name.toLowerCase(), created);
      return created.id;
    }
    // 409 (slug taken) or other — re-fetch the list and try to match by name.
    const list = (await fetchJson('/api/portfolio/competitors')).competitors || [];
    _kbCompetitorByName = new Map(list.map((c) => [c.name.toLowerCase(), c]));
    const again = _kbCompetitorByName.get(name.toLowerCase());
    if (again) return again.id;
    const payload = await r.json().catch(() => ({}));
    throw new Error(payload.error || `Could not create competitor "${name}"`);
  }

  // Resolve a typed product-line name → products row id (find-or-create).
  // Product lines have a TEXT slug PK; a new name is slugified. If the slug
  // collides with an existing product we re-fetch the list and match by name.
  // Returns null for an empty string (= company-wide / no product line).
  async function resolveProductName(typed) {
    const name = String(typed || '').trim();
    if (!name) return null;
    const hit = _kbProductByName.get(name.toLowerCase());
    if (hit) return hit.id;
    const id = slugify(name);
    const r = await fetch('/api/portfolio/products', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    if (r.ok) {
      const created = (await r.json()).product;
      _kbProductByName.set(name.toLowerCase(), created);
      return created.id;
    }
    // 409 (slug taken) or other — re-fetch the list and try to match by name.
    const list = (await fetchJson('/api/portfolio/products')).products || [];
    _kbProductByName = new Map(list.map((p) => [p.name.toLowerCase(), p]));
    const again = _kbProductByName.get(name.toLowerCase());
    if (again) return again.id;
    const payload = await r.json().catch(() => ({}));
    throw new Error(payload.error || `Could not create product line "${name}"`);
  }

  // Resolve a typed buyer-persona name → personas row id (find-or-create).
  // Personas have a TEXT slug PK; a new name is slugified. If the slug collides
  // with an existing persona we re-fetch the list and match by name. Returns
  // null for an empty string. Used by the Intel forms' inline persona picker,
  // which only shows when the entity is a prospect.
  async function resolvePersonaName(typed) {
    const name = String(typed || '').trim();
    if (!name) return null;
    const hit = _kbPersonaByName.get(name.toLowerCase());
    if (hit) return hit.id;
    const id = slugify(name);
    const r = await fetch('/api/portfolio/personas', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name }),
    });
    if (r.ok) {
      const created = (await r.json()).persona;
      _kbPersonaByName.set(name.toLowerCase(), created);
      return created.id;
    }
    // 409 (slug taken) or other — re-fetch the list and try to match by name.
    const list = (await fetchJson('/api/portfolio/personas')).personas || [];
    _kbPersonaByName = new Map(list.map((p) => [p.name.toLowerCase(), p]));
    const again = _kbPersonaByName.get(name.toLowerCase());
    if (again) return again.id;
    const payload = await r.json().catch(() => ({}));
    throw new Error(payload.error || `Could not create persona "${name}"`);
  }

  // Read the entity selection for a lane and return the fields to send with
  // an upload: { scope, companyId?, competitorIds?, tenantId? }. Throws (with
  // a user-facing message) if a required pick is missing. `dryRun` skips any
  // find-or-create side effects (web/social preview mode).
  async function resolveEntityForLane(lane, { dryRun = false } = {}) {
    const mode = _kbEntityMode[lane] || 'TENANT';
    if (mode === 'TENANT') {
      const tsel = document.getElementById(`kb-${lane}-tenant-select`);
      const out = { scope: 'TENANT' };
      if (isSuperadmin && tsel && !tsel.classList.contains('hidden') && tsel.value) out.tenantId = tsel.value;
      return out;
    }
    if (mode === 'PROSPECT') {
      const name = ($(`kb-${lane}-prospect`).value || '').trim();
      if (dryRun) return { scope: 'PROSPECT', _prospectName: name || null };
      if (!name) throw new Error('Pick or type a prospect company.');
      return { scope: 'PROSPECT', companyId: await resolveCompanyName(name) };
    }
    // COMPETITOR
    const cname = ($(`kb-${lane}-competitor`).value || '').trim();
    if (dryRun) return { scope: 'COMPETITOR', _competitorName: cname || null };
    if (!cname) throw new Error('Pick or type a competitor.');
    return { scope: 'COMPETITOR', competitorIds: [await resolveCompetitorName(cname)], _competitorName: cname };
  }

  function fillTagSelect(el, items, emptyLabel) {
    if (!el) return;
    if (items.length === 0) {
      el.innerHTML = `<option disabled>${escapeHtml(emptyLabel)} — created via Knowledge → Intel uploads</option>`;
      el.disabled = true;
      return;
    }
    el.disabled = false;
    el.innerHTML = items.map((it) =>
      `<option value="${escapeHtml(it.id)}">${escapeHtml(it.name)}</option>`
    ).join('');
  }

  function readSelectedValues(el) {
    if (!el) return [];
    return Array.from(el.selectedOptions).map((o) => o.value).filter(Boolean);
  }

  function wireKbTabs() {
    document.querySelectorAll('#kb-tabs .kb-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchKbTab(btn.dataset.kbTab));
    });
  }

  // The Intel tab's source picker: three cards (file / web / social). Clicking
  // one activates it and reveals the matching form below; the others hide.
  function wireKbSourceCards() {
    document.querySelectorAll('#kb-source-cards .kb-source-card').forEach((card) => {
      if (card.dataset.wired === '1') return;
      card.dataset.wired = '1';
      card.addEventListener('click', () => {
        const target = card.dataset.kbSource;
        document.querySelectorAll('#kb-source-cards .kb-source-card').forEach((c) => c.classList.toggle('active', c === card));
        ['file', 'web', 'social'].forEach((t) => {
          const el = $(`kb-subpane-${t}`);
          if (el) el.classList.toggle('hidden', t !== target);
        });
      });
    });
  }

  async function switchKbTab(tab) {
    kbCurrentTab = tab;
    document.querySelectorAll('#kb-tabs .kb-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.kbTab === tab);
    });
    ['status', 'library', 'intel', 'search'].forEach((t) => {
      const el = $(`kb-pane-${t}`);
      if (!el) return;
      if (t === tab) el.classList.remove('hidden');
      else el.classList.add('hidden');
    });
    if (tab === 'status')  await loadKbStatus();
    if (tab === 'library') await loadKbLibrary();
    if (tab === 'search')  wireKbSearchForm();
  }

  function wireKbSearchForm() {
    const form = $('kb-search-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('kb-search-btn');
      btn.disabled = true;
      const originalLabel = btn.textContent;
      btn.textContent = 'Searching…';
      try {
        const body = {
          query: $('kb-search-query').value.trim(),
          k: parseInt($('kb-search-k').value, 10) || 8,
        };
        const cat = $('kb-search-category').value;
        if (cat) body.categories = [cat];
        const r = await fetch('/api/knowledge/search', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
        renderKbSearchResults(payload);
      } catch (err) {
        $('kb-search-results').innerHTML = `<div class="kb-result error">${escapeHtml(err.message)}</div>`;
      } finally {
        btn.disabled = false; btn.textContent = originalLabel;
      }
    });
  }

  function renderKbSearchResults(payload) {
    const host = $('kb-search-results');
    const chunks = payload.chunks || [];
    if (chunks.length === 0) {
      host.innerHTML = '<div class="empty">No chunks matched. KB may be empty or the filter excluded everything.</div>';
      return;
    }
    host.innerHTML = `
      <div class="kb-search-meta">${chunks.length} hit${chunks.length === 1 ? '' : 's'} for "<em>${escapeHtml(payload.query)}</em>"</div>
      <div class="kb-search-list">
        ${chunks.map((c) => {
          const st = String(c.streamType || 'FILE').toUpperCase();
          const date = c.effectiveDate ? `· as of ${escapeHtml(fmtDate(c.effectiveDate))}` : '';
          const source = c.sourceUrl
            ? `<a href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.sourceUrl)} ↗</a>`
            : '';
          return `
            <article class="kb-search-hit">
              <header class="kb-search-hit-head">
                <span class="mono">${escapeHtml(c.citation)}</span>
                <span class="kb-stream-pill stream-${st.toLowerCase()}">${st}</span>
                <span class="kb-search-distance">d=${c.distance.toFixed(3)}</span>
              </header>
              <div class="kb-search-hit-title">${escapeHtml(c.documentTitle)}
                <span class="kb-subtle">· ${escapeHtml(c.category)} ${date}</span>
              </div>
              <pre class="kb-search-hit-text">${escapeHtml(c.text)}</pre>
              ${source ? `<div class="kb-search-hit-source">${source}</div>` : ''}
            </article>`;
        }).join('')}
      </div>`;
  }

  async function loadKbStatus() {
    const s = await fetchJson('/api/knowledge/status');

    $('kb-hero').innerHTML = `
      <div class="kb-hero-inner">
        <div class="kb-hero-pulse ${s.active ? 'on' : 'off'}"></div>
        <div>
          <div class="kb-hero-title">${escapeHtml(s.summary)}</div>
          <div class="kb-hero-sub">
            ${fmtNum(s.totals.documents)} document${s.totals.documents === 1 ? '' : 's'} ·
            ${fmtNum(s.totals.chunks)} intelligence points ·
            ${fmtNum(s.totals.tokens)} tokens indexed
          </div>
        </div>
      </div>
    `;

    const cats = s.byCategory || {};
    const streams = s.byStreamType || { FILE: 0, WEB: 0, SOCIAL: 0 };
    $('kb-stat-cards').innerHTML = [
      // Top row: category split
      statCard('Product Intel',   `${fmtNum(cats.PRODUCT_INTEL?.documents)} docs`),
      statCard('Org Intelligence', `${fmtNum(cats.ORG_INTELLIGENCE?.documents)} docs`),
      statCard('Battlecards',     `${fmtNum(cats.BATTLECARDS?.documents)} docs`),
      statCard('Total Chunks',    fmtNum(s.totals.chunks)),
      // Bottom row: Omni-Sync source split
      streamStatCard('Files',         streams.FILE,   'file'),
      streamStatCard('Web Pages',     streams.WEB,    'web'),
      streamStatCard('Social Posts',  streams.SOCIAL, 'social'),
      providerStatCard(s.providers || {}),
    ].join('');

    $('kb-category-breakdown').innerHTML = `
      <dl class="kv-list">
        ${kbCatRow('Product Intel',    cats.PRODUCT_INTEL)}
        ${kbCatRow('Org Intelligence', cats.ORG_INTELLIGENCE)}
        ${kbCatRow('Battlecards',      cats.BATTLECARDS)}
      </dl>
      ${kbStatusPills(s.byStatus)}
    `;

    const gc = s.globalCache || {};
    const gcPill = gc.mode === 'cached'
      ? '<span class="pill pill-cached">cached</span>'
      : gc.mode === 'inline'
        ? '<span class="pill pill-warn">inline (below cache threshold)</span>'
        : '<span class="pill pill-inline">empty</span>';
    const gcRefreshed = gc.refreshedAt ? fmtDate(gc.refreshedAt) : '—';
    const gcDocs = (gc.documents || []).length;

    $('kb-engine-info').innerHTML = `
      <dl class="kv-list">
        <div class="k">Embedding model</div><div class="v mono">${escapeHtml(s.embedding.model)}</div>
        <div class="k">Dimensions</div><div class="v">${s.embedding.dimensions}</div>
        <div class="k">R2 archive</div><div class="v">${s.storage.r2Configured
          ? '<span class="pill pill-ok">configured</span>'
          : '<span class="pill pill-warn">not configured</span>'}</div>
        <div class="k">Global cache</div><div class="v">${gcPill} ${fmtNum(gcDocs)} doc${gcDocs === 1 ? '' : 's'} · ${fmtNum(gc.tokenCount)} tokens</div>
        <div class="k">Cache name</div><div class="v mono">${escapeHtml(gc.cacheName || '—')}</div>
        <div class="k">Refreshed</div><div class="v">${gcRefreshed}</div>
      </dl>
      <div class="kb-action-row">
        <button class="kb-secondary-btn" id="kb-rebuild-btn">Rebuild global cache</button>
        <span class="kb-action-hint">Rebuilds from ORG_INTELLIGENCE + BATTLECARDS docs.</span>
      </div>
    `;
    const rebuild = document.getElementById('kb-rebuild-btn');
    if (rebuild) rebuild.addEventListener('click', kbRebuildGlobalCache);
  }

  async function kbRebuildGlobalCache() {
    const btn = document.getElementById('kb-rebuild-btn');
    if (!btn) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Rebuilding…';
    try {
      const r = await fetch('/api/knowledge/global-cache/rebuild', {
        method: 'POST', credentials: 'include',
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      loaded.knowledge = false;
      await loadKbStatus();
    } catch (err) {
      alert(`Rebuild failed: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function kbCatRow(label, c) {
    const docs = c?.documents || 0;
    const chunks = c?.chunks || 0;
    const tag = docs > 0
      ? '<span class="pill pill-cached">READY</span>'
      : '<span class="pill pill-inline">empty</span>';
    return `
      <div class="k">${label}</div>
      <div class="v">${fmtNum(docs)} doc${docs === 1 ? '' : 's'} · ${fmtNum(chunks)} chunks ${tag}</div>
    `;
  }

  function kbStatusPills(byStatus) {
    if (!byStatus) return '';
    const pending = byStatus.PROCESSING || 0;
    const failed  = byStatus.FAILED || 0;
    const archived = byStatus.ARCHIVED || 0;
    if (!pending && !failed && !archived) return '';
    const bits = [];
    if (pending) bits.push(`<span class="pill pill-warn">${pending} processing</span>`);
    if (failed)  bits.push(`<span class="pill pill-warn">${failed} failed</span>`);
    if (archived) bits.push(`<span class="pill pill-inline">${archived} archived</span>`);
    return `<div class="kb-status-pills">${bits.join(' ')}</div>`;
  }

  // The Library now shows only COMPETITOR + PROSPECT intel, grouped by who it's
  // about (the tenant's own intel lives on the Company page). Two sections —
  // Competitors and Prospects — each rendered as a **grid of entity cards**
  // (one tile per competitor / prospect, side by side). Clicking a tile opens
  // the entity full-width and hides the other tiles in that section ("zoom"
  // pattern). Closing returns to the grid. Per-section selection is tracked on
  // the module so re-renders (after a research start, poll completion, delete,
  // etc.) preserve the open detail view.
  const _libSelected = { competitor: null, prospect: null };

  async function loadKbLibrary() {
    const host = $('kb-library-body');
    if (!host) return;
    host.innerHTML = '<div class="kb-subtle">Loading…</div>';

    let competitors = [], companies = [], compDocs = [], prosDocs = [], researchRows = [];
    try {
      const [c, co, cd, pd, rs] = await Promise.all([
        fetchJson('/api/portfolio/competitors'),
        fetchJson('/api/companies'),
        fetchJson('/api/knowledge/documents?scope=COMPETITOR'),
        fetchJson('/api/knowledge/documents?scope=PROSPECT'),
        fetchJson('/api/knowledge/research'),
      ]);
      competitors  = c.competitors  || [];
      companies    = co.companies   || [];
      compDocs     = cd.documents   || [];
      prosDocs     = pd.documents   || [];
      researchRows = rs.research    || [];
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn't load the library: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const researchByCompany = new Map(researchRows.map((r) => [r.company_id, r]));

    // Build the per-entity groups (sorted: most intel first, then by name).
    const byDocsThenName = (a, b) => (b.docs.length - a.docs.length) || a.label.localeCompare(b.label);
    const compGroups = competitors.map((e) => ({
      id: e.id, label: e.name, sub: e.description || '',
      docs: compDocs.filter((d) => Array.isArray(d.competitor_ids) && d.competitor_ids.includes(e.id)),
    })).sort(byDocsThenName);
    const prosGroups = companies.map((e) => ({
      id: e.id, label: e.name, sub: e.domain || '',
      docs: prosDocs.filter((d) => d.company_id === e.id),
    })).sort(byDocsThenName);
    // Orphan docs (no matching entity) intentionally not surfaced here — the
    // tile-grid pattern doesn't have a natural place for them. They remain in
    // the DB and still feed retrieval; rare in practice.

    // A small status pill (research state) shown on each prospect tile and in
    // its detail header — so the collapsed grid still scans at a glance.
    const prospectBadge = (id) => {
      const r = researchByCompany.get(id);
      if (!r) return '';
      if (r.status === 'RUNNING') return ` <span class="lib-badge lib-badge-running">🔄 researching</span>`;
      if (r.status === 'FAILED')  return ` <span class="lib-badge lib-badge-failed">⚠︎ research failed</span>`;
      return ` <span class="lib-badge lib-badge-done">🔎 researched · ${escapeHtml(fmtDate(r.updated_at || r.created_at))}</span>`;
    };

    host.innerHTML =
      renderLibrarySection({
        title: 'Competitors', singular: 'competitor', icon: '🥊',
        section: 'competitor', scopeClass: 'scope-competitor',
        groups: compGroups, docTotal: compDocs.length,
        emptyHint: 'No competitors yet — add one from <strong>Intel</strong> ("A competitor").',
        cardPreview: competitorCardPreview,
        detailContent: competitorDetailContent,
      }) +
      renderLibrarySection({
        title: 'Prospects', singular: 'prospect', icon: '🎯',
        section: 'prospect', scopeClass: 'scope-prospect',
        groups: prosGroups, docTotal: prosDocs.length,
        emptyHint: 'No prospects yet — add one from <strong>Intel</strong> ("A prospect").',
        cardPreview: (g) => prospectCardPreview(g, researchByCompany.get(g.id)),
        detailContent: (g) => prospectDetailContent(g, researchByCompany.get(g.id)),
        badgeFor: prospectBadge,
      });

    host.querySelectorAll('[data-kb-delete]').forEach((b) =>
      b.addEventListener('click', () => kbDeleteDoc(b.dataset.kbDelete)));
    host.querySelectorAll('[data-kb-keypoints]').forEach((b) =>
      b.addEventListener('click', () => kbRegenKeyPoints(b.dataset.kbKeypoints, b)));
    host.querySelectorAll('[data-research-start],[data-research-rerun]').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        kbStartResearch(b.dataset.researchStart || b.dataset.researchRerun, b);
      }));
    // Tile click → open that entity's detail view. Keyboard (Enter/Space) too,
    // since the tile is a div with role=button (it can't be a <button> because
    // it nests block-level content the spec disallows).
    host.querySelectorAll('[data-lib-open]').forEach((el) => {
      const open = () => {
        const [section, id] = el.dataset.libOpen.split(':');
        _libSelected[section] = id;
        loadKbLibrary();
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); }
      });
    });
    // "← Back" → drop the section's selection and re-render the grid.
    host.querySelectorAll('[data-lib-close]').forEach((b) =>
      b.addEventListener('click', () => {
        _libSelected[b.dataset.libClose] = null;
        loadKbLibrary();
      }));
    // Re-attach pollers for any run still in flight (e.g. after a page reload).
    researchRows.filter((r) => r.status === 'RUNNING').forEach((r) => pollResearch(r.company_id));
  }

  // First sentence of `s`, hard-clamped to `max` chars (word boundary). Used
  // by the prospect tile preview to surface a one-glance summary of the deep
  // research without dumping the whole paragraph into the tile.
  function firstSentence(s, max = 200) {
    const raw = String(s || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    const m = raw.match(/^[^.!?]+[.!?]/);
    let out = m ? m[0] : raw;
    if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '') + '…';
    return out.trim();
  }

  // Tile-preview / detail-body builders — split per section so each can pick
  // the most useful summary content (deep-research summary for prospects;
  // first key-point / brief for competitors).
  function prospectCardPreview(g, r) {
    if (r && r.status === 'DONE' && r.summary) return escapeHtml(firstSentence(r.summary, 220));
    if (r && r.status === 'RUNNING') return '<span class="kb-subtle">Researching their site &amp; the web — open to watch progress.</span>';
    if (r && r.status === 'FAILED')  return `<span class="kb-subtle">Last research failed: ${escapeHtml(r.error || 'unknown error')}. Open to retry.</span>`;
    if (g.docs.length > 0) {
      const brief = intelBrief(g.docs[0]);
      if (brief) return escapeHtml(brief);
    }
    return '<span class="kb-subtle">No deep research yet — open the card to run it.</span>';
  }
  function prospectDetailContent(g, r) {
    return renderResearchPanel(g.id, r);
  }
  function competitorCardPreview(g) {
    if (g.docs.length > 0) {
      const md = g.docs[0].metadata || {};
      const points = Array.isArray(md.keyPoints) ? md.keyPoints.filter(Boolean) : [];
      if (points.length) return escapeHtml(points[0]);
      const brief = intelBrief(g.docs[0]);
      if (brief) return escapeHtml(brief);
    }
    if (g.sub) return escapeHtml(g.sub);
    return '<span class="kb-subtle">No intel filed yet — open the card to add some.</span>';
  }
  function competitorDetailContent(g) {
    if (g.docs.length === 0) {
      return `<div class="company-intel-empty">No intel filed under ${escapeHtml(g.label)} yet. Add some from <strong>Knowledge → Intel</strong>.</div>`;
    }
    return `<div class="company-intel-grid">${g.docs.map((d) => companyIntelCard(d, { deletable: true, keyPointsAction: true })).join('')}</div>`;
  }

  // One Library section: a wrapping `.card` whose body is either
  //   - a **grid of entity tiles** (default, when nothing is selected), or
  //   - a **detail view** of one entity (when its id is in `_libSelected`).
  // Each tile shows a name chip + sub line + doc count + optional status badge
  // + a short content preview. Clicking a tile sets `_libSelected[section]=id`
  // and re-renders. The detail view shows a "← Back" + the same header bits +
  // `detailContent(g)` (research panel for prospects, intel cards for comps).
  function renderLibrarySection({ title, singular, icon, section, scopeClass, groups, docTotal, emptyHint, cardPreview, detailContent, badgeFor = null }) {
    const head = `${icon} ${escapeHtml(title)} <span class="kb-subtle" style="font-weight:400">— ${fmtNum(groups.length)} ${escapeHtml(singular)}${groups.length === 1 ? '' : 's'} · ${fmtNum(docTotal)} intel doc${docTotal === 1 ? '' : 's'}</span>`;

    const selectedId = _libSelected[section];
    const selected = selectedId ? groups.find((g) => g.id === selectedId) : null;
    // Stale selection (entity gone) → fall back to the grid.
    if (selectedId && !selected) _libSelected[section] = null;

    let body;
    if (groups.length === 0) {
      body = `<div class="company-intel-empty">${emptyHint}</div>`;
    } else if (selected) {
      body = `
        <div class="lib-detail">
          <div class="lib-detail-h">
            <button type="button" class="kb-link-btn lib-back" data-lib-close="${escapeHtml(section)}">← Back to all ${escapeHtml(singular)}s</button>
            <span class="kb-row-scope ${scopeClass}">${escapeHtml(selected.label)}</span>
            ${selected.sub ? `<span class="kb-subtle">${escapeHtml(selected.sub)}</span>` : ''}
            <span class="kb-subtle">${fmtNum(selected.docs.length)} intel doc${selected.docs.length === 1 ? '' : 's'}</span>
            ${badgeFor ? badgeFor(selected.id) : ''}
          </div>
          <div class="lib-detail-b">${detailContent(selected)}</div>
        </div>`;
    } else {
      body = `<div class="lib-card-grid">${groups.map((g) => `
        <div class="lib-card" role="button" tabindex="0" data-lib-open="${escapeHtml(section)}:${escapeHtml(g.id)}" aria-label="Open ${escapeHtml(g.label)}">
          <div class="lib-card-h">
            <span class="kb-row-scope ${scopeClass}">${escapeHtml(g.label)}</span>
            ${badgeFor ? badgeFor(g.id) : ''}
          </div>
          <div class="lib-card-meta">
            ${g.sub ? `<span>${escapeHtml(g.sub)}</span>` : ''}
            <span class="kb-subtle">${fmtNum(g.docs.length)} intel doc${g.docs.length === 1 ? '' : 's'}</span>
          </div>
          <div class="lib-card-preview">${cardPreview(g) || '<span class="kb-subtle">No preview yet — open to view.</span>'}</div>
        </div>`).join('')}</div>`;
    }
    return `
      <div class="card" style="margin-bottom:18px">
        <div class="card-h">${head}</div>
        <div class="card-b">${body}</div>
      </div>`;
  }

  // ── Deep-research panel (Library → Prospects) ─────────────────────────────
  function renderResearchPanel(companyId, r) {
    if (!r) {
      return `<div class="research-panel research-empty">
        <button class="kb-link-btn research-btn" data-research-start="${escapeHtml(companyId)}">🔍 Deep research</button>
        <span class="kb-subtle">— scrape their site &amp; recent public news, then map openings to your portfolio</span>
      </div>`;
    }
    if (r.status === 'RUNNING') {
      return `<div class="research-panel research-running">
        <span class="research-spinner">🔄</span> Researching… scraping their site &amp; the web — this takes a minute.
      </div>`;
    }
    if (r.status === 'FAILED') {
      return `<div class="research-panel research-failed">
        <span>⚠︎ Research failed: ${escapeHtml(r.error || 'unknown error')}</span>
        <button class="kb-link-btn research-btn" data-research-rerun="${escapeHtml(companyId)}">↻ retry</button>
      </div>`;
    }
    // DONE
    const opps = Array.isArray(r.opportunities) ? r.opportunities : [];
    const srcs = Array.isArray(r.sources) ? r.sources : [];
    const srcByN = new Map(srcs.map((s) => [s.n, s]));
    const dot = (s) => `<span class="research-dot research-${escapeHtml(s)}" title="${escapeHtml(s)} play"></span>`;
    const cite = (ns) => (ns || []).map((n) => {
      const s = srcByN.get(n);
      return s
        ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer" class="research-cite" title="${escapeHtml(s.title || s.url)}">[${n}]</a>`
        : `<span class="research-cite">[${n}]</span>`;
    }).join(' ');
    const oppHtml = opps.length
      ? `<ol class="research-opps">${opps.map((o) => {
          // tolerate the old {point, product} shape too
          const title    = o.title || null;
          const analysis = o.analysis || o.point || '';
          const products = Array.isArray(o.products) ? o.products : (o.product ? [o.product] : []);
          const chips = products.map((p) => `<span class="kb-tag-chip kb-tag-product">${escapeHtml(p)}</span>`).join(' ');
          return `<li>
            <div class="research-opp-title">${dot(o.strength)}${title ? `<strong>${escapeHtml(title)}</strong>` : `<strong>${escapeHtml(analysis.slice(0, 60))}…</strong>`} ${cite(o.sources)}</div>
            ${title ? `<div class="research-opp-analysis">${escapeHtml(analysis)}</div>` : ''}
            ${chips ? `<div class="research-opp-products">${chips}</div>` : ''}
          </li>`;
        }).join('')}</ol>`
      : `<div class="kb-subtle">No clear openings surfaced — the public footprint was thin.</div>`;
    const sourcesHtml = srcs.length
      ? `<details class="research-sources"><summary>Sources (${srcs.length})</summary><ol>${srcs.map((s) =>
          `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.url)}</a>${s.date ? ` <span class="kb-subtle">· ${escapeHtml(String(s.date).slice(0, 10))}</span>` : ''}${s.scraped ? '' : ' <span class="kb-subtle">(snippet)</span>'}</li>`).join('')}</ol></details>`
      : '';
    const noPortfolioHint = (r.models && r.models.hadPortfolio === false)
      ? `<div class="kb-subtle research-portfolio-hint">⚠︎ No product portfolio on file — the products below are capability categories. Add your product lines on the <strong>Company</strong> page and re-run so these map to your actual catalogue.</div>`
      : '';
    return `<div class="research-panel research-done">
      <div class="research-h">🔎 Deep research <span class="kb-subtle" style="font-weight:400">· ${fmtNum(r.source_count)} source${r.source_count === 1 ? '' : 's'} · ${escapeHtml(fmtDate(r.updated_at || r.created_at))}</span>
        <button class="kb-link-btn research-btn" data-research-rerun="${escapeHtml(companyId)}">↻ re-run</button></div>
      ${r.summary ? `<div class="research-summary">${escapeHtml(r.summary)}</div>` : ''}
      ${noPortfolioHint}
      ${oppHtml}
      ${sourcesHtml}
    </div>`;
  }

  const _researchPolls = new Map(); // companyId → intervalId
  function pollResearch(companyId) {
    if (_researchPolls.has(companyId)) return;
    let attempts = 0;
    const id = setInterval(async () => {
      attempts++;
      let row = null;
      try { row = (await fetchJson(`/api/knowledge/research/${encodeURIComponent(companyId)}`)).research; } catch { /* ignore */ }
      if (!row || row.status !== 'RUNNING' || attempts >= 30) {
        clearInterval(id);
        _researchPolls.delete(companyId);
        await loadKbLibrary();
      }
    }, 6000);
    _researchPolls.set(companyId, id);
  }

  async function kbStartResearch(companyId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'starting…'; }
    try {
      const r = await fetch(`/api/knowledge/research/${encodeURIComponent(companyId)}`, { method: 'POST', credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    } catch (err) {
      alert(`Couldn't start research: ${err.message}`);
      if (btn) btn.disabled = false;
      return;
    }
    await loadKbLibrary();      // re-render → shows "Researching…"
    pollResearch(companyId);
  }

  function prettyCategory(cat) {
    return {
      PRODUCT_INTEL: 'Product Intel',
      ORG_INTELLIGENCE: 'Org Intelligence',
      BATTLECARDS: 'Battlecards',
    }[cat] || cat;
  }

  // Apply the preview's AI-suggested category to an upload-form <select>, if
  // the value is one of its options. The user can still change it afterwards.
  function applySuggestedCategory(selectId, cat) {
    const sel = $(selectId);
    if (!sel || !cat) return;
    if ([...sel.options].some((o) => o.value === cat)) sel.value = cat;
  }

  async function kbDeleteDoc(id) {
    if (!confirm('Delete this document and all its chunks? This cannot be undone.')) return;
    const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE', credentials: 'include',
    });
    if (!r.ok) {
      alert(`Delete failed: HTTP ${r.status}`);
      return;
    }
    await loadKbLibrary();
    // Status pane + Company profile are stale now too.
    loaded.knowledge = false;
    loaded.company = false;
  }

  function wireKbWebForm() {
    const form = $('kb-web-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('kb-web-btn');
      const result = $('kb-web-result');
      const dryRun = $('kb-web-dryrun').checked;
      result.classList.add('hidden');
      result.classList.remove('error', 'success');
      btn.disabled = true; btn.textContent = dryRun ? 'Fetching preview…' : 'Fetching & indexing…';

      try {
        const body = {
          url: $('kb-web-url').value.trim(),
          category: $('kb-web-category').value,
          dryRun,
        };
        const title = $('kb-web-title').value.trim();
        if (title) body.title = title;
        // Product line: free-typed names get find-or-created — but only on a
        // real ingest, not a dry run (which makes no DB writes). Empty = none.
        const webProductLine = ($('kb-web-product').value || '').trim();
        if (webProductLine && !dryRun) body.productIds = [await resolveProductName(webProductLine)];
        // Entity selection. On dry-run we don't find-or-create (no DB writes);
        // a COMPETITOR pick still triggers the head-to-head comparison.
        const ent = await resolveEntityForLane('web', { dryRun });
        body.scope = ent.scope;
        if (ent.companyId) body.companyId = ent.companyId;
        if (ent.competitorIds) body.competitorIds = ent.competitorIds;
        if (ent.tenantId) body.tenantId = ent.tenantId;
        if (ent._competitorName) body.competitorName = ent._competitorName;
        // Buyer persona — only when this is prospect intel; find-or-created on
        // a real ingest (skipped on dry run, which makes no DB writes).
        if (ent.scope === 'PROSPECT' && !dryRun) {
          const pid = await resolvePersonaName(($('kb-web-persona').value || '').trim());
          if (pid) body.personaIds = [pid];
        }

        const r = await fetch('/api/knowledge/web-sync', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);

        result.classList.remove('hidden');
        result.classList.add('success');
        if (dryRun) {
          result.innerHTML = renderPreviewCard(payload.preview || {});
          applySuggestedCategory('kb-web-category', payload.preview && payload.preview.suggestedCategory);
        } else {
          const d = payload.document || {};
          result.innerHTML = `
            <strong>Indexed.</strong> ${escapeHtml(d.title || '—')} — <span class="kb-row-scope scope-${String(d.scope || 'tenant').toLowerCase()}">${escapeHtml(d.scope || 'TENANT')}</span> · ${fmtNum(d.chunk_count)} chunks,
            ${fmtNum(d.token_count)} tokens · <span class="kb-stream-pill stream-web">WEB</span>.
            <a href="#" id="kb-web-go-library">Open Library</a>
          `;
          form.reset();
          $('kb-web-dryrun').checked = true;
          resetEntitySelector('web');
          const go = document.getElementById('kb-web-go-library');
          if (go) go.addEventListener('click', (ev) => {
            ev.preventDefault();
            switchKbTab('library');
          });
          loaded.knowledge = false;
          loaded.company = false; // a TENANT page changes the Company profile
        }
      } catch (err) {
        result.classList.remove('hidden');
        result.classList.add('error');
        result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Fetch & index';
      }
    });
  }

  function wireKbSocialForm() {
    const form = $('kb-social-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('kb-social-btn');
      const result = $('kb-social-result');
      const dryRun = $('kb-social-dryrun').checked;
      result.classList.add('hidden');
      result.classList.remove('error', 'success');
      btn.disabled = true; btn.textContent = dryRun ? 'Fetching preview…' : 'Fetching & indexing…';

      try {
        const body = {
          accountId: $('kb-social-account').value.trim(),
          category: $('kb-social-category').value,
          dryRun,
        };
        // Product line: free-typed names get find-or-created — but only on a
        // real ingest, not a dry run (which makes no DB writes). Empty = none.
        const socialProductLine = ($('kb-social-product').value || '').trim();
        if (socialProductLine && !dryRun) body.productIds = [await resolveProductName(socialProductLine)];
        const since = $('kb-social-since').value;
        if (since) body.since = new Date(since).toISOString();
        const limit = parseInt($('kb-social-limit').value, 10);
        if (!Number.isNaN(limit)) body.limit = limit;
        const ent = await resolveEntityForLane('social', { dryRun });
        body.scope = ent.scope;
        if (ent.companyId) body.companyId = ent.companyId;
        if (ent.competitorIds) body.competitorIds = ent.competitorIds;
        if (ent.tenantId) body.tenantId = ent.tenantId;
        // Buyer persona — only when this is prospect intel; find-or-created on
        // a real ingest (skipped on dry run, which makes no DB writes).
        if (ent.scope === 'PROSPECT' && !dryRun) {
          const pid = await resolvePersonaName(($('kb-social-persona').value || '').trim());
          if (pid) body.personaIds = [pid];
        }

        const r = await fetch('/api/knowledge/social-sync', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);

        result.classList.remove('hidden');
        result.classList.add('success');
        if (dryRun) {
          result.innerHTML = renderSocialPreview(payload.preview || {});
        } else {
          const res = payload.result || {};
          result.innerHTML = `
            <strong>Indexed.</strong> ${fmtNum(res.ingested)} of ${fmtNum(res.fetched)} posts ingested
            (${fmtNum(res.skipped)} skipped) · stream: <span class="kb-stream-pill stream-social">SOCIAL</span>.
            <a href="#" id="kb-social-go-library">Open Library</a>
          `;
          form.reset();
          $('kb-social-dryrun').checked = true;
          $('kb-social-limit').value = '25';
          resetEntitySelector('social');
          const go = document.getElementById('kb-social-go-library');
          if (go) go.addEventListener('click', (ev) => {
            ev.preventDefault();
            switchKbTab('library');
          });
          loaded.knowledge = false;
          loaded.company = false; // TENANT posts change the Company profile
        }
      } catch (err) {
        result.classList.remove('hidden');
        result.classList.add('error');
        result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Fetch & index';
      }
    });
  }

  // ---- Structured preview card (file / web dry-run) ----
  function renderPreviewCard(p) {
    if (!p || typeof p !== 'object') return '<div>No preview available.</div>';
    const st = p.stats || {};
    const src = p.sourceUrl
      ? `<div class="kb-preview-src"><a href="${escapeHtml(p.sourceUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.sourceUrl)} ↗</a></div>`
      : (p.originalFilename ? `<div class="kb-preview-src kb-subtle">${escapeHtml(p.originalFilename)}</div>` : '');
    const badges = [
      p.documentType ? `<span class="kb-preview-badge doctype">${escapeHtml(p.documentType)}</span>` : '',
      p.streamType ? `<span class="kb-preview-badge">${escapeHtml(p.streamType)}</span>` : '',
      (st.words != null) ? `<span class="kb-preview-badge">${fmtNum(st.words)} words</span>` : '',
      (st.estTokens != null) ? `<span class="kb-preview-badge">~${fmtNum(st.estTokens)} tokens</span>` : '',
      (st.estChunks != null) ? `<span class="kb-preview-badge">~${fmtNum(st.estChunks)} chunk${st.estChunks === 1 ? '' : 's'}</span>` : '',
      p.effectiveDate ? `<span class="kb-preview-badge">as of ${escapeHtml(fmtDate(p.effectiveDate))}</span>` : '',
    ].filter(Boolean).join('');
    const topics = (p.keyTopics || []).length
      ? `<div class="kb-preview-topics">${p.keyTopics.map((t) => `<span class="kb-preview-topic">${escapeHtml(t)}</span>`).join('')}</div>` : '';
    const outline = (p.outline || []).length
      ? `<details class="kb-preview-sec"><summary>Outline (${p.outline.length})</summary><ul class="kb-preview-outline">${p.outline.map((o) => `<li class="lvl-${o.level}">${escapeHtml(o.heading)}</li>`).join('')}</ul></details>` : '';
    const fulltext = p.fullText
      ? `<details class="kb-preview-sec"><summary>Extracted text${p.fullTextTruncated ? ' (truncated)' : ''}</summary><pre class="kb-preview-fulltext">${escapeHtml(p.fullText)}</pre></details>` : '';
    const aiTag = p.summarySource === 'gemini' ? '<span class="kb-preview-ai-tag">AI summary</span>' : '';
    const catHint = p.suggestedCategory ? `
      <div class="kb-preview-cat">
        <span class="kb-preview-cat-label">${p.suggestedCategorySource === 'scope' ? 'Category' : 'Suggested category'}</span>
        <strong>${escapeHtml(prettyCategory(p.suggestedCategory))}</strong>
        <span class="kb-subtle">— applied to the Category dropdown above; change it if that's not right.</span>
      </div>` : '';
    const next = p.streamType === 'WEB'
      ? 'Nothing indexed yet — uncheck "Preview only" and resubmit to add it.'
      : 'Nothing indexed yet — click "Upload &amp; index" to add it to the Knowledge Base.';
    return `
      <div class="kb-preview">
        <div class="kb-preview-head">
          ${p.title ? `<div class="kb-preview-title">${escapeHtml(p.title)}</div>` : ''}
          ${src}
        </div>
        ${badges ? `<div class="kb-preview-badges">${badges}</div>` : ''}
        ${catHint}
        ${p.summary ? `<div class="kb-preview-summary">${aiTag}${escapeHtml(p.summary)}</div>` : ''}
        ${renderComparison(p.comparison)}
        ${topics}
        ${outline}
        ${fulltext}
        <div class="kb-preview-note">${next}</div>
      </div>`;
  }

  // ---- Competitor head-to-head comparison (rendered when scope=COMPETITOR) ----
  function renderComparison(c) {
    if (!c) return '';
    if (!c.available) {
      return `<div class="kb-preview-cmp-na">⚖︎ ${escapeHtml(c.reason || 'Comparison unavailable.')}</div>`;
    }
    const edgeCell = (e) => {
      const v = String(e || 'EVEN').toUpperCase();
      const label = v === 'OURS' ? 'Us' : v === 'THEIRS' ? 'Them' : 'Even';
      return `<span class="kb-cmp-edge edge-${v.toLowerCase()}">${label}</span>`;
    };
    const rows = (c.dimensions || []).map((d) => `
      <tr>
        <th scope="row">${escapeHtml(d.dimension || '')}</th>
        <td>${escapeHtml(d.ours || '—')}</td>
        <td>${escapeHtml(d.theirs || '—')}</td>
        <td class="kb-cmp-edgecell">${edgeCell(d.edge)}${d.note ? `<div class="kb-cmp-note">${escapeHtml(d.note)}</div>` : ''}</td>
      </tr>`).join('');
    const list = (title, arr, cls) => (arr || []).length
      ? `<div class="kb-cmp-list ${cls}"><div class="kb-cmp-list-h">${escapeHtml(title)}</div><ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : '';
    const who = c.competitorName ? escapeHtml(c.competitorName) : 'this competitor';
    return `
      <div class="kb-preview-cmp">
        <div class="kb-cmp-head">⚔︎ Head-to-head — us vs. <strong>${who}</strong></div>
        ${c.competitorOverview ? `<div class="kb-cmp-overview">${escapeHtml(c.competitorOverview)}</div>` : ''}
        ${rows ? `<div class="kb-cmp-tablewrap"><table class="kb-cmp-table">
          <thead><tr><th>Dimension</th><th>Us</th><th>Them</th><th>Edge</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : ''}
        <div class="kb-cmp-lists">
          ${list('Where we win', c.ourStrengths, 'win')}
          ${list('Where they win / our gaps', c.theirStrengths, 'lose')}
          ${list('Similarities', c.similarities, 'same')}
          ${list('Talking points', c.talkingPoints, 'talk')}
        </div>
      </div>`;
  }

  // ---- Social dry-run preview (multi-post) ----
  function renderSocialPreview(p) {
    const posts = (p && p.sample) || [];
    const engStr = (e) => {
      if (!e || typeof e !== 'object') return '';
      const bits = [];
      if (e.like_count != null) bits.push(`${fmtNum(e.like_count)} likes`);
      if (e.comment_count != null) bits.push(`${fmtNum(e.comment_count)} comments`);
      if (e.share_count != null) bits.push(`${fmtNum(e.share_count)} shares`);
      if (e.view_count != null) bits.push(`${fmtNum(e.view_count)} views`);
      return bits.length ? ` · ${bits.join(' · ')}` : '';
    };
    const items = posts.map((s) => {
      const when = s.publishedAt ? fmtDate(s.publishedAt) : 'unknown date';
      const meta = [s.platform, s.handle && '@' + s.handle, s.type].filter(Boolean).join(' · ');
      const link = s.url ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(when)} ↗</a>` : escapeHtml(when);
      return `
        <div class="kb-preview-sec" style="padding:8px 12px">
          <div style="font-size:12px;color:var(--muted)">${link}${meta ? ' · ' + escapeHtml(meta) : ''}${escapeHtml(engStr(s.engagement))}</div>
          <div style="font-size:13px;margin-top:4px;white-space:pre-wrap">${escapeHtml((s.text || '').trim())}${s.textTruncated ? ' …' : ''}</div>
        </div>`;
    }).join('');
    return `
      <div class="kb-preview">
        <div class="kb-preview-badges">
          <span class="kb-preview-badge doctype">SOCIAL preview</span>
          <span class="kb-preview-badge">${fmtNum(p && p.fetched)} post${(p && p.fetched) === 1 ? '' : 's'} fetched</span>
          ${p && p.fromDate ? `<span class="kb-preview-badge">since ${escapeHtml(fmtDate(p.fromDate))}</span>` : ''}
        </div>
        ${items || '<div class="kb-preview-note">No posts in this window.</div>'}
        <div class="kb-preview-note">Nothing indexed yet — uncheck "Preview only" and resubmit to ingest each post as its own KB entry.</div>
      </div>`;
  }

  function wireKbUploadForm() {
    const form = $('kb-upload-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';

    // "Preview" — parse the chosen file server-side and show the structured
    // card WITHOUT indexing. Mirrors the web/social dry-run.
    const previewBtn = $('kb-upload-preview-btn');
    if (previewBtn) previewBtn.addEventListener('click', async () => {
      const result = $('kb-upload-result');
      const file = $('kb-file').files[0];
      result.classList.remove('hidden', 'success', 'error');
      if (!file) { result.classList.add('error'); result.textContent = 'Choose a file first.'; return; }
      previewBtn.disabled = true; const orig = previewBtn.textContent; previewBtn.textContent = 'Analyzing…';
      result.classList.add('hidden');
      try {
        const fd = new FormData();
        fd.append('file', file);
        const title = $('kb-title').value.trim();
        if (title) fd.append('title', title);
        // Tell the preview which entity this is — a COMPETITOR pick triggers
        // the head-to-head comparison vs our portfolio.
        const ent = await resolveEntityForLane('file', { dryRun: true });
        fd.append('scope', ent.scope);
        if (ent._competitorName) fd.append('competitorName', ent._competitorName);
        const r = await fetch('/api/knowledge/preview', { method: 'POST', credentials: 'include', body: fd });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        result.classList.remove('hidden'); result.classList.add('success');
        result.innerHTML = renderPreviewCard(body.preview || {});
        applySuggestedCategory('kb-category', body.preview && body.preview.suggestedCategory);
      } catch (err) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = err.message;
      } finally {
        previewBtn.disabled = false; previewBtn.textContent = orig;
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('kb-upload-btn');
      const result = $('kb-upload-result');
      result.classList.add('hidden');
      result.classList.remove('error', 'success');
      btn.disabled = true; btn.textContent = 'Uploading & indexing…';

      try {
        const fd = new FormData();
        const file = $('kb-file').files[0];
        if (!file) throw new Error('please choose a file');
        fd.append('file', file);
        fd.append('category', $('kb-category').value);
        fd.append('title', $('kb-title').value.trim());
        const meta = $('kb-metadata').value.trim();
        if (meta) fd.append('metadata', meta);
        // Product line: free-typed names get find-or-created here. Empty = no
        // product line = company-wide intel.
        const fileProductLine = ($('kb-file-product').value || '').trim();
        if (fileProductLine) fd.append('productIds', await resolveProductName(fileProductLine));
        // Entity selection → scope + the right id(s).
        const ent = await resolveEntityForLane('file');
        fd.append('scope', ent.scope);
        if (ent.companyId) fd.append('companyId', ent.companyId);
        for (const id of (ent.competitorIds || [])) fd.append('competitorIds', id);
        if (ent.tenantId) fd.append('tenantId', ent.tenantId);
        // Buyer persona — only meaningful for prospect intel; find-or-created.
        if (ent.scope === 'PROSPECT') {
          const pid = await resolvePersonaName(($('kb-file-persona').value || '').trim());
          if (pid) fd.append('personaIds', pid);
        }

        const r = await fetch('/api/knowledge/upload', {
          method: 'POST', credentials: 'include', body: fd,
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);

        result.classList.remove('hidden');
        result.classList.add('success');
        const d = body.document;
        result.innerHTML = `
          <strong>Indexed.</strong> ${escapeHtml(d.title)} — <span class="kb-row-scope scope-${String(d.scope || 'tenant').toLowerCase()}">${escapeHtml(d.scope || 'TENANT')}</span> · ${fmtNum(d.chunk_count)} chunks,
          ${fmtNum(d.token_count)} tokens. Switch to <a href="#" id="kb-go-library">Library</a> to view.
        `;
        form.reset();
        resetEntitySelector('file');
        const goLibrary = document.getElementById('kb-go-library');
        if (goLibrary) goLibrary.addEventListener('click', (ev) => {
          ev.preventDefault();
          switchKbTab('library');
        });
        // Invalidate the Knowledge status cache (hero number) and the Company
        // profile (its intel grouping + doc counts change on a TENANT upload).
        loaded.knowledge = false;
        loaded.company = false;
      } catch (err) {
        result.classList.remove('hidden');
        result.classList.add('error');
        result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = 'Upload & index';
      }
    });
  }

  // ===========================================================================
  // SETTINGS — API tokens for non-browser clients (Lili MCP, scripts).
  // See api/src/auth-tokens.js and docs/rfcs/0001-lili-integration.md §5.
  // ===========================================================================

  async function loadSettings() {
    await loadApiTokensTable();
    wireApiTokensForm();
  }

  async function loadApiTokensTable() {
    let tokens;
    try { tokens = await fetchJson('/api/auth/tokens'); }
    catch (err) {
      $('api-tokens-table').innerHTML =
        `<div class="empty">Couldn't load tokens: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const tbl = $('api-tokens-table');
    if (!tokens || tokens.length === 0) {
      tbl.innerHTML = '<div class="empty">No API tokens yet. Create one above to connect Lili or other MCP clients.</div>';
      return;
    }
    tbl.innerHTML = `
      <table class="dt">
        <thead><tr>
          <th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th>
          <th>Expires</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${tokens.map(apiTokenRow).join('')}</tbody>
      </table>`;
    tbl.querySelectorAll('[data-revoke]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Revoke this token? Any client using it will be locked out immediately.')) return;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/auth/tokens/${encodeURIComponent(btn.dataset.revoke)}`, {
            method: 'DELETE', credentials: 'include',
          });
          if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
          await loadApiTokensTable();
        } catch (err) {
          alert('Failed to revoke: ' + err.message);
          btn.disabled = false;
        }
      });
    });
  }

  function apiTokenRow(t) {
    const isActive = !t.revoked_at && (!t.expires_at || new Date(t.expires_at) > new Date());
    const status = isActive
      ? '<span class="pill pill-ok">active</span>'
      : t.revoked_at
        ? '<span class="pill pill-warn">revoked</span>'
        : '<span class="pill pill-warn">expired</span>';
    const action = isActive
      ? `<button type="button" data-revoke="${escapeHtml(t.id)}">Revoke</button>`
      : '<span class="muted">—</span>';
    return `
      <tr>
        <td>${escapeHtml(t.label || '')}</td>
        <td><code>${escapeHtml(t.prefix)}</code></td>
        <td>${fmtDate(t.created_at)}</td>
        <td>${t.last_used_at ? fmtDate(t.last_used_at) : '<span class="muted">—</span>'}</td>
        <td>${t.expires_at ? fmtDate(t.expires_at) : '<span class="muted">never</span>'}</td>
        <td>${status}</td>
        <td>${action}</td>
      </tr>`;
  }

  function wireApiTokensForm() {
    const form = $('api-tokens-create-form');
    if (!form || form.dataset.wired === '1') return;
    form.dataset.wired = '1';

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const label = $('api-token-label').value.trim();
      const expirySel = $('api-token-expiry').value;
      if (!label) return;
      const body = { label };
      if (expirySel !== '') body.expires_in_days = parseInt(expirySel, 10);
      const btn = $('api-token-create-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/auth/tokens', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.detail || err.error || `HTTP ${r.status}`);
        }
        const created = await r.json();
        revealNewToken(created.plaintext_token);
        form.reset();
        await loadApiTokensTable();
      } catch (err) {
        alert('Failed to create: ' + err.message);
      } finally {
        btn.disabled = false;
      }
    });

    const copyBtn = $('api-token-copy');
    if (copyBtn && copyBtn.dataset.wired !== '1') {
      copyBtn.dataset.wired = '1';
      copyBtn.addEventListener('click', async () => {
        const text = $('api-token-plaintext').textContent;
        try {
          await navigator.clipboard.writeText(text);
          const orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = orig; }, 1500);
        } catch { alert('Copy failed — select the token and copy manually.'); }
      });
    }

    const doneBtn = $('api-token-reveal-done');
    if (doneBtn && doneBtn.dataset.wired !== '1') {
      doneBtn.dataset.wired = '1';
      doneBtn.addEventListener('click', () => {
        hide('api-token-reveal-card');
        $('api-token-plaintext').textContent = '';
      });
    }
  }

  function revealNewToken(plaintext) {
    $('api-token-plaintext').textContent = plaintext;
    show('api-token-reveal-card');
  }

  // ── Calls page ─────────────────────────────────────────────────────────────
  // ADR-003 Phase-2 unified replacement for Portals + Meetings. Talks to the
  // additive GET /admin/calls endpoint shipped in PR #9. State lives in the
  // closure so re-entering the section via hash-link picks up the previous
  // tab/search/facets, but a fresh page load starts clean. The API uses
  // cursor pagination — we keep a forward stack so Prev works without a
  // re-query.

  const _callsState = {
    cursor: null,           // current page cursor; null = first page
    cursorStack: [],        // previous cursors, for Prev
    nextCursor: null,       // cursor for Next (from pageInfo)
    limit: 25,
    status: '',
    q: '',
    // Facets map directly onto API query params:
    //   source     → CSV
    //   mission_id → CSV
    //   company_id → CSV
    //   has_gaps   → 'none' | 'any' | 'high'
    //   has_portal → 'true' | 'false'
    facets: {},
    includeSamples: false,
    tenant: '',             // superadmin only — empty = own tenant (or all if no filter)
    inflight: 0,
    searchDebounce: null,
  };

  function applyCallsQuery(query) {
    if (!query) return;
    if (typeof query.status === 'string') _callsState.status = query.status;
    if (typeof query.q === 'string') _callsState.q = query.q;
    if (query.include_samples === '1' || query.include_samples === 'true') _callsState.includeSamples = true;
    ['source', 'mission_id', 'company_id'].forEach((k) => {
      if (typeof query[k] === 'string' && query[k]) {
        _callsState.facets[k] = query[k].split(',').filter(Boolean);
      }
    });
    if (typeof query.has_gaps === 'string' && query.has_gaps) _callsState.facets.has_gaps = query.has_gaps;
    if (typeof query.has_portal === 'string' && query.has_portal) _callsState.facets.has_portal = query.has_portal;
    if (typeof query.tenant === 'string') _callsState.tenant = query.tenant;
    _callsState.cursor = null;
    _callsState.cursorStack = [];

    const tabBtns = document.querySelectorAll('#calls-tabs .calls-tab');
    tabBtns.forEach((b) => b.classList.toggle('active', (b.dataset.status || '') === _callsState.status));
    const searchInput = $('calls-search');
    if (searchInput) searchInput.value = _callsState.q;
    const samplesToggle = $('calls-samples-toggle');
    if (samplesToggle) samplesToggle.checked = _callsState.includeSamples;
    refreshCalls();
  }

  async function loadCalls(query) {
    // Wire controls once; idempotent guard via dataset flag.
    const tabsHost = $('calls-tabs');
    if (tabsHost && tabsHost.dataset.wired !== '1') {
      tabsHost.dataset.wired = '1';
      tabsHost.querySelectorAll('.calls-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          _callsState.status = btn.dataset.status || '';
          _callsState.cursor = null;
          _callsState.cursorStack = [];
          tabsHost.querySelectorAll('.calls-tab').forEach((b) => b.classList.toggle('active', b === btn));
          pushCallsHash();
          refreshCalls();
        });
      });
    }

    const searchInput = $('calls-search');
    if (searchInput && searchInput.dataset.wired !== '1') {
      searchInput.dataset.wired = '1';
      searchInput.addEventListener('input', () => {
        clearTimeout(_callsState.searchDebounce);
        _callsState.searchDebounce = setTimeout(() => {
          _callsState.q = searchInput.value.trim();
          _callsState.cursor = null;
          _callsState.cursorStack = [];
          pushCallsHash();
          refreshCalls();
        }, 250);
      });
    }

    const samplesToggle = $('calls-samples-toggle');
    if (samplesToggle && samplesToggle.dataset.wired !== '1') {
      samplesToggle.dataset.wired = '1';
      samplesToggle.addEventListener('change', () => {
        _callsState.includeSamples = samplesToggle.checked;
        _callsState.cursor = null;
        _callsState.cursorStack = [];
        pushCallsHash();
        refreshCalls();
      });
    }

    // Tenant selector — only superadmins can switch.
    if (isSuperadmin) {
      const row = $('calls-tenant-row');
      if (row) row.classList.remove('hidden');
      const select = $('calls-tenant-select');
      if (select && select.dataset.wired !== '1') {
        select.dataset.wired = '1';
        try {
          const { tenants } = await fetchJson('/api/admin/tenants');
          select.innerHTML =
            '<option value="">All tenants</option>' +
            tenants.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name || t.id)}</option>`).join('');
        } catch (err) {
          console.warn('tenant list failed', err);
          select.innerHTML = '<option value="">All tenants</option>';
        }
        select.addEventListener('change', () => {
          _callsState.tenant = select.value;
          _callsState.cursor = null;
          _callsState.cursorStack = [];
          pushCallsHash();
          refreshCalls();
        });
      }
    }

    if (query) {
      applyCallsQuery(query);
    } else {
      refreshCalls();
    }
  }

  function pushCallsHash() {
    // Persistent URL parts only — cursor is page-local navigation state and
    // would just clutter shared links.
    const params = new URLSearchParams();
    if (_callsState.status) params.set('status', _callsState.status);
    if (_callsState.q) params.set('q', _callsState.q);
    if (_callsState.includeSamples) params.set('include_samples', '1');
    if (_callsState.tenant) params.set('tenant', _callsState.tenant);
    Object.entries(_callsState.facets).forEach(([k, v]) => {
      if (Array.isArray(v) && v.length) params.set(k, v.join(','));
      else if (typeof v === 'string' && v) params.set(k, v);
    });
    const qs = params.toString();
    history.replaceState(null, '', qs ? `#calls?${qs}` : '#calls');
  }

  function _buildCallsQuery() {
    const params = new URLSearchParams();
    if (_callsState.status) params.set('status', _callsState.status);
    if (_callsState.q) params.set('q', _callsState.q);
    params.set('limit', String(_callsState.limit));
    if (_callsState.cursor) params.set('cursor', _callsState.cursor);
    if (_callsState.includeSamples) params.set('include_samples', '1');
    if (_callsState.tenant) params.set('tenant', _callsState.tenant);
    Object.entries(_callsState.facets).forEach(([k, v]) => {
      if (Array.isArray(v) && v.length) params.set(k, v.join(','));
      else if (typeof v === 'string' && v) params.set(k, v);
    });
    return params;
  }

  async function refreshCalls() {
    const token = ++_callsState.inflight;
    const params = _buildCallsQuery();

    const tableHost = $('calls-table');
    if (tableHost && !tableHost.dataset.everLoaded) tableHost.innerHTML = '<div class="kb-subtle">Loading…</div>';

    let body;
    try {
      body = await fetchJson(`/api/admin/calls?${params.toString()}`);
    } catch (err) {
      if (token !== _callsState.inflight) return;
      if (tableHost) tableHost.innerHTML = `<div class="empty">Couldn't load calls: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (token !== _callsState.inflight) return;

    updateCallsTable(body);
    if (tableHost) tableHost.dataset.everLoaded = '1';
  }

  function updateCallsTable(body) {
    const calls = body.calls || [];
    const facets = body.facets || {};
    const pageInfo = body.pageInfo || { hasMore: false, cursor: null, total: calls.length };
    _callsState.nextCursor = pageInfo.cursor || null;
    const statusCounts = (facets && facets.status) || { pending: 0, analysing: 0, ready: 0, failed: 0 };

    // Tab counts come from the status facet — which is computed over the
    // tenant-scoped full set, BEFORE the active status filter, so the badges
    // remain meaningful when a tab is selected.
    document.querySelectorAll('#calls-tabs .calls-tab-count').forEach((el) => {
      const key = el.dataset.count;
      const n = key === 'all'
        ? ((statusCounts.pending || 0) + (statusCounts.analysing || 0) + (statusCounts.ready || 0) + (statusCounts.failed || 0))
        : (statusCounts[key] || 0);
      el.textContent = n > 0 ? n : '';
    });

    // Active filter chips.
    _renderCallsChips();

    // Table body.
    const tableHost = $('calls-table');
    if (tableHost) {
      tableHost.innerHTML = calls.length === 0
        ? '<div class="empty">No calls match the current filters.</div>'
        : `
          <table class="dt">
            <thead><tr>
              <th>Title</th><th>Source</th><th>Status</th><th>Mission</th>
              <th>Duration</th><th>Created</th><th></th>
            </tr></thead>
            <tbody>${calls.map(callsRow).join('')}</tbody>
          </table>`;
    }

    // Right-rail facets + pagination.
    _renderCallsFacets(facets);
    _renderCallsPagination(pageInfo);
  }

  function callsRow(c) {
    const meeting = c.meeting || {};
    const portal = c.portal || null;
    const duration = meeting.durationSeconds;
    const statusPill = `<span class="pill pill-${escapeHtml(c.status || 'pending')}">${escapeHtml(c.status || 'pending')}</span>`;
    const sourcePill = c.source
      ? `<span class="pill pill-${escapeHtml(c.source)}">${escapeHtml(c.source)}</span>`
      : '<span class="muted">—</span>';
    const missionId = meeting.missionId;
    const missionCell = missionId
      ? `<span class="mono muted" title="mission ${escapeHtml(missionId)}">${escapeHtml(missionId.slice(0, 8))}…</span>`
      : '<span class="muted">—</span>';
    const title = (portal && portal.title) || meeting.title || meeting.meetingUrl || c.id;
    // Action column — buckets dictate options:
    //   ready  → Open ↗ to the portal viewer
    //   others → no action (pending/analysing finish on their own; failed
    //            requires capture re-run, not a UI button)
    const action = (c.status === 'ready' && portal)
      ? `<a href="/portal/?id=${encodeURIComponent(portal.id)}" target="_blank">Open ↗</a>`
      : '<span class="muted">—</span>';
    return `
      <tr>
        <td class="truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</td>
        <td>${sourcePill}</td>
        <td>${statusPill}</td>
        <td>${missionCell}</td>
        <td class="mono">${fmtDuration(duration)}</td>
        <td>${fmtDate(c.createdAt)}</td>
        <td>${action}</td>
      </tr>`;
  }

  async function callsReanalyze(portalId, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Reanalyzing…'; }
    try {
      const r = await fetch(`/api/portals/${encodeURIComponent(portalId)}/reanalyze`, {
        method: 'POST', credentials: 'include',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      refreshCalls();
    } catch (err) {
      alert(`Reanalyze failed: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Reanalyze'; }
    }
  }

  function _renderCallsChips() {
    const host = $('calls-chips');
    if (!host) return;
    const chips = [];
    if (_callsState.q) chips.push({ k: 'q', label: `“${_callsState.q}”` });
    Object.entries(_callsState.facets).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach((val) => chips.push({ k, val, label: `${k}: ${val}` }));
      else if (v) chips.push({ k, label: `${k}: ${v}` });
    });
    if (_callsState.includeSamples) chips.push({ k: 'samples', label: 'showing samples' });
    if (chips.length === 0) { host.innerHTML = ''; return; }
    host.innerHTML = chips.map((c, i) =>
      `<button type="button" class="calls-chip" data-chip-idx="${i}" data-chip-k="${escapeHtml(c.k)}" data-chip-val="${escapeHtml(c.val || '')}">${escapeHtml(c.label)} ✕</button>`
    ).join('') + ' <button type="button" class="calls-chip calls-chip-clear" data-chip-clear="1">Clear all ✕</button>';
    host.querySelectorAll('[data-chip-clear]').forEach((b) => b.addEventListener('click', () => {
      _callsState.q = ''; _callsState.facets = {}; _callsState.includeSamples = false;
      _callsState.cursor = null; _callsState.cursorStack = [];
      $('calls-search').value = '';
      $('calls-samples-toggle').checked = false;
      pushCallsHash(); refreshCalls();
    }));
    host.querySelectorAll('.calls-chip[data-chip-k]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.chipK;
      const val = b.dataset.chipVal;
      if (k === 'q') { _callsState.q = ''; $('calls-search').value = ''; }
      else if (k === 'samples') { _callsState.includeSamples = false; $('calls-samples-toggle').checked = false; }
      else if (Array.isArray(_callsState.facets[k])) {
        _callsState.facets[k] = _callsState.facets[k].filter((v) => v !== val);
        if (_callsState.facets[k].length === 0) delete _callsState.facets[k];
      } else {
        delete _callsState.facets[k];
      }
      _callsState.cursor = null;
      _callsState.cursorStack = [];
      pushCallsHash(); refreshCalls();
    }));
  }

  function _renderCallsFacets(facets) {
    const host = $('calls-facets');
    if (!host) return;
    // Right-rail (§3.2). API returns facets.source as { value: count } map.
    // Mission/Company facets aren't surfaced by the API yet — they're driven
    // by direct deep-links from the Missions page (?mission_id=…) instead.
    const groups = [];

    const sourceItems = Object.entries(facets.source || {})
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, count }));
    if (sourceItems.length) groups.push({ key: 'source', label: 'Source', items: sourceItems, multi: true });

    // Has-gaps & Has-portal — tri-state toggles. Buttons cycle off/'any'/'none'
    // for gaps; off/'true'/'false' for portal. Tap to apply, tap again to clear.
    groups.push({ key: 'has_gaps', label: 'Has gaps', items: [
      { value: 'any',  label: 'Has gaps' },
      { value: 'high', label: 'High-severity gaps' },
      { value: 'none', label: 'No gaps' },
    ], multi: false });
    groups.push({ key: 'has_portal', label: 'Portal', items: [
      { value: 'true',  label: 'Has portal' },
      { value: 'false', label: 'No portal' },
    ], multi: false });

    host.innerHTML = groups.map((g) => {
      const items = (g.items || []).map((it) => {
        const value = it.value;
        const label = it.label || value;
        const count = it.count;
        const active = g.multi
          ? (_callsState.facets[g.key] || []).includes(value)
          : _callsState.facets[g.key] === value;
        return `<button type="button" class="facet-item${active ? ' active' : ''}" data-facet-k="${escapeHtml(g.key)}" data-facet-v="${escapeHtml(value)}" data-facet-multi="${g.multi ? '1' : '0'}">
          <span>${escapeHtml(label)}</span>${count != null ? `<span class="facet-count">${count}</span>` : ''}
        </button>`;
      }).join('');
      return `<div class="facet-group"><h4>${escapeHtml(g.label)}</h4>${items}</div>`;
    }).join('');

    host.querySelectorAll('.facet-item').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.facetK;
      const v = b.dataset.facetV;
      const multi = b.dataset.facetMulti === '1';
      if (multi) {
        const cur = _callsState.facets[k] || [];
        if (cur.includes(v)) {
          _callsState.facets[k] = cur.filter((x) => x !== v);
          if (_callsState.facets[k].length === 0) delete _callsState.facets[k];
        } else {
          _callsState.facets[k] = [...cur, v];
        }
      } else {
        if (_callsState.facets[k] === v) delete _callsState.facets[k];
        else _callsState.facets[k] = v;
      }
      _callsState.cursor = null;
      _callsState.cursorStack = [];
      pushCallsHash(); refreshCalls();
    }));
  }

  function _renderCallsPagination(pageInfo) {
    const host = $('calls-pagination');
    if (!host) return;
    const hasMore = !!pageInfo.hasMore;
    const hasPrev = _callsState.cursorStack.length > 0;
    const total = pageInfo.total || 0;
    if (!hasMore && !hasPrev) {
      host.innerHTML = total > 0 ? `<span class="muted">${total} call${total === 1 ? '' : 's'}</span>` : '';
      return;
    }
    host.innerHTML = `
      <button type="button" class="kb-secondary-btn" data-page-prev="1" ${hasPrev ? '' : 'disabled'}>← Prev</button>
      <span class="muted">${total} total</span>
      <button type="button" class="kb-secondary-btn" data-page-next="1" ${hasMore ? '' : 'disabled'}>Next →</button>`;
    const prev = host.querySelector('[data-page-prev]');
    if (prev) prev.addEventListener('click', () => {
      const c = _callsState.cursorStack.pop() || null;
      _callsState.cursor = c;
      refreshCalls();
    });
    const next = host.querySelector('[data-page-next]');
    if (next) next.addEventListener('click', () => {
      if (!_callsState.nextCursor) return;
      _callsState.cursorStack.push(_callsState.cursor);
      _callsState.cursor = _callsState.nextCursor;
      refreshCalls();
    });
  }

  // ── Calls operations (superadmin) — failed/stuck queue surface ─────────────
  // No replay UI yet: a failed capture run isn't fixable from a button (the
  // upstream Recall bot has to be restarted server-side). This is a read-only
  // triage table — sort failed calls newest-first and link to capture logs.
  async function loadCallsOps() {
    if (!isSuperadmin) {
      $('calls-ops-table').innerHTML = '<div class="empty">Superadmin only.</div>';
      return;
    }
    let data;
    try {
      data = await fetchJson('/api/admin/calls?status=failed&limit=50&include_samples=1');
    } catch (err) {
      $('calls-ops-table').innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const calls = data.calls || [];
    $('calls-ops-table').innerHTML = calls.length === 0
      ? '<div class="empty">No failed calls.</div>'
      : `
        <table class="dt">
          <thead><tr>
            <th>ID</th><th>Source</th><th>Raw status</th><th>Created</th>
          </tr></thead>
          <tbody>${calls.map((c) => `
            <tr>
              <td class="mono">${escapeHtml(c.id)}</td>
              <td>${escapeHtml(c.source || '—')}</td>
              <td class="mono">${escapeHtml(c.rawStatus || '—')}</td>
              <td>${fmtDate(c.createdAt)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
  }
})();
