(function () {
  const $ = (id) => document.getElementById(id);
  const show = (id) => $(id).classList.remove('hidden');
  const hide = (id) => $(id).classList.add('hidden');

  const sections = ['overview', 'company', 'missions', 'prospects', 'competitors', 'market-map', 'market-signals', 'calendar', 'calls', 'calls-ops', 'platform', 'instances', 'platform-audit', 'platform-keys', 'sessions', 'integrations', 'billing', 'subaccounts', 'settings', 'profile'];
  const loaders = {
    overview: loadOverview,
    company: loadCompany,
    missions: loadMissions,
    prospects: loadProspects,
    competitors: loadCompetitors,
    'market-map': loadMarketMap,
    'market-signals': loadMarketSignals,
    calendar: loadCalendar,
    calls: loadCalls,
    'calls-ops': loadCallsOps,
    platform: loadPlatform,
    instances: loadInstances,
    'platform-audit': loadPlatformAudit,
    'platform-keys': loadPlatformKeys,
    sessions: loadSessions,
    integrations: loadIntegrations,
    billing: loadBilling,
    subaccounts: loadSubaccounts,
    settings: loadSettings,
    profile: loadProfile,
  };
  const loaded = {};
  let currentSection = 'overview';
  let kbCurrentTab = 'status';
  let missionsCurrentTab = 'upcoming';
  let isSuperadmin = false; // platform admin (Founders tenant) — set in init()
  let marketWatchAvailable = false; // plan includes Market Watch — set in init()

  init();

  async function init() {
    // Auth check first; redirect if no valid cookie.
    let me;
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) throw new Error('unauthorized');
      // /auth/me returns { user, entitlements } as siblings — flatten entitlements
      // onto `me` so the sidebar plan chip and trial banner have their data.
      const payload = await r.json();
      me = payload.user;
      if (me && payload.entitlements) me.entitlements = payload.entitlements;
      if (me) me.credits = payload.credits || null;
      window._me = me; // exposed for the support panel (prefilled email context)
    } catch {
      window.location.href = '/admin/login.html';
      return;
    }

    $('user-email').textContent = me.email;
    if (me.name) {
      const nameEl = $('user-name');
      nameEl.textContent = me.name;
      nameEl.classList.remove('hidden');
      // Avatar = initials from the name (e.g. "Jordan Rivera" → "JR").
      const initials = me.name.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
      $('user-avatar').textContent = initials || (me.email || '?')[0].toUpperCase();
    } else {
      $('user-avatar').textContent = (me.email || '?')[0].toUpperCase();
    }
    isSuperadmin = !!me.isAdmin;
    marketWatchAvailable = !!(me.entitlements && Array.isArray(me.entitlements.features) && me.entitlements.features.includes('market_monitoring'));

    // Returning from Stripe Checkout (?cs=<session>) — confirm the subscription
    // synchronously so the plan is live before the welcome flow (and gate) run.
    const _cs = new URLSearchParams(window.location.search).get('cs');
    if (_cs) {
      try {
        const r = await fetch('/api/billing/confirm', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: _cs }),
        });
        if (r.ok) { const b = await r.json(); if (b.entitlements) me.entitlements = b.entitlements; }
      } catch { /* the webhook will reconcile */ }
      const u = new URL(window.location.href);
      u.searchParams.delete('cs');
      history.replaceState(null, '', u.pathname + u.search + u.hash);
    }

    renderSubBanner(me.entitlements);
    renderUserCredits(me.credits);

    // Reveal superadmin-only nav entries before rendering the initial section
    // so deep-linking to e.g. #calls-ops on a fresh load works.
    if (isSuperadmin) {
      document.querySelectorAll('.superadmin-only').forEach((el) => el.classList.remove('hidden'));
    }
    // Team-members nav (internally: sub-accounts) is shown only when the plan includes it (Pro/Enterprise),
    // and never for a sub-tenant (children can't nest).
    const feats = (me.entitlements && me.entitlements.features) || [];
    // Sidebar account-type label (was hardcoded "admin"): a normal account shows
    // "tenant", a child workspace shows "team member", a platform admin "platform admin".
    const _roleEl = $('user-role');
    if (_roleEl) {
      _roleEl.textContent = me.isAdmin ? 'platform admin'
        : (me.entitlements && me.entitlements.isSubtenant) ? 'team member' : 'tenant';
    }
    if (feats.includes('sub_accounts') && !(me.entitlements && me.entitlements.isSubtenant)) {
      document.querySelectorAll('.subaccounts-only').forEach((el) => el.classList.remove('hidden'));
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

    // Market Watch unread badge — poll on load + every 5 min.
    refreshWatchBadge();
    setInterval(refreshWatchBadge, 300000);

    // Help & support: opens the FAQ-first support panel.
    const supportBtn = $('support-btn');
    if (supportBtn) supportBtn.addEventListener('click', openSupportModal);

    // Product tour: wire the "？ Guide" replay button + auto-run once for new users.
    const tourBtn = $('tour-btn');
    if (tourBtn) tourBtn.addEventListener('click', startTour);
    try {
      if (!localStorage.getItem('gs_tour_seen')) setTimeout(startTour, 900);
    } catch { /* localStorage blocked — skip auto-tour */ }
  }

  // Guided product tour (Driver.js, vendored). Anchored on the persistent sidebar
  // nav so it never breaks on section switches; replayable from the Guide button.
  function startTour() {
    if (!window.driver || !window.driver.js) return;
    const { driver } = window.driver.js;
    const nav = (s) => `#nav a[data-section="${s}"]`;
    driver({
      showProgress: true,
      allowClose: true,
      overlayOpacity: 0.6,
      nextBtnText: 'Next →',
      prevBtnText: '← Back',
      doneBtnText: 'Got it',
      popoverClass: 'gs-tour',
      onDestroyed: () => { try { localStorage.setItem('gs_tour_seen', '1'); } catch { /* ignore */ } },
      steps: [
        { popover: { title: 'Welcome to DealScope 👋', description: 'A 30-second tour of how to go from a cold list to a closed call. You can replay it any time from <b>？ Guide</b> in the top bar.' } },
        { element: nav('overview'),     popover: { title: '1 · Your cockpit', description: 'Priority opportunities, upcoming engagements, and your foundation health — what to do next, at a glance.', side: 'right', align: 'start' } },
        { element: nav('company'),      popover: { title: '2 · Company foundation', description: 'Built automatically from your website on day one — your products, positioning and personas. Every AI output is grounded here.', side: 'right', align: 'start' } },
        { element: nav('prospects'),    popover: { title: '3 · Find prospects', description: 'Add them manually, pull from your CRM, or let AI <b>discover</b> companies showing a buying signal — ranked by priority and matched to your products (≈ 3 credits a run).', side: 'right', align: 'start' } },
        { element: nav('competitors'),  popover: { title: '4 · Know your competitors', description: 'Auto-discover rivals by region, pull their real product lineup, and generate battlecards — so you walk in knowing how to win.', side: 'right', align: 'start' } },
        { element: nav('missions'),     popover: { title: '5 · Run the call', description: 'Schedule an engagement; the AI joins, records, and turns the meeting into a Note Taker Report with a consolidated summary — pre-call brief ready beforehand.', side: 'right', align: 'start' } },
        { element: nav('integrations'), popover: { title: '6 · Connect your stack', description: 'Link your calendar and CRM (HubSpot is live) to pull prospects and auto-schedule. Optional — but it supercharges everything.', side: 'right', align: 'start' } },
        { element: '#tour-btn',         popover: { title: 'You\'re all set 🚀', description: 'Start by reviewing your <b>Company</b> foundation, then <b>Discover</b> your first prospects. Replay this tour any time from here.', side: 'bottom', align: 'end' } },
      ],
    }).drive();
  }

  // ── Support panel ─────────────────────────────────────────────────────────
  // FAQ first (the common answers resolve most questions instantly), then a
  // "still need help" form that composes an email to support. No backend
  // dependency — submitting opens the rep's mail client with a prefilled draft.
  const SUPPORT_EMAIL = 'support@dealscope.io';
  const SUPPORT_FAQ = [
    { q: 'How do I add prospects?',
      a: 'Three ways, all on the <b>Prospects</b> page: add a company manually, pull from a connected CRM (Integrations → HubSpot is live), or let <b>AI Discovery</b> find companies showing a buying signal — ranked by priority and matched to your products (≈ 3 credits a run).' },
    { q: 'How do credits work?',
      a: 'Every plan includes a monthly pool of AI credits that flow to whatever you do — a recorded call ≈ 24 credits, a discovery run ≈ 3, an Arena session ≈ 1. You can top up anytime from <b>Billing</b>; nothing is charged beyond your plan + any top-ups.' },
    { q: 'How do I connect my calendar?',
      a: 'Go to <b>Integrations</b> and connect Google or Microsoft 365. Upcoming meetings then prefill the schedule form, and you can generate a Google Meet / Teams meeting in one click. Calendly auto-creates engagements when a prospect books.' },
    { q: 'A meeting invite didn’t arrive — why?',
      a: 'Invites are sent from our branded sender (not your mailbox) so deliverability is consistent. If a recipient shows as failed in the create dialog, check the address and resend; persistent failures are usually a recipient-side spam filter.' },
    { q: 'How is my data kept private?',
      a: 'Each workspace is fully isolated (multi-tenant), connected tokens are encrypted at rest, and your data is never used to train shared models. See the Privacy Policy and DPA linked from the marketing site.' },
  ];

  function openSupportModal() {
    let overlay = $('support-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'support-modal-overlay';
      overlay.className = 'cal-picker-overlay support-overlay';
      const faq = SUPPORT_FAQ.map((f, i) => `
        <div class="support-faq-item">
          <button type="button" class="support-faq-q" data-support-faq="${i}" aria-expanded="false">
            <span>${escapeHtml(f.q)}</span><span class="support-faq-chevron" aria-hidden="true">▸</span>
          </button>
          <div class="support-faq-a hidden" data-support-faq-a="${i}">${f.a}</div>
        </div>`).join('');
      overlay.innerHTML = `
        <div class="cal-picker support-modal">
          <div class="cal-picker-h">
            <span class="cal-picker-title">Help &amp; support</span>
            <button type="button" class="kb-link-btn cal-picker-close">✕</button>
          </div>
          <div class="cal-picker-body support-body">
            <div class="support-section-h">Frequently asked</div>
            <div class="support-faq">${faq}</div>
            <div class="support-section-h support-contact-h">Still need help? Send us a message</div>
            <div class="kb-form support-form">
              <div class="field">
                <label for="support-subject">Subject</label>
                <input id="support-subject" type="text" maxlength="150" placeholder="e.g. AI discovery returned no results">
              </div>
              <div class="field">
                <label for="support-message">Message</label>
                <textarea id="support-message" rows="5" placeholder="Tell us what's happening — the more detail, the faster we can help."></textarea>
              </div>
              <div class="support-form-actions">
                <button type="button" class="primary-cta" id="support-send-btn">Send message</button>
                <span class="kb-subtle">or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></span>
              </div>
              <div class="kb-result hidden" id="support-result"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSupportModal(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', closeSupportModal);
      document.addEventListener('keydown', _supportEsc);
      // FAQ accordion toggles.
      overlay.querySelectorAll('[data-support-faq]').forEach((b) => b.addEventListener('click', () => {
        const ans = overlay.querySelector(`[data-support-faq-a="${b.dataset.supportFaq}"]`);
        if (!ans) return;
        const open = ans.classList.toggle('hidden') === false;
        b.setAttribute('aria-expanded', String(open));
        b.classList.toggle('open', open);
      }));
      overlay.querySelector('#support-send-btn').addEventListener('click', submitSupport);
    }
    // Reset the form each open.
    $('support-subject').value = '';
    $('support-message').value = '';
    $('support-result').classList.add('hidden');
    overlay.classList.remove('hidden');
    setTimeout(() => $('support-subject').focus(), 50);
  }

  function _supportEsc(e) { if (e.key === 'Escape') closeSupportModal(); }
  function closeSupportModal() { const o = $('support-modal-overlay'); if (o) o.classList.add('hidden'); }

  function submitSupport() {
    const subject = ($('support-subject').value || '').trim();
    const message = ($('support-message').value || '').trim();
    const result = $('support-result');
    result.classList.remove('hidden', 'error', 'success');
    if (!message) { result.classList.add('error'); result.textContent = 'Please add a short message first.'; return; }
    // Compose a prefilled email. Include the workspace + signed-in user so the
    // support team has context without asking. _me is set during init().
    const who = (window._me && (window._me.email || window._me.name)) || 'a DealScope user';
    const ctx = `\n\n— Sent from the DealScope app by ${who}`;
    const href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject || 'DealScope support request')}&body=${encodeURIComponent(message + ctx)}`;
    window.location.href = href;
    result.classList.add('success');
    result.innerHTML = `Opening your email app… if nothing happens, email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> directly.`;
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
    // The sidebar user block is the entry point to profile management.
    const block = document.querySelector('.user-block');
    if (block) {
      block.addEventListener('click', () => {
        switchSection('profile', {});
        history.replaceState(null, '', '#profile');
      });
    }
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
    const eb = $('page-eyebrow');
    if (eb) eb.innerHTML = `${escapeHtml(groupFor(sec))} <b>·</b> ${escapeHtml(titleFor(sec) || '')}`;
    // Company deep-links: ?tab=<intel|products|personas> selects a tab; ?welcome=1
    // (the post-onboarding landing) arms the one-time pull-from-website bootstrap.
    // Set these BEFORE the loader so the first render lands on the right tab.
    if (sec === 'company' && query) {
      if (query.tab) _companyTab = query.tab;
      if (query.welcome) _companyWelcome = true;
    }
    // Market Map re-renders on every visit: data is cheap and its draw loop
    // stops when you navigate away, so a cached page would be a frozen frame.
    if (sec === 'market-map') loaded[sec] = false;
    if (!loaded[sec]) {
      try { await loaders[sec](query || {}); loaded[sec] = true; }
      catch (err) { console.error(err); }
    } else if (sec === 'calls' && query) {
      // Already-loaded Calls page — re-apply the query so deep-linked filter
      // changes (e.g. clicking a chip or external link) take effect.
      applyCallsQuery(query);
    } else if (sec === 'company' && query && (query.tab || query.welcome)) {
      // Already-loaded Company page navigated with a new tab/welcome → re-render.
      renderCompanyWorkspace();
    }
    // Deep link to a specific product line (e.g. from a competitor's pinned
    // product chip): scroll the Company product table to it and flash it.
    if (sec === 'company' && query && query.product) {
      highlightCompanyProduct(query.product);
    }
  }

  function highlightCompanyProduct(productId) {
    const row = document.querySelector(`[data-product-row="${CSS.escape(productId)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row.classList.add('row-highlight');
    setTimeout(() => row.classList.remove('row-highlight'), 2000);
  }

  // Mono eyebrow group above the page title — mirrors the sidebar nav groups.
  function groupFor(sec) {
    if (['overview', 'company', 'prospects', 'competitors', 'market-map', 'market-signals'].includes(sec)) return 'Intelligence';
    if (['missions', 'calendar', 'sessions', 'calls', 'calls-ops'].includes(sec)) return 'Pipeline';
    if (['platform', 'instances', 'platform-audit', 'platform-keys'].includes(sec)) return 'Platform';
    return 'Workspace';
  }
  function titleFor(sec) {
    return {
      overview: 'Overview',
      company: 'Company',
      missions: 'Engagements',
      prospects: 'Prospects',
      competitors: 'Competitors',
      'market-map': 'Market Map',
      'market-signals': 'Market signals',
      calendar: 'Calendar',
      calls: 'Calls',
      'calls-ops': 'Calls — Operations',
      platform: 'Platform overview',
      instances: 'Instances',
      'platform-audit': 'Audit log',
      'platform-keys': 'Keys & secrets',
      sessions: 'Arena Practice',
      integrations: 'Integrations',
      billing: 'Billing',
      subaccounts: 'Team members',
      settings: 'Settings',
      profile: 'Your profile',
    }[sec];
  }

  // Tiny JSON fetch wrapper. Accepts a standard fetch options bag — any
  // method/body/headers passed through. (Originally this only took `url`,
  // which silently turned every POST/PATCH/DELETE call into a GET — a long
  // tail of "HTTP 404" bugs on routes that only existed for the non-GET
  // verb. Fixed 2026-05-29.)
  async function fetchJson(url, opts = {}) {
    const r = await fetch(url, { credentials: 'include', ...opts });
    if (r.status === 401) {
      window.location.href = '/admin/login.html';
      throw new Error('unauthorized');
    }
    if (r.status === 402) {
      // Subscription/usage gate (USAGE_LIMIT / SUBSCRIPTION_REQUIRED) — prompt upgrade.
      const body = await r.json().catch(() => ({}));
      handlePaywall(body);
      throw new Error((body && body.error) || 'Upgrade required');
    }
    if (r.status === 403) {
      // Feature-not-in-plan is a plan gate (route to Billing); other 403s are
      // ordinary role/permission denials and just surface their message.
      const body = await r.json().catch(() => ({}));
      if (body && body.code === 'FEATURE_NOT_IN_PLAN') {
        handlePaywall(body);
        throw new Error((body && body.error) || 'Upgrade required');
      }
      throw new Error((body && body.error) || `HTTP 403`);
    }
    if (!r.ok) {
      // Surface the server's `error` field when present — gives reps a
      // useful message instead of "HTTP 404".
      const body = await r.json().catch(() => null);
      throw new Error((body && body.error) || `HTTP ${r.status}`);
    }
    return r.json();
  }

  // ── Dashboard (sales cockpit) ─────────────────────────────────────────────
  async function loadOverview() {
    const host = $('dashboard-body');
    if (!host) return;
    host.innerHTML = '<div class="kb-subtle">Loading your dashboard…</div>';
    let d;
    try { d = await fetchJson('/api/dashboard'); }
    catch (err) { host.innerHTML = `<div class="empty">Couldn't load dashboard: ${escapeHtml(err.message)}</div>`; return; }

    const t = d.tenant || {}, k = d.kpis || {}, f = d.foundation || {};
    const planUpper = String(t.plan || 'TRIAL').toUpperCase();
    const planOk = planUpper === 'ACTIVE' || planUpper === 'INTERNAL';
    const trialPill = planOk
      ? `<span class="pill pill-ok">${escapeHtml(planUpper)}</span>`
      : `<span class="pill pill-warn">${escapeHtml(planUpper)}${t.daysLeft != null ? ` · ${t.daysLeft} day${t.daysLeft === 1 ? '' : 's'} left` : ''}</span>`;

    // Activation nudge — only while the foundation is incomplete.
    const need = [];
    if (!f.profileSet) need.push(['Set your company positioning', 'company']);
    if (!f.products) need.push(['Add your products', 'company']);
    if (!f.competitors) need.push(['Add a competitor', 'competitors']);
    if (!k.prospects) need.push(['Find your first prospects', 'prospects']);
    const activation = need.length ? `
      <div class="dash-activation">
        <div class="dash-activation-h">Finish setting up DealScope</div>
        <div class="dash-activation-steps">${need.map(([label, sec]) => `<button class="dash-chip" data-goto="${sec}">○ ${escapeHtml(label)} →</button>`).join('')}</div>
      </div>` : '';

    const opps = d.opportunities || [];
    const engs = d.engagements || [];

    host.innerHTML = `
      <div class="dash-header">
        <div>
          <div class="dash-hello kb-subtle">Welcome back</div>
          <div class="dash-company">${escapeHtml(t.name || 'your company')} ${trialPill}</div>
        </div>
        <div class="dash-actions">
          <button class="primary-cta" data-goto="prospects" data-pmode="discover">Discover prospects</button>
          <button class="kb-secondary-btn" data-goto="competitors">Add competitor</button>
          <button class="kb-secondary-btn" data-goto="missions">Schedule</button>
        </div>
      </div>
      ${activation}
      <div class="dash-kpis">
        ${kpiCell('Open signals', fmtNum(k.openSignals || 0), 'priority opportunities', 'prospects', true)}
        ${kpiCell('Prospects', fmtNum(k.prospects || 0), k.prospectsNewWeek ? `+${k.prospectsNewWeek} this week` : 'in your pipeline', 'prospects')}
        ${kpiCell('Competitors', fmtNum(k.competitors || 0), `${fmtNum(f.competitorsWithIntel || 0)} with intel`, 'competitors')}
        ${kpiCell('Next 7 days', fmtNum(k.engagementsNext7d || 0), 'engagements', 'missions')}
      </div>
      ${buildDashCharts(d)}
      <div class="dash-grid">
        <div class="dash-col">
          <div class="dash-card-h">Priority opportunities</div>
          <div class="dash-opps">${opps.length ? opps.map(dashOppRow).join('') : dashEmpty('No opportunities yet — Discover prospects or run research to surface buying signals.')}</div>
        </div>
        <div class="dash-col">
          <div class="dash-card-h">Upcoming engagements</div>
          <div class="dash-engs">${engs.length ? engs.map(dashEngRow).join('') : dashEmpty('No upcoming engagements — schedule one from a prospect or the Engagements page.')}</div>
        </div>
      </div>
      <div id="dash-subaccounts"></div>
      <div class="dash-foundation">
        <span class="dash-found-h">Foundation</span>
        ${dashFound(f.profileSet, 'Positioning')}
        ${dashFound(f.products > 0, `${fmtNum(f.products)} Products`)}
        ${dashFound(f.personas > 0, `${fmtNum(f.personas)} Personas`)}
        ${dashFound(f.competitorsWithIntel > 0, `${fmtNum(f.competitorsWithIntel)}/${fmtNum(f.competitors)} competitors w/ intel`)}
        ${dashFound(!!f.crm, f.crm ? `CRM ${f.crm}` : 'CRM not connected')}
        <span class="dash-found-spacer"></span>
        <button class="kb-link-btn" data-goto="company">Company →</button>
        <button class="kb-link-btn" data-goto="integrations">Integrations →</button>
      </div>`;

    host.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
      const sec = b.dataset.goto;
      if (sec === 'prospects' && b.dataset.pmode) _prospectMode = b.dataset.pmode;
      window.location.hash = '#' + sec;
    }));
    // Click a priority row (its header) to expand the full description.
    const toggleOpp = (idx) => {
      const detail = host.querySelector(`[data-opp-detail="${idx}"]`);
      const headEl = host.querySelector(`[data-opp-toggle="${idx}"]`);
      if (!detail) return;
      const open = detail.classList.toggle('hidden') === false;
      if (headEl) {
        headEl.setAttribute('aria-expanded', String(open));
        headEl.classList.toggle('open', open);
      }
    };
    host.querySelectorAll('[data-opp-toggle]').forEach((el) => {
      el.addEventListener('click', () => toggleOpp(el.dataset.oppToggle));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpp(el.dataset.oppToggle); }
      });
    });
    host.querySelectorAll('[data-opp-company]').forEach((el) => el.addEventListener('click', (e) => {
      e.stopPropagation();
      _prospectsState.selectedCompanyId = el.dataset.oppCompany;
      window.location.hash = '#prospects';
    }));
    host.querySelectorAll('[data-opp-brief]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const o = opps[Number(b.dataset.oppBrief)] || {};
      window._prefillMission = { companyName: o.companyName || '', companyDomain: '', productIds: [], note: o.title ? `Angle: ${o.title}` : '' };
      window.location.hash = '#missions';
    }));
    // Kick off prospect research for the opportunity's company. Research runs
    // in the background; we land the rep on the prospect so they watch it fill
    // in (Signals/Intel tabs) rather than staring at a spinner here.
    host.querySelectorAll('[data-opp-intel]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const o = opps[Number(b.dataset.oppIntel)] || {};
      if (!o.companyId) { alert("This opportunity isn't linked to a company yet."); return; }
      b.disabled = true; const orig = b.textContent; b.textContent = 'Starting research…';
      try {
        await fetchJson(`/api/knowledge/research/${encodeURIComponent(o.companyId)}`, { method: 'POST' });
        _prospectsState.selectedCompanyId = o.companyId;
        loaded.prospects = false;
        window.location.hash = '#prospects';
      } catch (err) {
        b.disabled = false; b.textContent = orig;
        alert(`Couldn't start prospect intel: ${err.message}`);
      }
    }));
    host.querySelectorAll('[data-eng-company]').forEach((el) => el.addEventListener('click', () => {
      const cid = el.dataset.engCompany;
      if (cid) { _prospectsState.selectedCompanyId = cid; window.location.hash = '#prospects'; }
      else window.location.hash = '#missions';
    }));

    // Parent-account roll-up + market-signals card load async (separate
    // endpoints); neither blocks the main dashboard render.
    renderDashRollup();
    renderDashWatch();
  }

  // ── Overview charts (inline SVG / CSS — no charting dependency) ───────────
  const DASH_STRENGTH_SEGS = [
    { key: 'strong', label: 'Strong', color: '#8ce046' },
    { key: 'tie',    label: 'Even',   color: '#4da3e8' },
    { key: 'weak',   label: 'Weak',   color: '#39424e' },
  ];

  function buildDashCharts(d) {
    const meters = (d.usage && d.usage.meters) || [];
    const usageCard = meters.length ? `
      <div class="dash-col dash-chart-card">
        <div class="dash-card-h"><span class="dash-dot"></span>Usage this ${d.usage.lifetime ? 'account' : 'month'}</div>
        <div class="dash-gauges">${meters.map(dashGauge).join('')}</div>
      </div>` : '';
    const mixCard = `
      <div class="dash-col dash-chart-card">
        <div class="dash-card-h"><span class="dash-dot"></span>Opportunity mix</div>
        ${dashStrengthDonut(d.strengthBreakdown || {})}
      </div>`;
    const trendCard = `
      <div class="dash-col dash-chart-card">
        <div class="dash-card-h"><span class="dash-dot"></span>Pipeline activity</div>
        ${dashTrend(d.prospectTrend)}
      </div>`;
    const topCard = `
      <div class="dash-col dash-chart-card">
        <div class="dash-card-h"><span class="dash-dot"></span>Top prospects</div>
        ${dashTopProspects(d.opportunities || [])}
      </div>`;
    const watchCard = `
      <div class="dash-col dash-chart-card" id="dash-watch-card">
        <div class="dash-card-h"><span class="dash-dot"></span>Market signals</div>
        <div id="dash-watch">${dashEmpty('Loading signals…')}</div>
      </div>`;
    return `<div class="dash-charts">${trendCard}${mixCard}${usageCard}</div>
            <div class="dash-charts dash-charts-2">${topCard}${watchCard}</div>`;
  }

  // Film-style "Top prospects": horizontal signal bars, one per company with
  // open opportunities — width = share of signals, lime when any are strong.
  function dashTopProspects(opps) {
    const by = new Map();
    for (const o of opps) {
      const k = o.companyName || 'Unknown';
      if (!by.has(k)) by.set(k, { id: o.companyId, n: 0, strong: 0 });
      const e = by.get(k); e.n++; if (o.strength === 'strong') e.strong++;
    }
    const rows = [...by.entries()].sort((a, b) => (b[1].strong - a[1].strong) || (b[1].n - a[1].n)).slice(0, 6);
    if (!rows.length) return dashEmpty('No scored prospects yet — run discovery or research to rank your pipeline.');
    const max = Math.max(1, ...rows.map(([, v]) => v.n));
    return `<div class="dash-hbars">${rows.map(([name, v]) => `
      <button class="dash-hbar" data-opp-company="${escapeHtml(v.id || '')}" title="${escapeHtml(name)}: ${fmtNum(v.n)} signal${v.n === 1 ? '' : 's'}${v.strong ? `, ${fmtNum(v.strong)} strong` : ''}">
        <span class="dash-hbar-name">${escapeHtml(name)}</span>
        <span class="dash-hbar-track"><i class="${v.strong ? 'is-strong' : ''}" style="width:${Math.max(8, Math.round((v.n / max) * 100))}%"></i></span>
        <span class="dash-hbar-n">${fmtNum(v.n)}</span>
      </button>`).join('')}</div>`;
  }

  // Async "Market signals" card body — latest Market Watch findings. Never
  // blocks the dashboard; quietly collapses when the feature has no data.
  async function renderDashWatch() {
    const host = $('dash-watch');
    if (!host) return;
    let data = null;
    try { data = await fetchJson('/api/watch/findings?limit=24'); } catch (_) { /* gated or empty */ }
    const items = ((data && data.findings) || []).filter((f) => f.status === 'NEW').slice(0, 6);
    if (!items.length) {
      host.innerHTML = dashEmpty('No new market signals. Turn on Market Watch for a prospect or competitor to monitor it here.');
      return;
    }
    host.innerHTML = `<div class="dash-signals">${items.map((f) => `
      <button class="dash-signal" data-goto="market-signals" title="${escapeHtml(f.title || '')}">
        <span class="dash-signal-who">${escapeHtml(f.subject_name || '')}</span>
        <span class="dash-signal-title">${escapeHtml(f.title || '')}</span>
        <span class="dash-signal-mat">${'●'.repeat(Math.max(1, Math.min(5, f.materiality || 3)))}</span>
      </button>`).join('')}</div>`;
    host.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { window.location.hash = '#market-signals'; }));
  }

  // Single usage gauge: a ring filled to used/cap, colored by headroom.
  // cap === null (unlimited) → faint full ring, count + ∞, no fill arc.
  function dashGauge(m) {
    const unlimited = m.cap == null;
    const frac = unlimited || m.cap <= 0 ? 0 : Math.min(1, m.used / m.cap);
    const r = 30, c = 2 * Math.PI * r, filled = c * frac;
    const col = frac >= 1 ? 'var(--danger)' : frac >= 0.85 ? 'var(--warn)' : 'var(--accent)';
    const sub = unlimited ? '∞' : `/${fmtNum(m.cap)}`;
    return `<div class="dash-gauge" title="${escapeHtml(m.label)}: ${fmtNum(m.used)}${unlimited ? '' : ' of ' + fmtNum(m.cap)} used">
      <svg viewBox="0 0 80 80" class="dash-gauge-svg" role="img" aria-label="${escapeHtml(m.label)} usage">
        <circle cx="40" cy="40" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="9"/>
        ${unlimited ? '' : `<circle cx="40" cy="40" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${filled.toFixed(2)} ${(c - filled).toFixed(2)}" transform="rotate(-90 40 40)"/>`}
        <text x="40" y="38" class="dash-gauge-v">${fmtNum(m.used)}</text>
        <text x="40" y="53" class="dash-gauge-s">${escapeHtml(sub)}</text>
      </svg>
      <div class="dash-gauge-l">${escapeHtml(m.label)}</div>
    </div>`;
  }

  // Donut of opportunity strength mix (strong / even / weak).
  function dashStrengthDonut(b) {
    const segs = DASH_STRENGTH_SEGS.map((s) => ({ ...s, value: b[s.key] || 0 }));
    const sum = segs.reduce((s, x) => s + x.value, 0);
    const r = 32, c = 2 * Math.PI * r;
    let offset = 0;
    const arcs = sum === 0
      ? `<circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--surface-2)" stroke-width="14"/>`
      : segs.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / sum) * c;
          const arc = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="${s.color}" stroke-width="14" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 50 50)"/>`;
          offset += len; return arc;
        }).join('');
    const legend = segs.map((s) => `<span class="dash-leg"><i style="background:${s.color}"></i>${escapeHtml(s.label)} <b>${fmtNum(s.value)}</b></span>`).join('');
    return `<div class="dash-donut-wrap">
      <svg viewBox="0 0 100 100" class="dash-donut" role="img" aria-label="Opportunity strength mix">
        ${arcs}
        <text x="50" y="47" class="dash-donut-v">${fmtNum(sum)}</text>
        <text x="50" y="62" class="dash-donut-s">signals</text>
      </svg>
      <div class="dash-legend">${legend}</div>
    </div>`;
  }

  // 8-week new-prospect chart, film style: lime bars over a soft gradient
  // area of the same series (one honest dataset, two renderings).
  function dashTrend(rows) {
    const data = Array.isArray(rows) ? rows : [];
    if (!data.length) return dashEmpty('No prospect history yet.');
    const max = Math.max(1, ...data.map((r) => r.count || 0));
    const W = 320, H = 110, PAD = 6, bw = (W - PAD * 2) / data.length;
    const y = (v) => H - 18 - (v / max) * (H - 34);
    const pts = data.map((r, i) => `${(PAD + bw * i + bw / 2).toFixed(1)},${y(r.count || 0).toFixed(1)}`);
    const area = `M${PAD},${H - 18} L${pts.join(' L')} L${W - PAD},${H - 18} Z`;
    const bars = data.map((r, i) => {
      const v = r.count || 0, x = PAD + bw * i + bw * 0.28, w = bw * 0.44;
      const h = Math.max(2, (v / max) * (H - 34));
      const wk = String(r.week || '').slice(5);
      return `<rect x="${x.toFixed(1)}" y="${(H - 18 - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="2" class="dash-tbar${i % 2 ? ' alt' : ''}"><title>Week of ${escapeHtml(r.week || '')}: ${fmtNum(v)} new</title></rect>
              <text x="${(PAD + bw * i + bw / 2).toFixed(1)}" y="${H - 5}" class="dash-tlbl">${escapeHtml(wk)}</text>`;
    }).join('');
    const totalNew = data.reduce((s, r) => s + (r.count || 0), 0);
    return `<div class="dash-trend-svgwrap"><svg viewBox="0 0 ${W} ${H}" class="dash-trend-svg" role="img" aria-label="New prospects per week">
      <defs><linearGradient id="dash-area-g" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#8ce046" stop-opacity=".28"/><stop offset="1" stop-color="#8ce046" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#dash-area-g)"/>
      <polyline points="${pts.join(' ')}" fill="none" stroke="#8ce046" stroke-width="1.5" stroke-opacity=".8"/>
      ${bars}
    </svg></div><div class="dash-trend-foot kb-subtle">${fmtNum(totalNew)} new prospect${totalNew === 1 ? '' : 's'} in 8 weeks</div>`;
  }

  // Parent-account only: per-child activity bars (intel + calls + upcoming).
  async function renderDashRollup() {
    const host = $('dash-subaccounts');
    if (!host) return;
    const u = window._me;
    const feats = (u && u.entitlements && u.entitlements.features) || [];
    const isParent = feats.includes('sub_accounts') && !(u && u.entitlements && u.entitlements.isSubtenant);
    if (!isParent) return;
    let d;
    try { d = await fetchJson('/api/account/subaccounts/monitor'); }
    catch (_) { return; }
    const kids = (d && d.children) || [];
    if (!kids.length) return;
    const act = (c) => (c.intel.count || 0) + (c.calls.count || 0) + (c.upcoming.count || 0);
    const maxAct = Math.max(1, ...kids.map(act));
    const rows = kids.map((c) => {
      const w = Math.round((act(c) / maxAct) * 100);
      return `<button class="dash-kid" data-goto="subaccounts">
        <span class="dash-kid-name">${escapeHtml(c.name || c.domain || 'Workspace')}</span>
        <span class="dash-kid-bar"><i style="width:${Math.max(w, 2)}%"></i></span>
        <span class="dash-kid-stats kb-subtle">${fmtNum(c.intel.count || 0)} intel · ${fmtNum(c.calls.count || 0)} calls · ${fmtNum(c.upcoming.count || 0)} upcoming</span>
      </button>`;
    }).join('');
    host.innerHTML = `<div class="dash-col dash-chart-card dash-rollup">
      <div class="dash-card-h">Team activity <button class="kb-link-btn dash-rollup-manage" data-goto="subaccounts">Manage →</button></div>
      <div class="dash-kids">${rows}</div>
    </div>`;
    host.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => { window.location.hash = '#' + b.dataset.goto; }));
  }

  // ── Market Map — canvas force graph of you vs competitors vs prospects ────
  // Film-style glowing node network. Pure canvas, no dependencies; the layout
  // is a tiny spring/repulsion sim pre-run synchronously, then drawn with a
  // gentle ambient drift so the map feels alive without ever rearranging.
  let _mmFrame = 0; // rAF id — cancelled on every (re)load so only one loop runs
  let _mmResize = null; // ResizeObserver — replaced on every (re)load

  async function loadMarketMap() {
    const canvas = $('mm-canvas');
    const tip = $('mm-tip');
    const emptyEl = $('mm-empty');
    const foot = $('mm-foot');
    if (!canvas) return;
    cancelAnimationFrame(_mmFrame);

    let companies = [], competitors = [], dash = null, threats = {}, findings = [];
    try {
      const [cR, kR, dR, tR, fR] = await Promise.all([
        fetchJson('/api/companies'),
        fetchJson('/api/portfolio/competitors'),
        fetchJson('/api/dashboard'),
        fetchJson('/api/portfolio/competitors/threats').catch(() => ({ threats: {} })),
        fetchJson('/api/watch/findings?limit=200').catch(() => ({ findings: [] })),
      ]);
      companies = cR.companies || [];
      competitors = kR.competitors || [];
      dash = dR;
      threats = tR.threats || {};
      findings = fR.findings || [];
    } catch (err) {
      emptyEl.classList.remove('hidden');
      emptyEl.innerHTML = `Couldn't load the map: ${escapeHtml(err.message)}`;
      return;
    }

    // Signal strength per company from the dashboard's opportunity feed.
    const sigByCompany = new Map();
    for (const o of (dash && dash.opportunities) || []) {
      if (!o.companyId) continue;
      const e = sigByCompany.get(o.companyId) || { n: 0, strong: 0 };
      e.n++; if (o.strength === 'strong') e.strong++;
      sigByCompany.set(o.companyId, e);
    }

    if (!companies.length && !competitors.length) {
      emptyEl.classList.remove('hidden');
      emptyEl.innerHTML = `Your map is empty. <a href="#prospects">Discover prospects</a> and <a href="#competitors">add competitors</a> and they'll light up here.`;
      foot.textContent = '';
    } else {
      emptyEl.classList.add('hidden');
      const hot = [...sigByCompany.values()].filter((e) => e.strong > 0).length;
      foot.textContent = `${fmtNum(companies.length)} prospects · ${fmtNum(competitors.length)} competitors · ${fmtNum(hot)} with strong signals  —  drag nodes · drag background to orbit · scroll to zoom`;
    }

    const LIME = '#8ce046', BLUE = '#4da3e8', INK = '#e8edf2';
    const nodes = [];
    const crossEdges = []; // competitor ↔ prospect "in play" links
    const center = { id: '_you', type: 'you', label: (dash && dash.tenant && dash.tenant.name) || 'You', x: 0, y: 0, z: 0, r: 15, color: LIME, fx: true };
    nodes.push(center);
    const cap = (arr, n) => arr.slice(0, n);
    // Small labeled satellite dot around a hub — the film's leaf clusters.
    const addLeaf = (hub, label, color) => {
      const leaf = { type: 'leaf', parent: hub, label: String(label).slice(0, 18), r: 3.2, color: color || hub.color, meta: hub.label };
      nodes.push(leaf);
      return leaf;
    };
    // Competitor threat scale: orange → red. Criticality is how much of your
    // attention they're consuming — intel volume, plus Market Watch being on.
    const maxDoc = Math.max(1, ...competitors.map((k) => k.doc_count || 0));
    const threatColor = (t) => {
      const o = [240, 161, 61], r = [239, 68, 68];
      const c = o.map((v, i) => Math.round(v + (r[i] - v) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    };
    for (const k of cap(competitors, 40)) {
      const t = threats[k.id];
      const threat = t ? t.score
        : Math.min(1, ((k.doc_count || 0) / maxDoc) * 0.75 + (k.watch_enabled ? 0.25 : 0));
      const lvl = t ? t.level : (threat >= 0.66 ? 'High' : threat >= 0.33 ? 'Medium' : 'Low');
      const entangled = t && t.overlapProspects && t.overlapProspects.length
        ? ` · in play at ${t.overlapProspects.slice(0, 3).join(', ')}${t.overlapProspects.length > 3 ? '…' : ''}` : '';
      const hub = { id: 'k:' + k.id, kid: k.id, type: 'comp', label: k.name, meta: `${lvl} threat · ${fmtNum(k.doc_count || 0)} intel doc${(k.doc_count || 0) === 1 ? '' : 's'}${k.watch_enabled ? ' · watched' : ''}${entangled}`, r: 7 + Math.min(7, (k.doc_count || 0) * 1.2), color: threatColor(threat), solid: true, hot: threat >= 0.66, side: -1 };
      nodes.push(hub);
      // satellite facts, film-style: threat %, intel volume, watch, in-play accounts
      addLeaf(hub, `Threat ${Math.round(threat * 100)}%`);
      if (k.doc_count > 0) addLeaf(hub, `${fmtNum(k.doc_count)} docs`);
      if (k.watch_enabled) addLeaf(hub, 'Watched');
      hub.inPlay = (t && t.overlapProspects) || [];
      for (const nm of hub.inPlay.slice(0, 3)) addLeaf(hub, `In play: ${nm}`);
    }
    // NEW (unreviewed) market-watch findings per prospect → notification badge.
    const newSigByCompany = new Map();
    for (const f of findings) {
      if (f.scope !== 'PROSPECT' || f.status !== 'NEW') continue;
      newSigByCompany.set(f.subject_id, (newSigByCompany.get(f.subject_id) || 0) + 1);
    }
    for (const c of cap(companies, 80)) {
      const sig = sigByCompany.get(c.id) || { n: 0, strong: 0 };
      const fresh = newSigByCompany.get(c.id) || 0;
      const badge = fresh + (c.meeting_count || 0);
      const hub = { id: 'p:' + c.id, cid: c.id, type: 'pros', label: c.name, badge, meta: `${fmtNum(sig.n)} signal${sig.n === 1 ? '' : 's'}${sig.strong ? ` · ${fmtNum(sig.strong)} strong` : ''}${c.meeting_count ? ` · ${fmtNum(c.meeting_count)} engagement${c.meeting_count === 1 ? '' : 's'}` : ''}${fresh ? ` · ${fmtNum(fresh)} new development${fresh === 1 ? '' : 's'}` : ''}`, r: 5.5 + Math.min(8, sig.n * 1.6 + (c.meeting_count || 0)), color: BLUE, hot: sig.strong > 0, side: 1 };
      nodes.push(hub);
      if (sig.strong) addLeaf(hub, `${fmtNum(sig.strong)} strong signal${sig.strong === 1 ? '' : 's'}`, LIME);
      else if (sig.n) addLeaf(hub, `${fmtNum(sig.n)} signal${sig.n === 1 ? '' : 's'}`);
      if (c.meeting_count) addLeaf(hub, `${fmtNum(c.meeting_count)} engagement${c.meeting_count === 1 ? '' : 's'}`);
      if (fresh) addLeaf(hub, `${fmtNum(fresh)} new`, LIME);
      // each opportunity becomes its own labeled satellite, like the film's
      // metric dots — real signal titles, truncated to chip length
      const myOpps = ((dash && dash.opportunities) || []).filter((o) => o.companyId === c.id).slice(0, 3);
      for (const o of myOpps) addLeaf(hub, String(o.title || 'Signal').slice(0, 16), o.strength === 'strong' ? LIME : undefined);
      // fresh development categories ("New: funding")
      const cats = [...new Set(findings.filter((f) => f.scope === 'PROSPECT' && f.subject_id === c.id && f.status === 'NEW').map((f) => f.category).filter(Boolean))];
      for (const cat of cats.slice(0, 2)) addLeaf(hub, `New: ${cat}`, LIME);
    }
    // Cross-links: a competitor entangled at one of our prospects gets a real
    // edge to that prospect — the web the film shows, grounded in intel.
    {
      const prosByName = new Map(nodes.filter((n) => n.type === 'pros').map((n) => [String(n.label).toLowerCase(), n]));
      for (const hub of nodes.filter((n) => n.type === 'comp')) {
        for (const nm of (hub.inPlay || [])) {
          const pn = prosByName.get(String(nm).toLowerCase());
          if (pn) crossEdges.push({ a: hub, b: pn });
        }
      }
    }

    // The stage can still be display:hidden on a cold load — wait for size.
    const stage = canvas.parentElement;
    for (let tries = 0; tries < 120 && stage.clientWidth === 0; tries++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    let W = Math.max(640, stage.clientWidth), H = Math.max(480, stage.clientHeight);
    let R = Math.min(W, H) * 0.36; // world shell radius

    // ── 3D world — nodes live on a sphere around you; the camera orbits. ──
    // Seed on a golden-angle sphere, competitors toward -x, prospects +x.
    // Wide, flattish web (the film reads as a tilted plane, not a ball):
    // hubs spread on a disc with mild depth, leaves orbit their parent.
    const hubs = nodes.filter((n) => !n.fx && !n.parent);
    hubs.forEach((n, i) => {
      const golden = i * 2.39996;
      const shell = (n.type === 'comp' ? 0.45 : 0.72) * R * (0.7 + 0.5 * ((i % 9) / 9));
      n.x = Math.cos(golden) * shell * 1.45 + (n.side || 0) * R * 0.3;
      n.y = (((i * 7) % 11) / 11 - 0.5) * R * 0.5;
      n.z = Math.sin(golden) * shell * 0.9;
      n.vx = 0; n.vy = 0; n.vz = 0;
    });
    nodes.filter((n) => n.parent).forEach((n, i) => {
      const a = i * 2.1 + (n.parent.x || 0);
      n.x = n.parent.x + Math.cos(a) * 34;
      n.y = n.parent.y + (((i % 3) - 1) * 14);
      n.z = n.parent.z + Math.sin(a) * 34;
      n.vx = 0; n.vy = 0; n.vz = 0;
    });

    // Decorative dust — tiny drifting motes like the film's background field.
    // Parametric (no physics), unlabeled, never hit-tested.
    const dust = [];
    {
      const D = 90;
      for (let i = 0; i < D; i++) {
        const golden = i * 2.39996;
        dust.push({
          a0: golden, r0: R * (0.25 + ((i * 13) % 23) / 23 * 1.05),
          y0: (((i * 7) % 17) / 17 - 0.5) * R * 0.6,
          sp: 0.008 + ((i % 5) / 5) * 0.02,
          size: 0.9 + ((i % 4) / 4) * 1.1,
          hue: i % 3, // 0 slate, 1 lime, 2 blue
        });
      }
    }

    let dragNode = null;
    function physicsStep(t) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (a.fx || a === dragNode) continue;
        let fx = 0, fy = 0, fz = 0;
        const myRep = a.parent ? 380 : 3400;
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue;
          const b = nodes[j];
          const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
          const d2 = dx * dx + dy * dy + dz * dz || 1;
          const rep = (b.parent ? Math.min(myRep, 420) : myRep) / d2;
          fx += dx * rep; fy += dy * rep; fz += dz * rep;
        }
        if (a.parent) {
          // leaves ride their hub on a short tether
          const dx = a.x - a.parent.x, dy = a.y - a.parent.y, dz = a.z - a.parent.z;
          const dist = Math.hypot(dx, dy, dz) || 1;
          const pull = (dist - 30) * 0.25 * 18;
          fx -= (dx / dist) * pull; fy -= (dy / dist) * pull; fz -= (dz / dist) * pull;
        } else {
          // hubs spring toward the center at the type's shell distance
          const dist = Math.hypot(a.x, a.y, a.z) || 1;
          const rest = (a.type === 'comp' ? 0.45 : 0.72) * R;
          const pull = (dist - rest) * 0.05 * 18;
          fx -= (a.x / dist) * pull; fy -= (a.y / dist) * pull; fz -= (a.z / dist) * pull;
          fx += (a.side || 0) * 1.1;
          fy -= a.y * 0.06; // keep the web flat-ish like the film's plane
        }
        // ambient life — tiny per-node breeze so the map never freezes
        fx += Math.sin(t * 0.3 + i * 1.7) * 0.8;
        fy += Math.cos(t * 0.25 + i * 2.3) * 0.7;
        fz += Math.sin(t * 0.22 + i * 2.9) * 0.8;
        a.vx = (a.vx + fx * 0.012) * 0.86;
        a.vy = (a.vy + fy * 0.012) * 0.86;
        a.vz = (a.vz + fz * 0.012) * 0.86;
        const sp = Math.hypot(a.vx, a.vy, a.vz);
        if (sp > 3) { const f = 3 / sp; a.vx *= f; a.vy *= f; a.vz *= f; }
      }
      for (const n of nodes) {
        if (n.fx || n === dragNode) continue;
        n.x += n.vx; n.y += n.vy; n.z += n.vz;
      }
    }
    for (let t = 0; t < 200; t++) physicsStep(t * 0.016);

    // Hi-DPI canvas
    const ctx = canvas.getContext('2d');
    const fitCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W * dpr; canvas.height = H * dpr;
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    };
    fitCanvas();
    if (_mmResize) _mmResize.disconnect();
    _mmResize = new ResizeObserver(() => {
      const nw = stage.clientWidth, nh = stage.clientHeight;
      if (!nw || !nh || (nw === W && nh === H)) return;
      W = nw; H = nh; R = Math.min(W, H) * 0.36;
      fitCanvas(); // projection is origin-centered, so it recenters itself
    });
    _mmResize.observe(stage);

    // ── Camera + projection ──
    const cam = { yaw: -0.45, pitch: 0.42, dist: 0.95 };
    const FOCAL = 1100;
    let lastInteract = 0;
    let hover = null, panning = null, moved = 0, lastP = null;
    canvas.style.touchAction = 'none';

    function project() {
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      for (const n of nodes) {
        const x1 = n.x * cy + n.z * sy;
        const z1 = -n.x * sy + n.z * cy;
        const y2 = n.y * cp - z1 * sp;
        const z2 = n.y * sp + z1 * cp;
        const sc = (FOCAL / (FOCAL + z2)) / cam.dist;
        n.sx = W / 2 + x1 * sc;
        n.sy = H / 2 + y2 * sc;
        n.sc = sc;
        n.depth = z2;
        n.fade = Math.max(0.35, Math.min(1, 1 - z2 / (R * 2.6)));
      }
    }
    // Screen-plane delta → world delta (so dragging a node feels flat-2D).
    function screenToWorldDelta(du, dv) {
      const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      const dy = dv * cp, dz1 = -dv * sp;
      return { dx: du * cy - dz1 * sy, dy, dz: du * sy + dz1 * cy };
    }

    const t0 = performance.now();
    function draw(now) {
      const t = (now - t0) / 1000;
      physicsStep(t);
      // slow auto-orbit when the cursor has been idle a moment
      if (now - lastInteract > 2500 && !dragNode && !panning) cam.yaw += 0.0006;
      project();
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      // dust field beneath everything
      {
        const cy = Math.cos(cam.yaw), syw = Math.sin(cam.yaw);
        const cp = Math.cos(cam.pitch), sp2 = Math.sin(cam.pitch);
        for (const d of dust) {
          const ang = d.a0 + t * d.sp;
          const wx = Math.cos(ang) * d.r0 * 1.45, wy = d.y0, wz = Math.sin(ang) * d.r0 * 0.9;
          const x1 = wx * cy + wz * syw, z1 = -wx * syw + wz * cy;
          const y2 = wy * cp - z1 * sp2, z2 = wy * sp2 + z1 * cp;
          const sc = (FOCAL / (FOCAL + z2)) / cam.dist;
          const fade = Math.max(0.12, Math.min(0.4, 1 - z2 / (R * 2.6)) * 0.4);
          ctx.fillStyle = d.hue === 1 ? `rgba(140,224,70,${fade})` : d.hue === 2 ? `rgba(77,163,232,${fade})` : `rgba(170,180,191,${fade * 0.8})`;
          ctx.beginPath(); ctx.arc(W / 2 + x1 * sc, H / 2 + y2 * sc, d.size * sc, 0, Math.PI * 2); ctx.fill();
        }
      }
      // edges first (faint, depth-faded)
      for (const n of nodes) {
        if (n.fx) continue;
        if (n.parent) {
          // leaf tether — short, in the hub's hue
          const a = 0.30 * ((n.fade + n.parent.fade) / 2);
          ctx.strokeStyle = n.color.startsWith('rgb(') ? n.color.replace('rgb(', 'rgba(').replace(')', `,${a})`) : `rgba(140,224,70,${a})`;
          if (n.color === BLUE) ctx.strokeStyle = `rgba(77,163,232,${a})`;
          else if (n.color === LIME) ctx.strokeStyle = `rgba(140,224,70,${a})`;
          ctx.lineWidth = Math.max(0.5, 0.8 * n.sc);
          ctx.beginPath(); ctx.moveTo(n.parent.sx, n.parent.sy); ctx.lineTo(n.sx, n.sy); ctx.stroke();
          continue;
        }
        const a = (0.10 + (n.hot ? 0.10 : 0) + (hover === n ? 0.25 : 0)) * ((n.fade + center.fade) / 2);
        ctx.strokeStyle = (n.type === 'comp' ? `rgba(239,99,61,${a})` : `rgba(77,163,232,${a})`);
        ctx.lineWidth = Math.max(0.6, 1 * n.sc);
        ctx.beginPath();
        ctx.moveTo(center.sx, center.sy);
        ctx.lineTo(n.sx, n.sy);
        ctx.stroke();
        // tiny traveller dot along the spoke — film-style edge detail
        const f = 0.35 + 0.3 * (0.5 + 0.5 * Math.sin(t * 0.3 + n.sx * 0.01));
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.arc(center.sx + (n.sx - center.sx) * f, center.sy + (n.sy - center.sy) * f, Math.max(0.8, 1.3 * n.sc), 0, Math.PI * 2);
        ctx.fill();
      }
      // "in play" cross-links: competitor entangled at a prospect
      for (const e of crossEdges) {
        const a = 0.30 * ((e.a.fade + e.b.fade) / 2);
        ctx.strokeStyle = `rgba(239,99,61,${a})`;
        ctx.lineWidth = Math.max(0.6, 0.9 * ((e.a.sc + e.b.sc) / 2));
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(e.a.sx, e.a.sy); ctx.lineTo(e.b.sx, e.b.sy); ctx.stroke();
        ctx.setLineDash([]);
      }
      // nodes far → near so close ones draw on top
      const order = [...nodes].sort((a, b) => b.depth - a.depth);
      for (const n of order) {
        const x = n.sx, y = n.sy, rr = Math.max(2.5, n.r * n.sc);
        const pulse = n.hot ? (0.7 + 0.3 * Math.sin(t * 1.2 + n.x)) : 1;
        ctx.globalAlpha = n.fade;
        ctx.save();
        ctx.shadowColor = n.color;
        ctx.shadowBlur = (n.fx ? 26 : n.hot ? 22 : 12) * pulse * n.sc;
        ctx.fillStyle = n.color;
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        ctx.globalAlpha = n.fade;
        if (!n.solid) {
          ctx.fillStyle = 'rgba(10,14,19,.55)';
          ctx.beginPath(); ctx.arc(x, y, Math.max(2, rr - 3), 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = n.color; ctx.lineWidth = 1.4 * Math.max(0.7, n.sc);
        ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
        // notification badge — engagements + new developments
        if (n.badge > 0) {
          const br = 7.5 * Math.max(0.75, n.sc);
          const bx = x + rr * 0.85, by = y - rr * 0.85;
          const txt = n.badge > 9 ? '9+' : String(n.badge);
          ctx.save();
          ctx.shadowColor = '#8ce046'; ctx.shadowBlur = 8 * n.sc;
          ctx.fillStyle = '#8ce046';
          ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
          ctx.fillStyle = '#0c1407';
          ctx.font = `700 ${Math.round(9 * Math.max(0.8, n.sc))}px 'IBM Plex Mono', monospace`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(txt, bx, by + 0.5);
          ctx.textBaseline = 'alphabetic';
        }
        // labels — the film labels nearly everything; leaves get tiny metrics
        const isLeaf = !!n.parent;
        const show = n.fx || hover === n || dragNode === n
          || (!isLeaf && n.sc > 0.45)
          || (isLeaf && n.sc > 0.72);
        if (show) {
          const fpx = Math.max(8, Math.min(15, (n.fx ? 13 : isLeaf ? 8.5 : 11) * n.sc));
          ctx.font = `${n.fx ? '600' : '500'} ${fpx.toFixed(1)}px 'IBM Plex Mono', monospace`;
          const la = hover === n ? 1 : (isLeaf ? 0.5 : 0.72) * n.fade;
          ctx.fillStyle = hover === n ? INK : `rgba(232,237,242,${la.toFixed(2)})`;
          ctx.textAlign = 'center';
          const lbl = String(n.label || '').length > 22 ? String(n.label).slice(0, 21) + '…' : String(n.label || '');
          ctx.fillText(lbl, x, y + rr + (isLeaf ? 10 : 13));
        }
        ctx.globalAlpha = 1;
      }
      if (currentSection === 'market-map' && canvas.isConnected) _mmFrame = requestAnimationFrame(draw);
    }
    _mmFrame = requestAnimationFrame(draw);
    canvas._mm = { nodes }; // debug/test handle: projected positions live on each node

    const hitNode = (mx, my) => {
      // nearest-first so close nodes win over far ones behind them
      let best = null, bestD = Infinity;
      for (const n of nodes) {
        const rr = Math.max(2.5, n.r * n.sc) + 7;
        const dx = mx - n.sx, dy = my - n.sy;
        const d2 = dx * dx + dy * dy;
        if (d2 <= rr * rr && n.depth < bestD) { best = n; bestD = n.depth; }
      }
      return best;
    };
    const pos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { mx: e.clientX - rect.left, my: e.clientY - rect.top };
    };

    canvas.onpointerdown = (e) => {
      const { mx, my } = pos(e);
      moved = 0; lastP = { mx, my };
      lastInteract = performance.now();
      const n = hitNode(mx, my);
      if (n) { dragNode = n; n.vx = 0; n.vy = 0; n.vz = 0; }
      else panning = { mx, my, yaw: cam.yaw, pitch: cam.pitch };
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      tip.classList.add('hidden');
    };
    canvas.onpointermove = (e) => {
      const { mx, my } = pos(e);
      lastInteract = performance.now();
      if (dragNode) {
        const sc = dragNode.sc || 1;
        const d = screenToWorldDelta((mx - lastP.mx) / sc, (my - lastP.my) / sc);
        dragNode.x += d.dx; dragNode.y += d.dy; dragNode.z += d.dz;
        moved += Math.hypot(mx - lastP.mx, my - lastP.my);
        lastP = { mx, my };
        return;
      }
      if (panning) {
        cam.yaw = panning.yaw + (mx - panning.mx) * 0.005;
        cam.pitch = Math.max(-1.25, Math.min(1.25, panning.pitch + (my - panning.my) * 0.005));
        moved = Math.hypot(mx - panning.mx, my - panning.my);
        return;
      }
      hover = hitNode(mx, my);
      canvas.style.cursor = hover ? 'grab' : 'default';
      if (hover && !hover.fx) {
        tip.classList.remove('hidden');
        tip.style.left = Math.min(W - 220, mx + 14) + 'px';
        tip.style.top = (my + 12) + 'px';
        tip.innerHTML = hover.parent
          ? `<b>${escapeHtml(hover.parent.label || '')}</b><span>${escapeHtml(hover.label || '')}</span>`
          : `<b>${escapeHtml(hover.label || '')}</b><span>${hover.type === 'comp' ? 'Competitor' : 'Prospect'}${hover.meta ? ' · ' + escapeHtml(hover.meta) : ''}</span>`;
      } else tip.classList.add('hidden');
    };
    // ── Side panel — in fullscreen a click opens details here instead of
    // navigating away (you can't see the SPA route under fullscreen anyway).
    const side = $('mm-side');
    const closeSide = () => { if (side) side.classList.add('hidden'); };
    const matPills = (m) => '●'.repeat(Math.max(1, Math.min(5, m || 3)));
    function openSide(target) {
      if (!side) return;
      let kindLbl = '', body = '', openLbl = '', openAct = null;
      if (target.type === 'pros') {
        const c = companies.find((x) => x.id === target.cid) || {};
        const opps = ((dash && dash.opportunities) || []).filter((o) => o.companyId === target.cid);
        const finds = findings.filter((f) => f.scope === 'PROSPECT' && f.subject_id === target.cid).slice(0, 6);
        kindLbl = 'Prospect';
        body = `
          <div class="mm-side-sec"><div class="mm-side-facts">
            ${c.domain ? `<span>${escapeHtml(c.domain)}</span>` : ''}
            <span>${fmtNum(c.meeting_count || 0)} engagement${(c.meeting_count || 0) === 1 ? '' : 's'}</span>
            <span>${fmtNum(opps.length)} signal${opps.length === 1 ? '' : 's'}</span>
          </div></div>
          <div class="mm-side-sec"><h5>Priority signals</h5>
            ${opps.length ? opps.slice(0, 6).map((o) => `<div class="mm-side-row"><span><b>${escapeHtml(o.title || 'Opportunity')}</b></span><span class="mono-sm">${escapeHtml(o.strength || '—')}</span></div>`).join('') : '<div class="mm-side-empty">No scored signals yet — run prospect research.</div>'}
          </div>
          <div class="mm-side-sec"><h5>New developments</h5>
            ${finds.length ? finds.map((f) => `<div class="mm-side-row"><span><b>${escapeHtml(f.title || '')}</b><br><span class="mono-sm">${escapeHtml(f.category || '')}</span></span><span class="mono-sm">${matPills(f.materiality)}</span></div>`).join('') : '<div class="mm-side-empty">Nothing new from Market Watch.</div>'}
          </div>`;
        openLbl = 'Open full profile →';
        openAct = () => { _prospectsState.selectedCompanyId = target.cid; window.location.hash = '#prospects'; };
      } else {
        const k = competitors.find((x) => x.id === target.kid) || {};
        const t = threats[target.kid] || null;
        const finds = findings.filter((f) => f.scope === 'COMPETITOR' && f.subject_id === target.kid).slice(0, 6);
        const score = t ? t.score : 0;
        const FNAMES = { battlecard: 'Battlecard threat', prospects: 'Prospect entanglement', products: 'Product overlap', watch: 'Market Watch activity' };
        kindLbl = 'Competitor';
        body = `
          <div class="mm-side-sec"><h5>Threat — ${t ? t.level : 'Low'} (${Math.round(score * 100)}%)</h5>
            <div class="mm-threat-bar"><i style="width:${Math.max(4, Math.round(score * 100))}%"></i></div>
            ${t && Object.keys(t.factors).length ? Object.entries(t.factors).map(([fk, fv]) => `<div class="mm-side-row"><span>${escapeHtml(FNAMES[fk] || fk)}</span><span class="mono-sm">${Math.round(fv * 100)}%</span></div>`).join('') : '<div class="mm-side-empty">No threat intelligence filed yet.</div>'}
          </div>
          ${t && t.overlapProspects && t.overlapProspects.length ? `<div class="mm-side-sec"><h5>In play at</h5><div class="mm-side-facts">${t.overlapProspects.map((nm) => `<span>${escapeHtml(nm)}</span>`).join('')}</div></div>` : ''}
          <div class="mm-side-sec"><div class="mm-side-facts">
            ${k.website ? `<span>${escapeHtml(k.website)}</span>` : ''}
            <span>${fmtNum(k.doc_count || 0)} intel doc${(k.doc_count || 0) === 1 ? '' : 's'}</span>
            ${k.watch_enabled ? '<span>Watched</span>' : ''}
          </div></div>
          <div class="mm-side-sec"><h5>New developments</h5>
            ${finds.length ? finds.map((f) => `<div class="mm-side-row"><span><b>${escapeHtml(f.title || '')}</b><br><span class="mono-sm">${escapeHtml(f.category || '')}</span></span><span class="mono-sm">${matPills(f.materiality)}</span></div>`).join('') : '<div class="mm-side-empty">Nothing new from Market Watch.</div>'}
          </div>`;
        openLbl = 'Open competitors page →';
        openAct = () => { window.location.hash = '#competitors'; };
      }
      side.innerHTML = `
        <div class="mm-side-h">
          <div><div class="mm-side-name">${escapeHtml(target.label || '')}</div><span class="mm-side-kind">${kindLbl}</span></div>
          <button class="mm-side-close" title="Close" aria-label="Close">×</button>
        </div>
        <div class="mm-side-b">${body}</div>
        <div class="mm-side-foot"><button class="mm-side-open">${openLbl}</button></div>`;
      side.querySelector('.mm-side-close').onclick = closeSide;
      side.querySelector('.mm-side-open').onclick = () => {
        closeSide();
        const go = () => openAct && openAct();
        if (document.fullscreenElement) document.exitFullscreen().then(go).catch(go);
        else go();
      };
      side.classList.remove('hidden');
    }

    const endPointer = (e) => {
      const wasDrag = dragNode;
      dragNode = null; panning = null;
      canvas.style.cursor = 'default';
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      // a press that barely moved is a click — open the entity. In fullscreen
      // we show the side panel instead of navigating underneath the overlay.
      if (wasDrag && !wasDrag.fx && moved < 5) {
        const target = wasDrag.parent || wasDrag;
        if (document.fullscreenElement) { openSide(target); return; }
        if (target.type === 'pros') { _prospectsState.selectedCompanyId = target.cid; window.location.hash = '#prospects'; }
        else if (target.type === 'comp') window.location.hash = '#competitors';
      }
    };
    canvas.onpointerup = endPointer;
    canvas.onpointercancel = endPointer;
    canvas.onmouseleave = () => { if (!dragNode && !panning) { hover = null; tip.classList.add('hidden'); } };
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      lastInteract = performance.now();
      cam.dist = Math.max(0.45, Math.min(2.6, cam.dist * (e.deltaY > 0 ? 1.1 : 0.9)));
    }, { passive: false });

    // Fullscreen toggle — the ResizeObserver re-fits the canvas on the way in
    // and out, so the projection recenters by itself.
    const fsBtn = $('mm-fs-btn');
    if (fsBtn) {
      const wrap = stage.closest('.mm-wrap') || stage;
      fsBtn.onclick = () => {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else wrap.requestFullscreen().catch(() => {});
      };
      document.onfullscreenchange = () => {
        const span = fsBtn.querySelector('span');
        if (span) span.textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
        if (!document.fullscreenElement) closeSide();
      };
    }
  }

  function kpiCell(label, value, sub, sec, hot) {
    return `<button class="dash-kpi${hot ? ' hot' : ''}" data-goto="${sec}"><div class="dash-kpi-v">${value}</div><div class="dash-kpi-l">${escapeHtml(label)}</div>${sub ? `<div class="dash-kpi-s kb-subtle">${escapeHtml(sub)}</div>` : ''}</button>`;
  }
  function dashEmpty(msg) { return `<div class="dash-empty kb-subtle">${escapeHtml(msg)}</div>`; }
  function dashFound(ok, label) { return `<span class="dash-found-item ${ok ? 'ok' : 'todo'}">${ok ? '✓' : '○'} ${escapeHtml(label)}</span>`; }
  function dashStrengthClass(s) { return s === 'strong' ? 'win' : s === 'weak' ? 'lose' : 'tie'; }
  function dashOppRow(o, i) {
    const fits = (o.products || []).slice(0, 4).map((p) => `<span class="kb-stream-pill stream-file">${escapeHtml(p)}</span>`).join(' ');
    const analysis = (o.analysis || '').trim();
    return `<div class="dash-opp" data-opp-idx="${i}">
      <div class="dash-opp-head" data-opp-toggle="${i}" role="button" tabindex="0" aria-expanded="false" title="Click for the full description">
        <div class="dash-opp-co">${escapeHtml(o.companyName || 'Prospect')}</div>
        <div class="dash-opp-top">
          <span class="bc-verdict bc-verdict-${dashStrengthClass(o.strength)}">${escapeHtml(o.strength || '—')}</span>
          <span class="dash-opp-title">${escapeHtml(o.title || 'Opportunity')}</span>
          <span class="dash-opp-chevron" aria-hidden="true">▸</span>
        </div>
        ${fits ? `<div class="dash-opp-fits">${fits}</div>` : ''}
      </div>
      <div class="dash-opp-detail hidden" data-opp-detail="${i}">
        <p class="dash-opp-analysis">${analysis
          ? escapeHtml(analysis)
          : '<span class="kb-subtle">No detailed description yet — generate prospect intel to research this account and surface the “why now”.</span>'}</p>
        <div class="dash-opp-actions">
          <button class="kb-secondary-btn" data-opp-intel="${i}">Generate prospect intel</button>
          <button class="kb-link-btn" data-opp-brief="${i}">Brief an engagement →</button>
          <button class="kb-link-btn" data-opp-company="${escapeHtml(o.companyId)}">Open prospect →</button>
        </div>
      </div>
    </div>`;
  }
  function dashEngRow(e) {
    const statusCls = e.status === 'BRIEFED' ? 'pill-ok' : 'pill-info';
    return `<div class="dash-eng" data-eng-company="${escapeHtml(e.companyId || '')}">
      <div class="dash-eng-when">${escapeHtml(fmtDate(e.scheduledAt))}</div>
      <div class="dash-eng-co">${escapeHtml(e.companyName || 'Prospect')}</div>
      <span class="pill ${statusCls}">${escapeHtml(e.status || '')}</span>
    </div>`;
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
      ? `<div class="mono muted" title="engagement ${escapeHtml(meeting.missionId)}">engagement · ${escapeHtml(meeting.missionId.slice(0, 8))}…</div>`
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

  // ── Arena practice history + coaching ────────────────────────────────────
  // Durable list of completed practice runs, each with an AI scorecard. Row
  // click → transcript + breakdown detail. A rep filter narrows to one person.
  let _sessionsFilter = { rep: '', status: '' };

  async function loadSessions() {
    showSessionsList();
    const qs = new URLSearchParams();
    if (_sessionsFilter.rep) qs.set('rep', _sessionsFilter.rep);
    if (_sessionsFilter.status) qs.set('status', _sessionsFilter.status);
    const { sessions } = await fetchJson('/api/admin/sessions' + (qs.toString() ? `?${qs}` : ''));
    renderSessionsFilters(sessions);
    $('sessions-table').innerHTML = sessions.length === 0
      ? '<div class="empty">No practice sessions yet. Reps start them from a call portal’s “Practice” button.</div>'
      : `
        <table class="dt">
          <thead><tr><th>Rep</th><th>Persona</th><th>Objection</th><th>Score</th><th>Turns</th><th>Duration</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${sessions.map(sessionRow).join('')}</tbody>
        </table>`;
    $('sessions-table').querySelectorAll('tr[data-sid]').forEach((tr) => {
      tr.addEventListener('click', () => loadSessionDetail(tr.getAttribute('data-sid')));
    });
  }

  function renderSessionsFilters(sessions) {
    // Build the rep dropdown from whatever reps appear in the current result
    // set, plus the active filter (so it survives a zero-result filter).
    const reps = new Set(sessions.map((s) => s.repName).filter(Boolean));
    if (_sessionsFilter.rep) reps.add(_sessionsFilter.rep);
    const repOpts = ['<option value="">All reps</option>']
      .concat([...reps].sort().map((r) =>
        `<option value="${escapeHtml(r)}"${r === _sessionsFilter.rep ? ' selected' : ''}>${escapeHtml(r)}</option>`));
    const statuses = [['', 'All statuses'], ['completed', 'Completed'], ['active', 'In progress'], ['abandoned', 'Abandoned']];
    const statusOpts = statuses.map(([v, l]) =>
      `<option value="${v}"${v === _sessionsFilter.status ? ' selected' : ''}>${l}</option>`);
    $('sessions-filters').innerHTML = `
      <select id="sessions-rep-filter">${repOpts.join('')}</select>
      <select id="sessions-status-filter">${statusOpts.join('')}</select>`;
    $('sessions-rep-filter').addEventListener('change', (e) => {
      _sessionsFilter.rep = e.target.value; loadSessions();
    });
    $('sessions-status-filter').addEventListener('change', (e) => {
      _sessionsFilter.status = e.target.value; loadSessions();
    });
  }

  function scorePill(score) {
    if (score == null) return '<span class="muted">—</span>';
    const cls = score >= 75 ? 'pill-good' : score >= 50 ? 'pill-mid' : 'pill-low';
    return `<span class="pill ${cls}">${score}</span>`;
  }

  function fmtDuration(sec) {
    if (sec == null) return '—';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m ? `${m}m ${s}s` : `${s}s`;
  }

  function sessionRow(s) {
    return `
      <tr data-sid="${escapeHtml(s.id)}" class="row-clickable">
        <td>${escapeHtml(s.repName || '—')}</td>
        <td>${escapeHtml((s.persona || '').replace(/-/g, ' '))}</td>
        <td>${escapeHtml(s.objectionCategory || '—')}</td>
        <td>${scorePill(s.score)}</td>
        <td>${s.turnCount}</td>
        <td>${fmtDuration(s.durationSeconds)}</td>
        <td><span class="pill pill-${s.status}">${s.status}</span></td>
        <td>${fmtDate(s.startedAt)}</td>
      </tr>`;
  }

  function showSessionsList() {
    hide('session-detail-card');
    show('sessions-filters');
    show('sessions-table');
  }

  async function loadSessionDetail(id) {
    const { session } = await fetchJson(`/api/admin/sessions/${encodeURIComponent(id)}`);
    hide('sessions-filters');
    hide('sessions-table');
    show('session-detail-card');
    $('session-detail-body').innerHTML = renderSessionDetail(session);
    // onclick (not addEventListener) so repeated opens don't stack handlers.
    $('session-detail-back').onclick = (e) => { e.preventDefault(); showSessionsList(); };
    $('session-detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderSessionDetail(s) {
    const o = s.objection || {};
    const meta = `
      <div class="sd-meta">
        <span><span class="label">Rep</span>${escapeHtml(s.repName || '—')}</span>
        <span><span class="label">Persona</span>${escapeHtml((s.persona || '').replace(/-/g, ' '))}</span>
        <span><span class="label">Objection</span>${escapeHtml(o.category || '—')}</span>
        <span><span class="label">Status</span>${escapeHtml(s.status)}</span>
        <span><span class="label">Started</span>${fmtDate(s.startedAt)}</span>
        <span><span class="label">Portal</span><a href="/portal/?id=${encodeURIComponent(s.portalId)}" target="_blank">open ↗</a></span>
      </div>`;
    const scorecard = renderAdminScorecard(s.scorecard);
    const transcript = (s.turns || []).map((t) => `
      <div class="sd-turn sd-turn-${t.role === 'rep' ? 'rep' : 'prospect'}">
        <div class="sd-turn-who">${t.role === 'rep' ? 'Rep' : 'Prospect'}</div>
        <div class="sd-turn-text">${escapeHtml(t.content)}</div>
      </div>`).join('');
    return `${meta}${scorecard}
      <h4 class="sd-section-h">Transcript</h4>
      <div class="sd-transcript">${transcript || '<div class="muted">No turns recorded.</div>'}</div>`;
  }

  function renderAdminScorecard(sc) {
    if (!sc) return '<div class="sd-noscore">No scorecard — session was not completed.</div>';
    if (sc.incomplete || sc.error) {
      return `<div class="sd-noscore">${escapeHtml(sc.feedback || 'Scorecard unavailable.')}</div>`;
    }
    const dims = (sc.dimensions || []).map((d) => {
      const pct = d.max ? Math.round((d.score / d.max) * 100) : 0;
      return `
        <div class="sd-dim">
          <div class="sd-dim-top"><span>${escapeHtml(d.name)}</span><span>${d.score}/${d.max}</span></div>
          <div class="sd-bar"><i style="width:${pct}%"></i></div>
          ${d.note ? `<div class="sd-dim-note">${escapeHtml(d.note)}</div>` : ''}
        </div>`;
    }).join('');
    const list = (title, items) => (items && items.length)
      ? `<div><h5>${title}</h5><ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>`
      : '';
    return `
      <div class="sd-scorecard">
        <div class="sd-score-head">
          <h4 class="sd-section-h" style="margin:0">Coaching scorecard</h4>
          ${typeof sc.overall === 'number' ? `<div class="sd-overall">${sc.overall}<small>/100</small></div>` : ''}
        </div>
        ${dims}
        ${sc.feedback ? `<p class="sd-feedback">${escapeHtml(sc.feedback)}</p>` : ''}
        <div class="sd-lists">${list('Strengths', sc.strengths)}${list('To improve', sc.improvements)}</div>
      </div>`;
  }

  // ── Prospects (companies + buyer-persona contacts) ───────────────────────
  // Two-pane view. Left: list of prospect companies (with mission + contact
  // counts). Right: selected company detail + contacts table. The contacts
  // table is what fulfils the "Name + Email + Role" buyer-persona record;
  // the persona auto-linking happens server-side (contacts.js).

  let _prospectsState = { companies: [], selectedCompanyId: null, contacts: [] };
  let _prospectResearch = null; // latest research run for the open prospect (Signals tab)
  let _prospectMode = 'manual'; // creation mode: manual | crm | discover

  async function loadProspects() {
    const host = $('prospects-body');
    if (!host) return;
    host.innerHTML = '<div class="kb-subtle">Loading…</div>';
    try {
      const data = await fetchJson('/api/companies');
      _prospectsState.companies = data.companies || data || [];
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn't load prospects: ${escapeHtml(err.message)}</div>`;
      return;
    }
    // Pick previously-selected or first.
    if (!_prospectsState.selectedCompanyId && _prospectsState.companies.length > 0) {
      _prospectsState.selectedCompanyId = _prospectsState.companies[0].id;
    }
    await renderProspects(host);
  }

  // Collapsible left column (shared by Prospects + Competitors). State persists
  // in localStorage so it survives the frequent re-renders these pages do.
  function isLeftCollapsed(key) { try { return localStorage.getItem('gs_collapse_' + key) === '1'; } catch { return false; } }
  function setLeftCollapsed(key, v) { try { localStorage.setItem('gs_collapse_' + key, v ? '1' : '0'); } catch { /* ignore */ } }
  const collapseRail = '<button type="button" class="list-show-rail" data-list-collapse title="Show list">☰</button>';
  const collapseBtn = '<button type="button" class="list-collapse-btn" data-list-collapse title="Hide list">«</button>';
  function wireListCollapse(host, key) {
    const grid = host.querySelector('.prospects-grid');
    if (!grid) return;
    grid.classList.toggle('left-collapsed', isLeftCollapsed(key));
    host.querySelectorAll('[data-list-collapse]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = !grid.classList.contains('left-collapsed');
      grid.classList.toggle('left-collapsed', collapsed);
      setLeftCollapsed(key, collapsed);
    }));
  }

  async function renderProspects(host) {
    const companies = _prospectsState.companies;
    const selectedId = _prospectsState.selectedCompanyId;
    // Creation banner with 3 modes: Manual · From CRM · Discover online. The
    // active mode's panel renders into #prospect-mode-panel (renderProspectModePanel).
    const modeSection = `
      <div class="prospect-quick-banner">
        <div class="prospect-modes">
          <button type="button" class="kb-tab${_prospectMode === 'manual' ? ' active' : ''}" data-pmode="manual">Manual</button>
          <button type="button" class="kb-tab${_prospectMode === 'crm' ? ' active' : ''}" data-pmode="crm">From CRM</button>
          <button type="button" class="kb-tab discover-tab${_prospectMode === 'discover' ? ' active' : ''}" data-pmode="discover"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>Discover online</button>
        </div>
        <div id="prospect-mode-panel"></div>
      </div>`;

    if (companies.length === 0) {
      host.innerHTML = `
        ${modeSection}
        <div class="empty">
          <p>No prospects yet.</p>
          <p class="kb-subtle">Add one above (manual, from your CRM, or by discovering them online), or schedule an engagement on the <a href="#missions">Engagements tab</a>.</p>
        </div>`;
      wireProspectModes(host);
      return;
    }
    let contacts = [];
    if (selectedId) {
      try {
        const r = await fetchJson(`/api/contacts?companyId=${encodeURIComponent(selectedId)}`);
        contacts = r.contacts || [];
      } catch { /* render empty contacts */ }
    }
    _prospectsState.contacts = contacts;
    const selected = companies.find((c) => c.id === selectedId);

    host.innerHTML = `
      ${modeSection}
      <div class="prospects-grid">
        ${collapseRail}
        <div class="prospects-list">
          <div class="prospects-list-h"><span>${companies.length} prospect${companies.length === 1 ? '' : 's'}</span>${collapseBtn}</div>
          <div class="prospects-list-rows">
            ${companies.map((c) => `
              <div class="prospect-row ${c.id === selectedId ? 'active' : ''}" data-prospect-pick="${escapeHtml(c.id)}" role="button" tabindex="0">
                <div class="prospect-row-name">${escapeHtml(c.name)}</div>
                <div class="prospect-row-meta kb-subtle">${escapeHtml(c.domain || '—')} · ${fmtNum(c.meeting_count || 0)} engagement${(c.meeting_count || 0) === 1 ? '' : 's'}</div>
              </div>`).join('')}
          </div>
        </div>
        <div class="prospects-detail">
          ${selected ? renderProspectDetail(selected, contacts) : '<div class="kb-subtle">Pick a prospect on the left.</div>'}
        </div>
      </div>
    `;
    host.querySelectorAll('[data-prospect-pick]').forEach((el) => {
      el.addEventListener('click', () => {
        _prospectsState.selectedCompanyId = el.dataset.prospectPick;
        renderProspects(host);
      });
    });
    if (selected) wireProspectDetail(host, selected);
    wireListCollapse(host, 'prospects');
    wireProspectModes(host);
  }

  async function refreshProspectIntelStatus(companyId) {
    const el = $('prospect-intel-status');
    if (!el) return;
    let r;
    try {
      const data = await fetchJson(`/api/knowledge/research/${encodeURIComponent(companyId)}`);
      r = data.research;
    } catch (err) {
      el.innerHTML = `<span class="kb-subtle">Couldn't load research status: ${escapeHtml(err.message)}</span>`;
      return;
    }
    if (!r) {
      el.innerHTML = `<span class="kb-subtle">No research yet — click "Run / refresh research" to start.</span>`;
      return;
    }
    _prospectResearch = r;
    const auto   = (r.sources || []).filter((s) => !s.addedManually).length;
    const statusBadge = r.status === 'RUNNING' ? '<span class="lib-badge lib-badge-running">researching</span>'
                     : r.status === 'FAILED'  ? `<span class="lib-badge lib-badge-failed">⚠︎ failed</span>`
                     : `<span class="lib-badge lib-badge-done">${escapeHtml(fmtDate(r.updated_at || r.created_at))}</span>`;
    el.innerHTML = `
      ${statusBadge}
      &nbsp;·&nbsp; ${auto} web source${auto === 1 ? '' : 's'} scanned
      ${r.summary ? `<div class="prospect-summary"><strong>Summary:</strong> ${escapeHtml(r.summary)}</div>` : ''}
      ${r.error  ? `<div style="margin-top:8px" class="kb-result error">${escapeHtml(r.error)}</div>` : ''}
    `;
    const oppsHost = $('prospect-opps');
    if (oppsHost) renderOpportunities(companyId, oppsHost, r);
    // If RUNNING, poll gently.
    if (r.status === 'RUNNING') setTimeout(() => refreshProspectIntelStatus(companyId), 6000);
  }

  // Render the opportunity cards (the "why call them" plays) — pinned first.
  function renderOpportunities(companyId, host, r) {
    const opps = (r.opportunities || []).slice().sort((a, b) => (b && b.pinned ? 1 : 0) - (a && a.pinned ? 1 : 0));
    if (!opps.length) {
      host.innerHTML = r.status === 'RUNNING'
        ? '<div class="kb-subtle" style="padding:10px 0">Researching… opportunities will appear here.</div>'
        : r.status === 'DONE'
          ? '<div class="kb-subtle" style="padding:10px 0">No opportunities surfaced. Add intel on the Intel tab, then Re-analyze.</div>'
          : '';
      return;
    }
    const strengthCls = (s) => s === 'strong' ? 'win' : s === 'weak' ? 'lose' : 'tie';
    host.innerHTML = opps.map((o, i) => `
      <div class="opp-card${o.pinned ? ' pinned' : ''}">
        <div class="opp-h">
          <span class="opp-title">${o.pinned ? '★ ' : ''}${escapeHtml(o.title || 'Opportunity')}</span>
          <span class="bc-verdict bc-verdict-${strengthCls(o.strength)} opp-strength">${escapeHtml(o.strength || '—')}</span>
        </div>
        ${o.analysis ? `<div class="opp-analysis">${escapeHtml(o.analysis)}</div>` : ''}
        ${Array.isArray(o.products) && o.products.length ? `<div class="opp-fits"><span class="kb-subtle">Fits:</span> ${o.products.map((p) => `<span class="kb-stream-pill stream-file">${escapeHtml(p)}</span>`).join(' ')}</div>` : ''}
        ${Array.isArray(o.sources) && o.sources.length ? `<div class="opp-src kb-subtle">Sources: ${o.sources.map((n) => `[${escapeHtml(String(n))}]`).join(' ')}</div>` : ''}
        <div class="opp-actions">
          <button type="button" class="kb-secondary-btn opp-brief" data-i="${i}">Brief an engagement</button>
          <button type="button" class="kb-link-btn opp-pin" data-i="${i}">${o.pinned ? '★ Unpin' : '☆ Pin'}</button>
        </div>
      </div>`).join('');
    host.querySelectorAll('.opp-brief').forEach((b) => b.addEventListener('click', () => briefMissionFromOpportunity(companyId, opps[Number(b.dataset.i)])));
    host.querySelectorAll('.opp-pin').forEach((b) => b.addEventListener('click', async () => {
      const o = opps[Number(b.dataset.i)];
      b.disabled = true;
      try {
        await fetchJson(`/api/knowledge/research/${encodeURIComponent(companyId)}/opportunity`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: o.title, pinned: !o.pinned }),
        });
        await refreshProspectIntelStatus(companyId);
      } catch (err) { alert(`Couldn't pin: ${err.message}`); b.disabled = false; }
    }));
  }

  // "Brief a mission" — prefill the missions scheduler with this prospect + the
  // opportunity's mapped products, then jump to the missions page.
  async function briefMissionFromOpportunity(companyId, opp) {
    const company = (_prospectsState.companies || []).find((c) => c.id === companyId) || {};
    let productIds = [];
    try {
      const r = await fetchJson('/api/portfolio/products');
      const byName = new Map((r.products || []).map((p) => [String(p.name).toLowerCase(), p.id]));
      productIds = (opp.products || []).map((nm) => byName.get(String(nm).toLowerCase())).filter(Boolean);
    } catch { /* best-effort */ }
    window._prefillMission = {
      companyName: company.name || '',
      companyDomain: company.domain || '',
      productIds,
      note: opp.title ? `Angle: ${opp.title}` : '',
    };
    window.location.hash = '#missions';
  }

  // Download the current research (summary + opportunities) as markdown.
  // Download arbitrary markdown as a Word .docx via the server export endpoint.
  async function downloadDocx(filename, markdown, opts) {
    try {
      const r = await fetch('/api/export/docx', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ filename: filename, markdown: markdown }, opts || {})),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { alert("Couldn't generate the Word document: " + e.message); }
  }

  function downloadProspectResearch(company) {
    const r = _prospectResearch;
    if (!r) { alert('Run research first.'); return; }
    const safe = (s) => String(s == null ? '' : s).replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '/').trim();
    const opps = r.opportunities || [];
    const L = [];
    if (r.summary) L.push(`**Summary:** ${r.summary}`, '');
    if (opps.length) {
      L.push('## Opportunities at a glance', '', '| # | Opportunity | Strength | Fit |', '| --- | --- | --- | --- |');
      opps.forEach((o, i) => L.push(`| ${i + 1} | ${safe(o.title || 'Opportunity')} | ${safe(o.strength || '—')} | ${safe((o.products || []).join(', '))} |`));
      L.push('', '## Details');
      opps.forEach((o, i) => {
        L.push(`### ${i + 1}. ${o.title || 'Opportunity'}${o.strength ? ` (${o.strength})` : ''}`);
        if (o.analysis) L.push(o.analysis);
        if (Array.isArray(o.products) && o.products.length) L.push(`**Fits:** ${o.products.join(', ')}`);
        L.push('');
      });
    }
    const slug = String(company.name || 'prospect').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    downloadDocx(`research-${slug}.docx`, L.join('\n'), { title: `Research — ${company.name}`, docType: 'Prospect research', footerNote: 'Generated by DealScope · grounded in your knowledge base' });
  }

  // ── Prospect creation modes (Manual · From CRM · Discover online) ─────────
  function wireProspectModes(host) {
    host.querySelectorAll('[data-pmode]').forEach((b) => b.addEventListener('click', () => {
      _prospectMode = b.dataset.pmode;
      host.querySelectorAll('[data-pmode]').forEach((x) => x.classList.toggle('active', x.dataset.pmode === _prospectMode));
      renderProspectModePanel();
    }));
    renderProspectModePanel();
  }

  function renderProspectModePanel() {
    const panel = $('prospect-mode-panel');
    if (!panel) return;
    if (_prospectMode === 'crm') renderProspectCrmMode(panel);
    else if (_prospectMode === 'discover') renderProspectDiscoverMode(panel);
    else renderProspectManualMode(panel);
  }

  function renderProspectManualMode(panel) {
    panel.innerHTML = `
      <div class="prospect-quick-h"><strong>Add a prospect</strong> — paste a name + website and we'll build a sales-angled dossier in ~60s.</div>
      <div class="prospect-quick-row">
        <input id="prospect-quick-name"   type="text" placeholder="Company name (e.g. Acme Corp)">
        <input id="prospect-quick-domain" type="text" placeholder="Domain (e.g. acme.com)">
        <button class="primary-cta" id="prospect-quick-run-btn">Run research</button>
      </div>
      <div class="kb-result hidden" id="prospect-quick-result"></div>`;
    wireQuickResearch(panel);
  }

  async function renderProspectCrmMode(panel) {
    panel.innerHTML = '<div class="kb-subtle">Loading your CRM connections…</div>';
    let providers = [];
    try { providers = (await fetchJson('/api/crm/providers')).providers || []; } catch { providers = []; }
    const connected = providers.filter((p) => p.connection && p.connection.connected);
    if (!connected.length) {
      panel.innerHTML = `
        <div class="prospect-quick-h"><strong>Pull prospects from your CRM</strong></div>
        <div class="kb-subtle">No CRM connected yet. <a href="#integrations">Connect a CRM on the Integrations page</a> (HubSpot is live today), then come back here to pull your companies + contacts in.</div>`;
      return;
    }
    panel.innerHTML = `
      <div class="prospect-quick-h"><strong>Pull prospects from your CRM</strong></div>
      <div class="crm-pull-list">${connected.map((p) => `
        <div class="crm-pull-row">
          <span>${escapeHtml(p.label)}${p.connection.lastSyncAt ? ` <span class="kb-subtle">· last pull ${escapeHtml(fmtDate(p.connection.lastSyncAt))}</span>` : ''}</span>
          <button class="primary-cta" data-crm-import="${escapeHtml(p.id)}">Pull prospects</button>
          <span class="kb-result hidden" id="crm-result-${escapeHtml(p.id)}"></span>
        </div>`).join('')}</div>
      <div class="kb-subtle" style="margin-top:8px">Manage connections on <a href="#integrations">Integrations</a>.</div>`;
    panel.querySelectorAll('[data-crm-import]').forEach((b) => b.addEventListener('click', async () => {
      await crmImport(b.dataset.crmImport, b);
      loaded.prospects = false;
      await loadProspects(); // refresh the list with the pulled prospects (stays on CRM mode)
    }));
  }

  const PROSPECT_PRIO = { 5: 'Critical', 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Watch' };
  function prioLabel(l) { return PROSPECT_PRIO[l] || 'Medium'; }

  // ── Discovery result persistence ─────────────────────────────────────────
  // Keep the last prospect / competitor online-discovery results (+ the form
  // inputs that produced them) so they survive navigating away and back — and a
  // full page reload — within the browser tab. Cleared when the tab closes.
  const DISCOVERY_CACHE = { prospects: 'ds.discover.prospects', competitors: 'ds.discover.competitors' };
  function saveDiscovery(kind, data) {
    try { sessionStorage.setItem(DISCOVERY_CACHE[kind], JSON.stringify(data)); } catch { /* quota/full — non-fatal */ }
  }
  function loadDiscovery(kind) {
    try { const r = sessionStorage.getItem(DISCOVERY_CACHE[kind]); return r ? JSON.parse(r) : null; } catch { return null; }
  }
  // Mark a candidate as tracked in the persisted results (by name) so a restored
  // view shows "✓ tracked" instead of an Add button after it's been added.
  function markDiscoveryAdded(kind, name) {
    const cached = loadDiscovery(kind);
    const arr = cached && cached[kind];
    if (!Array.isArray(arr)) return;
    const m = arr.find((x) => x && x.name === name);
    if (m && !m.exists) { m.exists = true; saveDiscovery(kind, cached); }
  }
  // Restore a saved region/country/city tuple, honouring the region→country
  // dependency (wireRegionCountry repopulates country options per region).
  function restoreRegionCountryCity(f, regionId, countryId, cityId) {
    const r = $(regionId), c = $(countryId), city = cityId ? $(cityId) : null;
    if (r && f.region != null) { r.value = f.region; if (typeof r.onchange === 'function') r.onchange(); }
    if (c && f.country != null) c.value = f.country;
    if (city && f.city != null) city.value = f.city;
  }

  async function renderProspectDiscoverMode(panel) {
    panel.innerHTML = `
      <div class="prospect-quick-h"><strong>Discover prospects online</strong> — we find the businesses you sell to (your ideal customer profile) showing a buying signal, rank them, and show why. Set your "who you sell to" on the Company page for best results.</div>
      <div class="prospect-discover-form">
        <label class="comp-finder-field">Region
          <select id="pdisc-region">${COMPETITOR_REGIONS.map((r) => `<option>${escapeHtml(r)}</option>`).join('')}</select>
        </label>
        <label class="comp-finder-field">Country <span class="kb-subtle">(optional)</span>
          <select id="pdisc-country">${countryOptions()}</select>
        </label>
        <label class="comp-finder-field">City <span class="kb-subtle">(optional)</span>
          <input id="pdisc-city" type="text" placeholder="e.g. Houston">
        </label>
        <label class="comp-finder-field">Target customer segment
          <select id="pdisc-industry" title="The businesses you sell TO (e.g. bars, clubs, restaurants) — not your own industry"><option value="">Any segment</option></select>
        </label>
        <label class="comp-finder-field">How many <span class="kb-subtle">(max 100)</span>
          <input id="pdisc-limit" type="number" min="1" max="100" step="1" value="30" title="How many prospects to return this search, ranked by priority (max 100 per search).">
        </label>
        <button type="button" class="primary-cta" id="pdisc-search">Search</button>
      </div>
      <div id="pdisc-body"></div>`;
    try {
      const { industries } = await fetchJson('/api/onboarding/industries');
      const sel = $('pdisc-industry');
      (industries || []).forEach((i) => { const o = document.createElement('option'); o.value = i; o.textContent = i; sel.appendChild(o); });
    } catch { /* dropdown stays at "Any industry" */ }
    $('pdisc-search').addEventListener('click', runProspectDiscover);
    wireRegionCountry('pdisc-region', 'pdisc-country');
    // Restore the last search (form inputs + results) so they persist across
    // navigation and reload until a new search replaces them.
    const cached = loadDiscovery('prospects');
    if (cached) {
      const f = cached.inputs || {};
      restoreRegionCountryCity(f, 'pdisc-region', 'pdisc-country', 'pdisc-city');
      if (f.limit != null && $('pdisc-limit')) $('pdisc-limit').value = f.limit;
      if (f.industry != null && $('pdisc-industry')) $('pdisc-industry').value = f.industry;
      if (cached.prospects && (cached.prospects.length || (cached.existing || []).length)) renderProspectCandidates($('pdisc-body'), cached.prospects, cached.dataHints, cached.existing || []);
    }
  }

  async function runProspectDiscover() {
    const btn = $('pdisc-search'); const body = $('pdisc-body');
    const region = $('pdisc-region').value; const industry = $('pdisc-industry').value;
    const country = ($('pdisc-country').value || '').trim();
    const city = ($('pdisc-city').value || '').trim();
    // How many to return — clamp to 1..100 (server clamps too); default 30.
    const limit = Math.max(1, Math.min(100, parseInt($('pdisc-limit').value, 10) || 30));
    const where = [city, country].filter(Boolean).join(', ') || (region && !/global|any/i.test(region) ? region : '');
    btn.disabled = true; const o = btn.textContent; btn.textContent = 'Searching…';
    body.innerHTML = `<div class="kb-subtle" style="padding:12px">Searching the web for up to ${limit} prospects${industry ? ` in ${escapeHtml(industry)}` : ''}${where ? ` · ${escapeHtml(where)}` : ''}…</div>`;
    try {
      const data = await fetchJson('/api/companies/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, industry, country, city, limit }),
      });
      const prospects = (data && data.prospects) || [];
      renderProspectCandidates(body, prospects, data && data.dataHints, (data && data.existing) || []);
      saveDiscovery('prospects', { inputs: { region, industry, country, city, limit }, prospects, existing: (data && data.existing) || [], dataHints: (data && data.dataHints) || null });
    } catch (err) {
      body.innerHTML = `<div class="kb-result error" style="margin:12px">${escapeHtml(err.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = o; }
  }

  // Location + public contact info a discovery candidate carries (any may be
  // empty). Rendered as a compact sub-line under the company name.
  function contactLines(c) {
    const loc = [c.city, c.country].filter(Boolean).join(', ');
    const bits = [];
    if (loc) bits.push(`📍 ${escapeHtml(loc)}`);
    if (c.address) bits.push(escapeHtml(c.address));
    if (c.phone) bits.push(`☎ ${escapeHtml(c.phone)}`);
    if (c.email) bits.push(`✉ <a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
    return bits.length ? `<div class="kb-subtle" style="margin-top:3px;line-height:1.5">${bits.join(' · ')}</div>` : '';
  }

  // "Already tracked" strip for discovery results — existing entities never
  // come back as candidates; they get re-analyze / update-intel affordances.
  function existingTrackedStrip(kind, existing) {
    if (!existing || !existing.length) return '';
    const rows = existing.map((e, i) => `
      <span class="disc-exist-row">
        <strong>${escapeHtml(e.name)}</strong>
        ${kind === 'prospects' ? `<button type="button" class="kb-link-btn dx-research" data-i="${i}">↻ Re-analyze</button>` : ''}
        ${e.watchEnabled ? `<button type="button" class="kb-link-btn dx-watch" data-i="${i}">⟳ Update intel</button>` : ''}
        <button type="button" class="kb-link-btn dx-view" data-i="${i}">View →</button>
      </span>`).join('');
    return `<div class="disc-existing">
      <span class="disc-exist-h">Already in your workspace (${existing.length})</span>${rows}
      <span class="disc-exist-note kb-subtle">— not shown again as candidates</span>
    </div>`;
  }
  function wireExistingTrackedStrip(body, kind, existing) {
    if (!existing || !existing.length) return;
    body.querySelectorAll('.dx-research').forEach((b) => b.addEventListener('click', async () => {
      const e = existing[Number(b.dataset.i)];
      b.disabled = true; const o = b.textContent; b.textContent = 'Starting…';
      try {
        await fetchJson(`/api/knowledge/research/${encodeURIComponent(e.id)}`, { method: 'POST' });
        _prospectsState.selectedCompanyId = e.id;
        loaded.prospects = false;
        if (currentSection === 'prospects') switchSection('prospects'); else window.location.hash = '#prospects';
      } catch (err) { b.disabled = false; b.textContent = o; alert(`Couldn't start research: ${err.message}`); }
    }));
    body.querySelectorAll('.dx-watch').forEach((b) => b.addEventListener('click', async () => {
      const e = existing[Number(b.dataset.i)];
      b.disabled = true; const o = b.textContent; b.textContent = 'Checking…';
      try {
        await fetchJson('/api/watch/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: kind === 'prospects' ? 'PROSPECT' : 'COMPETITOR', id: e.id }),
        });
        b.textContent = '✓ Checked — see Market signals';
        refreshWatchBadge();
      } catch (err) { b.disabled = false; b.textContent = o; alert(`Couldn't run Market Watch: ${err.message}`); }
    }));
    body.querySelectorAll('.dx-view').forEach((b) => b.addEventListener('click', () => {
      const e = existing[Number(b.dataset.i)];
      if (kind === 'prospects') {
        _prospectsState.selectedCompanyId = e.id;
        loaded.prospects = false;
        if (currentSection === 'prospects') switchSection('prospects'); else window.location.hash = '#prospects';
      } else {
        _competitorsState.selectedId = e.id;
        loaded.competitors = false;
        if (currentSection === 'competitors') switchSection('competitors'); else window.location.hash = '#competitors';
      }
    }));
  }

  function renderProspectCandidates(body, list, dataHints, existing) {
    if (!list.length) {
      body.innerHTML = `${dataHintBanner(dataHints)}${existingTrackedStrip('prospects', existing)}<div class="empty" style="padding:16px">No NEW prospects surfaced${existing && existing.length ? ' — everything found is already in your workspace' : ''}. Try a different region or industry.</div>`;
      wireEnrichJump(body);
      wireExistingTrackedStrip(body, 'prospects', existing);
      return;
    }
    // One row of the results table. `i` is the index into the ORIGINAL list so
    // the Add button stays correct even when the view is filtered.
    const rowHtml = (c, i) => {
      const lvl = c.priority || 3;
      const fits = (c.matchedProductNames && c.matchedProductNames.length)
        ? c.matchedProductNames.map((n) => `<span class="kb-stream-pill stream-file">${escapeHtml(n)}</span>`).join(' ')
        : '<span class="kb-subtle">—</span>';
      const sub = c.domain ? `<div class="kb-subtle"><a href="https://${escapeHtml(c.domain)}" target="_blank" rel="noopener">${escapeHtml(c.domain)}</a></div>` : '';
      return `
      <tr data-pcand="${i}">
        <td><span class="prio prio-${lvl}">${prioLabel(lvl)}</span></td>
        <td class="dt-name"><strong>${escapeHtml(c.name)}</strong>${sub}${contactLines(c)}</td>
        <td class="dt-what">${escapeHtml(c.signal || '')}${c.fitReason ? `<div class="kb-subtle">${escapeHtml(c.fitReason)}</div>` : ''}</td>
        <td class="dt-vs">${fits}</td>
        <td class="dt-act">${c.exists ? '<span class="kb-subtle">✓ tracked</span>' : `<button type="button" class="kb-secondary-btn pcand-add" data-i="${i}">＋ Add prospect</button>`}</td>
      </tr>`;
    };

    // Filter options drawn from the results: category = priority tier present,
    // product = distinct matched product names present.
    const catsPresent = [...new Set(list.map((c) => c.priority || 3))].sort((a, b) => b - a);
    const prodsPresent = [...new Set(list.flatMap((c) => c.matchedProductNames || []))].filter(Boolean).sort((a, b) => a.localeCompare(b));
    const catOptions = ['<option value="">All categories</option>'].concat(catsPresent.map((p) => `<option value="${p}">${prioLabel(p)}</option>`)).join('');
    const prodOptions = ['<option value="">All products</option>'].concat(prodsPresent.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)).join('');

    body.innerHTML = `
      ${dataHintBanner(dataHints)}
      ${existingTrackedStrip('prospects', existing)}
      <div class="prospect-result-filters" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:4px 0 8px">
        <label class="comp-finder-field" style="margin:0">Category
          <select id="pcand-filter-cat">${catOptions}</select>
        </label>
        <label class="comp-finder-field" style="margin:0">Product
          <select id="pcand-filter-prod">${prodOptions}</select>
        </label>
        <span class="kb-subtle" id="pcand-filter-count" style="padding-bottom:6px"></span>
      </div>
      <table class="comp-discover-table">
        <thead><tr><th>Priority</th><th>Company</th><th>Signal / why now</th><th>Fits (our products)</th><th></th></tr></thead>
        <tbody id="pcand-tbody"></tbody>
      </table>
      <div class="kb-subtle" style="padding:2px 0 10px">Ranked by priority — best product fit and freshest buying signal first.</div>
      <div class="kb-result hidden" id="pcand-result"></div>`;

    const tbody = $('pcand-tbody');
    const applyFilters = () => {
      const cat = $('pcand-filter-cat').value;
      const prod = $('pcand-filter-prod').value;
      const shown = [];
      list.forEach((c, i) => {
        if (cat && String(c.priority || 3) !== cat) return;
        if (prod && !(c.matchedProductNames || []).includes(prod)) return;
        shown.push(rowHtml(c, i));
      });
      tbody.innerHTML = shown.length
        ? shown.join('')
        : '<tr><td colspan="5" class="kb-subtle" style="padding:14px">No prospects match these filters.</td></tr>';
      $('pcand-filter-count').textContent = `Showing ${shown.length} of ${list.length}`;
      tbody.querySelectorAll('.pcand-add').forEach((b) => b.addEventListener('click', () => addProspectCandidate(list[Number(b.dataset.i)], b)));
    };
    $('pcand-filter-cat').addEventListener('change', applyFilters);
    $('pcand-filter-prod').addEventListener('change', applyFilters);
    applyFilters();
    wireEnrichJump(body);
    wireExistingTrackedStrip(body, 'prospects', existing);
  }

  async function addProspectCandidate(c, btn) {
    btn.disabled = true; btn.textContent = 'Adding…';
    try {
      const r = await fetchJson('/api/companies/discover/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: c.name, domain: c.domain || null, signal: c.signal || null, fitReason: c.fitReason || null,
          matchedProductNames: c.matchedProductNames || [], priority: c.priority || 3,
          country: c.country || null, city: c.city || null, address: c.address || null, phone: c.phone || null, email: c.email || null,
        }),
      });
      btn.textContent = r.signalSaved ? '✓ Added · signal saved' : '✓ Added';
      btn.classList.add('ev-added');
      markDiscoveryAdded('prospects', c.name);
      loaded.prospects = false; // list refreshes on next visit / refresh
      if (r.company && r.company.id) _prospectsState.selectedCompanyId = r.company.id;
    } catch (err) {
      if (/already exists/i.test(err.message)) { btn.textContent = '✓ Exists'; btn.classList.add('ev-added'); markDiscoveryAdded('prospects', c.name); return; }
      btn.disabled = false; btn.textContent = '＋ Add prospect';
      const rr = $('pcand-result'); if (rr) { rr.classList.remove('hidden', 'success'); rr.classList.add('error'); rr.textContent = `${c.name}: ${err.message}`; }
    }
  }

  // ── AI email composer ─────────────────────────────────────────────────────
  // Drafts an outreach email to a prospect contact (category + free-text intent),
  // then hands it to the rep's own mail client via mailto — with the prospect's
  // inbound-parse address CC'd so the send + any reply-all feed prospect intel.
  const EMAIL_CATS_FALLBACK = [
    { key: 'cold', label: 'Cold outreach' }, { key: 'followup', label: 'Follow-up' },
    { key: 'postcall', label: 'Post-call / engagement' }, { key: 'reengage', label: 'Re-engagement' },
    { key: 'meeting', label: 'Meeting request' }, { key: 'proposal', label: 'Proposal / next-steps' },
    { key: 'other', label: 'Other' },
  ];
  let _emailCatsCache = null;
  async function emailCategories() {
    if (_emailCatsCache) return _emailCatsCache;
    try { const r = await fetchJson('/api/contacts/email-categories'); _emailCatsCache = (r.categories && r.categories.length) ? r.categories : EMAIL_CATS_FALLBACK; }
    catch { _emailCatsCache = EMAIL_CATS_FALLBACK; }
    return _emailCatsCache;
  }

  async function openEmailComposer(contact, companyId) {
    let overlay = $('email-composer-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'email-composer-overlay';
      overlay.className = 'cal-picker-overlay';
      document.body.appendChild(overlay);
    }
    const cats = await emailCategories();
    const initial = (contact.name || 'contact').trim().charAt(0).toUpperCase() || '✉';
    overlay.innerHTML = `
      <div class="email-composer">
        <div class="ec-head">
          <div class="ec-head-id">
            <span class="ec-avatar">${escapeHtml(initial)}</span>
            <div>
              <div class="ec-head-title">Compose email</div>
              <div class="ec-head-sub">to ${escapeHtml(contact.name || 'contact')}${contact.role ? ` · ${escapeHtml(contact.role)}` : ''}</div>
            </div>
          </div>
          <button type="button" class="ec-close cal-picker-close" aria-label="Close">✕</button>
        </div>
        <div class="ec-to"><span class="ec-to-label">To</span><span class="ec-to-addr">${escapeHtml(contact.email || '')}</span></div>
        <div class="ec-recipients" id="ec-recipients">
          <div class="ec-recip-add">
            <span class="ec-to-label">Cc/Bcc</span>
            <select id="ec-recip-pick"><option value="">Add another contact…</option></select>
            <button type="button" class="kb-link-btn" id="ec-recip-cc" disabled>+ Cc</button>
            <button type="button" class="kb-link-btn" id="ec-recip-bcc" disabled>+ Bcc</button>
          </div>
          <div class="ec-recip-chips" id="ec-recip-chips"></div>
        </div>
        <div class="ec-body">
          <div class="ec-controls">
            <label class="ec-field ec-field-cat">Category
              <select id="ec-category">${cats.map((c) => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('')}</select>
            </label>
            <label class="ec-field ec-field-intent">What should this email reflect? <span class="ec-opt">optional</span>
              <input id="ec-instruction" type="text" placeholder="e.g. mention our new tokenization product; we already serve their competitor">
            </label>
            <button type="button" class="ec-generate" id="ec-generate"><span class="ec-spark">✦</span> Generate draft</button>
          </div>
          <div class="ec-engagement hidden" id="ec-engagement-wrap">
            <label class="ec-field">Based on touchpoint
              <select id="ec-engagement"><option value="">Most recent touchpoint (auto)</option></select>
            </label>
            <span class="ec-engagement-hint kb-subtle">Grounds the email in this past call or email thread.</span>
          </div>
          <div id="ec-draft" class="ec-draft hidden">
            <label class="ec-field">Subject
              <input id="ec-subject" type="text" class="ec-subject">
            </label>
            <label class="ec-field">Message
              <textarea id="ec-body" rows="11" class="ec-message"></textarea>
            </label>
            <div id="ec-cc-note" class="ec-cc-note"></div>
          </div>
          <div class="kb-result hidden" id="ec-result"></div>
        </div>
        <div class="ec-foot">
          <button type="button" class="kb-secondary-btn" id="ec-cancel">Close</button>
          <button type="button" class="ec-send hidden" id="ec-open">✉ Open in email app</button>
        </div>
      </div>`;
    overlay.classList.remove('hidden');
    let lastCc = null;
    const added = []; // extra recipients: { email, name, mode: 'cc' | 'bcc' }
    const close = () => overlay.classList.add('hidden');
    overlay.querySelector('.cal-picker-close').onclick = close;
    $('ec-cancel').onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    // Populate the Cc/Bcc picker with this prospect's OTHER contacts (with email).
    const pick = $('ec-recip-pick');
    const recCc = $('ec-recip-cc'); const recBcc = $('ec-recip-bcc');
    let pickerContacts = []; // available contacts (with email), minus the primary
    const updateRecBtns = () => { const has = !!pick.value; recCc.disabled = !has; recBcc.disabled = !has; };
    // Rebuild the dropdown from the available contacts that haven't been added yet,
    // so a selected email drops out of the list (and returns when its chip is removed).
    const renderPicker = () => {
      const taken = new Set(added.map((r) => r.email));
      const avail = pickerContacts.filter((c) => !taken.has(c.email));
      pick.innerHTML = avail.length
        ? '<option value="">Add another contact…</option>' + avail.map((c) =>
            `<option value="${escapeHtml(c.email)}">${escapeHtml(`${c.name || c.email}${c.role && c.role !== 'Unknown' ? ' · ' + c.role : ''}`)}</option>`).join('')
        : `<option value="">${pickerContacts.length ? 'All contacts added' : 'No other contacts'}</option>`;
      pick.disabled = !avail.length;
      updateRecBtns();
    };
    const renderChips = () => {
      $('ec-recip-chips').innerHTML = added.map((r, i) =>
        `<span class="ec-chip ec-chip-${r.mode}"><span class="ec-chip-mode">${r.mode}</span>${escapeHtml(r.name || r.email)}<button type="button" class="ec-chip-x" data-i="${i}" aria-label="remove">✕</button></span>`).join('');
      $('ec-recip-chips').querySelectorAll('.ec-chip-x').forEach((b) =>
        b.addEventListener('click', () => { added.splice(Number(b.dataset.i), 1); renderChips(); renderPicker(); }));
    };
    const addRecip = (mode) => {
      const email = pick.value; if (!email || email === contact.email || added.some((r) => r.email === email)) return;
      const c = pickerContacts.find((x) => x.email === email);
      added.push({ email, name: (c && c.name) || '', mode });
      renderChips(); renderPicker();
    };
    pick.addEventListener('change', updateRecBtns);
    recCc.addEventListener('click', () => addRecip('cc'));
    recBcc.addEventListener('click', () => addRecip('bcc'));
    if (companyId) {
      fetchJson(`/api/contacts?companyId=${encodeURIComponent(companyId)}`).then((r) => {
        pickerContacts = (r.contacts || []).filter((c) => c.email && c.email !== contact.email);
        renderPicker();
      }).catch(() => { pick.disabled = true; });
    } else { pick.disabled = true; }

    // Show the past-engagement picker for follow-up / post-call, and lazy-load
    // this prospect's completed engagements the first time it's shown.
    const updateEngagementPicker = async () => {
      const wrap = $('ec-engagement-wrap'); const sel = $('ec-engagement');
      const needs = ['followup', 'postcall'].includes($('ec-category').value);
      wrap.classList.toggle('hidden', !needs);
      if (!needs || sel.dataset.loaded === '1') return;
      sel.dataset.loaded = '1';
      if (!companyId) { sel.innerHTML = '<option value="">No prospect selected</option>'; return; }
      sel.innerHTML = '<option value="">Loading…</option>';
      try {
        const r = await fetchJson(`/api/companies/${encodeURIComponent(companyId)}/engagements`);
        const engs = r.engagements || [];
        sel.innerHTML = engs.length
          ? '<option value="">Most recent touchpoint (auto)</option>' + engs.map((e) => {
              const d = e.at ? new Date(e.at).toLocaleDateString() : '';
              const icon = e.type === 'EMAIL' ? '✉' : '📞';
              const lbl = [icon, d, e.title].filter(Boolean).join(' · ');
              return `<option value="${escapeHtml(e.id)}">${escapeHtml(lbl)}</option>`;
            }).join('')
          : '<option value="">No past calls or emails found</option>';
      } catch { sel.dataset.loaded = ''; sel.innerHTML = '<option value="">Couldn’t load engagements</option>'; }
    };
    $('ec-category').addEventListener('change', updateEngagementPicker);
    updateEngagementPicker();

    $('ec-generate').onclick = async () => {
      const gen = $('ec-generate'); gen.disabled = true; const o = gen.textContent; gen.textContent = 'Drafting…';
      const res = $('ec-result'); res.className = 'kb-result'; res.classList.remove('hidden'); res.textContent = 'Writing a draft from the prospect context…';
      try {
        const engWrap = $('ec-engagement-wrap');
        const engagementId = (engWrap && !engWrap.classList.contains('hidden') && $('ec-engagement')) ? ($('ec-engagement').value || null) : null;
        const r = await fetchJson(`/api/contacts/${encodeURIComponent(contact.id)}/draft-email`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category: $('ec-category').value, instruction: $('ec-instruction').value.trim(), engagementId }),
        });
        $('ec-subject').value = r.subject || '';
        $('ec-body').value = r.body || '';
        lastCc = r.cc || null;
        $('ec-cc-note').innerHTML = r.ccCapture
          ? `<span class="ec-cc-ok">✓ captured</span> A copy goes to DealScope (CC ${escapeHtml(r.cc)}) so this email — and any reply — feeds the prospect's intel.`
          : `<span class="ec-cc-warn">!</span> Inbound capture isn’t configured, so replies won’t be auto-filed.`;
        $('ec-draft').classList.remove('hidden');
        $('ec-open').classList.remove('hidden');
        res.classList.add('hidden');
      } catch (err) {
        res.className = 'kb-result error'; res.textContent = err.message;
      } finally { gen.disabled = false; gen.textContent = o; }
    };

    $('ec-open').onclick = () => {
      // Cc = the capture address (for reply-all ingest) + any user-added Cc; Bcc = user-added Bcc.
      const ccs = [lastCc, ...added.filter((r) => r.mode === 'cc').map((r) => r.email)].filter(Boolean);
      const bccs = added.filter((r) => r.mode === 'bcc').map((r) => r.email);
      const params = [];
      if (ccs.length) params.push(`cc=${encodeURIComponent(ccs.join(','))}`);
      if (bccs.length) params.push(`bcc=${encodeURIComponent(bccs.join(','))}`);
      params.push(`subject=${encodeURIComponent($('ec-subject').value || '')}`);
      params.push(`body=${encodeURIComponent($('ec-body').value || '')}`);
      const href = `mailto:${encodeURIComponent(contact.email || '')}?${params.join('&')}`;
      // Anchor-click rather than location.href so the SPA isn't navigated away.
      const a = document.createElement('a'); a.href = href; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
    };
  }

  // Captured emails for a prospect (sent via the composer's CC + prospect replies),
  // shown on the Intel tab. Each row expands to the thread body on demand.
  async function renderProspectEmails(companyId) {
    const host = $('prospect-emails-host');
    if (!host) return;
    host.innerHTML = '';
    let emails = [];
    try { const r = await fetchJson(`/api/companies/${encodeURIComponent(companyId)}/emails`); emails = r.emails || []; }
    catch { return; }
    if (!emails.length) return; // nothing captured yet — keep the tab uncluttered
    const rows = emails.map((e) => {
      const d = e.receivedAt ? new Date(e.receivedAt).toLocaleString() : '';
      return `<div class="pemail-row">
        <div class="pemail-main">
          <span class="pemail-subject">${escapeHtml(e.subject || '(no subject)')}</span>
          <span class="pemail-meta">${escapeHtml(e.from || '')}${d ? ' · ' + escapeHtml(d) : ''}</span>
        </div>
        <button type="button" class="kb-link-btn pemail-toggle" data-id="${escapeHtml(e.id)}">View</button>
        <pre class="pemail-body hidden" data-body="${escapeHtml(e.id)}"></pre>
      </div>`;
    }).join('');
    host.innerHTML = `
      <div class="pemail-head"><span class="pemail-title">✉ Emails</span>
        <span class="kb-subtle">${emails.length} captured · sent (via CC) + replies for this prospect</span></div>
      <div class="pemail-list">${rows}</div>`;
    host.querySelectorAll('.pemail-toggle').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const body = host.querySelector(`[data-body="${id}"]`);
      if (!body) return;
      if (!body.classList.contains('hidden')) { body.classList.add('hidden'); b.textContent = 'View'; return; }
      if (body.dataset.loaded !== '1') {
        body.textContent = 'Loading…';
        try {
          const r = await fetchJson(`/api/companies/${encodeURIComponent(companyId)}/emails/${encodeURIComponent(id)}/body`);
          body.textContent = (r.text || '(empty)').replace(/^#\s*Email:.*\n+/i, '');
          body.dataset.loaded = '1';
        } catch (err) { body.textContent = err.message; }
      }
      body.classList.remove('hidden'); b.textContent = 'Hide';
    }));
  }

  function wireQuickResearch(host) {
    const btn = $('prospect-quick-run-btn');
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const result = $('prospect-quick-result');
      result.classList.add('hidden'); result.classList.remove('error', 'success');
      const name   = $('prospect-quick-name').value.trim();
      const domain = $('prospect-quick-domain').value.trim();
      if (!name) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = 'Company name is required.';
        return;
      }
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Creating prospect…';
      try {
        // Reuse-or-create on the prospect side: if the rep typed a name
        // that already exists, /companies returns 409 — we recover by
        // looking it up and using its id.
        let companyId = null;
        try {
          const r = await fetchJson('/api/companies', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, domain: domain || null }),
          });
          companyId = (r.company || r).id;
        } catch (err) {
          // Conflict path — look up by name.
          const list = await fetchJson('/api/companies');
          const match = (list.companies || []).find((c) => c.name.toLowerCase() === name.toLowerCase());
          if (!match) throw err;
          companyId = match.id;
        }
        btn.textContent = 'Starting research…';
        await fetchJson(`/api/knowledge/research/${encodeURIComponent(companyId)}`, { method: 'POST' });
        // Land on the new prospect.
        _prospectsState.selectedCompanyId = companyId;
        loaded.prospects = false;
        $('prospect-quick-name').value = '';
        $('prospect-quick-domain').value = '';
        await loadProspects();
        result.classList.remove('hidden'); result.classList.add('success');
        result.innerHTML = `Research started for <strong>${escapeHtml(name)}</strong>. It runs in the background (~30-60s) — refresh the page or open the prospect to watch progress.`;
      } catch (err) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = `Couldn't start: ${err.message}`;
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  }

  // ── Proposal recommendation (Phase 1) ──────────────────────────────────
  const REC_BLOCKS = [
    { k: 'situation',   ico: '📍', label: 'Their situation' },
    { k: 'positioning', ico: '🎯', label: 'Recommended positioning' },
    { k: 'outcomes',    ico: '📈', label: 'Outcomes to emphasize' },
    { k: 'edge',        ico: '⚔️', label: 'Our edge vs alternatives' },
    { k: 'proof',       ico: '🏆', label: 'Proof points' },
  ];
  const _recConf = (c) => {
    const k = String(c || '').toLowerCase();
    const cls = k === 'high' ? 'hi' : k === 'low' ? 'lo' : 'mid';
    return `<span class="rec-conf rec-conf-${cls}" title="Confidence this section is grounded in evidence"><i></i>${escapeHtml(k || '—')}</span>`;
  };
  const _recCites = (arr) => (Array.isArray(arr) && arr.length)
    ? `<div class="rec-cites">Sources ${arr.map((n) => `<span class="rec-cite">${escapeHtml(String(n))}</span>`).join('')}</div>` : '';
  const _recAssume = (arr) => (Array.isArray(arr) && arr.length)
    ? `<div class="rec-assume"><span class="rec-assume-h">⚠︎ Assumptions</span>${arr.map((a) => escapeHtml(a)).join(' · ')}</div>` : '';
  function _recBlock(ico, label, sec) {
    if (!sec || !sec.text) return '';
    return `<section class="rec-block">
      <div class="rec-block-h"><span class="rec-ico">${ico}</span><h4>${escapeHtml(label)}</h4>${_recConf(sec.confidence)}</div>
      <div class="rec-body-text">${escapeHtml(sec.text)}</div>
      ${_recCites(sec.citations)}
      ${_recAssume(sec.assumptions)}
    </section>`;
  }

  function renderRecommendationVersion(host, prop) {
    const c = prop.content_json || {};
    const cov = prop.coverage_json || {};
    const ev = Array.isArray(prop.citations_json) ? prop.citations_json : [];
    const objections = Array.isArray(c.objections) ? c.objections : [];
    const gaps = Array.isArray(cov.gaps) ? cov.gaps : (Array.isArray(c.intelligenceGaps) ? c.intelligenceGaps : []);
    const score = (cov.score != null) ? cov.score : null;
    const covCls = score == null ? 'mid' : score >= 75 ? 'hi' : score >= 45 ? 'mid' : 'lo';
    const head = c.headline || {};
    host.innerHTML = `
      <article class="rec-doc">
        <header class="rec-top">
          <div class="rec-top-main">
            <div class="rec-eyebrow">Recommendation · v${escapeHtml(String(prop.version))}<span class="rec-status rec-status-${prop.status === 'FINAL' ? 'final' : 'draft'}">${escapeHtml(prop.status || 'DRAFT')}</span></div>
            ${head.text ? `<h3 class="rec-headline">${escapeHtml(head.text)}</h3>` : ''}
            ${_recCites(head.citations)}
          </div>
          <div class="rec-cov rec-cov-${covCls}">
            <div class="rec-cov-num">${score == null ? '—' : escapeHtml(String(score)) + '<small>%</small>'}</div>
            <div class="rec-cov-track"><span style="width:${score == null ? 0 : score}%"></span></div>
            <div class="rec-cov-cap">intel coverage</div>
          </div>
        </header>
        <div class="rec-blocks">
          ${REC_BLOCKS.map((b) => _recBlock(b.ico, b.label, c[b.k])).join('')}
          ${objections.length ? `<section class="rec-block">
            <div class="rec-block-h"><span class="rec-ico">🛡️</span><h4>Objections to preempt</h4></div>
            <div class="rec-objs">${objections.map((o) => `<div class="rec-obj">
              <div class="rec-obj-q">${escapeHtml(o.objection || '')}</div>
              <div class="rec-obj-a">${escapeHtml(o.response || '')}</div>
              ${_recCites(o.citations)}
            </div>`).join('')}</div>
          </section>` : ''}
          ${_recBlock('➡️', 'Recommended next move', c.nextMove)}
        </div>
        ${gaps.length ? `<div class="rec-gaps"><div class="rec-gaps-h">Intelligence gaps — what would sharpen this</div><ul>${gaps.map((g) => `<li>${escapeHtml(g)}</li>`).join('')}</ul></div>` : ''}
        ${ev.length ? `<details class="rec-evidence"><summary>Evidence basis · ${ev.length} item${ev.length === 1 ? '' : 's'}</summary><ol>${ev.map((e) => `<li><span class="rec-ev-n">${escapeHtml(String(e.n))}</span><span class="kb-stream-pill ${/compet/i.test(e.type || '') ? 'stream-web' : 'stream-file'}">${escapeHtml(e.type || '')}</span> ${escapeHtml(e.label || '')}</li>`).join('')}</ol></details>` : ''}
        <div class="rec-foot">Generated ${escapeHtml(new Date(prop.created_at).toLocaleString())} · a grounded suggestion — you decide.</div>
      </article>
    `;
  }

  function wireProspectProposal(companyId) {
    const status = $('prospect-proposal-status');
    const host = $('prospect-proposal');
    const sel = $('prospect-proposal-version');
    const finalBtn = $('prospect-proposal-final-btn');
    const exportBtn = $('prospect-proposal-export-btn');
    const genBtn = $('prospect-proposal-gen-btn');
    if (!host) return;
    let versions = [];
    let current = null;

    async function loadVersion(id) {
      current = await fetchJson(`/api/proposals/version/${encodeURIComponent(id)}`);
      renderRecommendationVersion(host, current);
      finalBtn.classList.remove('hidden');
      finalBtn.textContent = current.status === 'FINAL' ? '✓ Final' : '✓ Mark final';
      finalBtn.disabled = current.status === 'FINAL';
      exportBtn.classList.remove('hidden');
    }
    if (exportBtn) exportBtn.addEventListener('click', () => {
      if (current) window.open(`/api/proposals/version/${encodeURIComponent(current.id)}/export`, '_blank');
    });
    async function refresh() {
      try {
        const r = await fetchJson(`/api/proposals/${encodeURIComponent(companyId)}`);
        versions = r.versions || [];
      } catch (err) { status.textContent = `Couldn't load: ${err.message}`; return; }
      if (!versions.length) {
        status.textContent = 'No recommendation yet — generate one from everything we know about this prospect.';
        sel.classList.add('hidden'); finalBtn.classList.add('hidden'); exportBtn.classList.add('hidden'); host.innerHTML = '';
        return;
      }
      status.textContent = '';
      sel.classList.remove('hidden');
      sel.innerHTML = versions.map((v) => `<option value="${escapeHtml(v.id)}">v${escapeHtml(String(v.version))} · ${escapeHtml(v.status)} · ${(v.coverage_json && v.coverage_json.score != null) ? escapeHtml(String(v.coverage_json.score)) + '%' : '—'}</option>`).join('');
      await loadVersion(versions[0].id);
    }
    async function loadInbox() {
      const box = $('prospect-proposal-inbox');
      if (!box) return;
      try {
        const info = await fetchJson(`/api/proposals/${encodeURIComponent(companyId)}/inbox`);
        if (!info.configured || !info.address) { box.classList.add('hidden'); return; }
        box.innerHTML = `<span class="rec-inbox-ico">✉️</span>
          <div class="rec-inbox-main"><div class="rec-inbox-t">Feed this recommendation by email</div>
          <div class="rec-inbox-sub">BCC or forward this prospect's emails to <code>${escapeHtml(info.address)}</code> — they're filed as intel and sharpen the next recommendation.</div></div>
          <button type="button" class="kb-secondary-btn" id="rec-inbox-copy">Copy</button>`;
        const cp = $('rec-inbox-copy');
        if (cp) cp.addEventListener('click', () => navigator.clipboard.writeText(info.address)
          .then(() => { cp.textContent = 'Copied'; setTimeout(() => { cp.textContent = 'Copy'; }, 1500); }).catch(() => {}));
        box.classList.remove('hidden');
      } catch { box.classList.add('hidden'); }
    }

    sel.addEventListener('change', () => loadVersion(sel.value).catch((err) => { status.textContent = `Couldn't load version: ${err.message}`; }));
    finalBtn.addEventListener('click', async () => {
      if (!current) return;
      finalBtn.disabled = true;
      try {
        await fetchJson(`/api/proposals/version/${encodeURIComponent(current.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'FINAL' }) });
        await refresh();
      } catch (err) { alert(`Couldn't update: ${err.message}`); finalBtn.disabled = false; }
    });
    genBtn.addEventListener('click', async () => {
      genBtn.disabled = true; const t0 = genBtn.textContent; genBtn.textContent = 'Generating… (~15s)';
      status.textContent = 'Consolidating intelligence and formulating a recommendation…';
      try {
        await fetchJson(`/api/proposals/${encodeURIComponent(companyId)}/generate`, { method: 'POST' });
        await refresh();
      } catch (err) { status.textContent = ''; alert(`Couldn't generate: ${err.message}`); }
      finally { genBtn.disabled = false; genBtn.textContent = t0; }
    });
    loadInbox();
    refresh();
  }

  function renderProspectDetail(c, contacts) {
    return `
      <div class="prospect-detail-h">
        <input id="prospect-name" type="text" class="prospect-name-input" value="${escapeHtml(c.name)}" maxlength="200">
        <div class="prospect-detail-actions">
          <button class="kb-secondary-btn" id="prospect-save-btn">Save</button>
          <button class="kb-secondary-btn danger" id="prospect-delete-btn">Delete prospect</button>
        </div>
      </div>
      <div class="prospect-detail-fields">
        <label>Domain<input id="prospect-domain" type="text" value="${escapeHtml(c.domain || '')}" placeholder="acme.com"></label>
        <label>Primary contact<input id="prospect-primary" type="text" value="${escapeHtml(c.primary_contact || '')}" placeholder="Jane Smith"></label>
        <label>City<input id="prospect-city" type="text" value="${escapeHtml(c.city || '')}" placeholder="Houston"></label>
        <label>Country<input id="prospect-country" type="text" value="${escapeHtml(c.country || '')}" placeholder="United States"></label>
        <label>Address<input id="prospect-address" type="text" value="${escapeHtml(c.address || '')}" placeholder="123 Main St"></label>
        <label>Phone<input id="prospect-phone" type="text" value="${escapeHtml(c.phone || '')}" placeholder="+1 …"></label>
        <label>Email<input id="prospect-email" type="text" value="${escapeHtml(c.email || '')}" placeholder="contact@acme.com"></label>
        <label>Notes<textarea id="prospect-notes" rows="2" placeholder="Anything worth remembering across engagements">${escapeHtml(c.notes || '')}</textarea></label>
      </div>

      <div id="prospect-watch-panel"></div>

      <div class="prospect-tabs">
        <button type="button" class="kb-tab active" data-prospect-tab="signals">Signals</button>
        <button type="button" class="kb-tab" data-prospect-tab="people">People (${contacts.length})</button>
        <button type="button" class="kb-tab" data-prospect-tab="intel">Intel</button>
        <button type="button" class="kb-tab" data-prospect-tab="proposal">Proposal</button>
      </div>

      <div class="prospect-tab-pane" data-prospect-pane="signals">
        <span class="kb-subtle">Why this company is worth a call right now. We scan their site, the web, and recent news, then match what we find to your products.</span>
        <div class="prospect-intel-actions">
          <button class="primary-cta" id="prospect-intel-run-btn">Research / refresh</button>
          <button class="kb-secondary-btn" id="prospect-intel-reanalyze-btn">⚙︎ Re-analyze</button>
          <button class="kb-secondary-btn" id="prospect-research-download-btn">Download</button>
        </div>
        <div class="prospect-intel-status kb-subtle" id="prospect-intel-status">Loading…</div>
        <div id="prospect-opps" class="prospect-opps"></div>
      </div>

      <div class="prospect-tab-pane hidden" data-prospect-pane="people">
        <div class="prospect-people-head" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
          <span class="kb-subtle">The people you deal with at this company. You'll pick from this list when you schedule a call or create a Teams meeting.</span>
          <button class="kb-secondary-btn" id="prospect-pull-contacts" title="Find decision-makers at this company via Apollo; we'll auto-find the website if it's missing" style="white-space:nowrap">⤓ Find contacts</button>
        </div>
        <div class="kb-result hidden" id="prospect-pull-result" style="margin:8px 0"></div>
        <div id="prospect-pull-picker" class="hidden" style="margin:8px 0"></div>
        ${contacts.length === 0
          ? '<div class="empty" style="padding:10px 0">No contacts yet. Add the first one below.</div>'
          : `<table class="prospect-contacts-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Persona link</th><th></th></tr></thead>
              <tbody>
                ${contacts.map((ct) => `
                  <tr data-contact-row="${escapeHtml(ct.id)}">
                    <td><input type="text" data-contact-field="name"  value="${escapeHtml(ct.name)}"  maxlength="200"></td>
                    <td><input type="email" data-contact-field="email" value="${escapeHtml(ct.email)}"></td>
                    <td><input type="text" data-contact-field="role"  value="${escapeHtml(ct.role)}" maxlength="100"></td>
                    <td>${ct.persona_name ? `<span class="pill pill-info">${escapeHtml(ct.persona_name)}</span>` : '<span class="kb-subtle">—</span>'}</td>
                    <td>
                      <button class="kb-link-btn" data-contact-email="${escapeHtml(ct.id)}" ${ct.email ? '' : 'disabled'} title="${ct.email ? 'Draft an email to this contact with AI' : 'Add an email address first'}">✉ Email</button>
                      <button class="kb-link-btn hidden" data-contact-save="${escapeHtml(ct.id)}" title="Save your edits to this contact">Save</button>
                      <button class="kb-link-btn danger" data-contact-delete="${escapeHtml(ct.id)}">Delete</button>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>`}
        <div class="prospect-contact-add">
          <h5 style="margin:14px 0 6px 0">Add a contact</h5>
          <div class="prospect-contact-add-row">
            <input id="prospect-new-name"  type="text"  placeholder="Name (e.g. Jane Smith)" maxlength="200">
            <input id="prospect-new-email" type="email" placeholder="Email (e.g. jane@acme.com)">
            <input id="prospect-new-role"  type="text"  placeholder="Role (e.g. CFO)" maxlength="100">
            <button class="primary-cta" id="prospect-new-add-btn">Add</button>
          </div>
          <div class="kb-result hidden" id="prospect-add-result"></div>
        </div>
      </div>

      <div class="prospect-tab-pane hidden" data-prospect-pane="intel">
        <span class="kb-subtle">Files, links, and notes you've saved about this company. They're searchable and feed both the research summary and your pre-call briefs.</span>
        <div id="prospect-emails-host" class="prospect-emails"></div>
        <div class="prospect-note-add">
          <input id="prospect-note-title" type="text" placeholder='Note title (e.g. "From their Q3 call")'>
          <textarea id="prospect-note-text" rows="3" placeholder="Paste a note — internal context, conference notes, a forwarded email…"></textarea>
          <button type="button" class="kb-secondary-btn" id="prospect-note-add-btn">＋ Add note</button>
          <div class="kb-result hidden" id="prospect-note-result"></div>
        </div>
        <div id="prospect-intel-library-host" style="margin:10px 0 8px 0"></div>
      </div>

      <div class="prospect-tab-pane hidden" data-prospect-pane="proposal">
        <span class="kb-subtle">A recommendation that pulls together everything we know — your profile, this prospect's signals, competitor intel and past calls — into how to position, which outcomes to lead with, and what objections to preempt. It's a grounded, cited suggestion; you decide. No pricing, no pipeline.</span>
        <div class="prospect-intel-actions">
          <button class="primary-cta" id="prospect-proposal-gen-btn">Generate recommendation</button>
          <select id="prospect-proposal-version" class="kb-select hidden" title="Version"></select>
          <button class="kb-secondary-btn hidden" id="prospect-proposal-export-btn">Export</button>
          <button class="kb-secondary-btn hidden" id="prospect-proposal-final-btn">✓ Mark final</button>
        </div>
        <div class="prospect-intel-status kb-subtle" id="prospect-proposal-status">Loading…</div>
        <div id="prospect-proposal-inbox" class="rec-inbox hidden"></div>
        <div id="prospect-proposal" class="prospect-proposal"></div>
      </div>
    `;
  }

  function wireProspectDetail(host, company) {
    mountWatchPanel('prospect-watch-panel', 'PROSPECT', company, () => { loaded.prospects = false; });
    $('prospect-save-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await fetchJson(`/api/companies/${encodeURIComponent(company.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name:           $('prospect-name').value.trim(),
            domain:         $('prospect-domain').value.trim() || null,
            primaryContact: $('prospect-primary').value.trim() || null,
            city:           $('prospect-city').value.trim() || null,
            country:        $('prospect-country').value.trim() || null,
            address:        $('prospect-address').value.trim() || null,
            phone:          $('prospect-phone').value.trim() || null,
            email:          $('prospect-email').value.trim() || null,
            notes:          $('prospect-notes').value.trim() || null,
          }),
        });
        loaded.prospects = false;
        await loadProspects();
      } catch (err) { alert(`Couldn't save: ${err.message}`); }
      finally { btn.disabled = false; btn.textContent = 'Save'; }
    });
    $('prospect-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete "${company.name}" and all its contacts? This does NOT delete past engagements linked to this prospect.`)) return;
      try {
        await fetchJson(`/api/companies/${encodeURIComponent(company.id)}`, { method: 'DELETE' });
        _prospectsState.selectedCompanyId = null;
        loaded.prospects = false;
        await loadProspects();
      } catch (err) { alert(`Couldn't delete: ${err.message}`); }
    });

    host.querySelectorAll('[data-contact-save]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.dataset.contactSave;
        const row = host.querySelector(`[data-contact-row="${id}"]`);
        const patch = {};
        row.querySelectorAll('[data-contact-field]').forEach((el) => { patch[el.dataset.contactField] = el.value; });
        b.disabled = true; b.textContent = 'Saving…';
        try {
          await fetchJson(`/api/contacts/${encodeURIComponent(id)}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
          });
          loaded.prospects = false;
          await loadProspects();
        } catch (err) { alert(`Couldn't save: ${err.message}`); b.disabled = false; b.textContent = 'Save'; }
      }));
    host.querySelectorAll('[data-contact-delete]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.dataset.contactDelete;
        if (!confirm('Delete this contact?')) return;
        try {
          await fetchJson(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
          loaded.prospects = false;
          await loadProspects();
        } catch (err) { alert(`Couldn't delete: ${err.message}`); }
      }));
    host.querySelectorAll('[data-contact-email]').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.contactEmail;
        const row = host.querySelector(`[data-contact-row="${id}"]`);
        const field = (f) => { const el = row && row.querySelector(`[data-contact-field="${f}"]`); return el ? el.value.trim() : ''; };
        openEmailComposer({ id, name: field('name'), email: field('email'), role: field('role') }, _prospectsState.selectedCompanyId);
      }));
    // Save only appears once a row is actually edited — keeps the row uncluttered.
    host.querySelectorAll('[data-contact-row]').forEach((row) => {
      const save = row.querySelector('[data-contact-save]');
      if (!save) return;
      row.querySelectorAll('[data-contact-field]').forEach((el) =>
        el.addEventListener('input', () => save.classList.remove('hidden')));
    });

    // ── Tabs (Signals / People / Intel / Proposal) ──
    host.querySelectorAll('[data-prospect-tab]').forEach((t) => t.addEventListener('click', () => {
      host.querySelectorAll('[data-prospect-tab]').forEach((x) => x.classList.toggle('active', x === t));
      host.querySelectorAll('[data-prospect-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.prospectPane !== t.dataset.prospectTab));
    }));

    // ── Proposal: intelligence-driven recommendation ──
    wireProspectProposal(company.id);

    // ── Intel Library (the unified, retrievable store) ──
    const intelHost = $('prospect-intel-library-host');
    const reloadIntel = () => { if (intelHost) renderIntelLibrary({ container: intelHost, scope: 'PROSPECT', companyId: company.id, onChange: () => { loaded.prospects = false; } }); };
    reloadIntel();
    renderProspectEmails(company.id);

    // ── Signals: research run / re-analyze / download ──
    refreshProspectIntelStatus(company.id);
    $('prospect-intel-run-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Starting…';
      try {
        await fetchJson(`/api/knowledge/research/${encodeURIComponent(company.id)}`, { method: 'POST' });
        setTimeout(() => refreshProspectIntelStatus(company.id), 1000);
      } catch (err) { alert(`Couldn't start: ${err.message}`); }
      finally { btn.disabled = false; btn.textContent = 'Research / refresh'; }
    });
    $('prospect-intel-reanalyze-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Re-analyzing…';
      try {
        await fetchJson(`/api/knowledge/research/${encodeURIComponent(company.id)}/reanalyze`, { method: 'POST' });
        await refreshProspectIntelStatus(company.id);
      } catch (err) { alert(`Couldn't re-analyze: ${err.message}`); }
      finally { btn.disabled = false; btn.textContent = '⚙︎ Re-analyze'; }
    });
    const dlBtn = $('prospect-research-download-btn');
    if (dlBtn) dlBtn.addEventListener('click', () => downloadProspectResearch(company));

    // One-shot: arrived from the "pull intelligence" prompt after a new
    // prospect's engagement completed → jump to Signals + start research.
    if (window._pendingIntelPull && window._pendingIntelPull === company.id) {
      window._pendingIntelPull = null;
      const signalsTab = host.querySelector('[data-prospect-tab="signals"]');
      if (signalsTab) signalsTab.click();
      const runBtn = $('prospect-intel-run-btn');
      if (runBtn) runBtn.click();
    }

    // ── Intel: add a note → filed as a retrievable prospect doc (unified store) ──
    const noteBtn = $('prospect-note-add-btn');
    if (noteBtn) noteBtn.addEventListener('click', async () => {
      const title = $('prospect-note-title').value.trim();
      const text = $('prospect-note-text').value;
      const result = $('prospect-note-result');
      if (result) { result.classList.add('hidden'); result.classList.remove('error', 'success'); }
      if (!text.trim()) { if (result) { result.classList.remove('hidden'); result.classList.add('error'); result.textContent = 'Note text is required.'; } return; }
      noteBtn.disabled = true; const o = noteBtn.textContent; noteBtn.textContent = 'Adding…';
      try {
        const md = `# ${title || 'Note'}\n\n${text}`;
        const fd = new FormData();
        fd.append('file', new Blob([md], { type: 'text/markdown' }), 'note.md');
        fd.append('scope', 'PROSPECT');
        fd.append('category', 'ORG_INTELLIGENCE');
        fd.append('companyId', company.id);
        fd.append('title', title || 'Note');
        const r = await fetch('/api/knowledge/upload', { method: 'POST', credentials: 'include', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        $('prospect-note-title').value = ''; $('prospect-note-text').value = '';
        if (result) { result.classList.remove('hidden'); result.classList.add('success'); result.textContent = 'Note filed. It feeds the pre-call brief + research re-analysis.'; }
        reloadIntel();
        loaded.prospects = false;
      } catch (err) { if (result) { result.classList.remove('hidden'); result.classList.add('error'); result.textContent = err.message; } }
      finally { noteBtn.disabled = false; noteBtn.textContent = o; }
    });

    $('prospect-new-add-btn').addEventListener('click', async () => {
      const result = $('prospect-add-result');
      result.classList.add('hidden');
      const body = {
        companyId: company.id,
        name:      $('prospect-new-name').value.trim(),
        email:     $('prospect-new-email').value.trim(),
        role:      $('prospect-new-role').value.trim() || 'Unknown',
      };
      if (!body.name || !body.email) {
        result.classList.remove('hidden'); result.classList.add('error'); result.textContent = 'Name and email are required.';
        return;
      }
      try {
        await fetchJson('/api/contacts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        loaded.prospects = false;
        await loadProspects();
      } catch (err) {
        result.classList.remove('hidden'); result.classList.add('error'); result.textContent = err.message;
      }
    });

    // Find contacts via Apollo — two stages so we don't burn reveal credits on
    // people the rep won't keep. Stage 1 (find-contacts): auto-resolve a missing
    // website + list decision-makers as teasers (no email revealed yet). The rep
    // ticks who they want; stage 2 (add-contacts) reveals+saves only those.
    const pullBtn = $('prospect-pull-contacts');
    if (pullBtn) pullBtn.addEventListener('click', async () => {
      const out = $('prospect-pull-result');
      const picker = $('prospect-pull-picker');
      picker.classList.add('hidden'); picker.innerHTML = '';
      out.className = 'kb-result'; out.classList.remove('hidden'); out.textContent = 'Searching Apollo for decision-makers…';
      pullBtn.disabled = true; const lbl = pullBtn.textContent; pullBtn.textContent = 'Finding…';
      try {
        const r = await fetchJson(`/api/companies/${encodeURIComponent(company.id)}/find-contacts`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 12 }),
        });
        const cands = (r.candidates || []).filter((c) => c.id);
        const note = r.resolvedDomain ? ` · website auto-found: <strong>${escapeHtml(r.domain)}</strong>` : '';
        if (!cands.length) {
          out.className = 'kb-result'; out.innerHTML = `No decision-makers found at <strong>${escapeHtml(r.domain || '')}</strong>${note}.`;
          if (r.resolvedDomain) { loaded.prospects = false; await loadProspects(); }
          return;
        }
        out.className = 'kb-result success';
        out.innerHTML = `Found ${cands.length} decision-maker${cands.length === 1 ? '' : 's'} at <strong>${escapeHtml(r.domain)}</strong>${note}. Tick the ones to add, then “Add selected”.`;
        const rows = cands.map((c, i) => {
          const reachable = c.hasEmail !== false;
          const who = escapeHtml(c.firstName || c.name || 'Unknown');
          const title = escapeHtml(c.title || '');
          const badge = reachable ? '<span class="kb-stream-pill stream-file" title="Email available">✉ email</span>' : '<span class="kb-subtle" title="No email on file — can\'t be added">no email</span>';
          return `<label class="apollo-cand-row" style="display:flex;align-items:center;gap:8px;padding:5px 2px;border-bottom:1px solid var(--hairline,#eee)">
            <input type="checkbox" data-apollo-id="${escapeHtml(c.id)}" ${reachable ? 'checked' : 'disabled'}>
            <span style="flex:1"><strong>${who}</strong>${title ? ` — ${title}` : ''}</span>
            ${badge}</label>`;
        }).join('');
        picker.innerHTML = `<div class="apollo-cand-list">${rows}</div>
          <div style="margin-top:8px;display:flex;gap:10px;align-items:center">
            <button class="primary-cta" id="apollo-add-selected">Add selected</button>
            <span class="kb-subtle" id="apollo-pick-count"></span>
          </div>`;
        picker.classList.remove('hidden');
        const updateCount = () => {
          const n = picker.querySelectorAll('input[data-apollo-id]:checked').length;
          $('apollo-pick-count').textContent = n ? `${n} selected` : 'none selected';
          $('apollo-add-selected').disabled = !n;
        };
        picker.querySelectorAll('input[data-apollo-id]').forEach((cb) => cb.addEventListener('change', updateCount));
        updateCount();
        $('apollo-add-selected').addEventListener('click', async () => {
          const ids = [...picker.querySelectorAll('input[data-apollo-id]:checked')].map((cb) => cb.getAttribute('data-apollo-id'));
          if (!ids.length) return;
          const addBtn = $('apollo-add-selected'); addBtn.disabled = true; addBtn.textContent = 'Adding…';
          out.className = 'kb-result'; out.textContent = `Revealing ${ids.length} contact${ids.length === 1 ? '' : 's'} + saving…`;
          try {
            const a = await fetchJson(`/api/companies/${encodeURIComponent(company.id)}/add-contacts`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids }),
            });
            const parts = [];
            if (a.created) parts.push(`${a.created} added`);
            if (a.existing) parts.push(`${a.existing} already on file`);
            if (a.failed) parts.push(`${a.failed} had no reachable email`);
            out.className = 'kb-result success'; out.textContent = `${parts.join(' · ') || 'Nothing to add'}.`;
            picker.classList.add('hidden'); picker.innerHTML = '';
            loaded.prospects = false; await loadProspects();
          } catch (err) {
            out.className = 'kb-result error'; out.textContent = err.message;
            addBtn.disabled = false; addBtn.textContent = 'Add selected';
          }
        });
      } catch (err) {
        out.className = 'kb-result error'; out.textContent = err.message;
      } finally {
        pullBtn.disabled = false; pullBtn.textContent = lbl;
      }
    });
  }

  // ── Intel Library widget — embedded inside Company / Prospect / Competitor
  // pages. Self-contained: knows its scope + entity FK, renders the doc list,
  // and provides a small File/Web ingest form. Built fresh rather than
  // refactoring the legacy KB Intel form so the entity pages don't depend on
  // the about-to-be-removed Knowledge page DOM.
  //
  // opts: {
  //   container: DOM element (e.g. a div on the Company/Prospect/Competitor page)
  //   scope:     'TENANT' | 'PROSPECT' | 'COMPETITOR'
  //   companyId: required when scope='PROSPECT'
  //   competitorId: required when scope='COMPETITOR'
  //   products:  [{id, name}] — for Company (product-line filing) and Competitor (applies-to selector)
  //   onChange:  optional callback fired after a successful ingest or delete (e.g. parent re-renders counts)
  // }
  async function renderIntelLibrary(opts) {
    const { container, scope, companyId, competitorId, products = [], competitorOfferings = [], hasMainIntel = false, onChange } = opts || {};
    if (!container) return;
    // Scope all element lookups to THIS library's container. The Intel library
    // renders in three places (Company, Prospect, Competitor) with identical
    // element ids; the global `$` (getElementById) returns the first match in
    // document order, so once a second instance is in the DOM the handlers
    // would wire onto the wrong one — e.g. the competitor "Add intel" button
    // appearing dead until a refresh dropped the other sections. `q` keeps each
    // instance wiring its own controls.
    const q = (id) => container.querySelector('#' + id);
    const queryParams = new URLSearchParams({ scope });
    if (companyId)    queryParams.set('companyId', companyId);
    if (competitorId) queryParams.set('competitorIds', competitorId);
    let docs = [];
    try {
      const r = await fetchJson(`/api/knowledge/documents?${queryParams.toString()}`);
      docs = (r.documents || r) || [];
      // For competitors, the backend filter is best-effort via the kb_document_competitors join.
      // Some legacy paths return all-scope docs; defensively filter client-side.
      docs = docs.filter((d) => {
        if (scope === 'TENANT')     return d.scope === 'TENANT';
        if (scope === 'PROSPECT')   return d.scope === 'PROSPECT' && d.company_id === companyId;
        if (scope === 'COMPETITOR') return d.scope === 'COMPETITOR' &&
          Array.isArray(d.competitor_ids) && d.competitor_ids.includes(competitorId);
        return true;
      });
    } catch (err) {
      container.innerHTML = `<div class="empty">Couldn't load intel: ${escapeHtml(err.message)}</div>`;
      return;
    }

    // Slug → display name for THEIR products, so a doc filed under an offering
    // shows the offering name (not its slug) as a pill on the card.
    const offeringNames = new Map((competitorOfferings || []).map((o) => [o.id, o.name]));
    const scopeLabel = scope === 'TENANT' ? 'workspace intel' : scope === 'PROSPECT' ? 'prospect memory' : 'battlecards';
    container.innerHTML = `
      <div class="intel-lib-h">
        <strong>${docs.length} doc${docs.length === 1 ? '' : 's'}</strong>
        <span class="kb-subtle"> · ${scopeLabel} on file</span>
        <button class="kb-secondary-btn intel-lib-add-btn" id="intel-lib-add-btn">Add intel</button>
      </div>
      <div class="intel-lib-add-pane hidden" id="intel-lib-add-pane">
        <div class="prospect-intel-add-tabs">
          <button class="kb-tab active" id="intel-lib-tab-file" data-intel-lib-tab="file">File</button>
          <button class="kb-tab" id="intel-lib-tab-web" data-intel-lib-tab="web">URL</button>
        </div>
        ${scope === 'COMPETITOR' ? `
        <div class="intel-mode-row" id="intel-lib-mode-row">
          <span class="kb-subtle">This intel is about:</span>
          <label class="kb-radio"><input type="radio" name="intel-lib-mode" value="main" checked> Main company</label>
          <label class="kb-radio${hasMainIntel ? '' : ' kb-radio-disabled'}"><input type="radio" name="intel-lib-mode" value="product"${hasMainIntel ? '' : ' disabled'}> Their product</label>
          ${hasMainIntel ? '' : '<span class="kb-subtle intel-mode-hint">Add main-company intel first to unlock per-product intel.</span>'}
        </div>
        <div class="intel-mode-product hidden" id="intel-lib-mode-product">
          ${competitorOfferings.length
            ? `<label class="kb-subtle" style="display:block">Which of their products
                 <select id="intel-lib-comp-product">${competitorOfferings.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join('')}</select>
               </label>`
            : '<span class="kb-subtle">No products yet — add one in the "Their products" panel above, then come back.</span>'}
        </div>
        ${products.length
          ? `<div class="intel-applies-row" style="margin-top:6px"><span class="kb-subtle">Relevant to our products:</span>
               <label class="kb-checkbox"><input type="checkbox" id="intel-lib-applies-all" checked> <span>All products</span></label>
               <div id="intel-lib-applies-list" class="hidden">${products.map((p) => `<label class="kb-checkbox"><input type="checkbox" data-applies-p="${escapeHtml(p.id)}"> <span>${escapeHtml(p.name)}</span></label>`).join('')}</div>
             </div>` : ''}
        ` : ''}
        <div class="intel-lib-tab-pane" id="intel-lib-pane-file">
          <input type="file" id="intel-lib-file" accept=".pdf,.md,.txt,.docx">
          ${products.length && scope === 'TENANT'
            ? `<label class="kb-subtle" style="display:block;margin-top:6px">Product line (optional)
                 <select id="intel-lib-product"><option value="">— Company-wide —</option>${products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select>
               </label>` : ''}
          <button class="kb-secondary-btn" id="intel-lib-file-submit">Upload &amp; index</button>
        </div>
        <div class="intel-lib-tab-pane hidden" id="intel-lib-pane-web">
          <input type="url" id="intel-lib-url" placeholder="https://example.com/page">
          ${products.length && scope === 'TENANT'
            ? `<label class="kb-subtle" style="display:block;margin-top:6px">Product line (optional)
                 <select id="intel-lib-url-product"><option value="">— Company-wide —</option>${products.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select>
               </label>` : ''}
          <button class="kb-secondary-btn" id="intel-lib-url-submit">Fetch &amp; index</button>
        </div>
        <div class="kb-result hidden" id="intel-lib-result"></div>
      </div>
      <div class="intel-lib-list company-intel-grid">
        ${docs.length === 0
          ? '<div class="empty" style="padding:14px">No docs on file yet — add the first one above.</div>'
          : docs.map((d) => companyIntelCard(d, { deletable: true, keyPointsAction: true, compProductName: offeringNames.get((d.metadata || {}).competitorProductId) })).join('')}
      </div>
    `;

    // Add-intel toggle
    q('intel-lib-add-btn').addEventListener('click', () => {
      q('intel-lib-add-pane').classList.toggle('hidden');
    });
    // File/URL tab switcher
    container.querySelectorAll('[data-intel-lib-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        const t = b.dataset.intelLibTab;
        container.querySelectorAll('[data-intel-lib-tab]').forEach((x) => x.classList.toggle('active', x === b));
        q('intel-lib-pane-file').classList.toggle('hidden', t !== 'file');
        q('intel-lib-pane-web').classList.toggle('hidden',  t !== 'web');
      }));
    // Competitor "applies to" toggle
    const allBox = q('intel-lib-applies-all');
    if (allBox) {
      allBox.addEventListener('change', () => {
        q('intel-lib-applies-list').classList.toggle('hidden', allBox.checked);
        if (allBox.checked) {
          container.querySelectorAll('[data-applies-p]').forEach((x) => { x.checked = false; });
        }
      });
    }

    function readAppliesIds() {
      if (!allBox || allBox.checked) return [];
      return Array.from(container.querySelectorAll('[data-applies-p]:checked')).map((x) => x.dataset.appliesP);
    }

    // Competitor intel mode: "main" (competitor-wide) vs "product" (filed under
    // one of their offerings). The product dropdown only shows in product mode.
    function currentIntelMode() {
      const checked = container.querySelector('input[name="intel-lib-mode"]:checked');
      return checked ? checked.value : 'main';
    }
    container.querySelectorAll('input[name="intel-lib-mode"]').forEach((r) =>
      r.addEventListener('change', () => {
        const pe = q('intel-lib-mode-product');
        if (pe) pe.classList.toggle('hidden', currentIntelMode() !== 'product');
      }));

    // Resolves which of THEIR products to file under: '' for main-company mode,
    // the selected offering id for product mode. Returns null (after flagging an
    // error) if product mode is chosen without an offering selected.
    function resolveCompProductId(result) {
      if (scope !== 'COMPETITOR' || currentIntelMode() !== 'product') return '';
      const cp = q('intel-lib-comp-product');
      const cpid = cp && cp.value ? cp.value : '';
      if (!cpid) {
        result.classList.remove('hidden', 'success'); result.classList.add('error');
        result.textContent = 'Pick which of their products this intel is about (or add one in "Their products" below).';
        return null;
      }
      return cpid;
    }

    // Backend requires a category on /upload and /web-sync. We hide the
    // dropdown from the UI (per ADR-equivalent decision) and infer it from
    // scope + product-line selection.
    function categoryFor(productId) {
      if (scope === 'COMPETITOR') return 'BATTLECARDS';
      if (scope === 'TENANT' && productId) return 'PRODUCT_INTEL';
      return 'ORG_INTELLIGENCE';
    }

    // File upload submit
    q('intel-lib-file-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget; const result = q('intel-lib-result');
      const file = (q('intel-lib-file').files || [])[0];
      result.classList.add('hidden'); result.classList.remove('error', 'success');
      if (!file) { result.classList.remove('hidden'); result.classList.add('error'); result.textContent = 'Pick a file first.'; return; }
      const compProductId = resolveCompProductId(result);
      if (compProductId === null) return; // product mode without a product picked
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Uploading…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('scope', scope);
        const prodSel = q('intel-lib-product');
        const productId = prodSel && prodSel.value ? prodSel.value : null;
        fd.append('category', categoryFor(productId));
        // Backend requires `title` on /upload (no filename fallback). Default
        // to the file name with the extension stripped — replicates what the
        // rep would type anyway and lets them edit later via the doc detail.
        const defaultTitle = file.name ? file.name.replace(/\.[^.]+$/, '').trim() || file.name : 'Untitled';
        fd.append('title', defaultTitle);
        if (companyId)    fd.append('companyId', companyId);
        if (competitorId) fd.append('competitorIds', competitorId);
        if (productId)    fd.append('productIds', productId);
        if (scope === 'COMPETITOR') {
          for (const pid of readAppliesIds()) fd.append('appliesToProductIds', pid);
          if (compProductId) fd.append('competitorProductId', compProductId);
        }
        const r = await fetch('/api/knowledge/upload', { method: 'POST', credentials: 'include', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        result.classList.remove('hidden'); result.classList.add('success');
        result.textContent = `Indexed — ${fmtNum(j.chunks || 0)} chunks created.`;
        if (typeof onChange === 'function') onChange();
        await renderIntelLibrary(opts); // refresh the list in place
      } catch (err) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = err.message;
      } finally { btn.disabled = false; btn.textContent = orig; }
    });

    // URL ingest submit
    q('intel-lib-url-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget; const result = q('intel-lib-result');
      const url = q('intel-lib-url').value.trim();
      result.classList.add('hidden'); result.classList.remove('error', 'success');
      if (!/^https?:\/\//i.test(url)) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = 'A valid http(s) URL is required.'; return;
      }
      const compProductId = resolveCompProductId(result);
      if (compProductId === null) return; // product mode without a product picked
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Fetching…';
      try {
        const urlProd = q('intel-lib-url-product');
        const urlProductId = urlProd && urlProd.value ? urlProd.value : null;
        const body = { url, scope, category: categoryFor(urlProductId) };
        if (companyId)    body.companyId = companyId;
        if (competitorId) body.competitorIds = [competitorId];
        if (urlProductId) body.productIds = [urlProductId];
        if (scope === 'COMPETITOR') {
          const a = readAppliesIds();
          if (a.length) body.appliesToProductIds = a;
          if (compProductId) body.competitorProductId = compProductId;
        }
        const r = await fetch('/api/knowledge/web-sync', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        result.classList.remove('hidden'); result.classList.add('success');
        result.textContent = `Indexed — ${fmtNum((j.result && j.result.chunks) || 0)} chunks created.`;
        if (typeof onChange === 'function') onChange();
        await renderIntelLibrary(opts);
      } catch (err) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = err.message;
      } finally { btn.disabled = false; btn.textContent = orig; }
    });

    // Card click → open full-view modal. Modal owns the lazy-load of the
    // full text + the action buttons (regen analysis · delete). After a
    // delete or analysis run, the modal closes and we re-render this list.
    container.querySelectorAll('[data-intel-card-open]').forEach((card) => {
      const open = () => {
        const d = docs.find((x) => x.id === card.dataset.docId);
        if (d) openIntelDocModal(d, { onChange: async () => {
          if (typeof onChange === 'function') onChange();
          await renderIntelLibrary(opts);
        }});
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  // ── Competitors (battlecard library + strengths/weaknesses) ──────────────
  // Two-pane layout mirroring Prospects: list of competitors on the left,
  // selected detail on the right. Detail card lets the rep edit name +
  // description inline. The Intel Library section that gets added in a
  // follow-up task lists every kb_document tagged with this competitor.

  let _competitorsState = { competitors: [], selectedId: null };
  const COMPETITOR_REGIONS = ['Global / Any', 'North America', 'Latin America', 'Europe', 'GCC / Middle East', 'Africa', 'Asia-Pacific'];
  // Region → its countries. The flat COUNTRIES list is derived from this, and
  // selecting a region filters the country dropdown to just that region.
  const COUNTRIES_BY_REGION = {
    'North America': ['Canada','United States'],
    'Latin America': ['Argentina','Bahamas','Barbados','Belize','Bolivia','Brazil','Chile','Colombia','Costa Rica','Cuba','Dominican Republic','Ecuador','El Salvador','Guatemala','Guyana','Haiti','Honduras','Jamaica','Mexico','Nicaragua','Panama','Paraguay','Peru','Trinidad and Tobago','Uruguay','Venezuela'],
    'Europe': ['Albania','Austria','Belarus','Belgium','Bosnia and Herzegovina','Bulgaria','Croatia','Cyprus','Czechia','Denmark','Estonia','Finland','France','Germany','Greece','Hungary','Iceland','Ireland','Italy','Latvia','Lithuania','Luxembourg','Malta','Moldova','Monaco','Montenegro','Netherlands','North Macedonia','Norway','Poland','Portugal','Romania','Serbia','Slovakia','Slovenia','Spain','Sweden','Switzerland','Ukraine','United Kingdom'],
    'GCC / Middle East': ['Bahrain','Iran','Iraq','Israel','Jordan','Kuwait','Lebanon','Oman','Qatar','Saudi Arabia','Syria','Turkey','United Arab Emirates','Yemen'],
    'Africa': ['Algeria','Angola','Benin','Botswana','Burkina Faso','Cameroon','Chad','Democratic Republic of the Congo','Egypt','Eswatini','Ethiopia','Gabon','Ghana','Guinea','Ivory Coast','Kenya','Libya','Madagascar','Malawi','Mali','Mauritius','Morocco','Mozambique','Namibia','Niger','Nigeria','Rwanda','Senegal','Sierra Leone','Somalia','South Africa','Sudan','Tanzania','Togo','Tunisia','Uganda','Zambia','Zimbabwe'],
    'Asia-Pacific': ['Afghanistan','Armenia','Australia','Azerbaijan','Bangladesh','Bhutan','Brunei','Cambodia','China','Fiji','Georgia','Hong Kong','India','Indonesia','Japan','Kazakhstan','Kyrgyzstan','Laos','Malaysia','Maldives','Mongolia','Myanmar','Nepal','New Zealand','Pakistan','Papua New Guinea','Philippines','Singapore','South Korea','Sri Lanka','Taiwan','Tajikistan','Thailand','Turkmenistan','Uzbekistan','Vietnam'],
  };
  const COUNTRIES = Object.values(COUNTRIES_BY_REGION).flat().sort((a, b) => a.localeCompare(b));
  // Countries for a region — all countries for "Global / Any" (or unknown region).
  function countriesForRegion(region) {
    if (!region || /global|any/i.test(region)) return COUNTRIES;
    return COUNTRIES_BY_REGION[region] || COUNTRIES;
  }
  const countryOptions = (sel, region) => ['<option value="">Any country</option>']
    .concat(countriesForRegion(region).map((c) => `<option${c === sel ? ' selected' : ''}>${c}</option>`)).join('');
  // Wire a region <select> so changing it filters its country <select> to that
  // region (resetting to "Any country" if the prior pick isn't in the new region).
  function wireRegionCountry(regionId, countryId) {
    const rsel = $(regionId), csel = $(countryId);
    if (!rsel || !csel) return;
    // .onchange (not addEventListener) so re-wiring a reused element is idempotent.
    rsel.onchange = () => {
      const prev = csel.value;
      csel.innerHTML = countryOptions(prev, rsel.value);
      if (csel.value !== prev) csel.value = ''; // prior country not in this region
    };
  }
  let _finderAddedAny = false; // any competitor added in the finder modal → reload the list on close

  async function loadCompetitors() {
    const host = $('competitors-body');
    if (!host) return;
    host.innerHTML = '<div class="kb-subtle">Loading…</div>';
    try {
      const data = await fetchJson('/api/portfolio/competitors');
      _competitorsState.competitors = data.competitors || [];
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn't load competitors: ${escapeHtml(err.message)}</div>`;
      return;
    }
    if (!_competitorsState.selectedId && _competitorsState.competitors.length > 0) {
      _competitorsState.selectedId = _competitorsState.competitors[0].id;
    }
    await renderCompetitors(host);
  }

  async function renderCompetitors(host) {
    const list = _competitorsState.competitors;
    const selectedId = _competitorsState.selectedId;

    // Quick-add banner. Even when there are no competitors yet the rep needs
    // an entry point — this is also the only way to create one now that the
    // KB Intel form's "A competitor" lane is going away.
    const quickAdd = `
      <div class="prospect-quick-banner">
        <div class="prospect-quick-h"><strong>Add a competitor</strong> — name + website; we'll pull their homepage as the first company-wide intel.</div>
        <div class="prospect-quick-row" style="grid-template-columns: 0.7fr 1fr 1.5fr auto;">
          <input id="competitor-quick-id"   type="text" placeholder="ID (slug — e.g. gong)" maxlength="64">
          <input id="competitor-quick-name" type="text" placeholder="Name (e.g. Gong)">
          <input id="competitor-quick-website" type="text" placeholder="Website (e.g. gong.io)">
          <button class="primary-cta" id="competitor-quick-add-btn">Add</button>
        </div>
        <div class="kb-result hidden" id="competitor-quick-result"></div>
        <div class="prospect-quick-find">
          <button type="button" class="discover-cta" id="competitor-find-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>
            Find competitors automatically
          </button>
          <span class="kb-subtle">— we'll search the web for rivals in a region you pick.</span>
        </div>
      </div>`;

    if (list.length === 0) {
      host.innerHTML = `${quickAdd}<div class="empty"><p>No competitors yet.</p><p class="kb-subtle">Add the first one above.</p></div>`;
      wireCompetitorQuickAdd(host);
      return;
    }

    const selected = list.find((c) => c.id === selectedId);

    host.innerHTML = `
      ${quickAdd}
      <div class="prospects-grid">
        ${collapseRail}
        <div class="prospects-list">
          <div class="prospects-list-h"><span>${list.length} competitor${list.length === 1 ? '' : 's'}</span>${collapseBtn}</div>
          <div class="prospects-list-rows">
            ${list.map((c) => `
              <div class="comp-row-wrap ${c.id === selectedId ? 'active' : ''}">
                <div class="prospect-row ${c.id === selectedId ? 'active' : ''}" data-competitor-pick="${escapeHtml(c.id)}" role="button" tabindex="0">
                  <div class="prospect-row-name">${escapeHtml(c.name)}</div>
                  <div class="prospect-row-meta kb-subtle">${escapeHtml(c.id)} · ${fmtNum(c.doc_count || 0)} doc${(c.doc_count || 0) === 1 ? '' : 's'}</div>
                </div>
                <ul class="comp-subnav">
                  <li><button type="button" class="comp-subnav-link" data-comp-nav="${escapeHtml(c.id)}" data-comp-section="view">View</button></li>
                  <li><button type="button" class="comp-subnav-link" data-comp-nav="${escapeHtml(c.id)}" data-comp-section="battlecard">Matchups</button></li>
                </ul>
              </div>`).join('')}
          </div>
        </div>
        <div class="prospects-detail">
          ${selected ? renderCompetitorDetail(selected) : '<div class="kb-subtle">Pick a competitor on the left.</div>'}
        </div>
      </div>
    `;
    host.querySelectorAll('[data-competitor-pick]').forEach((el) => {
      el.addEventListener('click', () => {
        _competitorsState.selectedId = el.dataset.competitorPick;
        renderCompetitors(host);
      });
    });
    // Per-competitor sublist → jump straight to a section of that competitor's
    // detail pane. Selecting a different competitor first re-renders the detail
    // (so the target section exists), then we scroll to it.
    host.querySelectorAll('[data-comp-section]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = el.dataset.compNav;
        const section = el.dataset.compSection;
        if (_competitorsState.selectedId !== id) {
          _competitorsState.selectedId = id;
          await renderCompetitors(host);
        }
        scrollCompetitorSection(section);
      });
    });
    if (selected) wireCompetitorDetail(host, selected);
    wireListCollapse(host, 'competitors');
    wireCompetitorQuickAdd(host);
  }

  function scrollCompetitorSection(section) {
    const id = { view: 'competitor-section-view', battlecard: 'competitor-section-battlecard', intel: 'competitor-section-intel' }[section];
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('comp-section-flash');
    setTimeout(() => el.classList.remove('comp-section-flash'), 1600);
  }

  function renderCompetitorDetail(c) {
    return `
      <div class="prospect-detail-h comp-section-anchor" id="competitor-section-view">
        <input id="competitor-name" type="text" class="prospect-name-input" value="${escapeHtml(c.name)}" maxlength="200">
        <div class="prospect-detail-actions">
          <button class="kb-secondary-btn" id="competitor-save-btn">Save</button>
          <button class="kb-secondary-btn danger" id="competitor-delete-btn">Delete</button>
        </div>
      </div>
      <div class="prospect-detail-fields">
        <label>ID <span class="kb-subtle">(immutable)</span><input type="text" value="${escapeHtml(c.id)}" disabled></label>
        <label>Website<input id="competitor-website" type="text" value="${escapeHtml(c.website || '')}" placeholder="acme.com"></label>
        <label>City<input id="competitor-city" type="text" value="${escapeHtml(c.city || '')}" placeholder="Houston"></label>
        <label>Country<input id="competitor-country" type="text" value="${escapeHtml(c.country || '')}" placeholder="United States"></label>
        <label>Address<input id="competitor-address" type="text" value="${escapeHtml(c.address || '')}" placeholder="123 Main St"></label>
        <label>Phone<input id="competitor-phone" type="text" value="${escapeHtml(c.phone || '')}" placeholder="+1 …"></label>
        <label>Email<input id="competitor-email" type="text" value="${escapeHtml(c.email || '')}" placeholder="contact@acme.com"></label>
        <label>Description<textarea id="competitor-description" rows="3" placeholder="What's their pitch? Where do they win and where do they lose?">${escapeHtml(c.description || '')}</textarea></label>
      </div>

      <div id="competitor-watch-panel"></div>

      <div class="prospect-intel-panel">
        <h4 style="margin:14px 0 6px 0">Matchups</h4>
        <span class="kb-subtle">Pick a matchup — ${escapeHtml(c.name)} company-wide, or one of their products — to see its battlecard and the evidence behind it.</span>
        <div id="competitor-portfolio-host" class="comp-portfolio" style="margin:8px 0 10px 0"></div>
      </div>

      <div id="competitor-section-battlecard" class="comp-section-anchor">
        <div id="competitor-workspace-host" class="comp-workspace"></div>
      </div>
    `;
  }

  function wireCompetitorQuickAdd(host) {
    const findBtn = $('competitor-find-btn');
    if (findBtn && findBtn.dataset.wired !== '1') {
      findBtn.dataset.wired = '1';
      findBtn.addEventListener('click', openCompetitorFinderModal);
    }
    const btn = $('competitor-quick-add-btn');
    if (!btn || btn.dataset.wired === '1') return;
    btn.dataset.wired = '1';
    btn.addEventListener('click', async () => {
      const result = $('competitor-quick-result');
      result.classList.add('hidden'); result.classList.remove('error', 'success');
      const id   = $('competitor-quick-id').value.trim().toLowerCase();
      const name = $('competitor-quick-name').value.trim();
      const website = $('competitor-quick-website').value.trim();
      if (!id || !name) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = 'ID and Name are required.';
        return;
      }
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = 'ID must be slug-shaped: lowercase letters, numbers, hyphens, underscores (max 64 chars).';
        return;
      }
      btn.disabled = true; const orig = btn.textContent;
      btn.textContent = website ? 'Adding & pulling intel…' : 'Adding…';
      try {
        // manual-add creates the competitor AND, when a website is given, scrapes
        // its homepage as the first company-wide intel (unlocks per-product work).
        const r = await fetchJson('/api/portfolio/competitors/manual-add', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, website: website || null }),
        });
        _competitorsState.selectedId = (r.competitor || {}).id || id;
        loaded.competitors = false;
        $('competitor-quick-id').value = '';
        $('competitor-quick-name').value = '';
        $('competitor-quick-website').value = '';
        if (website && r.intelFiled === false) {
          result.classList.remove('hidden', 'error'); result.classList.add('success');
          result.textContent = `Added ${name}. We couldn't read that website — add intel manually on its page.`;
        }
        await loadCompetitors();
      } catch (err) {
        result.classList.remove('hidden'); result.classList.add('error');
        result.textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    });
  }

  // ── Competitor finder (auto-discover rivals of OUR company, by region) ────
  function closeCompetitorFinder() { const o = $('comp-finder-overlay'); if (o) o.classList.add('hidden'); }
  function _finderEsc(e) { if (e.key === 'Escape') finderDone(); }
  function finderDone() {
    closeCompetitorFinder();
    if (_finderAddedAny) { _finderAddedAny = false; loaded.competitors = false; loadCompetitors(); }
  }

  function openCompetitorFinderModal() {
    let overlay = $('comp-finder-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'comp-finder-overlay';
      overlay.className = 'cal-picker-overlay';
      overlay.innerHTML = `
        <div class="comp-discover-modal">
          <div class="cal-picker-h"><span class="cal-picker-title">Find competitors</span><button type="button" class="kb-link-btn cal-picker-close">✕</button></div>
          <div class="comp-finder-form">
            <label class="comp-finder-field">Region
              <select id="comp-finder-region">${COMPETITOR_REGIONS.map((r) => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}</select>
            </label>
            <label class="comp-finder-field">Country <span class="kb-subtle">(optional)</span>
              <select id="comp-finder-country">${countryOptions()}</select>
            </label>
            <label class="comp-finder-field">City <span class="kb-subtle">(optional)</span>
              <input id="comp-finder-city" type="text" placeholder="e.g. Houston">
            </label>
            <button type="button" class="primary-cta" id="comp-finder-search">Search</button>
          </div>
          <div class="comp-discover-body" id="comp-finder-body"></div>
          <div class="comp-discover-foot"><button type="button" class="kb-secondary-btn" id="comp-finder-done">Done</button></div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) finderDone(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', finderDone);
      document.addEventListener('keydown', _finderEsc);
    }
    $('comp-finder-search').onclick = runCompetitorFinderSearch;
    $('comp-finder-done').onclick = finderDone;
    wireRegionCountry('comp-finder-region', 'comp-finder-country');
    // Restore the last competitor search (inputs + results) if there is one, so
    // reopening the finder doesn't wipe what was found. Else show the prompt.
    const cached = loadDiscovery('competitors');
    if (cached && cached.competitors && cached.competitors.length) {
      restoreRegionCountryCity(cached.inputs || {}, 'comp-finder-region', 'comp-finder-country', 'comp-finder-city');
      renderCompetitorCandidates($('comp-finder-body'), cached.competitors, cached.dataHints, cached.existing || []);
    } else {
      $('comp-finder-body').innerHTML = `<div class="kb-subtle" style="padding:14px">Pick a region and hit Search. We'll find companies that compete with you, based on your own profile and products.</div>`;
    }
    overlay.classList.remove('hidden');
  }

  async function runCompetitorFinderSearch() {
    const btn = $('comp-finder-search');
    const body = $('comp-finder-body');
    const region = $('comp-finder-region').value;
    const country = ($('comp-finder-country').value || '').trim();
    const city = ($('comp-finder-city').value || '').trim();
    const where = [city, country].filter(Boolean).join(', ') || (region && !/global|any/i.test(region) ? region : '');
    btn.disabled = true; const o = btn.textContent; btn.textContent = 'Searching…';
    body.innerHTML = `<div class="kb-subtle" style="padding:14px">Searching the web for competitors${where ? ` in ${escapeHtml(where)}` : ''}…</div>`;
    try {
      const data = await fetchJson('/api/portfolio/competitors/discover', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region, country, city }),
      });
      const competitors = (data && data.competitors) || [];
      renderCompetitorCandidates(body, competitors, data && data.dataHints, (data && data.existing) || []);
      saveDiscovery('competitors', { inputs: { region, country, city }, competitors, existing: (data && data.existing) || [], dataHints: (data && data.dataHints) || null });
    } catch (err) {
      body.innerHTML = `<div class="kb-result error" style="margin:14px">${escapeHtml(err.message)}</div>`;
    } finally { btn.disabled = false; btn.textContent = o; }
  }

  const THREAT_LABELS = { 5: 'Critical', 4: 'High', 3: 'Medium', 2: 'Low', 1: 'Minimal' };
  function threatLabel(l) { return THREAT_LABELS[l] || 'Medium'; }

  // A nudge banner shown above thin discovery results (and in empty states),
  // with a one-click jump to enrich the company foundation.
  function dataHintBanner(h) {
    if (!h || !h.thin) return '';
    return `<div class="data-hint-nudge">${escapeHtml(h.message)}
      ${h.canAutoFill ? '<button type="button" class="kb-link-btn" data-enrich-jump="1">Enrich now →</button>' : ''}</div>`;
  }
  function wireEnrichJump(scope) {
    (scope || document).querySelectorAll('[data-enrich-jump]').forEach((b) =>
      b.addEventListener('click', () => { location.hash = '#company?tab=intel'; setTimeout(() => { const e = $('foundation-enrich-btn'); if (e) e.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 300); }));
  }

  function renderCompetitorCandidates(body, comps, dataHints, existing) {
    if (!comps.length) {
      body.innerHTML = `${dataHintBanner(dataHints)}${existingTrackedStrip('competitors', existing)}<div class="empty" style="padding:16px">No NEW competitors surfaced${existing && existing.length ? ' — everything found is already in your workspace' : ''}. Try a different region, or add one manually.</div>`;
      wireEnrichJump(body);
      wireExistingTrackedStrip(body, 'competitors', existing);
      return;
    }
    // Backend already orders by competing threat (highest first).
    const rows = comps.map((c, i) => {
      const lvl = c.threatLevel || 3;
      const threatens = (c.threatToProductNames && c.threatToProductNames.length)
        ? c.threatToProductNames.map((n) => `<span class="kb-stream-pill stream-file">${escapeHtml(n)}</span>`).join(' ')
        : '<span class="kb-subtle">general</span>';
      const sub = [c.website ? `<a href="https://${escapeHtml(c.website)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a>` : '', c.region ? escapeHtml(c.region) : ''].filter(Boolean).join(' · ');
      const incumbent = (c.incumbentAtProspects && c.incumbentAtProspects.length)
        ? `<div class="comp-incumbent" title="Already working with your prospect(s)">⚠ Already at: ${c.incumbentAtProspects.map((n) => escapeHtml(n)).join(', ')}</div>`
        : '';
      return `
      <tr data-cand="${i}">
        <td class="dt-name"><strong>${escapeHtml(c.name)}</strong>${sub ? `<div class="kb-subtle">${sub}</div>` : ''}${incumbent}${contactLines(c)}</td>
        <td class="dt-what">${escapeHtml(c.description || '')}</td>
        <td class="dt-their">${escapeHtml(c.theirStrength || c.whyRelevant || '')}</td>
        <td class="dt-vs">${threatens}</td>
        <td><span class="comp-threat comp-threat-${lvl}">${threatLabel(lvl)}</span></td>
        <td class="dt-act">${c.exists ? '<span class="kb-subtle">✓ tracked</span>' : `<button type="button" class="kb-secondary-btn cand-add" data-i="${i}">＋ Add</button>`}</td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      ${dataHintBanner(dataHints)}
      ${existingTrackedStrip('competitors', existing)}
      <table class="comp-discover-table">
        <thead><tr><th>Company</th><th>What they do</th><th>Their strength</th><th>Threatens (our products)</th><th>Threat</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="kb-subtle" style="padding:2px 0 12px">Ranked by competing threat — most direct first.</div>
      <div class="kb-result hidden" id="cand-result"></div>`;
    wireEnrichJump(body);
    body.querySelectorAll('.cand-add').forEach((b) => b.addEventListener('click', () => addCompetitorCandidate(comps[Number(b.dataset.i)], b)));
    wireExistingTrackedStrip(body, 'competitors', existing);
  }

  async function addCompetitorCandidate(c, btn) {
    btn.disabled = true; btn.textContent = 'Filing intel…';
    const id = slugify(c.name);
    try {
      // Creates the competitor AND files the analysis as company-wide intel —
      // which unlocks per-product intel/matchups for it.
      const r = await fetchJson('/api/portfolio/competitors/discover/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id, name: c.name, description: c.description || null,
          website: c.website || null, region: c.region || null,
          whyRelevant: c.whyRelevant || null, theirStrength: c.theirStrength || null,
          threatToProductNames: c.threatToProductNames || [], threatLevel: c.threatLevel || 3,
          country: c.country || null, city: c.city || null, address: c.address || null, phone: c.phone || null, email: c.email || null,
        }),
      });
      btn.textContent = r.intelFiled ? '✓ Added · unlocked' : '✓ Added';
      btn.classList.add('ev-added');
      markDiscoveryAdded('competitors', c.name);
      _finderAddedAny = true;
      _competitorsState.selectedId = (r.competitor || {}).id || id;
    } catch (err) {
      if (/already exists/i.test(err.message)) { btn.textContent = '✓ Exists'; btn.classList.add('ev-added'); markDiscoveryAdded('competitors', c.name); return; }
      btn.disabled = false; btn.textContent = '＋ Add';
      const rr = $('cand-result'); if (rr) { rr.classList.remove('hidden', 'success'); rr.classList.add('error'); rr.textContent = `${c.name}: ${err.message}`; }
    }
  }

  async function wireCompetitorDetail(host, competitor) {
    mountWatchPanel('competitor-watch-panel', 'COMPETITOR', competitor, () => { loaded.competitors = false; });
    // Product-centric view: reset the matchup to "company-wide vs whole
    // portfolio" whenever a competitor opens, then load the portfolio (which
    // renders the matchup node list + opens the default matchup workspace).
    _bcScope.product = '';
    _bcScope.competitorProduct = '';
    loadCompetitorPortfolio(competitor);
    $('competitor-save-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.textContent = 'Saving…';
      try {
        await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name:        $('competitor-name').value.trim(),
            description: $('competitor-description').value.trim() || null,
            website:     $('competitor-website').value.trim() || null,
            city:        $('competitor-city').value.trim() || null,
            country:     $('competitor-country').value.trim() || null,
            address:     $('competitor-address').value.trim() || null,
            phone:       $('competitor-phone').value.trim() || null,
            email:       $('competitor-email').value.trim() || null,
          }),
        });
        loaded.competitors = false;
        await loadCompetitors();
      } catch (err) { alert(`Couldn't save: ${err.message}`); }
      finally { btn.disabled = false; btn.textContent = 'Save'; }
    });
    $('competitor-delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete competitor "${competitor.name}"? Any docs tagged with it will block deletion until untagged.`)) return;
      try {
        await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}`, { method: 'DELETE' });
        _competitorsState.selectedId = null;
        loaded.competitors = false;
        await loadCompetitors();
      } catch (err) { alert(`Couldn't delete: ${err.message}`); }
    });
  }

  // ── Competitor battlecard (per-competitor synthesised view) ──────────────
  // Aggregates every kb_document tagged with this competitor + their
  // per-doc assessments + adds an AI-synthesised talk-track + objection
  // handlers + migration story. Backend lives in api/src/knowledge/
  // assessment.js#extractBattlecard; routes in portfolio.js.

  // Per-competitor battlecard scope: which of OUR products the card is for.
  // '' = company-wide (competitors.battlecard); a product id = a product-
  // scoped card (competitor_battlecards). Reset when a competitor is opened.
  // Battlecard matchup scope: '' on a side = "the whole side".
  //   product           = one of OUR product lines (or '')
  //   competitorProduct = one of THEIR offerings (or '')
  const _bcScope = { product: '', competitorProduct: '' };

  function bcScopeQuery() {
    const q = [];
    if (_bcScope.product) q.push(`product=${encodeURIComponent(_bcScope.product)}`);
    if (_bcScope.competitorProduct) q.push(`competitorProduct=${encodeURIComponent(_bcScope.competitorProduct)}`);
    return q.length ? `?${q.join('&')}` : '';
  }

  // ── Product-centric competitor view ──────────────────────────────────────
  // A competitor is a portfolio of matchups: "Company-wide" + each of their
  // products. The node list picks the THEIR side (_bcScope.competitorProduct,
  // '' = company-wide); clicking a node opens a focused workspace where you pick
  // the OUR side (_bcScope.product) and see that matchup's battlecard + evidence.
  // Add-evidence is auto-scoped to the node — no toggles or scope dropdowns.
  let _lastPortfolio = { products: [], offerings: [], byNode: new Map() };
  let _currentBattlecard = null; // the live battlecard shown in the open workspace

  // Flag the live battlecard as stale after new evidence lands.
  function markBattlecardStale() {
    const flag = $('competitor-battlecard-stale-flag');
    if (flag) flag.classList.remove('hidden');
  }

  function verdictChip(adv) {
    if (adv == null) return '<span class="kb-subtle">no card yet</span>';
    const n = Number(adv) || 0;
    const cls = n > 5 ? 'win' : n < -5 ? 'lose' : 'tie';
    const txt = n > 5 ? `we lead +${n}%` : n < -5 ? `we trail ${n}%` : `tied ${n >= 0 ? '+' : ''}${n}%`;
    return `<span class="bc-verdict bc-verdict-${cls} comp-node-verdict">${escapeHtml(txt)}</span>`;
  }

  // Fetch + shape everything the portfolio view needs: our products, their
  // offerings (+ gate), the competitor's docs grouped by their-product, and the
  // default-our-side verdict per node.
  async function fetchPortfolioData(competitor) {
    let products = [], offerings = [], hasMainIntel = false, docs = [], summary = [];
    const [pRes, oRes, dRes, sRes] = await Promise.allSettled([
      fetchJson('/api/portfolio/products'),
      fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/offerings`),
      fetchJson(`/api/knowledge/documents?scope=COMPETITOR&competitorIds=${encodeURIComponent(competitor.id)}`),
      fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecards/summary`),
    ]);
    if (pRes.status === 'fulfilled') products = pRes.value.products || [];
    if (oRes.status === 'fulfilled') { offerings = oRes.value.offerings || []; hasMainIntel = !!oRes.value.hasMainIntel; }
    if (dRes.status === 'fulfilled') {
      const all = dRes.value.documents || dRes.value || [];
      docs = all.filter((d) => d.scope === 'COMPETITOR' && Array.isArray(d.competitor_ids) && d.competitor_ids.includes(competitor.id));
    }
    if (sRes.status === 'fulfilled') summary = sRes.value.summary || [];
    const byNode = new Map();
    for (const d of docs) {
      const k = ((d.metadata || {}).competitorProductId) || '';
      if (!byNode.has(k)) byNode.set(k, []);
      byNode.get(k).push(d);
    }
    const verdictByNode = new Map();
    for (const s of summary) {
      if (s.productId == null) verdictByNode.set(s.competitorProductId || '', s.weightedAdvantage);
    }
    return { products, offerings, hasMainIntel, byNode, verdictByNode };
  }

  async function loadCompetitorPortfolio(competitor) {
    const portHost = $('competitor-portfolio-host');
    if (!portHost) return;
    portHost.innerHTML = '<div class="kb-subtle" style="padding:6px 0">Loading…</div>';
    const data = await fetchPortfolioData(competitor);
    // Drop a selected node/our-product that no longer exists.
    if (_bcScope.competitorProduct && !data.offerings.some((o) => o.id === _bcScope.competitorProduct)) _bcScope.competitorProduct = '';
    if (_bcScope.product && !data.products.some((p) => p.id === _bcScope.product)) _bcScope.product = '';
    _lastPortfolio = { products: data.products, offerings: data.offerings, byNode: data.byNode };
    renderPortfolioNodes(competitor, data);
    openMatchupWorkspace(competitor);
  }

  // Wire evidence-card clicks (open the doc modal) for a given container + docs.
  function wireEvidenceCards(container, docs, competitor) {
    container.querySelectorAll('[data-intel-card-open]').forEach((card) => {
      const open = () => {
        const d = docs.find((x) => x.id === card.dataset.docId);
        if (d) openIntelDocModal(d, { onChange: () => loadCompetitorPortfolio(competitor) });
      };
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // Refresh the evidence list + node-list counts/verdicts/gate in place, WITHOUT
  // rebuilding the workspace's add-evidence panel — so an open web-search result
  // list survives while the rep adds hits one by one.
  async function refreshEvidenceInPlace(competitor) {
    const data = await fetchPortfolioData(competitor);
    _lastPortfolio = { products: data.products, offerings: data.offerings, byNode: data.byNode };
    renderPortfolioNodes(competitor, data); // node list is a separate DOM subtree
    const node = _bcScope.competitorProduct || '';
    const list = data.byNode.get(node) || [];
    const ws = $('competitor-workspace-host');
    if (!ws) return;
    const count = ws.querySelector('.comp-evidence-count');
    if (count) count.textContent = String(list.length);
    const grid = ws.querySelector('.comp-evidence .intel-lib-list');
    if (grid) {
      const offeringNames = new Map(data.offerings.map((o) => [o.id, o.name]));
      grid.innerHTML = list.length
        ? list.map((d) => companyIntelCard(d, { deletable: true, keyPointsAction: true, compProductName: offeringNames.get((d.metadata || {}).competitorProductId) })).join('')
        : '<div class="empty" style="padding:12px">No evidence yet — add a deck, URL, or web search below.</div>';
      wireEvidenceCards(grid, list, competitor);
    }
    markBattlecardStale();
  }

  function renderPortfolioNodes(competitor, { offerings, hasMainIntel, byNode, verdictByNode }) {
    const host = $('competitor-portfolio-host');
    if (!host) return;
    const row = (id, label, opts = {}) => {
      const docs = byNode.get(id) || [];
      const unver = docs.filter((d) => (d.metadata || {}).relevanceVerified === false).length;
      const active = (_bcScope.competitorProduct || '') === id;
      const meta = opts.locked
        ? '<span class="kb-subtle">🔒 add main intel first</span>'
        : `${verdictChip(verdictByNode.has(id) ? verdictByNode.get(id) : null)} <span class="kb-subtle">· ${docs.length} doc${docs.length === 1 ? '' : 's'}</span>${unver ? ` <span class="kb-stream-pill warning">⚠ ${unver}</span>` : ''}`;
      return `<button type="button" class="comp-node${active ? ' active' : ''}${opts.locked ? ' locked' : ''}" data-node="${escapeHtml(id)}">
          <span class="comp-node-name">${escapeHtml(label)}</span>
          <span class="comp-node-meta">${meta}</span>
        </button>`;
    };
    const companyRow = row('', `${competitor.name} · Company-wide`);
    const productRows = offerings.map((o) => row(o.id, o.name, { locked: !hasMainIntel })).join('');
    const addRow = hasMainIntel
      ? `<div class="comp-node-add"><input id="comp-new-product" type="text" placeholder="Add their product (e.g. Forecast)" maxlength="200"><button class="kb-secondary-btn" id="comp-add-product-btn">＋ Add their product</button></div><div class="kb-result hidden" id="comp-add-product-result"></div>`
      : `<div class="comp-node-add-hint kb-subtle">🔒 Add Company-wide intel first to break out ${escapeHtml(competitor.name)}'s individual products.</div>`;
    const discoverRow = `<div class="comp-discover-row"><button class="kb-secondary-btn" id="comp-discover-btn">Discover their products</button><span class="kb-subtle">Don’t know their lineup? Search the web + map it against our products.</span></div>`;
    host.innerHTML = `<div class="comp-node-list">${companyRow}${productRows}</div>${addRow}${discoverRow}`;
    host.querySelectorAll('[data-node]').forEach((b) => b.addEventListener('click', () => {
      _bcScope.competitorProduct = b.dataset.node || '';
      _bcScope.product = ''; // reset our-side to whole portfolio on their-side switch
      host.querySelectorAll('[data-node]').forEach((x) => x.classList.toggle('active', x === b));
      openMatchupWorkspace(competitor);
    }));
    wireAddTheirProduct(competitor);
    const discBtn = $('comp-discover-btn');
    if (discBtn) discBtn.addEventListener('click', () => discoverCompetitorProducts(competitor, hasMainIntel));
  }

  async function discoverCompetitorProducts(competitor, hasMainIntel) {
    const btn = $('comp-discover-btn');
    const orig = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Searching the web…'; }
    try {
      const data = await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/discover-products`, { method: 'POST' });
      openDiscoveryModal(competitor, data, hasMainIntel);
    } catch (err) {
      alert(`Discovery failed: ${err.message}`);
    } finally { if (btn) { btn.disabled = false; btn.textContent = orig; } }
  }

  function closeDiscoveryModal() { const o = $('comp-discovery-overlay'); if (o) o.classList.add('hidden'); }
  function _discoveryEsc(e) { if (e.key === 'Escape') closeDiscoveryModal(); }

  function openDiscoveryModal(competitor, data, hasMainIntel) {
    const products = (data && data.products) || [];
    let overlay = $('comp-discovery-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'comp-discovery-overlay';
      overlay.className = 'cal-picker-overlay';
      overlay.innerHTML = `
        <div class="comp-discover-modal">
          <div class="cal-picker-h"><span class="cal-picker-title comp-discover-title"></span><button type="button" class="kb-link-btn cal-picker-close">✕</button></div>
          <div class="comp-discover-body"></div>
          <div class="comp-discover-foot"></div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDiscoveryModal(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', closeDiscoveryModal);
      document.addEventListener('keydown', _discoveryEsc);
    }
    overlay.querySelector('.comp-discover-title').textContent = `Discovered products · ${competitor.name}`;
    const body = overlay.querySelector('.comp-discover-body');
    const foot = overlay.querySelector('.comp-discover-foot');

    if (!products.length) {
      body.innerHTML = '<div class="empty" style="padding:16px">No products surfaced from the web. Try adding them manually, or run again later.</div>';
      foot.innerHTML = '';
      overlay.classList.remove('hidden');
      return;
    }

    const rows = products.map((p, i) => `
      <tr data-disc-row="${i}">
        <td class="dt-name"><strong>${escapeHtml(p.name)}</strong></td>
        <td class="dt-what">${escapeHtml(p.description || '')}</td>
        <td class="dt-vs">${p.competesWithProductName ? `<span class="kb-stream-pill stream-file">${escapeHtml(p.competesWithProductName)}</span>` : '<span class="kb-subtle">no direct match</span>'}</td>
        <td class="dt-their">${escapeHtml(p.theirStrength || '')}</td>
        <td class="dt-win">${escapeHtml(p.whereWeWin || '')}</td>
        <td class="dt-act">${hasMainIntel ? `<button type="button" class="kb-secondary-btn disc-add-one" data-i="${i}">＋ Add</button>` : '<span class="kb-subtle">🔒</span>'}</td>
      </tr>`).join('');
    body.innerHTML = `
      <table class="comp-discover-table">
        <thead><tr><th>Their product</th><th>What it is</th><th>Competes with (ours)</th><th>Their strength</th><th>Where we'd win</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="kb-result hidden" id="disc-result"></div>`;
    foot.innerHTML = hasMainIntel
      ? '<button type="button" class="primary-cta" id="disc-add-all">Add all as matchups</button><button type="button" class="kb-secondary-btn" id="disc-done">Done</button>'
      : '<span class="kb-subtle">🔒 Add Company-wide intel first to turn these into matchups.</span><button type="button" class="kb-secondary-btn" id="disc-done">Close</button>';

    // Build the offering description that carries the mapping + read.
    const descFor = (p) => {
      const bits = [];
      if (p.competesWithProductName) bits.push(`Competes with: ${p.competesWithProductName}.`);
      if (p.description) bits.push(p.description);
      if (p.theirStrength) bits.push(`Their strength: ${p.theirStrength}.`);
      if (p.whereWeWin) bits.push(`Where we win: ${p.whereWeWin}.`);
      return bits.join(' ').slice(0, 1000) || null;
    };
    // Add a single product as an offering. Returns true on success.
    const addOne = async (p, btn) => {
      if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
      try {
        await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/offerings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: p.name, description: descFor(p) }),
        });
        if (btn) { btn.textContent = '✓ Added'; btn.classList.add('ev-added'); }
        return true;
      } catch (err) {
        // 409 = already exists → treat as added; otherwise surface.
        if (/already exists/i.test(err.message)) { if (btn) { btn.textContent = '✓ Exists'; btn.classList.add('ev-added'); } return true; }
        if (btn) { btn.textContent = '＋ Add'; btn.disabled = false; }
        const r = $('disc-result'); if (r) { r.classList.remove('hidden', 'success'); r.classList.add('error'); r.textContent = `${p.name}: ${err.message}`; }
        return false;
      }
    };

    body.querySelectorAll('.disc-add-one').forEach((btn) => btn.addEventListener('click', async () => {
      await addOne(products[Number(btn.dataset.i)], btn);
    }));
    const addAll = $('disc-add-all');
    if (addAll) addAll.addEventListener('click', async () => {
      addAll.disabled = true; addAll.textContent = 'Adding…';
      const buttons = Array.from(body.querySelectorAll('.disc-add-one')).filter((b) => !b.classList.contains('ev-added'));
      for (const btn of buttons) { await addOne(products[Number(btn.dataset.i)], btn); }
      addAll.textContent = 'Added';
      await loadCompetitorPortfolio(competitor);
    });
    const done = $('disc-done');
    if (done) done.addEventListener('click', async () => { closeDiscoveryModal(); await loadCompetitorPortfolio(competitor); });

    overlay.classList.remove('hidden');
  }

  function openMatchupWorkspace(competitor) {
    const host = $('competitor-workspace-host');
    if (!host) return;
    const { products, offerings, byNode } = _lastPortfolio;
    const node = _bcScope.competitorProduct || '';
    const offering = node ? offerings.find((o) => o.id === node) : null;
    const theirLabel = node ? (offering ? offering.name : node) : `${competitor.name} · Company-wide`;
    const ourOpts = ['<option value="">Our whole portfolio</option>']
      .concat(products.map((p) => `<option value="${escapeHtml(p.id)}"${_bcScope.product === p.id ? ' selected' : ''}>${escapeHtml(p.name)}</option>`)).join('');
    const docs = byNode.get(node) || [];
    const offeringNames = new Map(offerings.map((o) => [o.id, o.name]));
    const evidenceCards = docs.length
      ? docs.map((d) => companyIntelCard(d, { deletable: true, keyPointsAction: true, compProductName: offeringNames.get((d.metadata || {}).competitorProductId) })).join('')
      : '<div class="empty" style="padding:12px">No evidence yet — add a deck, URL, or web search below.</div>';
    host.innerHTML = `
      <div class="comp-matchup-h">
        <span class="comp-matchup-their">${escapeHtml(theirLabel)}</span>
        <span class="comp-matchup-x">vs</span>
        <select id="comp-our-select" class="comp-our-select">${ourOpts}</select>
        ${node ? '<button type="button" class="kb-link-btn comp-remove-product" id="comp-remove-product-btn" title="Remove this product (its evidence is kept, moved to Company-wide)">✕ Remove product</button>' : ''}
      </div>
      <div id="competitor-battlecard-host" class="competitor-battlecard-host"></div>
      <div class="comp-evidence">
        <div class="comp-evidence-h">Evidence <span class="comp-evidence-count">${docs.length}</span></div>
        <div id="comp-evidence-add"></div>
        <div class="intel-lib-list company-intel-grid">${evidenceCards}</div>
      </div>`;
    const ourSel = $('comp-our-select');
    if (ourSel) ourSel.addEventListener('change', () => { _bcScope.product = ourSel.value; loadCompetitorBattlecard(competitor); });
    const rm = $('comp-remove-product-btn');
    if (rm) rm.addEventListener('click', async () => {
      if (!confirm(`Remove "${theirLabel}"?\n\nIts product-vs-product battlecards are deleted, but its filed evidence is KEPT and moved to ${competitor.name}'s Company-wide intel.`)) return;
      rm.disabled = true;
      try {
        const res = await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/offerings/${encodeURIComponent(node)}`, { method: 'DELETE' });
        _bcScope.competitorProduct = ''; _bcScope.product = ''; // back to Company-wide
        await loadCompetitorPortfolio(competitor);
        if (res && res.movedDocs) {
          const r2 = $('comp-add-product-result');
          if (r2) { r2.classList.remove('hidden', 'error'); r2.classList.add('warning'); r2.textContent = `Removed — ${res.movedDocs} evidence doc${res.movedDocs === 1 ? '' : 's'} moved to Company-wide.`; }
        }
      } catch (err) { alert(`Couldn't remove: ${err.message}`); rm.disabled = false; }
    });
    loadCompetitorBattlecard(competitor);
    wireEvidenceCards(host, docs, competitor);
    wireAddEvidence(competitor, node, $('comp-evidence-add'));
  }

  // One unified add-evidence panel (file · URL · web search), auto-scoped to the
  // node: company-wide (node='') files main intel; a product node tags that
  // offering. Replaces both the old per-offering tabs and the intel-library form.
  function wireAddEvidence(competitor, node, host) {
    if (!host) return;
    const compProductId = node || null;
    const theirName = node ? ((_lastPortfolio.offerings.find((o) => o.id === node) || {}).name || node) : '';
    const searchLabel = node ? `${competitor.name} ${theirName}` : competitor.name;
    host.innerHTML = `
      <div class="comp-add-ev">
        <div class="off-intel-tabs">
          <button type="button" class="kb-tab active" data-ev-tab="file">Deck</button>
          <button type="button" class="kb-tab" data-ev-tab="url">URL</button>
          <button type="button" class="kb-tab" data-ev-tab="web">Web search</button>
        </div>
        <div class="off-intel-pane" data-ev-pane="file">
          <input type="file" class="ev-file" accept=".pdf,.md,.txt,.docx">
          <button type="button" class="kb-secondary-btn ev-file-btn">Upload</button>
        </div>
        <div class="off-intel-pane hidden" data-ev-pane="url">
          <input type="url" class="ev-url" placeholder="https://competitor.com/...">
          <button type="button" class="kb-secondary-btn ev-url-btn">Fetch &amp; index</button>
        </div>
        <div class="off-intel-pane hidden" data-ev-pane="web">
          <span class="kb-subtle">Search the web for "${escapeHtml(searchLabel)}", then pick which results to file.</span>
          <button type="button" class="kb-secondary-btn ev-web-btn">Search the web</button>
          <div class="ev-web-results"></div>
        </div>
        <div class="kb-result hidden ev-result"></div>
      </div>`;
    const sel = (s) => host.querySelector(s);
    const result = sel('.ev-result');
    const note = (msg, ok) => { if (!result) return; result.classList.remove('hidden', 'error', 'success'); result.classList.add(ok ? 'success' : 'error'); result.textContent = msg; };
    // Land an add in the evidence list without tearing down this panel, so the
    // rep can keep adding (matches the web-search "Add to evidence" behavior).
    const afterAdd = async (msg) => { note(msg, true); await refreshEvidenceInPlace(competitor); };
    host.querySelectorAll('[data-ev-tab]').forEach((t) => t.addEventListener('click', () => {
      host.querySelectorAll('[data-ev-tab]').forEach((x) => x.classList.toggle('active', x === t));
      host.querySelectorAll('[data-ev-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.evPane !== t.dataset.evTab));
    }));

    const fileBtn = sel('.ev-file-btn');
    if (fileBtn) fileBtn.addEventListener('click', async () => {
      const file = (sel('.ev-file').files || [])[0];
      if (!file) { note('Pick a file first.', false); return; }
      fileBtn.disabled = true; const o = fileBtn.textContent; fileBtn.textContent = 'Uploading…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('scope', 'COMPETITOR');
        fd.append('category', 'BATTLECARDS');
        fd.append('competitorIds', competitor.id);
        if (compProductId) fd.append('competitorProductId', compProductId);
        fd.append('title', file.name ? (file.name.replace(/\.[^.]+$/, '').trim() || file.name) : 'Untitled');
        const r = await fetch('/api/knowledge/upload', { method: 'POST', credentials: 'include', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        sel('.ev-file').value = '';
        await afterAdd('Deck added to evidence.');
      } catch (err) { note(err.message, false); }
      finally { fileBtn.disabled = false; fileBtn.textContent = o; }
    });

    const urlBtn = sel('.ev-url-btn');
    if (urlBtn) urlBtn.addEventListener('click', async () => {
      const url = (sel('.ev-url').value || '').trim();
      if (!/^https?:\/\//i.test(url)) { note('A valid http(s) URL is required.', false); return; }
      urlBtn.disabled = true; const o = urlBtn.textContent; urlBtn.textContent = 'Fetching…';
      try {
        const body = { url, scope: 'COMPETITOR', category: 'BATTLECARDS', competitorIds: [competitor.id] };
        if (compProductId) body.competitorProductId = compProductId;
        await fetchJson('/api/knowledge/web-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        sel('.ev-url').value = '';
        await afterAdd('URL added to evidence.');
      } catch (err) { note(err.message, false); }
      finally { urlBtn.disabled = false; urlBtn.textContent = o; }
    });

    const webBtn = sel('.ev-web-btn');
    if (webBtn) webBtn.addEventListener('click', async () => {
      webBtn.disabled = true; const o = webBtn.textContent; webBtn.textContent = 'Searching…';
      const rhost = sel('.ev-web-results'); if (rhost) rhost.innerHTML = '';
      const base = compProductId
        ? `/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/offerings/${encodeURIComponent(compProductId)}/research`
        : `/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/research`;
      try {
        const data = await fetchJson(base, { method: 'POST' });
        renderCompetitorWebResults(competitor, compProductId, host, data);
      } catch (err) { note(err.message, false); }
      finally { webBtn.disabled = false; webBtn.textContent = o; }
    });
  }

  // Web-search results — each hit gets its own "Add to evidence" button that
  // scrapes + files just that URL and drops it straight into the evidence list
  // (refreshed in place, so the rest of the results stay for adding more).
  function renderCompetitorWebResults(competitor, compProductId, host, data) {
    const rhost = host.querySelector('.ev-web-results');
    if (!rhost) return;
    const results = (data && data.results) || [];
    if (!results.length) { rhost.innerHTML = '<div class="kb-subtle" style="margin-top:6px">No web results found.</div>'; return; }
    const ingBase = compProductId
      ? `/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/offerings/${encodeURIComponent(compProductId)}/research/ingest`
      : `/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/research/ingest`;
    rhost.innerHTML = `
      <ul class="off-web-list">${results.map((r) => `
        <li class="off-web-item ev-web-row">
          <span class="off-web-meta">
            <span class="off-web-title">${escapeHtml(r.title)}</span>
            <a class="off-web-url" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.url)}</a>
            ${r.description ? `<span class="kb-subtle">${escapeHtml(r.description)}</span>` : ''}
          </span>
          <button type="button" class="kb-secondary-btn ev-add-one" data-url="${escapeHtml(r.url)}">＋ Add to evidence</button>
        </li>`).join('')}</ul>`;
    rhost.querySelectorAll('.ev-add-one').forEach((btn) => btn.addEventListener('click', async () => {
      const url = btn.dataset.url;
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Adding…';
      try {
        const res = await fetchJson(ingBase, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [url] }) });
        if (res && res.ingested) {
          btn.textContent = '✓ Added to evidence';
          btn.classList.add('ev-added');
          await refreshEvidenceInPlace(competitor);
        } else {
          btn.textContent = '⚠ Couldn’t fetch — retry'; btn.disabled = false;
        }
      } catch (err) {
        btn.textContent = '⚠ Failed — retry'; btn.disabled = false;
      }
    }));
  }

  function wireAddTheirProduct(competitor) {
    const addBtn = $('comp-add-product-btn');
    if (!addBtn) return;
    addBtn.addEventListener('click', async () => {
      const input = $('comp-new-product');
      const name = input && input.value.trim();
      const result = $('comp-add-product-result');
      if (result) { result.classList.add('hidden'); result.classList.remove('error', 'warning'); }
      if (!name) return;
      addBtn.disabled = true;
      try {
        const resp = await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/offerings`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
        });
        const newId = resp && resp.offering && resp.offering.id;
        const warning = resp && resp.warning;
        if (newId) _bcScope.competitorProduct = newId; // jump into the new product
        _bcScope.product = '';
        await loadCompetitorPortfolio(competitor);
        if (warning) {
          const r2 = $('comp-add-product-result');
          if (r2) { r2.classList.remove('hidden', 'error'); r2.classList.add('warning'); r2.textContent = `Added "${name}" — heads up: ${warning}`; }
        }
      } catch (err) {
        if (result) { result.classList.remove('hidden'); result.classList.add('error'); result.textContent = err.message; }
        addBtn.disabled = false;
      }
    });
  }

  async function loadCompetitorBattlecard(competitor) {
    const host = $('competitor-battlecard-host');
    if (!host) return;
    host.innerHTML = '<div class="kb-subtle" style="padding:10px 0">Loading battlecard…</div>';
    let data;
    try {
      data = await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard${bcScopeQuery()}`);
    } catch (err) {
      host.innerHTML = `<div class="kb-result error">Couldn't load battlecard: ${escapeHtml(err.message)}</div>`;
      return;
    }
    _currentBattlecard = (data.battlecard && !data.empty) ? data.battlecard : null;
    const cardHtml = _currentBattlecard
      ? renderBattlecard(competitor, data.battlecard)
      : renderBattlecardEmpty(competitor);
    host.innerHTML = cardHtml + '<div class="bc-history" id="bc-history-host"></div>';
    wireBattlecardActions(competitor);
    loadBattlecardHistory(competitor);
  }

  function renderBattlecardEmpty(competitor) {
    return `
      <div class="bc-card bc-empty">
        <div class="bc-h">
          <h3 style="margin:0">Battlecard · ${escapeHtml(competitor.name)}</h3>
          <button class="primary-cta" id="bc-regen-btn">Generate battlecard</button>
        </div>
        <p class="kb-subtle" style="margin:8px 0 0 0">No battlecard yet. Add at least one piece of evidence below, then click "Generate battlecard" to synthesise the talk track, objection handlers, and migration story from it.</p>
        <div class="kb-result hidden" id="bc-action-result"></div>
      </div>`;
  }

  function renderBattlecard(competitor, bc, opts = {}) {
    const adv = Number(bc.weightedAdvantage) || 0;
    const verdictClass = adv > 5 ? 'win' : adv < -5 ? 'lose' : 'tie';
    const verdictLabel = adv > 5 ? `We lead by ${adv}%`
                       : adv < -5 ? `We trail by ${Math.abs(adv)}%`
                       : `Roughly tied (${adv >= 0 ? '+' : ''}${adv}%)`;
    const edited = Array.isArray(bc.editedSections) ? bc.editedSections : [];
    const editPill = (key) => edited.includes(key)
      ? '<span class="bc-edit-pill" title="You have a manual edit on this section">edited</span>' : '';
    // Read-only history view: a banner replaces the live actions, and the
    // per-section edit / regenerate controls are hidden via the modifier class.
    const ver = opts.readOnly ? opts.version : null;
    const banner = ver ? `
      <div class="bc-version-banner">
        <span>🕘 Viewing snapshot from <strong>${escapeHtml(fmtDate(ver.generatedAt))}</strong>${ver.current ? ' · this is the current version' : ''}</span>
        <span class="bc-version-banner-actions">
          <button class="kb-secondary-btn" id="bc-version-back">← Back to current</button>
          ${ver.current ? '' : `<button class="primary-cta" id="bc-version-restore" data-hist-id="${escapeHtml(ver.id)}">Restore this version</button>`}
        </span>
      </div>` : '';
    return `
      <div class="bc-card${opts.readOnly ? ' bc-card--readonly' : ''}">
        ${banner}
        <div class="bc-h">
          <div>
            <h3 style="margin:0">Battlecard · ${escapeHtml(competitor.name)}</h3>
            <div class="bc-verdict bc-verdict-${verdictClass}">${escapeHtml(verdictLabel)}</div>
          </div>
          <div class="bc-h-actions">
            <span class="bc-stale-flag hidden" id="competitor-battlecard-stale-flag">New evidence — regenerate to refresh</span>
            ${opts.readOnly ? '' : '<button class="kb-secondary-btn" id="bc-download-btn" title="Download this battlecard as a Word document">Download</button><button class="kb-secondary-btn" id="bc-add-evidence-btn" title="Save this battlecard as a reference snapshot in the evidence list (kept out of future regenerations)">＋ Add to evidence</button>'}
            <button class="kb-secondary-btn" id="bc-regen-btn">↻ Regenerate</button>
          </div>
        </div>

        ${bc.verdictHeadline ? `
          <div class="bc-section">
            <div class="bc-label">Verdict ${editPill('verdictHeadline')}<button class="bc-edit-btn" data-bc-edit="verdictHeadline">${edited.includes('verdictHeadline') ? '↩ Use AI' : '✎'}</button></div>
            <p class="bc-verdict-line">${escapeHtml(bc.verdictHeadline)}</p>
          </div>` : ''}

        <div class="bc-row-2col">
          <div class="bc-section">
            <div class="bc-label">Where we win</div>
            <ul class="bc-win-list">
              ${(bc.whereWeWin || []).map((w) => `
                <li>
                  <div class="bc-claim">${escapeHtml(w.claim || '')}</div>
                  ${w.evidence ? `<div class="bc-evidence">"${escapeHtml(w.evidence)}"</div>` : ''}
                </li>`).join('') || '<li class="kb-subtle">No clear advantages surfaced from the evidence.</li>'}
            </ul>
          </div>
          <div class="bc-section">
            <div class="bc-label">Where we lose</div>
            <ul class="bc-lose-list">
              ${(bc.whereWeLose || []).map((w) => `
                <li>
                  <div class="bc-claim">${escapeHtml(w.claim || '')}</div>
                  ${w.gapToOvercome ? `<div class="bc-gap">▲ Fix: ${escapeHtml(w.gapToOvercome)}</div>` : ''}
                </li>`).join('') || '<li class="kb-subtle">No losses surfaced from the evidence.</li>'}
            </ul>
          </div>
        </div>

        <div class="bc-section">
          <div class="bc-label">Talk track ${editPill('talkTrack')}<button class="bc-edit-btn" data-bc-edit="talkTrack">${edited.includes('talkTrack') ? '↩ Use AI' : '✎'}</button></div>
          <div class="bc-talktrack" id="bc-talktrack-display">
            ${(bc.talkTrack || []).map((line, i) => `
              <div class="bc-talkline"><span class="bc-talkidx">${i + 1}</span><span>${escapeHtml(line)}</span></div>`).join('') || '<div class="kb-subtle">No talk track yet.</div>'}
          </div>
        </div>

        <div class="bc-section">
          <div class="bc-label">Objection handlers ${editPill('objections')}<button class="bc-edit-btn" data-bc-edit="objections">${edited.includes('objections') ? '↩ Use AI' : '✎'}</button></div>
          <div class="bc-objections" id="bc-objections-display">
            ${(bc.objections || []).map((o) => `
              <div class="bc-objection">
                <div class="bc-objection-claim">They say: <em>"${escapeHtml(o.claim || '')}"</em></div>
                <div class="bc-objection-response">We say: ${escapeHtml(o.response || '')}</div>
                ${o.evidence ? `<div class="bc-objection-evidence">Evidence: ${escapeHtml(o.evidence)}</div>` : ''}
              </div>`).join('') || '<div class="kb-subtle">No objection handlers yet.</div>'}
          </div>
        </div>

        <div class="bc-section">
          <div class="bc-label">Migration story ${editPill('migrationStory')}<button class="bc-edit-btn" data-bc-edit="migrationStory">${edited.includes('migrationStory') ? '↩ Use AI' : '✎'}</button></div>
          <div id="bc-migration-display" class="bc-migration">${bc.migrationStory ? escapeHtml(bc.migrationStory) : '<span class="kb-subtle">No migration story yet.</span>'}</div>
        </div>

        ${bc.lastRefreshedAt ? `<div class="bc-meta kb-subtle">Synthesised ${escapeHtml(fmtDate(bc.lastRefreshedAt))}${bc.model ? ` · ${escapeHtml(bc.model)}` : ''}${bc.sourceDocIds && bc.sourceDocIds.length ? ` · ${bc.sourceDocIds.length} source doc${bc.sourceDocIds.length === 1 ? '' : 's'}` : ''}</div>` : ''}
        <div class="kb-result hidden" id="bc-action-result"></div>
      </div>`;
  }

  // Serialize a battlecard to markdown so it can be filed as an evidence doc.
  function battlecardToMarkdown(competitor, bc) {
    const offering = _bcScope.competitorProduct ? (_lastPortfolio.offerings.find((o) => o.id === _bcScope.competitorProduct) || {}).name : null;
    const ourProd = _bcScope.product ? (_lastPortfolio.products.find((p) => p.id === _bcScope.product) || {}).name : null;
    const their = offering ? `${competitor.name} ${offering}` : `${competitor.name} (company-wide)`;
    const our = ourProd || 'our whole portfolio';
    const adv = Number(bc.weightedAdvantage) || 0;
    const verdict = adv > 5 ? `We lead by ${adv}%` : adv < -5 ? `We trail by ${Math.abs(adv)}%` : `Roughly tied (${adv >= 0 ? '+' : ''}${adv}%)`;
    const L = [`# Battlecard — ${our} vs ${their}`, '', `**Verdict:** ${verdict}`];
    if (bc.verdictHeadline) L.push('', bc.verdictHeadline);
    if ((bc.whereWeWin || []).length) { L.push('', '## Where we win'); for (const w of bc.whereWeWin) L.push(`- ${w.claim || ''}${w.evidence ? ` — "${w.evidence}"` : ''}`); }
    if ((bc.whereWeLose || []).length) { L.push('', '## Where we lose'); for (const w of bc.whereWeLose) L.push(`- ${w.claim || ''}${w.gapToOvercome ? ` — Fix: ${w.gapToOvercome}` : ''}`); }
    if ((bc.talkTrack || []).length) { L.push('', '## Talk track'); bc.talkTrack.forEach((t, i) => L.push(`${i + 1}. ${t}`)); }
    if ((bc.objections || []).length) { L.push('', '## Objection handlers'); for (const o of bc.objections) { L.push(`- **They say:** "${o.claim || ''}"`, `  **We say:** ${o.response || ''}`); if (o.evidence) L.push(`  **Evidence:** ${o.evidence}`); } }
    if (bc.migrationStory) L.push('', '## Migration story', bc.migrationStory);
    if (bc.lastRefreshedAt) L.push('', `_Synthesised ${fmtDate(bc.lastRefreshedAt)}${bc.model ? ` · ${bc.model}` : ''}._`);
    return L.join('\n');
  }

  function wireBattlecardActions(competitor) {
    // Download the live battlecard as a Word .docx via the export endpoint.
    const dl = $('bc-download-btn');
    if (dl) dl.addEventListener('click', () => {
      if (!_currentBattlecard) return;
      const offering = _bcScope.competitorProduct ? (_lastPortfolio.offerings.find((x) => x.id === _bcScope.competitorProduct) || {}).name : null;
      const slug = `${competitor.name}-${offering || 'company-wide'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const md = battlecardToMarkdown(competitor, _currentBattlecard);
      downloadDocx(`battlecard-${slug || 'competitor'}.docx`, md, { title: `Battlecard — ${competitor.name}`, docType: 'Competitive battlecard', footerNote: 'Generated by DealScope · grounded in your intel' });
    });

    // Save the live battlecard as a reference snapshot in this matchup's evidence
    // list. Tagged isBattlecardSnapshot so it's kept OUT of future synthesis.
    const addEv = $('bc-add-evidence-btn');
    if (addEv) addEv.addEventListener('click', async () => {
      if (!_currentBattlecard) return;
      const result = $('bc-action-result');
      if (result) { result.classList.add('hidden'); result.classList.remove('error', 'success'); }
      addEv.disabled = true; const o = addEv.textContent; addEv.textContent = 'Adding…';
      try {
        const md = battlecardToMarkdown(competitor, _currentBattlecard);
        const offering = _bcScope.competitorProduct ? (_lastPortfolio.offerings.find((x) => x.id === _bcScope.competitorProduct) || {}).name : null;
        const stamp = fmtDate(_currentBattlecard.lastRefreshedAt || new Date().toISOString());
        const title = `Battlecard — ${offering || 'Company-wide'} (${stamp})`;
        const fd = new FormData();
        fd.append('file', new Blob([md], { type: 'text/markdown' }), 'battlecard.md');
        fd.append('scope', 'COMPETITOR');
        fd.append('category', 'BATTLECARDS');
        fd.append('competitorIds', competitor.id);
        if (_bcScope.competitorProduct) fd.append('competitorProductId', _bcScope.competitorProduct);
        fd.append('title', title);
        // Mark it a snapshot so it stays a readable reference but is kept OUT of
        // future battlecard synthesis + the main-intel gate (no feedback loop).
        fd.append('metadata', JSON.stringify({ isBattlecardSnapshot: true }));
        const r = await fetch('/api/knowledge/upload', { method: 'POST', credentials: 'include', body: fd });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (result) { result.classList.remove('hidden'); result.classList.add('success'); result.textContent = 'Battlecard saved to evidence as a snapshot (kept out of future regenerations).'; }
        await refreshEvidenceInPlace(competitor);
      } catch (err) {
        if (result) { result.classList.remove('hidden'); result.classList.add('error'); result.textContent = err.message; }
      } finally { addEv.disabled = false; addEv.textContent = o; }
    });

    const regen = $('bc-regen-btn');
    if (regen) regen.addEventListener('click', async () => {
      const result = $('bc-action-result');
      if (result) { result.classList.add('hidden'); result.classList.remove('error', 'success'); }
      if (!confirm('Regenerate the battlecard? Costs one AI call; manual edits will be preserved.')) return;
      regen.disabled = true; const orig = regen.textContent; regen.textContent = 'Synthesising…';
      try {
        await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard/regenerate${bcScopeQuery()}`, { method: 'POST' });
        await loadCompetitorBattlecard(competitor);
      } catch (err) {
        if (result) {
          result.classList.remove('hidden'); result.classList.add('error');
          result.textContent = `Regen failed: ${err.message}`;
        }
      } finally { regen.disabled = false; regen.textContent = orig; }
    });

    // Per-section edit / revert buttons.
    document.querySelectorAll('[data-bc-edit]').forEach((b) => {
      b.addEventListener('click', () => editBattlecardSection(competitor, b.dataset.bcEdit, b));
    });
  }

  async function editBattlecardSection(competitor, section, btn) {
    // If the button is currently in "↩ Use AI" mode, revert.
    if ((btn.textContent || '').startsWith('↩')) {
      try {
        await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard${bcScopeQuery()}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ section, revert: true }),
        });
        await loadCompetitorBattlecard(competitor);
      } catch (err) { alert(`Couldn't revert: ${err.message}`); }
      return;
    }
    // Otherwise prompt for the new value. For simple strings (verdictHeadline,
    // migrationStory) → prompt(). For arrays → take pasted JSON-line form.
    const current = await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard${bcScopeQuery()}`);
    const bc = current.battlecard || {};
    let value;
    if (section === 'verdictHeadline' || section === 'migrationStory') {
      const cur = bc[section] || '';
      value = prompt(`Edit ${section}:`, cur);
      if (value === null) return;
    } else if (section === 'talkTrack') {
      const cur = (bc.talkTrack || []).join('\n');
      const v = prompt('Edit talk track (one line per row, blank lines stripped):', cur);
      if (v === null) return;
      value = v.split(/\n+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
    } else if (section === 'whereWeWin' || section === 'whereWeLose') {
      // Edit as JSON to keep the structure. Power-user mode for now.
      const cur = JSON.stringify(bc[section] || [], null, 2);
      const v = prompt(`Edit ${section} as JSON array (each item: {claim, evidence} or {claim, gapToOvercome}):`, cur);
      if (v === null) return;
      try { value = JSON.parse(v); } catch { alert('Invalid JSON.'); return; }
    } else if (section === 'objections') {
      const cur = JSON.stringify(bc.objections || [], null, 2);
      const v = prompt('Edit objections as JSON array (each item: {claim, response, evidence?}):', cur);
      if (v === null) return;
      try { value = JSON.parse(v); } catch { alert('Invalid JSON.'); return; }
    }
    try {
      await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard${bcScopeQuery()}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, value }),
      });
      await loadCompetitorBattlecard(competitor);
    } catch (err) { alert(`Couldn't save: ${err.message}`); }
  }

  // ── Battlecard history (dated versions · view / restore) ─────────────────
  // Fetches the dated version list for the current (competitor, product?) scope
  // and renders it below the live card. `viewingId` highlights the version
  // currently being previewed read-only.
  async function loadBattlecardHistory(competitor, viewingId) {
    const hist = $('bc-history-host');
    if (!hist) return;
    let data;
    try {
      data = await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard/history${bcScopeQuery()}`);
    } catch { hist.innerHTML = ''; return; }
    const versions = data.versions || [];
    if (!versions.length) { hist.innerHTML = ''; return; }
    hist.innerHTML = renderBattlecardHistory(versions, viewingId);
    hist.querySelectorAll('[data-bc-hist-view]').forEach((b) => b.addEventListener('click', () => {
      const v = versions.find((x) => x.id === b.dataset.bcHistView);
      if (v) viewBattlecardVersion(competitor, v);
    }));
    hist.querySelectorAll('[data-bc-hist-restore]').forEach((b) => b.addEventListener('click', () =>
      restoreBattlecardVersion(competitor, b.dataset.bcHistRestore)));
  }

  function renderBattlecardHistory(versions, viewingId) {
    const advTxt = (a) => typeof a === 'number' ? `${a >= 0 ? '+' : ''}${a}%` : '';
    return `
      <details class="bc-history-details"${viewingId ? ' open' : ''}>
        <summary>🕘 History · ${versions.length} version${versions.length === 1 ? '' : 's'}</summary>
        <ul class="bc-history-list">
          ${versions.map((v) => `
            <li class="bc-history-row${v.current ? ' current' : ''}${v.id === viewingId ? ' viewing' : ''}">
              <div class="bc-history-meta">
                <span class="bc-history-date">${escapeHtml(fmtDate(v.generatedAt))}</span>
                ${v.current ? '<span class="bc-history-badge">current</span>' : ''}
                <span class="kb-subtle">${advTxt(v.weightedAdvantage)}${v.sourceDocCount ? ` · ${v.sourceDocCount} src` : ''}${v.model ? ` · ${escapeHtml(v.model)}` : ''}</span>
              </div>
              <div class="bc-history-actions">
                <button type="button" class="kb-link-btn" data-bc-hist-view="${escapeHtml(v.id)}">View</button>
                ${v.current ? '' : `<button type="button" class="kb-link-btn" data-bc-hist-restore="${escapeHtml(v.id)}">Restore</button>`}
              </div>
            </li>`).join('')}
        </ul>
      </details>`;
  }

  // Render a past snapshot read-only in place of the live card, keeping the
  // history list visible below (with this version highlighted).
  function viewBattlecardVersion(competitor, version) {
    const host = $('competitor-battlecard-host');
    if (!host) return;
    host.innerHTML = renderBattlecard(competitor, version.battlecard, { readOnly: true, version })
      + '<div class="bc-history" id="bc-history-host"></div>';
    const back = $('bc-version-back');
    if (back) back.addEventListener('click', () => loadCompetitorBattlecard(competitor));
    const restore = $('bc-version-restore');
    if (restore) restore.addEventListener('click', () => restoreBattlecardVersion(competitor, restore.dataset.histId));
    loadBattlecardHistory(competitor, version.id);
  }

  async function restoreBattlecardVersion(competitor, histId) {
    if (!confirm('Restore this version as the current battlecard? The current version stays in history.')) return;
    try {
      await fetchJson(`/api/portfolio/competitors/${encodeURIComponent(competitor.id)}/battlecard/history/${encodeURIComponent(histId)}/restore${bcScopeQuery()}`, { method: 'POST' });
      await loadCompetitorBattlecard(competitor);
    } catch (err) { alert(`Couldn't restore: ${err.message}`); }
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
    // CRM providers (pull prospects). Best-effort — a failure just hides the group.
    // Hide "coming soon" (not-yet-live) connectors for now — show only live ones
    // (plus any already connected, defensively).
    let crmProviders = [];
    try { crmProviders = (await fetchJson('/api/crm/providers')).providers || []; } catch { crmProviders = []; }
    crmProviders = crmProviders.filter((p) => p.live || (p.connection && p.connection.connected));

    // Flash from the OAuth callback redirects (?google=connected / ?ms=… / …).
    const flash = readCalFlash();
    // Group by connection model so the two flows read clearly: calendars we READ
    // (Google / Microsoft) vs inbound booking webhooks (Calendly).
    const readCal = providers.filter((p) => p.mode !== 'webhook');
    const inbound = providers.filter((p) => p.mode === 'webhook');
    const group = (label, hint, list) => list.length
      ? `<div class="integration-group">
           <div class="integration-group-h">${label} <span class="kb-subtle">${hint}</span></div>
           <div class="integration-grid">${list.map(integrationCard).join('')}</div>
         </div>`
      : '';
    const crmGroup = crmProviders.length
      ? `<div class="integration-group">
           <div class="integration-group-h">CRM <span class="kb-subtle">— pull your prospects (companies + contacts) into DealScope</span></div>
           <div class="integration-grid">${crmProviders.map(crmCard).join('')}</div>
         </div>`
      : '';
    const recPrivacyGroup = `
      <div class="integration-group">
        <div class="integration-group-h">Recording &amp; privacy <span class="kb-subtle">— control what the AI notetaker keeps</span></div>
        <div id="rec-privacy-card" class="rec-privacy-card"><div class="kb-subtle">Loading…</div></div>
      </div>`;
    const recommendationGroup = `
      <div class="integration-group">
        <div class="integration-group-h">Recommendations <span class="kb-subtle">— how the proposal engine handles thin intel</span></div>
        <div id="proposal-mode-card" class="rec-privacy-card"><div class="kb-subtle">Loading…</div></div>
      </div>`;
    host.innerHTML =
      (flash || '') +
      recPrivacyGroup +
      recommendationGroup +
      crmGroup +
      group('Read your calendar', '— pull events into the schedule form', readCal) +
      group('Inbound booking', '— auto-create engagements when prospects book', inbound);
    loadRecordingPrivacy();
    loadProposalMode();
    wireCrmCards(host);
    host.querySelectorAll('[data-copy]').forEach((b) =>
      b.addEventListener('click', () => copyToClipboard(b.dataset.copy, b)));
    host.querySelectorAll('[data-google-connect]').forEach((b) =>
      b.addEventListener('click', () => { window.location.href = '/api/integrations/google/connect'; }));
    host.querySelectorAll('[data-google-disconnect]').forEach((b) =>
      b.addEventListener('click', () => googleDisconnect(b)));
    host.querySelectorAll('[data-google-reconnect]').forEach((b) =>
      b.addEventListener('click', () => googleReconnect(b)));
    host.querySelectorAll('[data-caly-connect]').forEach((b) =>
      b.addEventListener('click', () => { window.location.href = '/api/integrations/calendly/connect'; }));
    host.querySelectorAll('[data-caly-disconnect]').forEach((b) =>
      b.addEventListener('click', () => calendlyDisconnect(b)));
    host.querySelectorAll('[data-caly-verify]').forEach((b) =>
      b.addEventListener('click', () => calendlyVerify(b)));
    // Microsoft 365 — per-user delegated OAuth only. Authenticated
    // Teams meeting joining is a Recall dashboard config, not handled here.
    host.querySelectorAll('[data-ms-connect]').forEach((b) =>
      b.addEventListener('click', () => { window.location.href = '/api/integrations/microsoft/connect'; }));
    host.querySelectorAll('[data-ms-disconnect]').forEach((b) =>
      b.addEventListener('click', () => microsoftDisconnect(b)));
    host.querySelectorAll('[data-ms-reconnect]').forEach((b) =>
      b.addEventListener('click', () => microsoftReconnect(b)));
  }

  // Disconnect + immediately route to the new-scopes OAuth flow. Used by the
  // amber "stale scopes" banner — and also called from the meeting modal
  // when the API returns CONSENT_REQUIRED.
  async function microsoftReconnect(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Reconnecting…'; }
    try {
      await fetch('/api/integrations/microsoft/connection', { method: 'DELETE', credentials: 'include' });
    } catch { /* best-effort; the connect step will overwrite the grant anyway */ }
    window.location.href = '/api/integrations/microsoft/connect';
  }

  // ── Calendar agenda view ─────────────────────────────────────────────────
  // Pulls upcoming events from every connected source (Google direct,
  // Microsoft 365 direct, Calendly). Renders an agenda grouped by day; each row
  // offers a quick "Schedule mission" hand-off that pre-fills the Missions form.

  let _calendarEvents = [];

  async function loadCalendar() {
    const host = $('calendar-body');
    if (!host) return;
    const refreshBtn = $('calendar-refresh-btn');
    if (refreshBtn && refreshBtn.dataset.wired !== '1') {
      refreshBtn.dataset.wired = '1';
      refreshBtn.addEventListener('click', () => { loaded.calendar = false; loadCalendar(); });
    }
    host.innerHTML = '<div class="kb-subtle">Loading your upcoming meetings…</div>';

    // Find out which sources are connected so we know what to pull from + can
    // show an honest empty state if nothing is connected.
    let msConnected = false, calyConnected = false, googleConnected = false;
    let anyConfigured = false;
    try {
      const providers = (await fetchJson('/api/integrations/calendar')).providers || [];
      const ms = providers.find((p) => p.key === 'microsoft');
      const cl = providers.find((p) => p.key === 'calendly');
      const gg = providers.find((p) => p.key === 'google');
      msConnected     = !!(ms && ms.connection && ms.connection.connected);
      calyConnected   = !!(cl && cl.connection && cl.connection.connected);
      googleConnected = !!(gg && gg.connection && gg.connection.connected);
      anyConfigured   = !!((ms && ms.configured) || (cl && cl.configured) || (gg && gg.configured));
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn't read integrations: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (!msConnected && !calyConnected && !googleConnected) {
      host.innerHTML = `
        <div class="empty">
          <p>No connected calendar yet.</p>
          <p class="kb-subtle">${anyConfigured
            ? 'Open <a href="#integrations">Integrations</a> to connect Google, Microsoft 365, or Calendly.'
            : 'No calendar provider is configured yet. Set the env vars and connect from <a href="#integrations">Integrations</a>.'}</p>
        </div>`;
      return;
    }

    // Fetch every connected source in parallel; tolerate any one failing.
    const [msRes, calyRes, googleRes] = await Promise.allSettled([
      msConnected     ? fetchJson('/api/integrations/microsoft/events?days=14') : Promise.resolve({ events: [] }),
      calyConnected   ? fetchJson('/api/integrations/calendly/events?days=30')  : Promise.resolve({ events: [] }),
      googleConnected ? fetchJson('/api/integrations/google/events?days=14')    : Promise.resolve({ events: [] }),
    ]);
    const errors = [];
    const events = [];
    if (msRes.status     === 'fulfilled') events.push(...(msRes.value.events     || []));
    else                                  errors.push(`Microsoft 365: ${msRes.reason.message}`);
    if (calyRes.status   === 'fulfilled') events.push(...(calyRes.value.events   || []));
    else                                  errors.push(`Calendly: ${calyRes.reason.message}`);
    if (googleRes.status === 'fulfilled') events.push(...(googleRes.value.events || []));
    else                                  errors.push(`Google: ${googleRes.reason.message}`);

    // Sort + dedupe (same event can appear in both feeds — match on
    // meetingUrl + start as a best-effort key).
    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    const seen = new Set();
    const deduped = events.filter((ev) => {
      const key = `${(ev.url || '').toLowerCase()}|${ev.start}`;
      if (key === '|' || seen.has(key)) return seen.has(key) ? false : seen.add(key);
      seen.add(key); return true;
    });
    _calendarEvents = deduped;

    const errorBanner = errors.length
      ? `<div class="kb-result error" style="margin-bottom:14px">Partial load — some sources failed: ${escapeHtml(errors.join('; '))}</div>` : '';

    if (deduped.length === 0) {
      host.innerHTML = errorBanner + '<div class="empty">No upcoming meetings in the next 14 days.</div>';
      return;
    }

    // One tab per connected source (Google / Microsoft / Calendly). Each pane
    // is that source's events grouped by day. Events keep their `provider`, so
    // we just partition the deduped list. The first connected source is active.
    const TAB_DEFS = [
      { key: 'google',    label: 'Google',    on: googleConnected },
      { key: 'microsoft', label: 'Microsoft', on: msConnected },
      { key: 'calendly',  label: 'Calendly',  on: calyConnected },
    ].filter((t) => t.on);

    const tabBar = TAB_DEFS.map((t, i) => {
      const n = deduped.filter((ev) => ev.provider === t.key).length;
      return `<button class="kb-tab cal-src-tab${i === 0 ? ' active' : ''}" data-cal-tab="${t.key}">${t.label} <span class="cal-tab-count">${n}</span></button>`;
    }).join('');

    const panes = TAB_DEFS.map((t, i) =>
      `<div class="cal-tab-pane${i === 0 ? '' : ' hidden'}" data-cal-pane="${t.key}">${renderCalendarAgenda(deduped.filter((ev) => ev.provider === t.key))}</div>`
    ).join('');

    host.innerHTML = errorBanner +
      `<div class="kb-tabs cal-src-tabs">${tabBar}</div><div class="cal-agenda">${panes}</div>`;

    // Tab switching — toggle active button + show the matching pane.
    host.querySelectorAll('[data-cal-tab]').forEach((tb) =>
      tb.addEventListener('click', () => {
        host.querySelectorAll('[data-cal-tab]').forEach((x) => x.classList.toggle('active', x === tb));
        host.querySelectorAll('[data-cal-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.calPane !== tb.dataset.calTab));
      }));

    host.querySelectorAll('[data-cal-schedule]').forEach((el) =>
      el.addEventListener('click', () => scheduleMissionFromCalendarRow(parseInt(el.dataset.calSchedule, 10))));
    host.querySelectorAll('[data-cal-open]').forEach((el) =>
      el.addEventListener('click', (e) => {
        // Don't intercept the click if the user is meta/ctrl-clicking — let
        // them open the join URL in a new tab naturally.
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      }));
  }

  // Render a set of events (one source) grouped by local day. Schedule-row
  // indices are resolved against the full _calendarEvents list so the
  // hand-off picks the right event regardless of which tab it's in.
  function renderCalendarAgenda(events) {
    if (!events.length) {
      return '<div class="empty">No upcoming meetings from this source in the next 14 days.</div>';
    }
    const dayKeyOf = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const groups = new Map();
    for (const ev of events) {
      const key = dayKeyOf(new Date(ev.start));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    }
    const todayKey = dayKeyOf(new Date());
    const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
    const tomorrowKey = dayKeyOf(tmr);
    return [...groups.entries()].map(([dayKey, items]) => {
      const sample = new Date(items[0].start);
      const heading = dayKey === todayKey
        ? `Today · ${sample.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}`
        : dayKey === tomorrowKey
          ? `Tomorrow · ${sample.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}`
          : sample.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      return `
        <div class="cal-day">
          <div class="cal-day-h">${escapeHtml(heading)}</div>
          ${items.map((ev) => calendarRow(ev, _calendarEvents.indexOf(ev))).join('')}
        </div>`;
    }).join('');
  }

  // One agenda row.
  function calendarRow(ev, idx) {
    const start = new Date(ev.start);
    const end   = ev.end ? new Date(ev.end) : null;
    const fmt = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const timeStr = end ? `${fmt(start)} – ${fmt(end)}` : fmt(start);
    const att = Array.isArray(ev.attendees) ? ev.attendees : [];
    const attShort = att.slice(0, 3).join(', ') + (att.length > 3 ? ` +${att.length - 3}` : '');
    const sug = ev.suggestion || {};
    const provider = sourcePill(ev);
    const joinHost = ev.url ? safeJoinHost(ev.url) : null;
    const joinBtn  = ev.url
      ? `<a class="kb-link-btn" data-cal-open href="${escapeHtml(ev.url)}" target="_blank" rel="noopener" title="Join ${escapeHtml(joinHost || 'meeting')}">Join ${escapeHtml(joinLabel(joinHost))}</a>`
      : '';
    const company = sug.companyName ? ` · <span class="kb-subtle">→ ${escapeHtml(sug.companyName)}</span>` : '';
    return `
      <div class="cal-row">
        <div class="cal-row-time"><strong>${escapeHtml(timeStr)}</strong></div>
        <div class="cal-row-body">
          <div class="cal-row-title">${escapeHtml(ev.title || '(no title)')} ${provider}</div>
          <div class="cal-row-meta kb-subtle">${escapeHtml(attShort || '(no attendees)')}${company}</div>
        </div>
        <div class="cal-row-actions">
          ${joinBtn}
          <button class="kb-secondary-btn" data-cal-schedule="${idx}">Schedule engagement</button>
        </div>
      </div>`;
  }

  // Hand-off: navigate to Missions → Schedule, then prefill from the event.
  async function scheduleMissionFromCalendarRow(idx) {
    const ev = _calendarEvents[idx];
    if (!ev) return;
    await switchSection('missions', {});
    // loadMissions sets up the form + tabs idempotently. Switch to the
    // schedule pane (in case the user landed on a different one previously),
    // then apply the event's suggestion into the form.
    await switchMissionsTab('schedule');
    applyCalendarEvent(ev);
    // Make the URL reflect where we are (so refresh keeps the user here).
    if (window.location.hash !== '#missions') {
      history.replaceState(null, '', location.pathname + location.search + '#missions');
    }
    // Scroll the form into view — the schedule pane sits below the tab bar.
    const sched = $('missions-pane-schedule');
    if (sched && sched.scrollIntoView) sched.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function safeJoinHost(url) {
    try { return new URL(url).hostname; } catch { return null; }
  }
  function joinLabel(host) {
    if (!host) return '';
    if (/teams\./i.test(host))  return 'Teams';
    if (/zoom\./i.test(host))   return 'Zoom';
    if (/meet\.google\.com$/i.test(host)) return 'Meet';
    if (/webex\./i.test(host))  return 'Webex';
    return '';
  }

  // Pull (and clear) the ?google=… / ?ms=… flash params the callbacks set,
  // returning a banner HTML string (or null). Cleans them off the URL so a
  // refresh is quiet.
  function readCalFlash() {
    const q = new URLSearchParams(location.search);
    const ggOk = q.get('google'), ggErr = q.get('google_error');
    const calNotice = q.get('cal_notice');
    const msOk = q.get('ms'),  msErr = q.get('ms_error');
    if (!ggOk && !ggErr && !calNotice && !msOk && !msErr) return null;
    ['google', 'google_error', 'cal_notice', 'ms', 'ms_error'].forEach((k) => q.delete(k));
    const clean = location.pathname + (q.toString() ? `?${q}` : '') + location.hash;
    history.replaceState(null, '', clean);
    if (msErr)  return `<div class="kb-result error"   style="margin-bottom:14px">Microsoft 365: ${escapeHtml(msErr)}</div>`;
    if (msOk)   return `<div class="kb-result success" style="margin-bottom:14px">Microsoft 365 calendar ${escapeHtml(msOk)}.</div>`;
    if (ggErr)  return `<div class="kb-result error"   style="margin-bottom:14px">Google connect failed: ${escapeHtml(ggErr)}</div>`;
    if (ggOk)   return `<div class="kb-result success" style="margin-bottom:14px">Google calendar ${escapeHtml(ggOk)}.</div>`;
    if (calNotice) return `<div class="kb-result success" style="margin-bottom:14px">Calendar ${escapeHtml(calNotice)}</div>`;
    return null;
  }

  async function googleDisconnect(btn) {
    if (!confirm('Disconnect your Google calendar? The schedule form will stop offering its events (re-connect any time).')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
    try {
      const r = await fetch('/api/integrations/google/connection', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) { alert(`Couldn't disconnect: ${err.message}`); }
    loaded.integrations = false;
    await loadIntegrations();
  }

  // Disconnect + immediately re-run the Google OAuth flow. Used by the amber
  // "needs reconsent" banner and by the meeting modal's CONSENT_REQUIRED path.
  async function googleReconnect(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Reconnecting…'; }
    try {
      await fetch('/api/integrations/google/connection', { method: 'DELETE', credentials: 'include' });
    } catch { /* best-effort; the connect step overwrites the grant anyway */ }
    window.location.href = '/api/integrations/google/connect';
  }

  // Retry webhook registration for an already-connected account. The status is
  // captured at connect time, so this recovers the "connected · webhook
  // inactive" state after the OAuth app's scopes were fixed. Surfaces Calendly's
  // own error (scope / plan tier) when registration still fails.
  async function calendlyVerify(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Activating…'; }
    try {
      const r = await fetch('/api/integrations/calendly/verify', { method: 'POST', credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    } catch (err) {
      alert(`Couldn't activate the webhook: ${err.message}`);
      if (btn) { btn.disabled = false; btn.textContent = 'Activate webhook'; }
      return;
    }
    loaded.integrations = false;
    await loadIntegrations();
  }

  async function calendlyDisconnect(btn) {
    if (!confirm('Disconnect Calendly? New bookings will stop auto-creating engagements.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
    try {
      const r = await fetch('/api/integrations/calendly/connection', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) { alert(`Couldn't disconnect: ${err.message}`); }
    loaded.integrations = false;
    await loadIntegrations();
  }

  async function microsoftDisconnect(btn) {
    if (!confirm('Disconnect your Microsoft 365 calendar? The schedule form will stop offering its events (re-connect any time).')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Disconnecting…'; }
    try {
      const r = await fetch('/api/integrations/microsoft/connection', { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) { alert(`Couldn't disconnect: ${err.message}`); }
    loaded.integrations = false;
    await loadIntegrations();
  }

  function integrationCard(p) {
    const isCalendly  = p.key === 'calendly';
    const isMicrosoft = p.key === 'microsoft';
    const isGoogle    = p.key === 'google';
    let badge, action;
    if (!p.configured) {
      badge = '<span class="pill pill-warn">Unavailable</span>';
      action = '<div class="integration-setup">Not available on your workspace yet.</div>';
    } else if (isMicrosoft) {
      const conn = p.connection || {};
      const reconnect = (conn.connected && conn.needsReconsent)
        ? '<div class="integration-actions"><button class="kb-link-btn" data-ms-reconnect>Reconnect to enable meeting creation →</button></div>'
        : '';
      badge = conn.connected ? '<span class="pill pill-ok">Connected</span>' : '<span class="pill pill-warn">Not connected</span>';
      action = conn.connected
        ? `<div class="integration-connected">Connected as <strong>${escapeHtml(conn.email || conn.name || 'your account')}</strong></div>
           ${reconnect}
           <div class="integration-actions"><button class="kb-secondary-btn" data-ms-disconnect>Disconnect</button></div>`
        : '<div class="integration-actions"><button class="primary-cta" data-ms-connect>Connect Microsoft 365</button></div>';
    } else if (isGoogle) {
      // Direct Google (replaces the old Nylas flow). Same shape as the
      // Microsoft card — per-user delegated OAuth + Google Meet creation.
      const conn = p.connection || {};
      const reconnect = (conn.connected && conn.needsReconsent)
        ? '<div class="integration-actions"><button class="kb-link-btn" data-google-reconnect>Reconnect to enable meeting creation →</button></div>'
        : '';
      badge = conn.connected ? '<span class="pill pill-ok">Connected</span>' : '<span class="pill pill-warn">Not connected</span>';
      action = conn.connected
        ? `<div class="integration-connected">Connected as <strong>${escapeHtml(conn.email || conn.name || 'your account')}</strong></div>
           ${reconnect}
           <div class="integration-actions"><button class="kb-secondary-btn" data-google-disconnect>Disconnect</button></div>`
        : '<div class="integration-actions"><button class="primary-cta" data-google-connect>Connect Google</button></div>';
    } else if (isCalendly) {
      const conn = p.connection || {};
      if (conn.connected) {
        badge = conn.webhookActive ? '<span class="pill pill-ok">Connected</span>' : '<span class="pill pill-warn">Connected · webhook inactive</span>';
        action = `
          <div class="integration-connected">${conn.webhookActive
            ? 'Connected — new bookings auto-create engagements.'
            : 'Connected, but the invitee.created webhook isn\'t registered yet, so bookings won\'t auto-create engagements. If you just added the webhooks scopes, activate it below.'}</div>
          <div class="integration-actions">
            ${conn.webhookActive ? '' : '<button class="primary-cta" data-caly-verify>Activate webhook</button>'}
            <button class="kb-secondary-btn" data-caly-disconnect>Disconnect</button>
          </div>`;
      } else {
        badge = '<span class="pill pill-warn">Not connected</span>';
        action = '<div class="integration-actions"><button class="primary-cta" data-caly-connect>Connect Calendly</button></div>';
      }
    } else {
      badge = '<span class="pill pill-warn">Unavailable</span>';
      action = '<div class="integration-setup">Unknown provider.</div>';
    }
    return `
      <div class="integration-card">
        <div class="integration-h">
          <span class="integration-icon">${p.icon || '🔌'}</span>
          <span class="integration-name">${escapeHtml(p.name)}</span>
          ${badge}
        </div>
        <div class="integration-blurb">${escapeHtml(p.blurb)}</div>
        ${action}
      </div>`;
  }

  // CRM provider card: connect via API token, then Pull prospects (or "coming
  // soon" for providers whose connector isn't live yet).
  const CRM_ICON = { hubspot: '🟠', salesforce: '☁️', zoho: '🟡', pipedrive: '🟢', dynamics: '🔷' };
  function crmCard(p) {
    const conn = p.connection;
    const icon = CRM_ICON[p.id] || '🔌';
    let badge, body;
    if (conn && conn.connected) {
      const s = conn.lastSyncSummary || null;
      const last = conn.lastSyncAt ? `Last pull ${escapeHtml(fmtDate(conn.lastSyncAt))}` : 'Not pulled yet';
      const sline = s ? `<div class="kb-subtle">${fmtNum(s.contactsCreated || 0)} new contacts · ${fmtNum(s.companiesCreated || 0)} new companies${s.contactsExisting ? ` · ${fmtNum(s.contactsExisting)} already on file` : ''}${s.skipped ? ` · ${fmtNum(s.skipped)} skipped` : ''}</div>` : '';
      badge = '<span class="pill pill-ok">Connected</span>';
      body = `
        <div class="integration-connected">Connected${conn.tokenHint ? ` <span class="kb-subtle">· token ${escapeHtml(conn.tokenHint)}</span>` : ''}</div>
        <div class="kb-subtle">${last}</div>
        ${sline}
        <div class="integration-actions">
          <button class="primary-cta" data-crm-import="${escapeHtml(p.id)}">Pull prospects</button>
          <button class="kb-secondary-btn" data-crm-disconnect="${escapeHtml(p.id)}">Disconnect</button>
        </div>
        <div class="kb-result hidden" id="crm-result-${escapeHtml(p.id)}"></div>`;
    } else if (p.live) {
      badge = '<span class="pill pill-warn">Not connected</span>';
      body = `
        <div class="integration-setup">${escapeHtml(p.tokenHelp || '')} ${p.docsUrl ? `<a href="${escapeHtml(p.docsUrl)}" target="_blank" rel="noopener">Docs ↗</a>` : ''}</div>
        <div class="crm-connect-row">
          <input type="password" id="crm-token-${escapeHtml(p.id)}" placeholder="${escapeHtml(p.tokenLabel || 'API token')}" autocomplete="off">
          <button class="primary-cta" data-crm-connect="${escapeHtml(p.id)}">Connect</button>
        </div>
        <div class="kb-result hidden" id="crm-result-${escapeHtml(p.id)}"></div>`;
    } else {
      badge = '<span class="pill">Coming soon</span>';
      body = `<div class="integration-setup">${escapeHtml(p.tokenHelp || '')} ${p.docsUrl ? `<a href="${escapeHtml(p.docsUrl)}" target="_blank" rel="noopener">Docs ↗</a>` : ''}</div>`;
    }
    return `
      <div class="integration-card">
        <div class="integration-h">
          <span class="integration-icon">${icon}</span>
          <span class="integration-name">${escapeHtml(p.label)}</span>
          <span class="integration-mode kb-subtle">pull prospects</span>
          ${badge}
        </div>
        ${body}
      </div>`;
  }

  // ── Recording & privacy settings card ────────────────────────────────────
  async function loadRecordingPrivacy() {
    const host = $('rec-privacy-card');
    if (!host) return;
    let s;
    try { s = await fetchJson('/api/settings/recording'); }
    catch (err) { host.innerHTML = `<div class="kb-result error">Couldn't load recording settings: ${escapeHtml(err.message)}</div>`; return; }
    const role = (window._me && window._me.role) || '';
    const canEdit = !!(window._me && window._me.isAdmin) || role === 'owner' || role === 'manager';
    renderRecordingPrivacy(host, s, canEdit);
  }

  function renderRecordingPrivacy(host, s, canEdit) {
    const dis = canEdit ? '' : 'disabled';
    const retentionVal = s.retentionDays == null ? '' : s.retentionDays;
    host.innerHTML = `
      <div class="rec-row">
        <label class="rec-toggle">
          <input type="checkbox" id="rec-video" ${s.videoEnabled ? 'checked' : ''} ${dis}>
          <span><strong>Record video of meetings</strong><br>
          <span class="kb-subtle">Off = the notetaker still joins and transcribes for your AI summary, consolidated report &amp; coaching — but no video is ever stored.</span></span>
        </label>
      </div>
      <div class="rec-row rec-retention">
        <label for="rec-retention"><strong>Delete recordings after</strong></label>
        <input type="number" id="rec-retention" min="1" max="3650" placeholder="keep forever" value="${retentionVal}" ${dis}>
        <span class="kb-subtle">days — blank keeps them indefinitely. Transcript &amp; portal text are always kept.</span>
      </div>
      <div class="rec-row">
        <label class="rec-toggle">
          <input type="checkbox" id="rec-notice" ${s.noticeEnabled ? 'checked' : ''} ${dis}>
          <span><strong>Notify participants the meeting is recorded</strong><br>
          <span class="kb-subtle">Posts a notice in the meeting chat the moment the notetaker joins.</span></span>
        </label>
      </div>
      <div class="rec-row rec-notice-text">
        <textarea id="rec-notice-msg" rows="2" placeholder="${escapeHtml(s.defaultNotice)}" ${dis}>${escapeHtml(s.notice || '')}</textarea>
        <span class="kb-subtle">Leave blank to use the default notice shown above.</span>
      </div>
      ${canEdit
        ? `<div class="rec-actions"><button class="primary-cta" id="rec-save-btn">Save settings</button><span class="kb-result hidden" id="rec-save-result"></span></div>`
        : '<div class="kb-subtle">Only an owner or manager can change these settings.</div>'}`;

    const vid = $('rec-video'), notice = $('rec-notice');
    const syncMuted = () => {
      const ret = $('rec-retention'); const msg = $('rec-notice-msg');
      const retRow = host.querySelector('.rec-retention'); const msgRow = host.querySelector('.rec-notice-text');
      if (retRow) retRow.classList.toggle('rec-muted', !(vid && vid.checked));
      if (msgRow) msgRow.classList.toggle('rec-muted', !(notice && notice.checked));
      if (ret) ret.disabled = !canEdit || !(vid && vid.checked);
      if (msg) msg.disabled = !canEdit || !(notice && notice.checked);
    };
    if (vid) vid.addEventListener('change', syncMuted);
    if (notice) notice.addEventListener('change', syncMuted);
    syncMuted();
    const saveBtn = $('rec-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', saveRecordingPrivacy);
  }

  async function saveRecordingPrivacy() {
    const btn = $('rec-save-btn'), result = $('rec-save-result');
    const retRaw = ($('rec-retention').value || '').trim();
    const body = {
      videoEnabled: $('rec-video').checked,
      noticeEnabled: $('rec-notice').checked,
      notice: ($('rec-notice-msg').value || '').trim() || null,
      retentionDays: retRaw === '' ? null : parseInt(retRaw, 10),
    };
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
    if (result) result.classList.add('hidden');
    try {
      const r = await fetch('/api/settings/recording', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (result) { result.classList.remove('hidden', 'error'); result.classList.add('success'); result.textContent = 'Saved.'; }
    } catch (err) {
      if (result) { result.classList.remove('hidden', 'success'); result.classList.add('error'); result.textContent = `Couldn't save: ${err.message}`; }
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  // ── Recommendations: proposal mode (Phase 3) ──────────────────────────────
  async function loadProposalMode() {
    const host = $('proposal-mode-card');
    if (!host) return;
    let s;
    try { s = await fetchJson('/api/settings/proposal'); }
    catch (err) { host.innerHTML = `<div class="kb-result error">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
    const role = (window._me && window._me.role) || '';
    const canEdit = !!(window._me && window._me.isAdmin) || role === 'owner' || role === 'manager';
    const dis = canEdit ? '' : 'disabled';
    const opt = (val, label, sub) => `
      <label class="rec-toggle" style="align-items:flex-start">
        <input type="radio" name="proposal-mode" value="${val}" ${s.mode === val ? 'checked' : ''} ${dis}>
        <span><strong>${label}</strong><br><span class="kb-subtle">${sub}</span></span>
      </label>`;
    host.innerHTML = `
      <div class="rec-row">${opt('DRAFT_WITH_ASSUMPTIONS', 'Draft with assumptions (default)',
        'Always generate. Where intel is thin, the recommendation flags those parts as assumptions and lowers the confidence — nothing is hidden.')}</div>
      <div class="rec-row">${opt('BLOCK', 'Require prospect intel first',
        'Withhold generation until this prospect has its own intelligence (research, filed intel, or a logged call/email) — not just your profile and generic competitor intel.')}</div>
      ${canEdit
        ? `<div class="rec-actions"><button class="primary-cta" id="pmode-save-btn">Save</button><span class="kb-result hidden" id="pmode-save-result"></span></div>`
        : '<div class="kb-subtle">Only an owner or manager can change this.</div>'}`;
    const saveBtn = $('pmode-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const sel = host.querySelector('input[name="proposal-mode"]:checked');
      if (!sel) return;
      const result = $('pmode-save-result');
      saveBtn.disabled = true; const orig = saveBtn.textContent; saveBtn.textContent = 'Saving…';
      if (result) result.classList.add('hidden');
      try {
        const r = await fetch('/api/settings/proposal', {
          method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: sel.value }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        if (result) { result.classList.remove('hidden', 'error'); result.classList.add('success'); result.textContent = 'Saved.'; }
      } catch (err) {
        if (result) { result.classList.remove('hidden', 'success'); result.classList.add('error'); result.textContent = `Couldn't save: ${err.message}`; }
      } finally { saveBtn.disabled = false; saveBtn.textContent = orig; }
    });
  }

  function wireCrmCards(host) {
    host.querySelectorAll('[data-crm-connect]').forEach((b) => b.addEventListener('click', () => crmConnect(b.dataset.crmConnect)));
    host.querySelectorAll('[data-crm-import]').forEach((b) => b.addEventListener('click', () => crmImport(b.dataset.crmImport, b)));
    host.querySelectorAll('[data-crm-disconnect]').forEach((b) => b.addEventListener('click', () => crmDisconnect(b.dataset.crmDisconnect)));
  }

  function crmResult(provider, msg, kind) {
    const el = $(`crm-result-${provider}`);
    if (!el) return;
    el.classList.remove('hidden', 'error', 'success');
    if (kind) el.classList.add(kind);
    el.textContent = msg;
  }

  async function crmConnect(provider) {
    const input = $(`crm-token-${provider}`);
    const token = input ? input.value.trim() : '';
    if (!token) { crmResult(provider, 'Paste your token first.', 'error'); return; }
    crmResult(provider, 'Verifying…', '');
    try {
      await fetchJson('/api/crm/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, token }),
      });
      loaded.integrations = false;
      await loadIntegrations();
    } catch (err) {
      crmResult(provider, err.message, 'error');
    }
  }

  async function crmImport(provider, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Pulling…'; }
    crmResult(provider, 'Pulling prospects from your CRM — this can take a moment…', '');
    try {
      const r = await fetchJson(`/api/crm/connections/${encodeURIComponent(provider)}/import`, { method: 'POST' });
      const s = r.summary || {};
      crmResult(provider, `Done — ${s.contactsCreated || 0} new contacts, ${s.companiesCreated || 0} new companies${s.contactsExisting ? `, ${s.contactsExisting} already on file` : ''}${s.skipped ? `, ${s.skipped} skipped` : ''}. See them on the Prospects page.`, 'success');
      loaded.prospects = false; // refresh prospects next visit
    } catch (err) {
      crmResult(provider, err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Pull prospects'; }
    }
  }

  async function crmDisconnect(provider) {
    if (!confirm(`Disconnect ${provider}? Prospects already pulled stay; we just forget the token.`)) return;
    try {
      await fetch(`/api/crm/connections/${encodeURIComponent(provider)}`, { method: 'DELETE', credentials: 'include' });
      loaded.integrations = false;
      await loadIntegrations();
    } catch (err) { alert(`Couldn't disconnect: ${err.message}`); }
  }

  function copyBtn(text) {
    if (!text) return '';
    return `<button class="kb-link-btn integration-copy" data-copy="${escapeHtml(text)}" title="Copy">⧉ copy</button>`;
  }
  async function copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) { const o = btn.textContent; btn.textContent = 'copied ✓'; setTimeout(() => { btn.textContent = o; }, 1400); }
    } catch { /* clipboard blocked — no-op */ }
  }

  // ── Schedule-form imports (calendar via Google / Microsoft, or Calendly) ──
  // "Check upcoming meetings" aggregates upcoming events from every connected
  // source (also offers Connect if configured-but-not-linked); "From
  // Calendly" lists upcoming Calendly-booked events. Either opens the same
  // picker modal; choosing an event prefills the form from its `suggestion`.

  let _calPickerEvents = [];
  // Single "Check upcoming meetings" button. State machine:
  //   'import'   — at least one source connected → opens aggregated picker
  //   'connect'  — at least one source configured but none connected →
  //                routes to #integrations so the rep picks which to connect
  //   'disabled' — no source configured at all
  let _calImportMode = 'disabled';

  async function refreshCalendarImportButton() {
    const nb = $('missions-import-btn'), hint = $('missions-import-hint');
    if (!nb) return;
    let googleConn = null, calyConn = null, msConn = null;
    let googleCfg = false, calyCfg = false, msCfg = false;
    try {
      const providers = (await fetchJson('/api/integrations/calendar')).providers || [];
      const gg  = providers.find((p) => p.key === 'google');
      const cly = providers.find((p) => p.key === 'calendly');
      const ms  = providers.find((p) => p.key === 'microsoft');
      googleConn = gg && gg.connection; googleCfg = !!(gg && gg.configured);
      calyConn   = cly && cly.connection; calyCfg  = !!(cly && cly.configured);
      msConn     = ms  && ms.connection;  msCfg    = !!(ms  && ms.configured);
    } catch { /* leave the button disabled */ }

    const anyConnected = !!((googleConn && googleConn.connected) ||
                            (calyConn   && calyConn.connected)  ||
                            (msConn     && msConn.connected));
    const anyConfigured = googleCfg || calyCfg || msCfg;

    // The "🎥 Generate meeting" button next to the URL field is gated by the
    // Google + Microsoft connection state, so toggle it here.
    refreshGenerateMeetingButton(msConn, googleConn);

    if (anyConnected) {
      _calImportMode = 'import'; nb.disabled = false;
      nb.textContent = 'Check upcoming meetings';
      const bits = [];
      if (msConn     && msConn.connected)     bits.push('Microsoft 365');
      if (googleConn && googleConn.connected) bits.push('Google');
      if (calyConn   && calyConn.connected)   bits.push('Calendly');
      nb.title = `Aggregated from ${bits.join(' + ')}`;
    } else if (anyConfigured) {
      _calImportMode = 'connect'; nb.disabled = false;
      nb.textContent = 'Connect a calendar';
      nb.title = 'Connect Google, Microsoft 365 or Calendly on the Integrations page';
    } else {
      _calImportMode = 'disabled'; nb.disabled = true;
      nb.textContent = 'Check upcoming meetings';
      nb.title = 'No calendar provider configured — set env vars first';
    }

    if (hint) {
      const connectedBits = [];
      if (msConn     && msConn.connected)     connectedBits.push(`Microsoft 365 (<strong>${escapeHtml(msConn.email || 'linked')}</strong>)`);
      if (googleConn && googleConn.connected) connectedBits.push(`Google (<strong>${escapeHtml(googleConn.email || 'linked')}</strong>)`);
      if (calyConn   && calyConn.connected)   connectedBits.push('Calendly');
      hint.innerHTML = connectedBits.length
        ? `Showing upcoming meetings from ${connectedBits.join(' + ')}. <a href="#integrations">Manage</a>`
        : `Connect a calendar in <a href="#integrations">Integrations</a> to skip the typing — or just fill the fields below.`;
    }
  }

  function _calPickerEsc(e) { if (e.key === 'Escape') closeCalendarPicker(); }
  function closeCalendarPicker() { const o = $('cal-picker-overlay'); if (o) o.classList.add('hidden'); }

  // Aggregated picker — pulls upcoming meetings from every connected source
  // (Microsoft 365 direct, Google direct, Calendly) in parallel, dedupes,
  // and renders one merged list with a source pill on each row. Replaces
  // the per-source picker; one button on the schedule form drives it.
  async function openAggregatedPicker() {
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
    overlay.querySelector('.cal-picker-title').textContent = 'Upcoming meetings — all sources';
    overlay.classList.remove('hidden');
    const body = overlay.querySelector('.cal-picker-body');
    body.innerHTML = '<div class="kb-subtle">Loading your upcoming meetings…</div>';

    // Figure out which sources are connected so we only fetch what's
    // available (and so we can render an honest empty state if none are).
    let msConn = false, calyConn = false, googleConn = false;
    let msCfg = false, calyCfg = false, googleCfg = false;
    try {
      const providers = (await fetchJson('/api/integrations/calendar')).providers || [];
      const ms = providers.find((p) => p.key === 'microsoft');
      const cl = providers.find((p) => p.key === 'calendly');
      const gg = providers.find((p) => p.key === 'google');
      msConn     = !!(ms && ms.connection && ms.connection.connected);
      calyConn   = !!(cl && cl.connection && cl.connection.connected);
      googleConn = !!(gg && gg.connection && gg.connection.connected);
      msCfg      = !!(ms && ms.configured);
      calyCfg    = !!(cl && cl.configured);
      googleCfg  = !!(gg && gg.configured);
    } catch (err) {
      body.innerHTML = `<div class="empty">Couldn't read integrations: ${escapeHtml(err.message)}</div>`;
      return;
    }

    if (!msConn && !calyConn && !googleConn) {
      body.innerHTML = `
        <div class="empty">
          <p>No connected calendar yet.</p>
          <p class="kb-subtle">${(msCfg || calyCfg || googleCfg)
            ? 'Connect one on the <a href="#integrations">Integrations page</a> and try again.'
            : 'None of the calendar providers are configured. Set their env vars and connect from <a href="#integrations">Integrations</a>.'}</p>
        </div>`;
      return;
    }

    const [msRes, calyRes, googleRes] = await Promise.allSettled([
      msConn     ? fetchJson('/api/integrations/microsoft/events?days=21') : Promise.resolve({ events: [] }),
      calyConn   ? fetchJson('/api/integrations/calendly/events?days=30')  : Promise.resolve({ events: [] }),
      googleConn ? fetchJson('/api/integrations/google/events?days=21')    : Promise.resolve({ events: [] }),
    ]);
    const errors = [];
    const events = [];
    if (msRes.status     === 'fulfilled') events.push(...(msRes.value.events     || []));
    else                                  errors.push(`Microsoft 365: ${msRes.reason.message}`);
    if (calyRes.status   === 'fulfilled') events.push(...(calyRes.value.events   || []));
    else                                  errors.push(`Calendly: ${calyRes.reason.message}`);
    if (googleRes.status === 'fulfilled') events.push(...(googleRes.value.events || []));
    else                                  errors.push(`Google: ${googleRes.reason.message}`);

    events.sort((a, b) => new Date(a.start) - new Date(b.start));
    // Dedupe by (join URL + start time) — same meeting can appear in both
    // Calendly (the booking) and Microsoft (the calendar event Calendly
    // created from the booking).
    const seen = new Set();
    const deduped = events.filter((ev) => {
      const key = `${(ev.url || '').toLowerCase()}|${ev.start || ''}`;
      if (key === '|' || !seen.has(key)) { seen.add(key); return true; }
      return false;
    });
    _calPickerEvents = deduped;

    const errorBanner = errors.length
      ? `<div class="kb-result error" style="margin: 0 0 10px 0">Partial load: ${escapeHtml(errors.join('; '))}</div>` : '';

    if (deduped.length === 0) {
      body.innerHTML = errorBanner + '<div class="empty">No upcoming meetings in the next 3 weeks.</div>';
      return;
    }

    body.innerHTML = errorBanner + `<div class="cal-picker-list">${deduped.map(calEventRow).join('')}</div>`;
    body.querySelectorAll('[data-cal-pick]').forEach((el) => {
      const pick = () => { applyCalendarEvent(_calPickerEvents[parseInt(el.dataset.calPick, 10)]); closeCalendarPicker(); };
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
    });
  }

  // Source badge mapping — each direct provider tags its events with its own
  // `provider` value so the row shows where the meeting came from.
  function sourcePill(ev) {
    const p = String(ev.provider || '').toLowerCase();
    if (p === 'calendly')  return '<span class="pill pill-info" title="Calendly booking">Calendly</span>';
    if (p === 'microsoft') return '<span class="pill pill-info" title="Microsoft 365 (direct Graph)">M365</span>';
    if (p === 'google')    return '<span class="pill pill-info" title="Google Calendar">Google</span>';
    return `<span class="pill pill-info" title="${escapeHtml(p || 'calendar')}">${escapeHtml((p || 'cal').toUpperCase().slice(0, 8))}</span>`;
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
        <div class="cal-event-title">${escapeHtml(ev.title || '(no title)')} ${sourcePill(ev)}</div>
        <div class="cal-event-meta">${escapeHtml(when)}${ev.url ? ' · has link' : ''}${attStr ? ' · ' + escapeHtml(attStr) : ''}</div>
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
    if (Array.isArray(s.prospectEmails) && s.prospectEmails.length) {
      // Replace chip state with the calendar-derived attendees. Names aren't
      // known at this point — they get filled in later when the rep edits.
      _missionAttendees = s.prospectEmails
        .filter((e) => typeof e === 'string' && /@/.test(e))
        .map((email) => ({ email, name: email, role: null }));
      renderMissionChips();
      syncAttendeesToHiddenField();
      // Try to attach to a real company so quick-add wires to the right id.
      if (s.companyName) loadAttendeeCandidatesForCompany(s.companyName);
    }
    if (s.notes && $('missions-notes')) {
      const cur = $('missions-notes').value.trim();
      $('missions-notes').value = cur ? `${cur}\n${s.notes}` : s.notes;
    }
    // Snap-autofill the tags from past missions against this company.
    snapAutofillForCompany($('missions-company').value);
    // Tell the rep whether this calendar event maps to an existing prospect or
    // will create a brand-new one when they schedule (matched on name + domain).
    updateProspectMatchBadge();
    const result = $('missions-form-result');
    if (result) {
      result.classList.remove('hidden', 'error'); result.classList.add('success');
      result.innerHTML = `Pulled from your calendar: <strong>${escapeHtml(ev.title || 'meeting')}</strong>. Review and adjust below, then schedule.`;
    }
  }

  // Normalize a domain/URL down to its bare host (drops protocol, www, path).
  function normProspectHost(d) {
    if (!d) return '';
    return String(d).trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  }

  // Match the schedule form's company-name + domain against the tenant's known
  // prospects (loaded into _missionsCompanyByName by populateScheduleForm).
  // Name match wins; otherwise fall back to a domain match — mirrors the
  // server's companies.findOrCreate dedup so the badge predicts the real outcome.
  function findProspectMatch(name, domain) {
    const nm = String(name || '').trim().toLowerCase();
    if (nm && _missionsCompanyByName.has(nm)) return _missionsCompanyByName.get(nm);
    const host = normProspectHost(domain);
    if (host) {
      for (const c of _missionsCompanyByName.values()) {
        if (normProspectHost(c.domain) === host) return c;
      }
    }
    return null;
  }

  // Render the new-vs-existing prospect badge under the company field.
  function updateProspectMatchBadge() {
    const el = $('missions-prospect-match');
    if (!el) return;
    const name = (($('missions-company') || {}).value || '').trim();
    const domain = (($('missions-domain') || {}).value || '').trim();
    if (!name && !domain) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const match = findProspectMatch(name, domain);
    el.classList.remove('hidden', 'is-new', 'is-existing');
    if (match) {
      el.classList.add('is-existing');
      el.innerHTML = `<span class="prospect-match-icon">✓</span> Existing prospect: <strong>${escapeHtml(match.name)}</strong>${match.domain ? ` <span class="kb-subtle">(${escapeHtml(match.domain)})</span>` : ''}`;
    } else {
      el.classList.add('is-new');
      el.innerHTML = `<span class="prospect-match-icon">✨</span> New prospect — <strong>${escapeHtml(name || domain)}</strong> will be added when you schedule.`;
    }
  }

  // ── Generate Teams meeting (Microsoft 365 direct) ────────────────────────
  // Modal for creating a Teams meeting on the rep's calendar + writing the
  // resulting joinUrl into the schedule form's meeting URL field. Pre-fills
  // start from the form's existing scheduledAt input; the resulting Outlook
  // event sends invites to the picked attendees on behalf of the rep.

  let _teamsAttendees = []; // [{ email, displayName, company }]
  let _teamsContactsCache = []; // last provider /contacts autocomplete response
  let _teamsApolloCache = [];   // last Apollo autocomplete response
  let _teamsContactsTimer = null;
  // When set, the modal is in EDIT mode: submitting hits PATCH on this
  // event id instead of POSTing a new meeting. Cleared on open/close.
  let _teamsEditContext = null; // { provider, eventId, missionId, mission } | null

  // The provider the meeting modal currently targets ('microsoft' | 'google').
  // Set when the modal opens (from the connected provider, or the mission being
  // edited). The two providers share the whole modal — only the API endpoints
  // and a few labels differ. See ADR-0002.
  let _meetingProvider = 'microsoft';
  let _meetingConns = { microsoft: null, google: null };
  const MEETING_PROVIDERS = {
    microsoft: { api: 'microsoft', label: 'Teams meeting', evField: 'ms', reconnect: (b) => microsoftReconnect(b),
                 dataset: { id: 'msEventId', uid: 'msIcalUid', org: 'msOrganizerEmail' } },
    google:    { api: 'google',    label: 'Google Meet',   evField: 'g',  reconnect: (b) => googleReconnect(b),
                 dataset: { id: 'googleEventId', uid: 'googleIcalUid', org: 'googleOrganizerEmail' } },
  };
  function meetingMeta(p) { return MEETING_PROVIDERS[p || _meetingProvider] || MEETING_PROVIDERS.microsoft; }
  // Prefer Microsoft when both are connected (preserves prior behaviour);
  // otherwise pick whichever is connected.
  function defaultMeetingProvider() {
    if (_meetingConns.microsoft && _meetingConns.microsoft.connected) return 'microsoft';
    if (_meetingConns.google && _meetingConns.google.connected) return 'google';
    return 'microsoft';
  }

  async function openGenerateTeamsModal(opts) {
    opts = opts || {};
    // Edit mode iff an eventId was passed; otherwise create mode.
    _teamsEditContext = opts.eventId ? opts : null;
    _meetingProvider = opts.provider || defaultMeetingProvider();
    const meta = meetingMeta();
    const attField = `${meta.evField}_attendee_emails`; // ms_attendee_emails | g_attendee_emails

    // Defaults — either pulled from the mission being edited, or from the
    // surrounding schedule form (create mode).
    let subject, startStr, durationMin = 30, bodyStr = '';
    if (_teamsEditContext) {
      const m = _teamsEditContext.mission || {};
      subject = m.company_name ? `DealScope call · ${m.company_name}`.trim() : 'DealScope call';
      // Convert the mission's scheduled_at (UTC ISO) into the datetime-local
      // shape the input expects.
      const d = m.scheduled_at ? new Date(m.scheduled_at) : new Date(Date.now() + 30 * 60_000);
      const pad = (n) => String(n).padStart(2, '0');
      startStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      _teamsAttendees = ((m[attField] && m[attField].length ? m[attField] : m.prospect_emails) || [])
        .map((email) => ({ email, displayName: email }));
    } else {
      const company = ($('missions-company') && $('missions-company').value || '').trim();
      subject = company ? `DealScope call · ${company}` : 'DealScope call';
      const formStart = ($('missions-scheduled-at') && $('missions-scheduled-at').value) || '';
      startStr = formStart || (() => {
        const d = new Date(Date.now() + 30 * 60_000);
        d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      })();
      // Seed attendees from the prospect emails the rep may have already typed.
      const prospects = ($('missions-emails') && $('missions-emails').value || '')
        .split(/[\s,;]+/).map((s) => s.trim()).filter((s) => /@/.test(s));
      _teamsAttendees = prospects.map((email) => ({ email, displayName: email }));
    }

    let overlay = $('teams-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'teams-modal-overlay';
      overlay.className = 'cal-picker-overlay';
      overlay.innerHTML = `
        <div class="cal-picker teams-modal">
          <div class="cal-picker-h">
            <span class="cal-picker-title">🎥 Generate meeting</span>
            <button type="button" class="kb-link-btn cal-picker-close">✕</button>
          </div>
          <div class="cal-picker-body">
            <div class="kb-form teams-form">
              <div class="field">
                <label for="teams-subject">Subject</label>
                <input id="teams-subject" type="text" maxlength="250">
              </div>
              <div class="field kb-inline-pair">
                <div>
                  <label for="teams-start">Starts</label>
                  <input id="teams-start" type="datetime-local">
                </div>
                <div>
                  <label for="teams-duration">Duration</label>
                  <select id="teams-duration">
                    <option value="15">15 min</option>
                    <option value="30" selected>30 min</option>
                    <option value="45">45 min</option>
                    <option value="60">1 hour</option>
                    <option value="90">1.5 hours</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label for="teams-attendee-input">Attendees <span class="kb-subtle">(start typing a name or email)</span></label>
                <div class="teams-chips" id="teams-chips"></div>
                <div class="teams-autocomplete-wrap">
                  <input id="teams-attendee-input" type="text" placeholder="alice@acme.com or 'Alice Doe'">
                  <div class="teams-autocomplete-results hidden" id="teams-ac-results"></div>
                </div>
              </div>
              <div class="field">
                <label for="teams-body">Agenda <span class="kb-subtle">(optional, sent in the invite)</span></label>
                <textarea id="teams-body" rows="3" placeholder="Quick discovery call to walk through your current stack…"></textarea>
              </div>
              <div class="teams-modal-actions">
                <button type="button" class="kb-secondary-btn" id="teams-cancel-btn">Cancel</button>
                <button type="button" class="primary-cta" id="teams-submit-btn">Create + insert URL</button>
              </div>
              <div class="kb-result hidden" id="teams-modal-result"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGenerateTeamsModal(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', closeGenerateTeamsModal);
      $('teams-cancel-btn').addEventListener('click', closeGenerateTeamsModal);
      $('teams-submit-btn').addEventListener('click', submitGenerateTeams);
      $('teams-attendee-input').addEventListener('input', onAttendeeInput);
      $('teams-attendee-input').addEventListener('keydown', onAttendeeKeyDown);
      $('teams-attendee-input').addEventListener('blur', () => setTimeout(() => $('teams-ac-results').classList.add('hidden'), 150));
      document.addEventListener('keydown', _teamsEsc);
    }

    $('teams-subject').value  = subject;
    $('teams-start').value    = startStr;
    $('teams-duration').value = String(durationMin);
    $('teams-body').value     = bodyStr;
    $('teams-attendee-input').value = '';
    $('teams-modal-result').classList.add('hidden');
    // Reflect mode + provider in the title + submit button.
    const titleEl  = overlay.querySelector('.cal-picker-title');
    const submitEl = $('teams-submit-btn');
    if (_teamsEditContext) {
      if (titleEl)  titleEl.textContent = `🎥 Edit ${meta.label}`;
      if (submitEl) submitEl.textContent = 'Save changes';
    } else {
      if (titleEl)  titleEl.textContent = `🎥 Generate ${meta.label}`;
      if (submitEl) submitEl.textContent = 'Create + insert URL';
    }
    renderTeamsChips();
    overlay.classList.remove('hidden');
    setTimeout(() => $('teams-subject').focus(), 50);
  }

  function _teamsEsc(e) { if (e.key === 'Escape') closeGenerateTeamsModal(); }
  function closeGenerateTeamsModal() {
    const o = $('teams-modal-overlay'); if (o) o.classList.add('hidden');
  }

  function renderTeamsChips() {
    const host = $('teams-chips');
    if (!host) return;
    if (_teamsAttendees.length === 0) {
      host.innerHTML = '<span class="kb-subtle teams-chips-empty">No attendees yet — pick from the suggestions below or type an email.</span>';
      return;
    }
    host.innerHTML = _teamsAttendees.map((a, i) => `
      <span class="teams-chip" title="${escapeHtml(a.email)}">
        <span>${escapeHtml(a.displayName || a.email)}</span>
        <button type="button" class="teams-chip-x" data-teams-chip-remove="${i}" aria-label="Remove">✕</button>
      </span>`).join('');
    host.querySelectorAll('[data-teams-chip-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        _teamsAttendees.splice(parseInt(b.dataset.teamsChipRemove, 10), 1);
        renderTeamsChips();
      }));
  }

  function onAttendeeInput() {
    const q = $('teams-attendee-input').value.trim();
    if (_teamsContactsTimer) clearTimeout(_teamsContactsTimer);
    if (q.length < 1) {
      $('teams-ac-results').classList.add('hidden');
      return;
    }
    _teamsContactsTimer = setTimeout(() => fetchAttendeeSuggestions(q), 250);
  }

  async function fetchAttendeeSuggestions(q) {
    const host = $('teams-ac-results');
    host.classList.remove('hidden');
    host.innerHTML = '<div class="kb-subtle teams-ac-loading">Searching your contacts…</div>';
    // Three sources in parallel: prospect_contacts (Name/Email/Role on file
    // for the buyer side), Microsoft /me/people (rep's address book), and
    // Apollo (extra decision-makers at the prospect's domain). Prospect
    // contacts win top slots — they're the people the rep is actually
    // trying to invite to *this* call.
    let prospectMatches = [];
    let msMatches = [];
    let apolloMatches = [];
    let msError = null;
    const meta = meetingMeta();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (_missionCandidateCompanyId) params.set('companyId', _missionCandidateCompanyId);
    // For Apollo, derive the company's domain from the picked company so we
    // only suggest people *at the prospect company*, not a global search.
    const companyForApollo = _prospectsState && _prospectsState.companies
      ? (_prospectsState.companies.find((c) => c.id === _missionCandidateCompanyId) || null) : null;
    const apolloDomain = companyForApollo && companyForApollo.domain;
    // The rep's own address book comes from whichever calendar provider the
    // modal targets (Microsoft /me/people or Google People API).
    const [prospectRes, msRes, apolloRes] = await Promise.allSettled([
      fetchJson(`/api/contacts?${params.toString()}`),
      fetchJson(`/api/integrations/${meta.api}/contacts?q=${encodeURIComponent(q)}`),
      apolloDomain ? fetchJson(`/api/contacts/apollo-search?domain=${encodeURIComponent(apolloDomain)}&q=${encodeURIComponent(q || '')}`) : Promise.resolve({ people: [] }),
    ]);
    if (prospectRes.status === 'fulfilled') prospectMatches = (prospectRes.value.contacts || []).slice(0, 6);
    if (msRes.status === 'fulfilled') msMatches = msRes.value.contacts || [];
    else                              msError = msRes.reason.message;
    if (apolloRes.status === 'fulfilled') apolloMatches = apolloRes.value.people || [];
    _teamsContactsCache = msMatches;
    // Stash Apollo results so the pick handler can read them by index.
    _teamsApolloCache = apolloMatches;

    let rows = '';
    if (prospectMatches.length) {
      rows += prospectMatches.map((c, i) => `
        <div class="teams-ac-row" data-teams-prospect-pick="${i}">
          <div class="teams-ac-name">${escapeHtml(c.name)} <span class="pill pill-info" title="On file for this prospect">contact</span></div>
          <div class="teams-ac-meta kb-subtle">${escapeHtml(c.email)} · ${escapeHtml(c.role || 'Unknown')}${c.company_name ? ' · ' + escapeHtml(c.company_name) : ''}</div>
        </div>`).join('');
    }
    if (apolloMatches.length) {
      rows += apolloMatches.filter((p) => p && p.email).map((p, i) => `
        <div class="teams-ac-row" data-teams-apollo-pick="${i}">
          <div class="teams-ac-name">${escapeHtml(p.name || p.email)} <span class="pill pill-info" title="From Apollo">Apollo</span></div>
          <div class="teams-ac-meta kb-subtle">${escapeHtml(p.email)}${p.emailStatus === 'verified' ? ' ✓' : ''}${p.title ? ' · ' + escapeHtml(p.title) : ''}${p.company ? ' · ' + escapeHtml(p.company) : ''}</div>
        </div>`).join('');
    }
    if (msMatches.length) {
      rows += msMatches.map((c, i) => `
        <div class="teams-ac-row" data-teams-pick="${i}">
          <div class="teams-ac-name">${escapeHtml(c.displayName)}</div>
          <div class="teams-ac-meta kb-subtle">${escapeHtml(c.email)}${c.company ? ' · ' + escapeHtml(c.company) : ''}${c.jobTitle ? ' · ' + escapeHtml(c.jobTitle) : ''}</div>
        </div>`).join('');
    }
    if (!prospectMatches.length && !msMatches.length && !apolloMatches.length) {
      if (/@/.test(q)) {
        rows += `<div class="teams-ac-row teams-ac-freeform" data-teams-pick-freeform="${escapeHtml(q)}">Add <strong>${escapeHtml(q)}</strong> as a guest</div>`;
      } else {
        rows += `<div class="kb-subtle teams-ac-empty">No matches in your contacts${msError ? ` (contacts search failed: ${escapeHtml(msError)})` : ''}.</div>`;
      }
    } else if (/@/.test(q) && !prospectMatches.some((c) => c.email.toLowerCase() === q.toLowerCase())
            && !msMatches.some((c) => c.email.toLowerCase() === q.toLowerCase())) {
      rows += `<div class="teams-ac-row teams-ac-freeform" data-teams-pick-freeform="${escapeHtml(q)}">Add <strong>${escapeHtml(q)}</strong> as a guest</div>`;
    }

    host.innerHTML = rows;

    host.querySelectorAll('[data-teams-prospect-pick]').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const c = prospectMatches[parseInt(el.dataset.teamsProspectPick, 10)];
        if (c) pickAttendee({ email: c.email, displayName: c.name, company: c.company_name || null });
      }));
    host.querySelectorAll('[data-teams-apollo-pick]').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const p = apolloMatches[parseInt(el.dataset.teamsApolloPick, 10)];
        if (p && p.email) pickAttendee({ email: p.email, displayName: p.name || p.email, company: p.company || null });
      }));
    host.querySelectorAll('[data-teams-pick]').forEach((el) =>
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pickAttendee(_teamsContactsCache[parseInt(el.dataset.teamsPick, 10)]); }));
    host.querySelectorAll('[data-teams-pick-freeform]').forEach((el) =>
      el.addEventListener('mousedown', (e) => { e.preventDefault(); pickAttendee({ email: el.dataset.teamsPickFreeform, displayName: el.dataset.teamsPickFreeform }); }));
  }

  function onAttendeeKeyDown(e) {
    // Enter on a parseable email → add as a freeform attendee (no contact match needed).
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = $('teams-attendee-input').value.trim();
      if (/@/.test(v)) pickAttendee({ email: v, displayName: v });
    }
  }

  function pickAttendee(c) {
    if (!c || !c.email) return;
    const exists = _teamsAttendees.some((a) => a.email.toLowerCase() === c.email.toLowerCase());
    if (!exists) _teamsAttendees.push({ email: c.email, displayName: c.displayName || c.email, company: c.company || null });
    $('teams-attendee-input').value = '';
    $('teams-ac-results').classList.add('hidden');
    renderTeamsChips();
    $('teams-attendee-input').focus();
  }

  async function submitGenerateTeams() {
    const subject = $('teams-subject').value.trim();
    const startStr = $('teams-start').value;
    const dur = parseInt($('teams-duration').value, 10) || 30;
    const body = $('teams-body').value.trim();
    const result = $('teams-modal-result');
    result.classList.remove('hidden', 'error', 'success');
    if (!subject) { result.classList.add('error'); result.textContent = 'Subject is required.'; return; }
    if (!startStr) { result.classList.add('error'); result.textContent = 'Start time is required.'; return; }
    const startDate = new Date(startStr);
    if (isNaN(startDate.getTime())) { result.classList.add('error'); result.textContent = "Couldn't parse the start time."; return; }
    const endDate = new Date(startDate.getTime() + dur * 60_000);
    const submitBtn = $('teams-submit-btn');
    submitBtn.disabled = true; const orig = submitBtn.textContent;
    submitBtn.textContent = _teamsEditContext ? 'Saving…' : 'Creating…';
    const meta = meetingMeta();
    try {
      const editing = !!_teamsEditContext;
      const url = editing
        ? `/api/integrations/${meta.api}/meetings/${encodeURIComponent(_teamsEditContext.eventId)}`
        : `/api/integrations/${meta.api}/meetings`;
      const r = await fetch(url, {
        method: editing ? 'PATCH' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject,
          startISO: startDate.toISOString(),
          endISO:   endDate.toISOString(),
          attendees: _teamsAttendees.map((a) => ({ email: a.email, name: a.displayName })),
          body,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (j.code === 'CONSENT_REQUIRED') {
          // Build a richer error UI: message + a one-click reconnect button.
          const provName = meta.api === 'google' ? 'Google' : 'Microsoft 365';
          result.classList.add('error');
          result.innerHTML = `
            <strong>Reconnect ${escapeHtml(provName)} to grant the required permissions.</strong>
            Your connection may have expired, or was made before meeting creation was enabled.
            <div style="margin-top:8px"><button type="button" class="primary-cta" id="teams-reconnect-btn">Disconnect &amp; reconnect now →</button></div>`;
          const rc = $('teams-reconnect-btn');
          if (rc) rc.addEventListener('click', () => meta.reconnect(rc));
          return;
        }
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      // Write back into the parent schedule form (create mode only).
      if (!editing) {
        const urlEl = $('missions-url');
        if (urlEl) {
          urlEl.value = j.joinUrl;
          // Clear any stale linkage from a previous provider, then stash the
          // current provider's identifiers so the mission form's submit handler
          // forwards them to the API, letting Edit / Cancel work later.
          delete urlEl.dataset.msEventId; delete urlEl.dataset.msIcalUid; delete urlEl.dataset.msOrganizerEmail;
          delete urlEl.dataset.googleEventId; delete urlEl.dataset.googleIcalUid; delete urlEl.dataset.googleOrganizerEmail;
          urlEl.dataset[meta.dataset.id]  = j.eventId || '';
          urlEl.dataset[meta.dataset.uid] = j.iCalUId || '';
          urlEl.dataset[meta.dataset.org] = j.organizerEmail || '';
        }
      }
      if (!editing && $('missions-scheduled-at') && !$('missions-scheduled-at').value) {
        // Only fill the When field if it was empty — don't clobber what the rep typed.
        const local = new Date(j.startISO || startDate.toISOString());
        const pad = (n) => String(n).padStart(2, '0');
        $('missions-scheduled-at').value =
          `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
      }
      // Merge picked attendees into the prospect emails textarea (de-dup).
      if (!editing && $('missions-emails')) {
        const existing = $('missions-emails').value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
        const merged = [...new Set([...existing, ..._teamsAttendees.map((a) => a.email)])];
        $('missions-emails').value = merged.join('\n');
      }
      // Render the outcome. The invite step is separate from meeting
      // creation — the meeting is on the rep's calendar regardless; if any
      // invite failed we surface per-recipient status so the rep can resend.
      const inv = j.invite || { sent: [], totalAttempted: 0, branding: {} };
      const ok = inv.sent.filter((x) => x.ok);
      const failed = inv.sent.filter((x) => !x.ok);
      const fromLine = inv.branding && inv.branding.fromEmail
        ? `from <strong>${escapeHtml(inv.branding.fromEmail)}</strong>`
        : 'via SendGrid';
      if (failed.length === 0 && ok.length > 0) {
        result.classList.add('success');
        result.innerHTML = `
          ✅ ${escapeHtml(meta.label)} created · invite delivered to ${ok.length} attendee${ok.length === 1 ? '' : 's'} ${fromLine}.
          <a href="${escapeHtml(j.joinUrl)}" target="_blank" rel="noopener">Open meeting ↗</a>`;
      } else if (failed.length > 0 && ok.length > 0) {
        result.classList.add('error');
        result.innerHTML = `
          ⚠️ Meeting created and ${ok.length} invite${ok.length === 1 ? '' : 's'} sent, but ${failed.length} failed:
          <ul style="margin:6px 0 0 18px;font-size:12.5px">
            ${failed.map((f) => `<li><code>${escapeHtml(f.email)}</code> — ${escapeHtml(f.reason || 'unknown')}</li>`).join('')}
          </ul>`;
      } else if (failed.length > 0) {
        result.classList.add('error');
        result.innerHTML = `
          ⚠️ Meeting created but no invites could be sent:
          <ul style="margin:6px 0 0 18px;font-size:12.5px">
            ${failed.map((f) => `<li><code>${escapeHtml(f.email)}</code> — ${escapeHtml(f.reason || 'unknown')}</li>`).join('')}
          </ul>
          The meeting URL is in the form below; you can share it manually.`;
      } else {
        // No attendees were provided — meeting exists for the rep only.
        result.classList.add('success');
        result.innerHTML = `
          ✅ ${escapeHtml(meta.label)} created on your calendar.
          <a href="${escapeHtml(j.joinUrl)}" target="_blank" rel="noopener">Open meeting ↗</a>`;
      }
      // Only auto-close if everything succeeded; otherwise keep the modal
      // open so the rep can read the failure list. In edit mode, refresh
      // the mission detail view so updated values render.
      if (failed.length === 0) {
        if (editing && _teamsEditContext.missionId) {
          const mid = _teamsEditContext.missionId;
          setTimeout(() => { closeGenerateTeamsModal(); openMissionDetail(mid); }, 1500);
        } else {
          setTimeout(closeGenerateTeamsModal, 1800);
        }
      }
    } catch (err) {
      result.classList.add('error');
      result.textContent = `Couldn't create the meeting: ${err.message}`;
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = orig;
    }
  }

  // Toggle the "Generate meeting" button based on the Google + Microsoft
  // connection state. Enabled when EITHER provider is connected; the modal
  // picks the provider at open time (Microsoft preferred when both linked).
  async function refreshGenerateMeetingButton(msConn, googleConn) {
    _meetingConns = { microsoft: msConn || null, google: googleConn || null };
    const b = $('missions-generate-teams-btn');
    if (!b) return;
    const msOk = !!(msConn && msConn.connected);
    const ggOk = !!(googleConn && googleConn.connected);
    if (msOk || ggOk) {
      b.disabled = false;
      const which = msOk && ggOk
        ? `Microsoft 365 (${msConn.email || 'connected'}) — Google also linked`
        : msOk ? `Microsoft 365 (${msConn.email || 'connected'})`
               : `Google (${googleConn.email || 'connected'})`;
      b.textContent = msOk && !ggOk ? '🎥 Generate Teams meeting'
                    : ggOk && !msOk ? '🎥 Generate Google Meet'
                    : '🎥 Generate meeting';
      b.title = `Create a meeting on your calendar · ${which}`;
    } else {
      b.disabled = true;
      b.textContent = '🎥 Generate meeting';
      b.title = 'Connect Google or Microsoft 365 in Integrations first';
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
    const pill = (ok) => ok
      ? '<span class="pill pill-ok">live</span>'
      : '<span class="pill pill-warn">no key</span>';
    return `<div class="stat-card provider-card">
      <div class="stat-label">Providers</div>
      <div class="provider-row"><span class="provider-name">Firecrawl</span>${pill(providers.firecrawl)}</div>
      <div class="provider-row"><span class="provider-name">Brave Search</span>${pill(providers.brave)}</div>
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
    // Schedule is the primary action, so it's the first/default tab. (A
    // "Brief an engagement" prefill also lands here and is consumed by the form.)
    await switchMissionsTab('schedule');
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
    if (when === 'past') loadUnlinkedRecordings();
    if (rows.length === 0) {
      host.innerHTML = `<div class="empty">No ${when} engagements. Go to Schedule to add one.</div>`;
      return;
    }
    host.innerHTML = `
      <table class="dt">
        <thead><tr>
          <th>Company</th><th>Scheduled</th><th>Focus</th><th>Brief</th><th>Recording</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map(missionRow).join('')}</tbody>
      </table>`;
    host.querySelectorAll('[data-mission-open]').forEach((el) => {
      el.addEventListener('click', () => openMissionDetail(el.dataset.missionOpen));
    });
    host.querySelectorAll('[data-rec-open]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
    host.querySelectorAll('[data-mission-cancel]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Cancel this engagement? Any generated brief is preserved.')) return;
        const r = await fetch(`/api/missions/${btn.dataset.missionCancel}`, { method: 'DELETE', credentials: 'include' });
        if (!r.ok) {
          const b = await r.json().catch(() => ({}));
          alert(b.error || `HTTP ${r.status}`);
          return;
        }
        await loadMissionsList(when);
      });
    });

    // After rendering Past, surface a one-time "pull intelligence" nudge for the
    // most recent completed engagement against a still-un-researched prospect —
    // covers the case where the rep wasn't watching the detail when it finished.
    if (when === 'past') {
      const prompted = intelPromptedSet();
      const candidate = rows
        .filter((m) => m.status === 'COMPLETED' && m.company_id && !prompted.has(m.id))
        .sort((a, b) => new Date(b.scheduled_at || 0) - new Date(a.scheduled_at || 0))[0];
      if (candidate) maybePromptIntelForCompletedMission(candidate);
    }
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
    const recordingCell = m.portal_id
      ? `<a class="kb-link-btn" data-rec-open href="/portal/?id=${escapeHtml(m.portal_id)}" target="_blank" rel="noopener">▶ Open ↗</a>`
      : '<span class="kb-subtle">—</span>';
    return `
      <tr class="missions-row" data-mission-open="${escapeHtml(m.id)}">
        <td>
          <div><strong>${escapeHtml(m.company_name || '—')}</strong></div>
          <div class="kb-row-sub">${escapeHtml(m.company_domain || '')}</div>
        </td>
        <td>${escapeHtml(when)}</td>
        <td class="mono kb-row-sub">${escapeHtml(engagement.join(' · ') || '—')}</td>
        <td>${briefBadge}</td>
        <td>${recordingCell}</td>
        <td><span class="pill ${pillClass}">${escapeHtml(status)}</span></td>
        <td>${status === 'COMPLETED' || status === 'CANCELLED' ? '' :
          `<button class="kb-link-btn" data-mission-cancel="${escapeHtml(m.id)}">Cancel</button>`}
        </td>
      </tr>`;
  }

  // The post-call half of an engagement: its recording + AI analysis (the
  // "portal"). Resolves the portal from the engagement's portal_id (written when
  // the call completes) or, for older calls, via the calls store by missionId.
  async function renderEngagementRecording(m, missionId) {
    const host = $('missions-recording');
    if (!host) return;
    let portalId = m.portal_id || null;
    if (!portalId) {
      try {
        const cl = await fetchJson(`/api/admin/calls?mission_id=${encodeURIComponent(missionId)}&limit=10`);
        const ready = (cl.calls || []).find((c) => c.status === 'ready' && c.portal && c.portal.id);
        if (ready) portalId = ready.portal.id;
      } catch { /* ignore */ }
    }
    if (!portalId) {
      host.innerHTML = m.status === 'COMPLETED'
        ? '<div class="missions-recording-card kb-subtle">Recording is processing — check back shortly.</div>'
        : '';
      return;
    }
    host.innerHTML = '<div class="missions-recording-card kb-subtle">Loading recording…</div>';
    let p;
    try { const r = await fetchJson(`/api/portals/${encodeURIComponent(portalId)}`); p = r.portal; }
    catch {
      host.innerHTML = `<div class="missions-recording-card"><div class="missions-recording-h">Recording & analysis</div><div class="rec-actions"><a class="primary-cta" href="/portal/?id=${escapeHtml(portalId)}" target="_blank" rel="noopener">▶ Open recording ↗</a></div></div>`;
      return;
    }
    const objection = p && p.moments && p.moments.objection && p.moments.objection.quote;
    // Consolidated report one-liner (new shape), falling back to the legacy
    // SOW scope line on portals analysed before the rename.
    const reportLine = p && ((p.report && p.report.overview) || (p.sowSummary && p.sowSummary.scopeOneLine)) || '';
    const participants = ((p && p.participants) || []).map((x) => x.name || x.role).filter(Boolean);
    host.innerHTML = `
      <div class="missions-recording-card">
        <div class="missions-recording-h">Recording & analysis</div>
        ${participants.length ? `<div class="kb-subtle rec-participants">${participants.map(escapeHtml).join(' · ')}</div>` : ''}
        ${objection ? `<div class="rec-moment"><span class="rec-label">Top objection</span> “${escapeHtml(objection)}”</div>` : ''}
        ${reportLine ? `<div class="rec-moment"><span class="rec-label">Report</span> ${escapeHtml(reportLine.slice(0, 240))}${reportLine.length > 240 ? '…' : ''}</div>` : ''}
        <div class="rec-actions">
          <a class="primary-cta" href="/portal/?id=${escapeHtml(portalId)}" target="_blank" rel="noopener">▶ Open full recording ↗</a>
          <button class="kb-secondary-btn" id="missions-arena-btn">🎭 Practice in Arena</button>
        </div>
      </div>`;
    const arenaBtn = $('missions-arena-btn');
    if (arenaBtn) arenaBtn.addEventListener('click', async () => {
      arenaBtn.disabled = true; const o = arenaBtn.textContent; arenaBtn.textContent = 'Starting…';
      try {
        const r = await fetchJson('/api/arena/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ portalId }) });
        const url = (r && r.arenaUrl) || (r && r.sessionId ? `/arena/?id=${encodeURIComponent(r.sessionId)}` : null);
        if (url) window.open(url, '_blank', 'noopener');
      } catch (err) { alert(`Couldn't start Arena: ${err.message}`); }
      finally { arenaBtn.disabled = false; arenaBtn.textContent = o; }
    });
  }

  // Recordings with no scheduled engagement (ad-hoc bots, calendar imports). Shown
  // under the Past tab so nothing is lost when Calls folds into Engagements.
  async function loadUnlinkedRecordings() {
    const host = $('missions-unlinked-recordings');
    if (!host) return;
    let calls = [];
    try { const r = await fetchJson('/api/admin/calls?limit=25'); calls = (r.calls || []).filter((c) => !(c.meeting && c.meeting.missionId)); }
    catch { host.innerHTML = ''; return; }
    if (!calls.length) { host.innerHTML = ''; return; }
    host.innerHTML = `
      <div class="card" style="margin-top:14px">
        <div class="card-h">Unlinked recordings <span class="pf-hint">Recordings that aren't tied to a scheduled call — from ad-hoc notetakers or calendar imports.</span></div>
        <div class="card-b table-wrap">
          <table class="dt">
            <thead><tr><th>Title</th><th>Source</th><th>Status</th><th>Duration</th><th>Created</th><th></th></tr></thead>
            <tbody>${calls.map((c) => {
              const portal = c.portal || null;
              const title = (portal && portal.title) || (c.meeting && (c.meeting.title || c.meeting.meetingUrl)) || c.id;
              const action = (c.status === 'ready' && portal) ? `<a href="/portal/?id=${encodeURIComponent(portal.id)}" target="_blank" rel="noopener">Open ↗</a>` : '<span class="kb-subtle">—</span>';
              return `<tr>
                <td class="truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</td>
                <td><span class="pill">${escapeHtml(c.source || '—')}</span></td>
                <td><span class="pill">${escapeHtml(c.status || 'pending')}</span></td>
                <td class="mono">${fmtDuration((c.meeting || {}).durationSeconds)}</td>
                <td>${escapeHtml(fmtDate(c.createdAt))}</td>
                <td>${action}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </div>`;
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
    $('missions-detail-title').textContent = `${m.company_name || 'Engagement'} — ${m.scheduled_at ? new Date(m.scheduled_at).toLocaleString() : '(no time)'}`;

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
        <div class="k">Focus</div><div class="v mono">${[
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
        ${(m.ms_event_id || m.g_event_id) ? `
          <button class="kb-secondary-btn" id="missions-edit-teams-btn" title="Update the calendar event + re-send invites">🎥 Edit ${m.g_event_id ? 'Google Meet' : 'Teams meeting'}</button>
          <button class="kb-secondary-btn" id="missions-cancel-teams-btn" title="Cancel the calendar event + notify attendees">🛑 Cancel ${m.g_event_id ? 'Google Meet' : 'Teams meeting'}</button>` : ''}
        <span class="kb-action-hint">Generate brief: researches the web and writes your prep notes. Send bot: sends an AI notetaker to join the call (~30s).</span>
      </div>
      ${hasBrief ? `
        <div class="missions-brief-frame">
          <div class="missions-brief-meta">Generated ${fmtDate(brief.generated_at)} · ${(brief.retrieved_citations || []).length} chunks retrieved · ${(brief.transient_doc_ids || []).length} transient docs</div>
          <article class="missions-brief-content" id="missions-brief-render"></article>
        </div>
      ` : `<div class="empty">No brief generated yet.</div>`}
      <div id="missions-recording" class="missions-recording"></div>
    `;
    if (hasBrief) {
      $('missions-brief-render').innerHTML = renderMarkdown(brief.content_md);
    }
    renderEngagementRecording(m, id);
    document.getElementById('missions-brief-now-btn').addEventListener('click', async () => {
      const btn = document.getElementById('missions-brief-now-btn');
      btn.disabled = true; btn.textContent = 'Generating…';
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
          alert(`Brief failed — AI quota exhausted.\n\n${err.message}\n\nThe engagement has been marked FAILED with this reason; click "Re-generate brief" once the quota resets or a new key is in place.`);
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
        if (hasBot && !confirm('A Recall bot has already been dispatched for this engagement. Send another one?')) return;
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
            alert(`A bot was already dispatched for this engagement (${b.botId}). Use the Meetings page to view its status.`);
          } else {
            alert(`Recall.ai bot dispatched.\nBot id: ${b.botId}\nStatus: ${b.botStatus || 'pending'}\n\nIt should join within ~30s. Tracking row created on the Meetings page.`);
          }
          await openMissionDetail(id);
        } catch (err) {
          if (err.code === 'BAD_MEETING_URL') {
            alert(`Bot dispatch rejected: ${err.message}\n\nFix the meeting URL on this engagement (must be meet.google.com / zoom.us / teams) and retry.`);
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

    // Which provider generated this mission's meeting? g_event_id → Google,
    // else ms_event_id → Microsoft. Drives the modal + the cancel endpoint.
    const mtgProvider = m.g_event_id ? 'google' : 'microsoft';
    const mtgEventId  = m.g_event_id || m.ms_event_id;
    const mtgLabel    = mtgProvider === 'google' ? 'Google Meet' : 'Teams meeting';
    const mtgAttendees = (mtgProvider === 'google' ? m.g_attendee_emails : m.ms_attendee_emails) || [];

    // Edit meeting — reopens the modal in edit mode, prefilled from this
    // mission. Only rendered when a provider event id is set.
    const editTeamsBtn = document.getElementById('missions-edit-teams-btn');
    if (editTeamsBtn) {
      editTeamsBtn.addEventListener('click', () => {
        openGenerateTeamsModal({ provider: mtgProvider, eventId: mtgEventId, missionId: id, mission: m });
      });
    }
    // Cancel meeting — deletes the calendar event + sends a CANCEL .ics to
    // every attendee on the original invite.
    const cancelTeamsBtn = document.getElementById('missions-cancel-teams-btn');
    if (cancelTeamsBtn) {
      cancelTeamsBtn.addEventListener('click', async () => {
        const attendeeCount = mtgAttendees.length;
        if (!confirm(`Cancel this ${mtgLabel}? The calendar event will be deleted and ${attendeeCount} attendee${attendeeCount === 1 ? '' : 's'} will receive a cancellation notice from meetings@eel-global.com.`)) return;
        cancelTeamsBtn.disabled = true; cancelTeamsBtn.textContent = 'Cancelling…';
        try {
          const r = await fetch(`/api/integrations/${mtgProvider}/meetings/${encodeURIComponent(mtgEventId)}`, {
            method: 'DELETE', credentials: 'include',
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          const inv = j.invite || { sent: [] };
          const ok = inv.sent.filter((x) => x.ok).length;
          const failed = inv.sent.filter((x) => !x.ok);
          let summary = `${mtgLabel} cancelled. ${ok} cancellation notice${ok === 1 ? '' : 's'} sent.`;
          if (failed.length) summary += `\n\nFailed for: ${failed.map((f) => `${f.email} (${f.reason})`).join(', ')}`;
          alert(summary);
          await openMissionDetail(id);
        } catch (err) {
          alert(`Couldn't cancel: ${err.message}`);
          cancelTeamsBtn.disabled = false;
          cancelTeamsBtn.textContent = `🛑 Cancel ${mtgLabel}`;
        }
      });
    }

    // Watch for completion. If the call hasn't finished processing yet, poll so
    // we can nudge the rep to pull intelligence the moment the engagement flips
    // to COMPLETED. If it's already COMPLETED, offer the pull right away.
    if (['COMPLETED', 'CANCELLED', 'FAILED'].includes(String(m.status))) {
      stopMissionCompletionPoll();
      if (m.status === 'COMPLETED') maybePromptIntelForCompletedMission(m);
    } else {
      startMissionCompletionPoll(id);
    }
  }

  // ── New-prospect intelligence nudge (post-engagement) ────────────────────
  // When an engagement against a brand-new prospect completes, offer to jump to
  // the prospect's Signals tab and pull intelligence. "New prospect" = a company
  // with no completed (or running) research run yet. We only nudge once per
  // engagement, persisted in localStorage so a reload doesn't re-nag.

  let _missionDetailPollTimer = null;
  let _missionDetailPollId = null;

  function stopMissionCompletionPoll() {
    if (_missionDetailPollTimer) { clearTimeout(_missionDetailPollTimer); _missionDetailPollTimer = null; }
    _missionDetailPollId = null;
  }

  function startMissionCompletionPoll(missionId) {
    stopMissionCompletionPoll();
    _missionDetailPollId = missionId;
    let polls = 0;
    const tick = async () => {
      // Bail if a newer detail opened or the rep navigated off the detail pane.
      if (_missionDetailPollId !== missionId) return;
      const pane = $('missions-pane-detail');
      if (!pane || pane.classList.contains('hidden')) { stopMissionCompletionPoll(); return; }
      if (++polls > 40) { stopMissionCompletionPoll(); return; } // ~10 min cap
      try {
        const d = await fetchJson(`/api/missions/${missionId}`);
        const mm = d.mission;
        if (mm && mm.status === 'COMPLETED') {
          stopMissionCompletionPoll();
          renderEngagementRecording(mm, missionId); // portal likely exists now
          maybePromptIntelForCompletedMission(mm);
          return;
        }
        if (mm && (mm.status === 'CANCELLED' || mm.status === 'FAILED')) { stopMissionCompletionPoll(); return; }
      } catch { /* transient — keep polling */ }
      _missionDetailPollTimer = setTimeout(tick, 15000);
    };
    _missionDetailPollTimer = setTimeout(tick, 15000);
  }

  function intelPromptedSet() {
    try { return new Set(JSON.parse(localStorage.getItem('ds_intel_prompted') || '[]')); }
    catch { return new Set(); }
  }
  function markIntelPrompted(missionId) {
    try {
      const s = intelPromptedSet(); s.add(missionId);
      // Keep the list bounded — only recent ids matter.
      localStorage.setItem('ds_intel_prompted', JSON.stringify([...s].slice(-200)));
    } catch { /* ignore */ }
  }

  // Resolve whether a completed engagement warrants an intelligence nudge.
  // Returns {id, name, missionId} for the prospect, or null.
  async function intelPullCandidate(m) {
    if (!m || m.status !== 'COMPLETED' || !m.company_id) return null;
    if (intelPromptedSet().has(m.id)) return null;
    // Authoritative "new prospect" check: skip if research is already done or
    // in flight. A null/FAILED run still counts as "no intelligence yet".
    try {
      const data = await fetchJson(`/api/knowledge/research/${encodeURIComponent(m.company_id)}`);
      const r = data.research;
      if (r && (r.status === 'DONE' || r.status === 'RUNNING')) return null;
    } catch { /* treat as no research */ }
    return { id: m.company_id, name: m.company_name || 'this prospect', missionId: m.id };
  }

  async function maybePromptIntelForCompletedMission(m) {
    try {
      const cand = await intelPullCandidate(m);
      if (cand) showIntelPrompt(cand);
    } catch { /* non-fatal */ }
  }

  function showIntelPrompt(cand) {
    const old = document.getElementById('intel-prompt');
    if (old) old.remove();
    const el = document.createElement('div');
    el.id = 'intel-prompt';
    el.className = 'intel-prompt';
    el.setAttribute('role', 'status');
    el.innerHTML = `
      <div class="intel-prompt-body">
        <span class="intel-prompt-icon">✨</span>
        <div>
          <div class="intel-prompt-title">Engagement with <strong>${escapeHtml(cand.name)}</strong> is complete</div>
          <div class="intel-prompt-sub">New prospect — pull intelligence now to map the opportunity?</div>
        </div>
      </div>
      <div class="intel-prompt-actions">
        <button class="primary-cta" id="intel-prompt-go">Pull intelligence</button>
        <button class="kb-link-btn" id="intel-prompt-dismiss">Dismiss</button>
      </div>`;
    document.body.appendChild(el);
    document.getElementById('intel-prompt-dismiss').addEventListener('click', () => {
      markIntelPrompted(cand.missionId); el.remove();
    });
    document.getElementById('intel-prompt-go').addEventListener('click', () => {
      markIntelPrompted(cand.missionId); el.remove();
      startProspectIntelPull(cand.id);
    });
  }

  // Navigate to the prospect's Signals tab and kick off a research run. Re-runs
  // the prospects loader (loaded=false) so wireProspectDetail re-binds and the
  // one-shot _pendingIntelPull below fires after render.
  async function startProspectIntelPull(companyId) {
    _prospectsState.selectedCompanyId = companyId;
    window._pendingIntelPull = companyId;
    loaded.prospects = false;
    if ((window.location.hash || '').replace('#', '') === 'prospects') {
      await switchSection('prospects', {});
    } else {
      window.location.hash = '#prospects';
    }
  }

  // Reflow PDF-style hard-wrapped prose into proper paragraphs without
  // touching deliberate markdown structure. Heuristic: detect strong
  // markdown signals (headings / lists / fenced code / numbered items /
  // very strong heading-like UPPERCASE lines) and leave structure intact;
  // otherwise treat single \n as a soft-wrap (PDF column break) and join
  // it into the surrounding sentence. Double \n is always a paragraph
  // break. Promote short, all-caps standalone lines to H3 headings so the
  // common "SECTION TITLE" pattern in scanned reports comes out structured.
  function normalizeProseText(text) {
    if (!text) return '';
    // Normalise weird whitespace + Windows line endings first.
    let t = String(text).replace(/\r\n?/g, '\n').replace(/[\t ]/g, ' ');
    // Strip excess blank lines (3+ → 2).
    t = t.replace(/\n{3,}/g, '\n\n');

    const lines = t.split('\n');
    const out = [];
    let buf = []; // accumulating soft-wrapped paragraph
    const flush = () => { if (buf.length) { out.push(buf.join(' ').replace(/\s+/g, ' ').trim()); buf = []; } };

    const isHeading        = (s) => /^#{1,6}\s/.test(s);
    const isListItem       = (s) => /^\s*([-*•]\s|\d+\.\s|>\s)/.test(s);
    const isCodeFence      = (s) => /^```/.test(s);
    const isHr             = (s) => /^---+\s*$/.test(s);
    // All-caps short standalone "section header" pattern (TOC entries, chapter
    // titles in scanned PDFs). 60-char cap keeps it from misfiring on
    // sentences that happen to start uppercase.
    const isShoutyHeading  = (s) => /^[A-Z0-9][A-Z0-9 \-:&/(),.]{2,60}$/.test(s.trim()) && !/[.?!]$/.test(s.trim());

    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();

      if (isCodeFence(trimmed)) { flush(); out.push(raw); inCode = !inCode; continue; }
      if (inCode)               { out.push(raw); continue; }

      if (trimmed === '') { flush(); out.push(''); continue; }

      if (isHeading(trimmed) || isListItem(raw) || isHr(trimmed)) {
        flush(); out.push(raw); continue;
      }

      if (isShoutyHeading(trimmed)) {
        flush();
        // Promote to a level-3 heading so the styling picks it up.
        out.push(`### ${toTitleCase(trimmed)}`);
        continue;
      }

      // Soft-wrap continuation — join with surrounding text.
      buf.push(trimmed);
    }
    flush();
    // Collapse repeated blank lines that the joins may have produced.
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  function toTitleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-:&/(])(\p{L})/gu, (_, p, c) => p + c.toUpperCase());
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
    // Consume a "Brief a mission" prefill from a prospect opportunity: company +
    // the opportunity's mapped products (snap-autofill fills domain/contacts/last-
    // mission tags first, then our opportunity products win).
    if (window._prefillMission) {
      const pf = window._prefillMission; window._prefillMission = null;
      const cn = $('missions-company'); if (cn && pf.companyName) cn.value = pf.companyName;
      try { await snapAutofillForCompany(pf.companyName || ''); } catch { /* ignore */ }
      const dom = $('missions-domain'); if (dom && pf.companyDomain && !dom.value) dom.value = pf.companyDomain;
      if (pf.note) { const nt = $('missions-notes'); if (nt && !nt.value) nt.value = pf.note; }
      if (Array.isArray(pf.productIds) && pf.productIds.length) {
        const sel = $('missions-product');
        if (sel) Array.from(sel.options).forEach((opt) => { if (pf.productIds.includes(opt.value)) opt.selected = true; });
      }
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

  // ── Mission schedule form: attendee chip picker ──────────────────────────
  // Replaces the old free-text prospect_emails textarea. Sources two pools:
  //   1. Contacts on file for the selected company (prospect_contacts)
  //   2. Free-text typed entries (with an inline quick-add modal that creates
  //      a real prospect_contacts row so they're remembered next time)
  // Syncs into the hidden #missions-emails textarea so the submit handler
  // and Teams modal continue to work unchanged.

  let _missionAttendees = []; // [{ email, name, role, contactId? }]
  let _missionCandidates = []; // prefetched contacts for the picked company
  let _missionCandidateCompanyId = null;

  function syncAttendeesToHiddenField() {
    const ta = $('missions-emails');
    if (!ta) return;
    ta.value = _missionAttendees.map((a) => a.email).join('\n');
  }

  function renderMissionChips() {
    const host = $('missions-attendees-chips');
    if (!host) return;
    if (_missionAttendees.length === 0) {
      host.innerHTML = '<span class="kb-subtle ma-chips-empty">No attendees yet — type or pick below.</span>';
    } else {
      host.innerHTML = _missionAttendees.map((a, i) => `
        <span class="teams-chip" title="${escapeHtml(a.email)}${a.role ? ' · ' + escapeHtml(a.role) : ''}">
          <span>${escapeHtml(a.name || a.email)}${a.role ? ` <span class="kb-subtle">(${escapeHtml(a.role)})</span>` : ''}</span>
          <button type="button" class="teams-chip-x" data-mission-attendee-remove="${i}" aria-label="Remove">✕</button>
        </span>`).join('');
      host.querySelectorAll('[data-mission-attendee-remove]').forEach((b) =>
        b.addEventListener('click', () => {
          _missionAttendees.splice(parseInt(b.dataset.missionAttendeeRemove, 10), 1);
          renderMissionChips();
          syncAttendeesToHiddenField();
        }));
    }
  }

  function pickMissionAttendee({ email, name, role, contactId }) {
    if (!email || !/@/.test(email)) return;
    const exists = _missionAttendees.some((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!exists) _missionAttendees.push({
      email: email.trim(),
      name: name || email,
      role: role || null,
      contactId: contactId || null,
    });
    renderMissionChips();
    syncAttendeesToHiddenField();
    $('missions-attendees-input').value = '';
    $('missions-attendees-results').classList.add('hidden');
    $('missions-attendees-input').focus();
  }

  // Look up the picked company so we know which contacts to surface. Matched
  // by exact (case-insensitive) name first; we don't need the id otherwise —
  // free-text contacts can still be added without it (they're company-less
  // until the mission is saved, at which point the backend creates the
  // company row + links them).
  async function loadAttendeeCandidatesForCompany(name) {
    const cleaned = String(name || '').trim();
    if (!cleaned) {
      _missionCandidates = [];
      _missionCandidateCompanyId = null;
      return;
    }
    try {
      const r = await fetchJson('/api/companies');
      const list = r.companies || [];
      const match = list.find((c) => c.name.toLowerCase() === cleaned.toLowerCase());
      if (!match) {
        _missionCandidates = [];
        _missionCandidateCompanyId = null;
        return;
      }
      _missionCandidateCompanyId = match.id;
      const cr = await fetchJson(`/api/contacts?companyId=${encodeURIComponent(match.id)}`);
      _missionCandidates = cr.contacts || [];
    } catch {
      _missionCandidates = [];
      _missionCandidateCompanyId = null;
    }
  }

  function showMissionAutocomplete(q) {
    const host = $('missions-attendees-results');
    if (!host) return;
    host.classList.remove('hidden');
    const needle = String(q || '').toLowerCase();
    const matches = _missionCandidates.filter((c) => {
      if (!needle) return true;
      return c.name.toLowerCase().includes(needle)
          || c.email.toLowerCase().includes(needle)
          || (c.role || '').toLowerCase().includes(needle);
    }).slice(0, 8);

    let rows = matches.map((c, i) => `
      <div class="teams-ac-row" data-mission-ac-pick="${i}">
        <div class="teams-ac-name">${escapeHtml(c.name)} <span class="pill pill-info" title="On file for this prospect">contact</span></div>
        <div class="teams-ac-meta kb-subtle">${escapeHtml(c.email)} · ${escapeHtml(c.role)}</div>
      </div>`).join('');

    // Free-text fallback: if the query parses as an email and isn't already
    // in the candidate list, offer to add it on the spot. The mission save
    // path will create the contact stub.
    if (needle.includes('@')) {
      const already = matches.some((c) => c.email.toLowerCase() === needle);
      if (!already) {
        rows += `<div class="teams-ac-row teams-ac-freeform" data-mission-ac-freeform="${escapeHtml(q)}">
          Add <strong>${escapeHtml(q)}</strong> as a guest
        </div>`;
      }
    }

    // Quick-add affordance: opens the inline form for a richer add (name +
    // role + email persisted as a contact for next time).
    rows += `<div class="teams-ac-row teams-ac-freeform" data-mission-ac-quickadd>
      Add a new contact (name + email + role)
    </div>`;

    host.innerHTML = rows;

    host.querySelectorAll('[data-mission-ac-pick]').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const c = matches[parseInt(el.dataset.missionAcPick, 10)];
        if (c) pickMissionAttendee({ email: c.email, name: c.name, role: c.role, contactId: c.id });
      }));
    host.querySelectorAll('[data-mission-ac-freeform]').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pickMissionAttendee({ email: el.dataset.missionAcFreeform });
      }));
    host.querySelectorAll('[data-mission-ac-quickadd]').forEach((el) =>
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const qa = $('missions-attendees-quickadd');
        if (qa) qa.classList.remove('hidden');
        const qaName = $('missions-qa-name');
        if (qaName) { qaName.value = ''; qaName.focus(); }
        $('missions-qa-email').value = $('missions-attendees-input').value.includes('@') ? $('missions-attendees-input').value : '';
        $('missions-qa-role').value  = '';
      }));
  }

  function wireAttendeePicker() {
    const input = $('missions-attendees-input');
    if (!input || input.dataset.wired === '1') return;
    input.dataset.wired = '1';
    input.addEventListener('input', () => showMissionAutocomplete(input.value));
    input.addEventListener('focus', () => showMissionAutocomplete(input.value));
    input.addEventListener('blur', () => setTimeout(() => $('missions-attendees-results').classList.add('hidden'), 150));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value.trim();
        if (/@/.test(v)) pickMissionAttendee({ email: v });
      }
    });

    // Quick-add inline form: persists a real contact row, then picks it.
    const saveBtn = $('missions-qa-save-btn');
    const cancelBtn = $('missions-qa-cancel-btn');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const name = $('missions-qa-name').value.trim();
      const email = $('missions-qa-email').value.trim();
      const role  = $('missions-qa-role').value.trim() || 'Unknown';
      if (!name || !email) return alert('Name and email are required.');
      // If we already know the company id (rep typed an existing prospect),
      // persist server-side. Otherwise just add as a free-text attendee —
      // the mission save will create both the company and the contact.
      if (_missionCandidateCompanyId) {
        try {
          const r = await fetchJson('/api/contacts', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ companyId: _missionCandidateCompanyId, name, email, role }),
          });
          const c = r.contact;
          pickMissionAttendee({ email: c.email, name: c.name, role: c.role, contactId: c.id });
          // Refresh candidates so the new contact appears in autocomplete from now on.
          _missionCandidates = [c, ..._missionCandidates.filter((x) => x.id !== c.id)];
        } catch (err) {
          alert(`Couldn't add contact: ${err.message}`);
          return;
        }
      } else {
        pickMissionAttendee({ email, name, role });
      }
      $('missions-attendees-quickadd').classList.add('hidden');
    });
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      $('missions-attendees-quickadd').classList.add('hidden');
    });

    renderMissionChips();
  }

  // Wipe the chip state and hidden field when the form is reset / opened
  // for a new mission. Called from places that previously cleared the
  // textarea directly.
  function clearMissionAttendees() {
    _missionAttendees = [];
    renderMissionChips();
    syncAttendeesToHiddenField();
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

    // Click-to-toggle on the Tags multi-selects (products · personas ·
    // competitors) so a second click deselects — no Ctrl/Cmd needed.
    enableToggleMultiSelect($('missions-product'));
    enableToggleMultiSelect($('missions-persona'));
    enableToggleMultiSelect($('missions-competitor'));

    // Snap autofill — fires on every change of the company-name input. The
    // `input` event covers typing AND datalist selection (most browsers fire
    // input when the user picks an option). Debounced lightly so we don't
    // refire on every keystroke.
    const companyInput = $('missions-company');
    if (companyInput) {
      let snapTimer = null;
      companyInput.addEventListener('input', () => {
        updateProspectMatchBadge();
        if (snapTimer) clearTimeout(snapTimer);
        snapTimer = setTimeout(() => {
          snapAutofillForCompany(companyInput.value);
          loadAttendeeCandidatesForCompany(companyInput.value);
        }, 200);
      });
      companyInput.addEventListener('change', () => {
        updateProspectMatchBadge();
        snapAutofillForCompany(companyInput.value);
        loadAttendeeCandidatesForCompany(companyInput.value);
      });
    }
    const domainInput = $('missions-domain');
    if (domainInput) domainInput.addEventListener('input', updateProspectMatchBadge);
    wireAttendeePicker();

    // Schedule-import buttons — wired once; enabled/disabled per connection
    // state by refreshCalendarImportButton() (called from populateScheduleForm).
    // Single aggregated import button. Three modes — see _calImportMode docs.
    const importBtn = $('missions-import-btn');
    if (importBtn) importBtn.addEventListener('click', () => {
      if (_calImportMode === 'connect') {
        // No source connected yet — bounce to Integrations so the rep
        // chooses which to connect. Routing direct to any one provider's
        // OAuth would be presumptuous (and wrong for Microsoft users now).
        window.location.hash = '#integrations';
        return;
      }
      if (_calImportMode === 'import') openAggregatedPicker();
    });
    // "🎥 Generate meeting" — opens the create-meeting modal for whichever
    // provider is connected (Microsoft preferred when both are).
    const gtBtn = $('missions-generate-teams-btn');
    if (gtBtn) gtBtn.addEventListener('click', () => openGenerateTeamsModal({ provider: defaultMeetingProvider() }));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('missions-submit-btn');
      const result = $('missions-form-result');
      result.classList.add('hidden');
      result.classList.remove('error', 'success');
      btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Scheduling…';

      try {
        const urlInput = $('missions-url');
        const body = {
          companyName:    $('missions-company').value.trim(),
          companyDomain:  $('missions-domain').value.trim() || null,
          primaryContact: $('missions-primary-contact').value.trim() || null,
          // datetime-local emits a naive local string; toISOString converts
          // to UTC so the scheduler queries it consistently.
          scheduledAt:    new Date($('missions-scheduled-at').value).toISOString(),
          meetingUrl:     urlInput.value.trim() || null,
          prospectEmails: $('missions-emails').value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
          productIds:     readSelectedValues($('missions-product')),
          personaIds:     readSelectedValues($('missions-persona')),
          competitorIds:  readSelectedValues($('missions-competitor')),
          notes:          $('missions-notes').value.trim() || null,
        };
        // If the rep generated this meeting through 🎥 Generate meeting, the
        // modal stamped the resulting provider identifiers onto the URL input
        // as dataset attributes — forward them so the mission row carries the
        // linkage and the detail UI can offer Edit / Cancel. A mission carries
        // at most one provider's linkage.
        if (urlInput && urlInput.dataset.msEventId) {
          body.msEventId        = urlInput.dataset.msEventId;
          body.msIcalUid        = urlInput.dataset.msIcalUid || null;
          body.msOrganizerEmail = urlInput.dataset.msOrganizerEmail || null;
        } else if (urlInput && urlInput.dataset.googleEventId) {
          body.googleEventId        = urlInput.dataset.googleEventId;
          body.googleIcalUid        = urlInput.dataset.googleIcalUid || null;
          body.googleOrganizerEmail = urlInput.dataset.googleOrganizerEmail || null;
        }
        const r = await fetch('/api/missions', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(payload.error || `HTTP ${r.status}`);
        form.reset();
        clearMissionAttendees();
        result.classList.add('hidden');
        // Confirm, then take the rep straight to the Upcoming tab so the new
        // engagement is visible. Previously success left them on the schedule
        // pane with only a small inline note, so it looked like nothing happened.
        toast('Engagement scheduled — opening Upcoming.');
        await switchMissionsTab('upcoming');
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

  // ── Company foundation (Profile / Products / Personas / Intel) ────────────
  // The source-of-truth workspace: positioning/objectives (which ground every
  // battlecard, prospect research run, and brief via tenantContextText), our
  // products (with drill-down), buyer personas, and the Basis intel library.
  let _companyData = { tenant: {}, products: [], personas: [], profile: {} };
  let _companyTab = 'intel';
  let _companyProductOpen = null;
  let _companyIntelAutoOpen = null; // {productId} → open the Add-intel flow on the Intel tab
  let _companyWelcome = false;        // armed by ?welcome=1 → auto-run the website pull once
  let _companyBootstrapTried = false; // guards the auto-pull so re-renders don't re-trigger it
  let _companyPullSummary = null;     // {mission, audience} from the last pull → grounds the AI on confirm
  const INTEL_EXPLAINER = 'Everything your AI reads about you — files, web pages, and notes. The more you add, the sharper your briefs, battlecards, and research.';

  // Jump to the Intel tab and open the Add-intel flow, optionally pre-scoped to a
  // product line (productId null = company-wide).
  function openCompanyAddIntel(productId) {
    _companyTab = 'intel';
    _companyIntelAutoOpen = { productId: productId || null };
    renderCompanyWorkspace();
  }

  async function loadCompany() {
    await refreshCompany();
  }

  async function refreshCompany() {
    try {
      const [t, p, pe, pf] = await Promise.all([
        fetchJson('/api/tenant'),
        fetchJson('/api/portfolio/products'),
        fetchJson('/api/portfolio/personas'),
        fetchJson('/api/portfolio/company-profile'),
      ]);
      _companyData = { tenant: t.tenant || {}, products: p.products || [], personas: pe.personas || [], profile: pf.profile || {} };
    } catch (err) {
      $('company-header').innerHTML = `<div class="empty">Couldn't load company: ${escapeHtml(err.message)}</div>`;
      return;
    }
    const tenant = _companyData.tenant;
    const planLabel = String(tenant.subscription_status || 'TRIAL').toUpperCase();
    const planOk = planLabel === 'ACTIVE' || planLabel === 'INTERNAL';
    $('company-header').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
        <div>
          <div style="font-size:20px;font-weight:700">${escapeHtml(tenant.name || 'Your company')}</div>
          <div style="margin-top:3px">${tenant.domain ? escapeHtml(tenant.domain) : '<span class="kb-subtle">no domain set</span>'} <span class="kb-subtle">· joined ${escapeHtml(fmtDate(tenant.created_at))}</span></div>
        </div>
        <div><span class="pill ${planOk ? 'pill-ok' : 'pill-warn'}">${escapeHtml(planLabel)}</span></div>
      </div>`;
    renderCompanyWorkspace();
  }

  function renderCompanyWorkspace() {
    const host = $('company-workspace');
    if (!host) return;
    const { products, personas } = _companyData;
    host.innerHTML = `
      <div id="foundation-health"></div>
      <div class="prospect-tabs">
        <button type="button" class="kb-tab${_companyTab === 'intel' ? ' active' : ''}" data-company-tab="intel">Intel</button>
        <button type="button" class="kb-tab${_companyTab === 'products' ? ' active' : ''}" data-company-tab="products">Products (${products.length})</button>
        <button type="button" class="kb-tab${_companyTab === 'personas' ? ' active' : ''}" data-company-tab="personas">Personas (${personas.length})</button>
      </div>
      <div class="prospect-tab-pane" id="company-tab-body"></div>`;
    host.querySelectorAll('[data-company-tab]').forEach((t) => t.addEventListener('click', () => {
      _companyTab = t.dataset.companyTab; _companyProductOpen = null; renderCompanyWorkspace();
    }));
    const body = $('company-tab-body');
    if (_companyTab === 'products') renderCompanyProductsTab(body);
    else if (_companyTab === 'personas') renderCompanyPersonasTab(body);
    else renderCompanyIntelTab(body);
    loadFoundationHealth();
  }

  // ── Foundation Coach: data-completeness score + one-click multi-source enrich ─
  const FOUND_BAND = { strong: 'pill-ok', fair: 'pill-warn', sparse: 'pill-bad' };
  async function loadFoundationHealth() {
    const host = $('foundation-health');
    if (!host) return;
    let h;
    try { h = await fetchJson('/api/foundation/health'); }
    catch { host.innerHTML = ''; return; }
    renderFoundationHealth(host, h);
  }

  function renderFoundationHealth(host, h) {
    const gaps = (h.topGaps || []).map((g) =>
      `<li class="found-gap found-${g.status}">
         <a href="${escapeHtml(g.deepLink)}">${escapeHtml(g.label)}</a>
         <span class="kb-subtle">— ${escapeHtml(g.suggestion)}</span>
       </li>`).join('');
    const enrichedNote = h.enrichedAt ? `Last enriched ${escapeHtml(fmtDate(h.enrichedAt))}` : 'Never enriched from web';
    host.innerHTML = `
      <div class="foundation-card">
        <div class="foundation-head">
          <div class="foundation-score">
            <span class="foundation-num">${h.score}</span><span class="kb-subtle">/100</span>
            <span class="pill ${FOUND_BAND[h.band] || 'pill-warn'}">${escapeHtml((h.band || '').toUpperCase())}</span>
          </div>
          <div class="foundation-meta">
            <strong>Data foundation</strong>
            <div class="kb-subtle">Richer data = sharper, more localized discovery. <span title="${escapeHtml(enrichedNote)}">${escapeHtml(enrichedNote)}</span></div>
          </div>
          <button class="primary-cta" id="foundation-enrich-btn">Enrich from web</button>
        </div>
        ${gaps ? `<ul class="foundation-gaps">${gaps}</ul>` : '<div class="kb-subtle" style="margin-top:8px">Your foundation looks strong. 🎉</div>'}
        <div class="kb-result hidden" id="foundation-enrich-result"></div>
      </div>`;
    const btn = $('foundation-enrich-btn');
    if (btn) btn.addEventListener('click', runFoundationEnrich);
  }

  async function runFoundationEnrich() {
    const btn = $('foundation-enrich-btn');
    const result = $('foundation-enrich-result');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Reading website, Apollo & news…'; }
    if (result) result.classList.add('hidden');
    try {
      const r = await fetchJson('/api/foundation/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const s = r.summary || {};
      const parts = [];
      if (s.profileFields && s.profileFields.length) parts.push(`filled ${s.profileFields.join(', ')}`);
      if (s.productsBackfilled) parts.push(`${s.productsBackfilled} product description${s.productsBackfilled === 1 ? '' : 's'}`);
      if (s.productsCreated) parts.push(`${s.productsCreated} new product${s.productsCreated === 1 ? '' : 's'}`);
      if (s.personasCreated) parts.push(`${s.personasCreated} persona${s.personasCreated === 1 ? '' : 's'}`);
      const msg = parts.length ? `Enriched from ${(s.sources || []).join(', ') || 'web'} — ${parts.join(', ')}. Review & edit anything below.` : 'Nothing new to add — your foundation is already filled.';
      if (result) { result.classList.remove('hidden', 'error'); result.classList.add('success'); result.textContent = msg; }
      loaded.knowledge = false;
      await refreshCompany();
    } catch (err) {
      if (result) { result.classList.remove('hidden', 'success'); result.classList.add('error'); result.textContent = `Couldn't enrich: ${err.message}`; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Enrich from web'; }
    }
  }

  // ── Pull-from-website bootstrap (post-onboarding "confirm what we found") ──
  // Reads the tenant's own homepage, summarises it, and lets the owner confirm —
  // filing the homepage as their first Basis intel and picking up product lines.
  function renderCompanyBootstrap(host) {
    if (!host) return;
    host.innerHTML = `
      <div class="company-bootstrap">
        <div class="company-bootstrap-head">
          <div>
            <div class="company-field-label">Pull from your website</div>
            <p class="kb-subtle" style="margin:2px 0 0">We read your homepage and pick up your products so you can confirm what we found.</p>
          </div>
          <button class="kb-secondary-btn" id="company-pull-btn">Pull from website</button>
        </div>
        <div id="company-pull-card"></div>
      </div>`;
    $('company-pull-btn').addEventListener('click', () => runCompanyPull());
    // Freshly-onboarded owner (?welcome=1): the server auto-enriches their
    // foundation from website + Apollo + news in the background. Watch the
    // health card populate rather than re-running the (now redundant) homepage
    // pull, which would duplicate products.
    if (_companyWelcome && !_companyBootstrapTried) {
      _companyWelcome = false;
      _companyBootstrapTried = true;
      watchWelcomeEnrichment();
    }
  }

  // Poll the foundation health while the post-onboarding background enrichment
  // runs, so the new owner watches their products/ICP appear, then refresh.
  function watchWelcomeEnrichment() {
    const host = $('foundation-health');
    if (host) host.innerHTML = '<div class="foundation-card"><div class="kb-subtle">Building your company foundation from your website, Apollo &amp; news… this usually takes under a minute.</div></div>';
    let n = 0;
    const tick = async () => {
      n++;
      try {
        const h = await fetchJson('/api/foundation/health');
        if (h.enrichedAt || h.score >= 70 || n >= 7) { loaded.knowledge = false; await refreshCompany(); return; }
      } catch { /* keep waiting */ }
      setTimeout(tick, n < 3 ? 6000 : 12000);
    };
    setTimeout(tick, 6000);
  }

  async function runCompanyPull() {
    _companyBootstrapTried = true;
    const card = $('company-pull-card');
    const btn = $('company-pull-btn');
    if (!card) return;
    if (btn) btn.disabled = true;
    card.innerHTML = `<div class="kb-subtle" style="padding:10px 0">⏳ Reading your website…</div>`;
    try {
      const r = await fetchJson('/api/portfolio/company-bootstrap/pull', { method: 'POST' });
      if (!r.ok) {
        card.innerHTML = `<div class="company-pull-warn">${escapeHtml(r.error || "Couldn't read your website.")} You can still add intel manually below.</div>`;
        return;
      }
      renderCompanyPullCard(card, r);
    } catch (err) {
      card.innerHTML = `<div class="company-pull-warn">${escapeHtml(err.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function renderCompanyPullCard(card, r) {
    const sum = r.summary || {};
    _companyPullSummary = { mission: sum.mission || null, audience: sum.audience || null };
    const prods = Array.isArray(r.suggestedProducts) ? r.suggestedProducts : [];
    card.innerHTML = `
      <div class="company-pull-result">
        <div class="company-pull-head">✅ Here's what we found${r.sourceUrl ? ` on <a href="${escapeHtml(r.sourceUrl)}" target="_blank" rel="noopener">your site</a>` : ''} — confirm it looks right.</div>
        ${sum.mission ? `<div class="company-pull-row"><span class="company-field-label">What you do</span><div>${escapeHtml(sum.mission)}</div></div>` : ''}
        ${sum.audience ? `<div class="company-pull-row"><span class="company-field-label">Who you sell to</span><div>${escapeHtml(sum.audience)}</div></div>` : ''}
        <div class="company-pull-row">
          <span class="company-field-label">Products we picked up <span class="kb-subtle">— add the ones that fit, then attach a deck or page</span></span>
          ${prods.length ? `<div class="company-pull-prods" id="company-pull-prods"></div>` : '<div class="kb-subtle">None detected — you can add product lines on the Products tab.</div>'}
        </div>
        <label class="company-pull-toggle"><input type="checkbox" id="company-pull-ingest" checked> File my homepage as company intel</label>
        <div class="company-pull-actions">
          <button class="primary-cta" id="company-pull-confirm">Confirm &amp; finish</button>
          <span class="kb-result hidden" id="company-pull-result-msg"></span>
        </div>
        <div class="company-pull-progress kb-subtle" id="company-pull-progress"></div>
      </div>`;
    if (prods.length) renderSuggestedProducts($('company-pull-prods'), prods);
    $('company-pull-confirm').addEventListener('click', confirmCompanyPull);
  }

  // Suggested products are NOT auto-created. "Add product" creates the line and
  // reveals an inline intel menu (deck file + website link) on the same page;
  // the actual fetch/ingest runs later, on Confirm & finish.
  function renderSuggestedProducts(host, prods) {
    if (!host) return;
    host.innerHTML = prods.map((p, i) => `
      <div class="company-sugg" data-sugg="${i}">
        <div class="company-sugg-row">
          <span class="company-sugg-name">${escapeHtml(p.name)}</span>
          <button class="kb-link-btn" data-sugg-add="${i}">＋ Add product</button>
        </div>
        <div class="company-sugg-intel hidden" data-intel="${i}"></div>
      </div>`).join('');
    host.querySelectorAll('[data-sugg-add]').forEach((b) =>
      b.addEventListener('click', () => addSuggestedProduct(host, prods, Number(b.dataset.suggAdd))));
  }

  async function addSuggestedProduct(host, prods, i) {
    const p = prods[i];
    const row = host.querySelector(`[data-sugg="${i}"]`);
    if (!row) return;
    const btn = row.querySelector('[data-sugg-add]');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      const resp = await fetchJson('/api/portfolio/products', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: slugify(p.name), name: p.name, description: p.description || null }),
      });
      const pid = (resp && resp.product && resp.product.id) || slugify(p.name);
      loaded.knowledge = false;
      // Refresh the cached product list so the Products tab + library reflect it.
      try { const pr = await fetchJson('/api/portfolio/products'); _companyData.products = pr.products || _companyData.products; } catch { /* keep stale */ }
      row.classList.add('added');
      row.dataset.pid = pid;
      const head = row.querySelector('.company-sugg-row');
      if (head) head.innerHTML = `<span class="company-sugg-name">✓ ${escapeHtml(p.name)}</span><span class="kb-subtle">added</span>`;
      const menu = row.querySelector(`[data-intel="${i}"]`);
      if (menu) {
        menu.classList.remove('hidden');
        menu.innerHTML = `
          <div class="company-sugg-intel-label">Add intel for this product <span class="kb-subtle">(optional — fetched when you finish)</span></div>
          <div class="company-sugg-intel-fields">
            <label class="company-sugg-file">Deck / file <input type="file" accept=".pdf,.md,.txt,.docx" data-pfile="${i}"></label>
            <input type="url" class="company-sugg-url" placeholder="https://product-page…" data-purl="${i}">
          </div>
          <div class="company-sugg-status" data-pstatus="${i}"></div>`;
      }
    } catch (err) {
      if (btn) { btn.disabled = false; btn.textContent = '＋ Add product'; }
      alert(`Couldn't add "${p.name}": ${err.message}`);
    }
  }

  // Confirm & finish: (1) save the pulled company info (positioning) + file the
  // homepage so it grounds every battlecard / prospect research / pre-call brief;
  // (2) fetch each product's queued deck/link one by one until all are done.
  async function confirmCompanyPull() {
    const btn = $('company-pull-confirm');
    const ingest = $('company-pull-ingest');
    const msg = $('company-pull-result-msg');
    const progress = $('company-pull-progress');
    btn.disabled = true; const o = btn.textContent; btn.textContent = 'Saving…';
    if (msg) msg.classList.add('hidden');
    try {
      // 1. Company info → tenant_profiles (grounds the AI) + homepage as Basis intel.
      const body = { ingestHomepage: ingest ? !!ingest.checked : false };
      const s = _companyPullSummary || {};
      const positioning = [s.mission, s.audience ? `Primary audience: ${s.audience}` : '']
        .filter(Boolean).join('\n').trim();
      if (positioning) body.positioning = positioning;
      await fetchJson('/api/portfolio/company-bootstrap/confirm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // 2. Build the per-product intel job list from the inline menus.
      const jobs = [];
      document.querySelectorAll('.company-sugg.added').forEach((row) => {
        const pid = row.dataset.pid;
        if (!pid) return;
        const fileEl = row.querySelector('[data-pfile]');
        const urlEl = row.querySelector('[data-purl]');
        const file = (fileEl && fileEl.files || [])[0] || null;
        const url = (urlEl && urlEl.value || '').trim();
        if (file) jobs.push({ pid, row, kind: 'file', file });
        if (/^https?:\/\//i.test(url)) jobs.push({ pid, row, kind: 'url', url });
      });

      // 3. Fetch the product intel one by one until all are done.
      if (jobs.length) {
        let done = 0;
        btn.textContent = `Fetching intel (0/${jobs.length})…`;
        for (const job of jobs) {
          const statusEl = job.row.querySelector('[data-pstatus]');
          if (statusEl) statusEl.textContent = '⏳ fetching…';
          try {
            if (job.kind === 'file') {
              const fd = new FormData();
              fd.append('file', job.file);
              fd.append('scope', 'TENANT');
              fd.append('category', 'PRODUCT_INTEL');
              fd.append('title', (job.file.name || 'Untitled').replace(/\.[^.]+$/, '') || job.file.name);
              fd.append('productIds', job.pid);
              const rr = await fetch('/api/knowledge/upload', { method: 'POST', credentials: 'include', body: fd });
              const jj = await rr.json().catch(() => ({}));
              if (!rr.ok) throw new Error(jj.error || `HTTP ${rr.status}`);
            } else {
              const rr = await fetch('/api/knowledge/web-sync', {
                method: 'POST', credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: job.url, scope: 'TENANT', category: 'PRODUCT_INTEL', productIds: [job.pid] }),
              });
              const jj = await rr.json().catch(() => ({}));
              if (!rr.ok) throw new Error(jj.error || `HTTP ${rr.status}`);
            }
            if (statusEl) statusEl.textContent = '✓ indexed';
          } catch (err) {
            if (statusEl) statusEl.textContent = `✗ ${err.message}`;
          }
          done++;
          if (progress) progress.textContent = `Fetched intel for ${done} of ${jobs.length}…`;
          btn.textContent = `Fetching intel (${done}/${jobs.length})…`;
        }
      }

      // Done → reload the workspace (new docs show in the library; card collapses).
      loaded.company = false; loaded.knowledge = false;
      await refreshCompany();
    } catch (err) {
      if (msg) { msg.classList.remove('hidden'); msg.classList.add('error'); msg.textContent = err.message; }
      btn.disabled = false; btn.textContent = o;
    }
  }

  function renderCompanyProductsTab(body) {
    if (_companyProductOpen) { renderCompanyProductDetail(body, _companyProductOpen); return; }
    const products = _companyData.products;
    const rows = products.length
      ? products.map((p) => `
          <tr>
            <td><strong>${escapeHtml(p.name)}</strong> <span class="mono kb-subtle">${escapeHtml(p.id)}</span>${p.ai_enriched ? '<span class="product-ai-badge" title="AI-enriched — review &amp; edit">AI</span>' : ''}</td>
            <td class="truncate">${escapeHtml(p.description || '—')}</td>
            <td>${fmtNum(p.doc_count)}</td>
            <td class="pf-actions-cell">
              <button class="kb-link-btn" data-prod-open="${escapeHtml(p.id)}">Open</button>
              <button class="kb-link-btn" data-prod-edit="${escapeHtml(p.id)}">Edit</button>
              <button class="kb-link-btn danger" data-prod-del="${escapeHtml(p.id)}">Delete</button>
            </td>
          </tr>`).join('')
      : '<tr><td colspan="4" class="kb-subtle" style="padding:10px">No product lines yet.</td></tr>';
    body.innerHTML = `
      <table class="dt"><thead><tr><th>Product line</th><th>Description</th><th>Docs</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="comp-node-add" style="margin-top:12px">
        <input id="company-new-product-name" type="text" placeholder="New product — e.g. Fraud Solution" maxlength="200">
        <input id="company-new-product-desc" type="text" placeholder="Description (optional)">
        <button class="kb-secondary-btn" id="company-add-product-btn">＋ Add product</button>
      </div>
      <div class="kb-result hidden" id="company-product-result"></div>`;
    body.querySelectorAll('[data-prod-open]').forEach((b) => b.addEventListener('click', () => { _companyProductOpen = b.dataset.prodOpen; renderCompanyWorkspace(); }));
    body.querySelectorAll('[data-prod-edit]').forEach((b) => b.addEventListener('click', () => companyEditEntity('products', b.dataset.prodEdit)));
    body.querySelectorAll('[data-prod-del]').forEach((b) => b.addEventListener('click', () => companyDeleteProduct(b.dataset.prodDel)));
    $('company-add-product-btn').addEventListener('click', () => companyAddEntity('products', 'company-new-product-name', 'company-new-product-desc', 'company-product-result'));
  }

  async function renderCompanyProductDetail(body, productId) {
    const p = (_companyData.products || []).find((x) => x.id === productId) || { id: productId, name: productId };
    body.innerHTML = `
      <button class="kb-link-btn" id="company-prod-back">← All products</button>
      <h3 style="margin:8px 0 2px">${escapeHtml(p.name)} <span class="mono kb-subtle">${escapeHtml(p.id)}</span></h3>
      <div class="kb-subtle" style="margin-bottom:12px">${escapeHtml(p.description || 'No description.')}</div>
      <div class="company-prod-section"><div class="company-field-label">Competitors it faces</div><div id="company-prod-competitors" class="kb-subtle">Loading…</div></div>
      <div class="company-prod-section"><div class="company-field-label">AI product analysis</div><div id="company-prod-analysis" class="kb-subtle">Loading…</div></div>
      <div class="company-prod-section">
        <div class="company-field-label">Filed intel <button class="kb-secondary-btn company-prod-add-intel-btn" id="company-prod-add-intel">Create intel for this product</button></div>
        <p class="kb-subtle" style="margin:0 0 8px">${INTEL_EXPLAINER}</p>
        <div id="company-prod-docs" class="intel-lib-list company-intel-grid">Loading…</div>
      </div>`;
    $('company-prod-back').addEventListener('click', () => { _companyProductOpen = null; renderCompanyWorkspace(); });
    $('company-prod-add-intel').addEventListener('click', () => openCompanyAddIntel(productId));
    fetchJson(`/api/portfolio/products/${encodeURIComponent(productId)}/competitors`).then((c) => {
      const comps = c.competitors || [];
      $('company-prod-competitors').innerHTML = comps.length
        ? comps.map((x) => `<a class="kb-stream-pill stream-file" href="#competitors">${escapeHtml(x.name)}</a>`).join(' ')
        : '<span class="kb-subtle">None pinned — pin this product to a competitor on the Competitors page.</span>';
    }).catch(() => { $('company-prod-competitors').textContent = '—'; });
    try {
      const d = await fetchJson(`/api/knowledge/documents?scope=TENANT&productId=${encodeURIComponent(productId)}`);
      const docs = d.documents || [];
      const withAnalysis = docs.find((x) => (x.metadata || {}).productAnalysis);
      $('company-prod-analysis').innerHTML = withAnalysis ? renderProductAnalysis(withAnalysis.metadata.productAnalysis) : '<span class="kb-subtle">No analysis yet — file product intel below to generate one.</span>';
      const grid = $('company-prod-docs');
      grid.innerHTML = docs.length ? docs.map((x) => companyIntelCard(x, { deletable: true, keyPointsAction: true })).join('') : '<span class="kb-subtle">No intel filed under this product yet — use the Intel tab.</span>';
      grid.querySelectorAll('[data-intel-card-open]').forEach((card) => card.addEventListener('click', () => {
        const doc = docs.find((y) => y.id === card.dataset.docId);
        if (doc) openIntelDocModal(doc, { onChange: () => refreshCompany() });
      }));
    } catch (err) { const g = $('company-prod-docs'); if (g) g.textContent = err.message; }
  }

  function renderCompanyPersonasTab(body) {
    const personas = _companyData.personas;
    const rows = personas.length
      ? personas.map((p) => `
          <tr>
            <td><strong>${escapeHtml(p.name)}</strong> <span class="mono kb-subtle">${escapeHtml(p.id)}</span></td>
            <td class="truncate">${escapeHtml(p.description || '—')}</td>
            <td>${fmtNum(p.doc_count)}</td>
            <td class="pf-actions-cell">
              <button class="kb-link-btn" data-persona-edit="${escapeHtml(p.id)}">Edit</button>
              <button class="kb-link-btn danger" data-persona-del="${escapeHtml(p.id)}">Delete</button>
            </td>
          </tr>`).join('')
      : '<tr><td colspan="4" class="kb-subtle" style="padding:10px">No personas yet.</td></tr>';
    body.innerHTML = `
      <p class="kb-subtle">The types of buyer you sell to (e.g. CFO, IT lead). They shape your pre-call briefs and link automatically to contacts with a matching role.</p>
      <table class="dt"><thead><tr><th>Persona</th><th>Description</th><th>Docs</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="comp-node-add" style="margin-top:12px">
        <input id="company-new-persona-name" type="text" placeholder="New persona — e.g. CFO" maxlength="200">
        <input id="company-new-persona-desc" type="text" placeholder="Traits / what they care about (optional)">
        <button class="kb-secondary-btn" id="company-add-persona-btn">＋ Add persona</button>
      </div>
      <div class="kb-result hidden" id="company-persona-result"></div>`;
    body.querySelectorAll('[data-persona-edit]').forEach((b) => b.addEventListener('click', () => companyEditEntity('personas', b.dataset.personaEdit)));
    body.querySelectorAll('[data-persona-del]').forEach((b) => b.addEventListener('click', () => companyDeleteEntity('personas', b.dataset.personaDel)));
    $('company-add-persona-btn').addEventListener('click', () => companyAddEntity('personas', 'company-new-persona-name', 'company-new-persona-desc', 'company-persona-result'));
  }

  async function renderCompanyIntelTab(body) {
    body.innerHTML = `
      <div id="company-profile-host"></div>
      <div class="company-bootstrap-block" id="company-bootstrap-host"></div>
      <div class="company-field-label" style="margin-top:18px">Intel library</div>
      <p class="kb-subtle">${INTEL_EXPLAINER} Optionally file a doc under a product line.</p>
      <div id="company-intel-host"></div>`;
    renderCompanyProfileEditor($('company-profile-host'));
    renderCompanyBootstrap($('company-bootstrap-host'));
    await renderIntelLibrary({ container: $('company-intel-host'), scope: 'TENANT', products: _companyData.products, onChange: () => { loaded.company = false; } });
    // If we arrived here via a "Create intel" button, open the Add-intel pane
    // (pre-scoped to a product line when given) and scroll it into view.
    if (_companyIntelAutoOpen) {
      const { productId } = _companyIntelAutoOpen;
      _companyIntelAutoOpen = null;
      const root = $('company-intel-host');
      const pane = root && root.querySelector('#intel-lib-add-pane');
      if (pane) pane.classList.remove('hidden');
      if (productId && root) {
        const a = root.querySelector('#intel-lib-product'); if (a) a.value = productId;
        const b = root.querySelector('#intel-lib-url-product'); if (b) b.value = productId;
      }
      if (pane) pane.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // Company foundation editor (positioning / ICP / objectives) — the grounding
  // that drives discovery, briefs, and battlecards. ICP ("who we sell to") is
  // the key field: discovery targets these buyers, not companies like us.
  function renderCompanyProfileEditor(host) {
    if (!host) return;
    const p = (_companyData && _companyData.profile) || {};
    host.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div class="card-h">Company foundation
          <span class="pf-hint">Grounds every brief, battlecard, and prospect/competitor search. Be specific about who you sell to.</span>
        </div>
        <div class="card-b cf-editor">
          <label class="company-field-label">What you do (positioning)</label>
          <textarea id="cf-positioning" rows="3" placeholder="What your product is + your differentiator">${escapeHtml(p.positioning || '')}</textarea>
          <label class="company-field-label">Ideal customer profile — who you sell to</label>
          <textarea id="cf-icp" rows="2" placeholder="The businesses that BUY from you — e.g. independent bars, nightclubs and late-night restaurants; buyers are owners / GMs / marketing managers">${escapeHtml(p.ideal_customer_profile || '')}</textarea>
          <label class="company-field-label">Goals (objectives)</label>
          <textarea id="cf-objectives" rows="2" placeholder="What you're trying to achieve">${escapeHtml(p.objectives || '')}</textarea>
          <div class="cf-actions">
            <button class="primary-cta" id="cf-save">Save foundation</button>
            <button class="kb-secondary-btn" id="cf-draft">Draft with AI</button>
            <span class="kb-subtle" id="cf-result"></span>
          </div>
        </div>
      </div>`;
    $('cf-save').addEventListener('click', saveCompanyFoundation);
    $('cf-draft').addEventListener('click', draftCompanyFoundation);
  }
  async function saveCompanyFoundation() {
    try {
      await fetchJson('/api/portfolio/company-profile', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positioning: $('cf-positioning').value.trim(),
          objectives: $('cf-objectives').value.trim(),
          idealCustomerProfile: $('cf-icp').value.trim(),
        }),
      });
      toast('Company foundation saved');
      await refreshCompany();
    } catch (err) { toast(err.message || 'Save failed', 'warn'); }
  }
  async function draftCompanyFoundation() {
    const r = $('cf-result'); if (r) r.textContent = 'Drafting from your intel…';
    try {
      const { draft } = await fetchJson('/api/portfolio/company-profile/draft', { method: 'POST' });
      if (draft) {
        if (draft.positioning) $('cf-positioning').value = draft.positioning;
        if (draft.objectives) $('cf-objectives').value = draft.objectives;
        if (draft.idealCustomerProfile) $('cf-icp').value = draft.idealCustomerProfile;
      }
      if (r) r.textContent = 'Drafted — review and Save.';
    } catch (err) { if (r) r.textContent = err.message || 'Draft failed'; }
  }

  // Shared add/edit/delete for products + personas (generic /portfolio/:resource).
  async function companyAddEntity(resource, nameId, descId, resultId) {
    const name = ($(nameId).value || '').trim();
    const description = ($(descId).value || '').trim() || null;
    if (!name) return;
    try {
      const resp = await fetchJson(`/api/portfolio/${resource}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: slugify(name), name, description }),
      });
      loaded.knowledge = false;
      // For a new product, drop straight into its detail — where "Create intel
      // for this product" lives — so the rep can enrich it right away.
      if (resource === 'products') {
        _companyTab = 'products';
        _companyProductOpen = (resp && resp.product && resp.product.id) || slugify(name);
      }
      await refreshCompany();
    } catch (err) { const r = $(resultId); if (r) { r.classList.remove('hidden'); r.classList.add('error'); r.textContent = err.message; } }
  }
  async function companyEditEntity(resource, id) {
    const list = resource === 'products' ? _companyData.products : _companyData.personas;
    const e = (list || []).find((x) => x.id === id); if (!e) return;
    const name = prompt('Name:', e.name); if (name === null) return;
    const description = prompt('Description:', e.description || ''); if (description === null) return;
    try {
      await fetchJson(`/api/portfolio/${resource}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      loaded.knowledge = false;
      await refreshCompany();
    } catch (err) { alert(`Couldn't update: ${err.message}`); }
  }
  async function companyDeleteEntity(resource, id) {
    if (!confirm(`Delete this ${resource.replace(/s$/, '')}? Docs tagged with it must be re-tagged first.`)) return;
    try {
      await fetchJson(`/api/portfolio/${resource}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      loaded.knowledge = false;
      await refreshCompany();
    } catch (err) { alert(`Couldn't delete: ${err.message}`); }
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
    const scoreboardHtml = renderScoreboard(md.assessment);
    // Collapsible full-document view — lazy-loads the indexed text on first open
    // (see wireDocDetails). Every doc has text, so it's always offered.
    const detailHtml = `
      <details class="ci-detail">
        <summary>View full document</summary>
        <div class="ci-detail-body" data-doc-fulltext="${escapeHtml(d.id)}"></div>
      </details>`;
    const actions = [];
    if (opts.keyPointsAction) {
      actions.push(`<button class="kb-link-btn ci-kp-btn" data-kb-keypoints="${escapeHtml(d.id)}">${points.length ? '↻ refresh analysis' : 'generate analysis'}</button>`);
    }
    if (opts.deletable) {
      actions.push(`<button class="kb-link-btn" data-kb-delete="${escapeHtml(d.id)}">Delete</button>`);
    }
    // Short one-line preview shown on the compact card. Prefer the first
    // key point (already AI-curated) over the raw brief — it's the single
    // most informative sentence we have on a doc.
    const oneLiner = points.length
      ? String(points[0]).slice(0, 140) + (String(points[0]).length > 140 ? '…' : '')
      : (intelBrief(d) ? intelBrief(d).slice(0, 140) + (intelBrief(d).length > 140 ? '…' : '') : '');
    // The card is a flat, clickable row. Click opens the full-view modal —
    // see openIntelDocModal — which renders the body + key points +
    // scoreboard + full document text in one place, covering the screen.
    // Cards no longer expand inline (that produced a wall of text).
    return `
      <div class="company-intel-card ci-card stream-${streamType.toLowerCase()}" data-doc-id="${escapeHtml(d.id)}" data-intel-card-open role="button" tabindex="0">
        <div class="ci-summary">
          <div class="ci-title">${title}</div>
          <div class="ci-meta">
            ${streamPill}
            ${opts.compProductName ? `<span class="kb-stream-pill ci-comp-product" title="Filed under their product">${escapeHtml(opts.compProductName)}</span>` : ''}
            ${(d.metadata || {}).relevanceVerified === false ? `<span class="kb-stream-pill warning ci-unverified" title="${escapeHtml((d.metadata || {}).relevanceReason || 'Flagged as a possible mismatch — open to review &amp; confirm')}">⚠ Unverified</span>` : ''}
            <span>${escapeHtml(prettyCategory(d.category))}</span>
            <span>${fmtNum(d.chunk_count)} chunk${d.chunk_count === 1 ? '' : 's'}</span>
            <span>${escapeHtml(fmtDate(d.effective_date || d.created_at))}</span>
          </div>
          ${oneLiner ? `<div class="ci-oneliner kb-subtle">${escapeHtml(oneLiner)}</div>` : ''}
        </div>
      </div>`;
  }

  // Full-view modal for one intel doc — opens when the rep clicks a compact
  // card. Shows title, meta, key points (or preview brief), competitive
  // scoreboard, AND the full indexed text inline. Action buttons (refresh
  // analysis · delete) are at the bottom; close X + Esc + click-outside
  // dismiss the overlay.
  //
  // opts: { onChange } — fired after delete or keypoints-regen so the parent
  // list refreshes (closes the modal too).
  function openIntelDocModal(doc, opts = {}) {
    const { onChange } = opts;
    let overlay = $('intel-doc-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'intel-doc-overlay';
      overlay.className = 'cal-picker-overlay';
      overlay.innerHTML = `
        <div class="intel-doc-modal">
          <div class="cal-picker-h"><span class="cal-picker-title intel-doc-title"></span><button type="button" class="kb-link-btn cal-picker-close">✕</button></div>
          <div class="intel-doc-body"></div>
          <div class="intel-doc-actions"></div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeIntelDocModal(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', closeIntelDocModal);
      document.addEventListener('keydown', _intelDocEsc);
    }
    overlay.querySelector('.intel-doc-title').textContent = doc.title || '(untitled)';
    const body = overlay.querySelector('.intel-doc-body');
    const actions = overlay.querySelector('.intel-doc-actions');

    const md = doc.metadata || {};
    const points = Array.isArray(md.keyPoints) ? md.keyPoints.filter(Boolean) : [];
    const streamType = String(doc.stream_type || 'FILE').toUpperCase();
    const streamPill = `<span class="kb-stream-pill stream-${streamType.toLowerCase()}">${escapeHtml(streamType)}</span>`;
    let contentHtml;
    // TENANT docs get the rich structured analysis — branched by category:
    //   - PRODUCT_INTEL → productAnalysis (capabilities, competing products,
    //     pitch angles for THIS product)
    //   - ORG_INTELLIGENCE → companyAnalysis (services portfolio, market
    //     position, similar competitors at the company level)
    // Falls back to keyPoints / brief if neither was generated yet — the rep
    // can click "Refresh analysis" to backfill.
    if (md.productAnalysis) {
      contentHtml = renderProductAnalysis(md.productAnalysis);
    } else if (md.companyAnalysis) {
      contentHtml = renderCompanyAnalysis(md.companyAnalysis);
    } else if (points.length) {
      const kindLabel = md.keyPointsKind === 'competitive' ? 'Competitive points'
                      : md.keyPointsKind === 'opportunity' ? 'Opportunity points'
                      : 'Key points';
      contentHtml = `<div class="ci-keypoints">
          <div class="ci-keypoints-h">${escapeHtml(kindLabel)}</div>
          <ul>${points.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
        </div>`;
    } else {
      const brief = intelBrief(doc);
      contentHtml = brief
        ? `<div class="ci-brief">${escapeHtml(brief)}</div>`
        : `<div class="ci-brief is-empty">No preview text available — open the original or run analysis below.</div>`;
    }

    body.innerHTML = `
      <div class="intel-doc-meta">
        ${streamPill}
        <span>${escapeHtml(prettyCategory(doc.category))}</span>
        <span>${fmtNum(doc.chunk_count)} chunk${doc.chunk_count === 1 ? '' : 's'}</span>
        <span>${escapeHtml(fmtDate(doc.effective_date || doc.created_at))}</span>
        ${doc.source_url ? `<a href="${escapeHtml(doc.source_url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ''}
      </div>
      ${(doc.metadata || {}).relevanceVerified === false ? `<div class="kb-result warning intel-doc-quarantine">⚠ <strong>Quarantined — possible mismatch.</strong> ${escapeHtml((doc.metadata || {}).relevanceReason || 'The content may not be about this competitor.')} It's excluded from the battlecard until you confirm it below.</div>` : ''}
      ${contentHtml}
      ${renderScoreboard(md.assessment)}
      <div class="intel-doc-fulltext-h">Full indexed text</div>
      <div class="intel-doc-fulltext" data-doc-fulltext="${escapeHtml(doc.id)}">
        <div class="kb-subtle">Loading full document…</div>
      </div>
    `;

    const isUnverified = (doc.metadata || {}).relevanceVerified === false;
    actions.innerHTML = `
      ${isUnverified ? `<button class="kb-secondary-btn" data-intel-doc-confirm="${escapeHtml(doc.id)}">✓ Confirm it's about this competitor</button>` : ''}
      <button class="kb-secondary-btn" data-intel-doc-keypoints="${escapeHtml(doc.id)}">${points.length ? '↻ Refresh analysis' : 'Generate analysis'}</button>
      <button class="kb-secondary-btn danger" data-intel-doc-delete="${escapeHtml(doc.id)}">Delete</button>
    `;

    // Lazy-load the full indexed text. PDF extraction emits text with
    // hard-wrapped lines (one per visual row from the source PDF), which
    // makes the rendered output look like a wall of short paragraph
    // fragments. normalizeProseText reflows those hard wraps into proper
    // paragraphs before rendering, while leaving real markdown structure
    // (headings, lists, code) alone.
    (async () => {
      const fullBody = body.querySelector('[data-doc-fulltext]');
      try {
        const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(doc.id)}/text`, { credentials: 'include' });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        const note = data.truncated
          ? '<div class="ci-detail-note">⚠ Large document — showing the first portion only.</div>' : '';
        const normalized = normalizeProseText(data.text || '');
        const rendered = normalized ? renderMarkdown(normalized) : '<em class="kb-subtle">No text extracted.</em>';
        fullBody.innerHTML = note + `<div class="intel-doc-prose">${rendered}</div>`;
      } catch (err) {
        fullBody.innerHTML = `<div class="kb-result error">Couldn't load document text: ${escapeHtml(err.message)}</div>`;
      }
    })();

    // Wire action buttons.
    actions.querySelector('[data-intel-doc-keypoints]').addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true; const orig = b.textContent; b.textContent = '… analyzing';
      try {
        const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(doc.id)}/keypoints`, { method: 'POST', credentials: 'include' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        if (typeof onChange === 'function') onChange();
        closeIntelDocModal();
      } catch (err) {
        alert(`Couldn't generate key points: ${err.message}`);
        b.disabled = false; b.textContent = orig;
      }
    });
    const confirmBtn = actions.querySelector('[data-intel-doc-confirm]');
    if (confirmBtn) confirmBtn.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true; const orig = b.textContent; b.textContent = '… confirming';
      try {
        const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(doc.id)}/confirm-relevance`, { method: 'POST', credentials: 'include' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        if (typeof onChange === 'function') onChange();
        closeIntelDocModal();
      } catch (err) {
        alert(`Couldn't confirm: ${err.message}`);
        b.disabled = false; b.textContent = orig;
      }
    });
    actions.querySelector('[data-intel-doc-delete]').addEventListener('click', async () => {
      if (!confirm('Delete this document and all its chunks? This cannot be undone.')) return;
      try {
        const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE', credentials: 'include' });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        if (typeof onChange === 'function') onChange();
        closeIntelDocModal();
      } catch (err) { alert(`Couldn't delete: ${err.message}`); }
    });

    overlay.classList.remove('hidden');
  }

  // Render the structured Company analysis payload (TENANT-scope docs only).
  // Shape produced by api/src/knowledge/keypoints.js#extractCompanyAnalysis.
  function renderCompanyAnalysis(a) {
    if (!a || typeof a !== 'object') return '';
    const parts = [];

    if (a.executiveSummary) {
      parts.push(`
        <div class="ca-summary">
          <div class="ca-label">Executive summary</div>
          <p>${escapeHtml(a.executiveSummary)}</p>
        </div>`);
    }

    if (Array.isArray(a.services) && a.services.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Services in this doc</div>
          <div class="ca-services">
            ${a.services.map((s) => `
              <div class="ca-service">
                <div class="ca-service-name">${escapeHtml(s.name || '')}</div>
                <div class="ca-service-desc">${escapeHtml(s.description || '')}</div>
                ${s.audience ? `<div class="ca-service-audience">For: ${escapeHtml(s.audience)}</div>` : ''}
              </div>`).join('')}
          </div>
        </div>`);
    }

    if (Array.isArray(a.strengths) && a.strengths.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Strengths</div>
          <div class="ca-strengths">
            ${a.strengths.map((s) => `
              <div class="ca-strength">
                <div class="ca-strength-claim">${escapeHtml(s.claim || '')}</div>
                ${s.evidence ? `<div class="ca-strength-evidence">"${escapeHtml(s.evidence)}"</div>` : ''}
              </div>`).join('')}
          </div>
        </div>`);
    }

    if (a.marketPosition && (a.marketPosition.category || a.marketPosition.differentiator || (a.marketPosition.weaknesses || []).length)) {
      const mp = a.marketPosition;
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Market position</div>
          <div class="ca-market">
            ${mp.category       ? `<div class="ca-market-row"><strong>Category:</strong> ${escapeHtml(mp.category)}</div>` : ''}
            ${mp.differentiator ? `<div class="ca-market-row"><strong>Why we win:</strong> ${escapeHtml(mp.differentiator)}</div>` : ''}
            ${Array.isArray(mp.weaknesses) && mp.weaknesses.length
              ? `<div class="ca-market-row"><strong>Honest gaps:</strong>
                  <ul>${mp.weaknesses.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
              : ''}
          </div>
        </div>`);
    }

    if (Array.isArray(a.competitors) && a.competitors.length) {
      const ovColor = (o) => o === 'high' ? 'ca-overlap-high' : o === 'medium' ? 'ca-overlap-med' : 'ca-overlap-low';
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Similar competitors</div>
          <div class="ca-competitors">
            ${a.competitors.map((c) => `
              <div class="ca-competitor">
                <span class="ca-competitor-name">${escapeHtml(c.name || '')}</span>
                <span class="ca-overlap ${ovColor(c.overlap)}">${escapeHtml(c.overlap || 'low')}</span>
                <div class="ca-competitor-reason">${escapeHtml(c.reason || '')}</div>
              </div>`).join('')}
          </div>
        </div>`);
    }

    if (a.idealCustomerProfile) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Ideal customer profile</div>
          <p class="ca-icp">${escapeHtml(a.idealCustomerProfile)}</p>
        </div>`);
    }

    if (Array.isArray(a.salesAngles) && a.salesAngles.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">How to use this doc</div>
          <ul class="ca-angles">
            ${a.salesAngles.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
          </ul>
        </div>`);
    }

    if (a.generatedAt) {
      parts.push(`<div class="ca-meta kb-subtle">AI analysis · ${escapeHtml(fmtDate(a.generatedAt))}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</div>`);
    }

    return `<div class="ca-analysis">${parts.join('')}</div>`;
  }

  // Render the structured Product analysis payload (TENANT-scope docs filed
  // under a product line). Shape produced by extractProductAnalysis.
  function renderProductAnalysis(a) {
    if (!a || typeof a !== 'object') return '';
    const parts = [];

    if (a.executiveSummary) {
      parts.push(`
        <div class="ca-summary ca-summary-product">
          <div class="ca-label">Product summary</div>
          <p>${escapeHtml(a.executiveSummary)}</p>
        </div>`);
    }

    if (Array.isArray(a.capabilities) && a.capabilities.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">What it does</div>
          <div class="ca-capabilities">
            ${a.capabilities.map((c) => `
              <div class="ca-capability">
                <div class="ca-capability-name">${escapeHtml(c.capability || '')}</div>
                <div class="ca-capability-benefit">${escapeHtml(c.benefit || '')}</div>
              </div>`).join('')}
          </div>
        </div>`);
    }

    if (Array.isArray(a.problemsSolved) && a.problemsSolved.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Problems it solves</div>
          <ul class="ca-problems">
            ${a.problemsSolved.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}
          </ul>
        </div>`);
    }

    if (a.whoBuysIt) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Who buys it</div>
          <p class="ca-icp">${escapeHtml(a.whoBuysIt)}</p>
        </div>`);
    }

    if (Array.isArray(a.integrations) && a.integrations.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Integrates with</div>
          <div class="ca-tech-stack">
            ${a.integrations.map((t) => `<span class="ca-tech-chip">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>`);
    }

    if (a.pricingPosture) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Pricing posture</div>
          <p class="ca-icp">${escapeHtml(a.pricingPosture)}</p>
        </div>`);
    }

    if (Array.isArray(a.competingProducts) && a.competingProducts.length) {
      const ovColor = (o) => o === 'high' ? 'ca-overlap-high' : o === 'medium' ? 'ca-overlap-med' : 'ca-overlap-low';
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">Competing products</div>
          <div class="ca-competitors">
            ${a.competingProducts.map((c) => `
              <div class="ca-competitor">
                <span class="ca-competitor-name">${escapeHtml(c.name || '')}</span>
                <span class="ca-overlap ${ovColor(c.overlap)}">${escapeHtml(c.overlap || 'low')}</span>
                <div class="ca-competitor-reason">${escapeHtml(c.reason || '')}</div>
              </div>`).join('')}
          </div>
        </div>`);
    }

    if (Array.isArray(a.pitchAngles) && a.pitchAngles.length) {
      parts.push(`
        <div class="ca-section">
          <div class="ca-label">How to pitch it</div>
          <ul class="ca-angles">
            ${a.pitchAngles.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}
          </ul>
        </div>`);
    }

    if (a.generatedAt) {
      parts.push(`<div class="ca-meta kb-subtle">Product analysis · ${escapeHtml(fmtDate(a.generatedAt))}${a.model ? ` · ${escapeHtml(a.model)}` : ''}</div>`);
    }

    return `<div class="ca-analysis">${parts.join('')}</div>`;
  }

  function _intelDocEsc(e) { if (e.key === 'Escape') closeIntelDocModal(); }
  function closeIntelDocModal() {
    const o = $('intel-doc-overlay');
    if (o) o.classList.add('hidden');
  }

  // Lazy-load wiring for the "View full document" collapse on intel cards.
  // The `toggle` event doesn't bubble, so we attach per-<details> after each
  // render. First open fetches /documents/:id/text; subsequent opens are cached.
  function wireDocDetails(root) {
    if (!root) return;
    root.querySelectorAll('details.ci-detail').forEach((det) => {
      if (det.dataset.wired === '1') return;
      det.dataset.wired = '1';
      det.addEventListener('toggle', async () => {
        if (!det.open) return;
        const body = det.querySelector('[data-doc-fulltext]');
        if (!body || body.dataset.loaded === '1' || body.dataset.loading === '1') return;
        body.dataset.loading = '1';
        body.innerHTML = '<div class="kb-subtle">Loading full document…</div>';
        try {
          const id = body.dataset.docFulltext;
          const r = await fetch(`/api/knowledge/documents/${encodeURIComponent(id)}/text`, { credentials: 'include' });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          const note = data.truncated
            ? '<div class="ci-detail-note">⚠ Large document — showing the first portion only.</div>'
            : '';
          body.innerHTML = note + `<pre class="ci-detail-text">${escapeHtml(data.text || '(no text extracted)')}</pre>`;
          body.dataset.loaded = '1';
        } catch (err) {
          body.innerHTML = `<div class="kb-result error">Couldn't load document text: ${escapeHtml(err.message)}</div>`;
        } finally {
          delete body.dataset.loading;
        }
      });
    });
  }

  // Competitive scoreboard renderer. `a` is metadata.assessment as produced by
  // api/src/knowledge/assessment.js — { summary, axes[8], topImprovements,
  // weightedAdvantage }. Returns '' when there's no assessment.
  function renderScoreboard(a) {
    if (!a || !Array.isArray(a.axes) || !a.axes.length) return '';
    const adv = Number(a.weightedAdvantage) || 0;
    const verdictClass = adv > 5 ? 'win' : adv < -5 ? 'lose' : 'tie';
    const verdictLabel = adv > 5 ? `We lead by ${adv}%`
                       : adv < -5 ? `We trail by ${Math.abs(adv)}%`
                       : `Roughly tied (${adv >= 0 ? '+' : ''}${adv}%)`;
    const winnerPill = (w) => {
      const map = { us: ['ours', 'We win'], them: ['theirs', 'They win'], tie: ['tie', 'Tie'], unknown: ['unknown', 'No data'] };
      const [cls, label] = map[w] || map.unknown;
      return `<span class="sb-winner sb-${cls}">${label}</span>`;
    };
    const rows = a.axes.map((ax) => {
      const our = Math.max(0, Math.min(10, Number(ax.ourScore) || 0));
      const their = Math.max(0, Math.min(10, Number(ax.theirScore) || 0));
      const gap = ax.gapToOvercome ? `<div class="sb-gap">▲ ${escapeHtml(ax.gapToOvercome)}</div>` : '';
      return `
        <div class="sb-row">
          <div class="sb-axis">
            <span class="sb-axis-name">${escapeHtml(ax.label || ax.key)}</span>
            <span class="sb-weight">${Number(ax.weight) || 0}%</span>
          </div>
          <div class="sb-bars">
            <div class="sb-bar sb-bar-ours"><span style="width:${our * 10}%"></span><em>${our}</em></div>
            <div class="sb-bar sb-bar-theirs"><span style="width:${their * 10}%"></span><em>${their}</em></div>
          </div>
          ${winnerPill(ax.winner)}
          ${gap}
        </div>`;
    }).join('');
    const improvements = Array.isArray(a.topImprovements) && a.topImprovements.length
      ? `<div class="sb-improvements">
           <div class="sb-improvements-h">Areas to overcome</div>
           <ol>${a.topImprovements.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>
         </div>`
      : '';
    return `
      <details class="ci-scoreboard">
        <summary>
          <span class="sb-title">Competitive scoreboard</span>
          <span class="sb-verdict sb-${verdictClass}">${escapeHtml(verdictLabel)}</span>
        </summary>
        <div class="sb-body">
          ${a.summary ? `<div class="sb-summary">${escapeHtml(a.summary)}</div>` : ''}
          <div class="sb-legend"><span class="sb-dot sb-bar-ours"></span>Us &nbsp; <span class="sb-dot sb-bar-theirs"></span>Them &nbsp; · &nbsp; weight = importance in this matchup</div>
          <div class="sb-rows">${rows}</div>
          ${improvements}
        </div>
      </details>`;
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

      for (const lane of ['file', 'web']) {
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
        // Battlecard "applies to which products" checkbox list (COMPETITOR lane).
        renderAppliesList(lane, productList);
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
      wireAppliesAllToggles();
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
    resetAppliesTo(lane);
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

  // Native <select multiple> collapses to a single pick on a plain click and
  // needs Ctrl/Cmd-click to toggle — unintuitive, and it made tags impossible
  // to deselect. This makes each option toggle on click (select on first,
  // deselect on second), no modifier key needed. Wired once on the element;
  // survives option re-renders since the handler is delegated on the <select>.
  function enableToggleMultiSelect(el) {
    if (!el || el.dataset.toggleWired === '1') return;
    el.dataset.toggleWired = '1';
    el.addEventListener('mousedown', (e) => {
      const opt = e.target;
      if (!opt || opt.tagName !== 'OPTION' || opt.disabled) return;
      e.preventDefault(); // stop the browser's single-select collapse
      opt.selected = !opt.selected;
      el.focus();
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // ---- Battlecard "Which of our products does this cover?" multi-select ----
  // Three lanes (file/web/social) each have one [data-applies-list] inside
  // their COMPETITOR detail block + one [data-applies-all] master checkbox.
  // When master is checked, the list is hidden + all selections cleared
  // (semantics: empty = covers all products). When master is unchecked, the
  // user picks the specific product lines.
  function renderAppliesList(lane, products) {
    const host = document.querySelector(`[data-applies-list][data-lane="${lane}"]`);
    if (!host) return;
    if (!products.length) {
      host.innerHTML = `<div class="kb-subtle">No product lines yet — add one from the Company page first.</div>`;
      return;
    }
    host.innerHTML = products.map((p) =>
      `<label class="kb-checkbox kb-applies-item">
        <input type="checkbox" data-applies-product value="${escapeHtml(p.id)}">
        <span>${escapeHtml(p.name)}</span>
      </label>`
    ).join('');
  }

  function wireAppliesAllToggles() {
    document.querySelectorAll('[data-applies-all]').forEach((box) => {
      if (box.dataset.wired === '1') return;
      box.dataset.wired = '1';
      box.addEventListener('change', () => {
        const lane = box.dataset.lane;
        const list = document.querySelector(`[data-applies-list][data-lane="${lane}"]`);
        if (!list) return;
        if (box.checked) {
          list.hidden = true;
          list.querySelectorAll('[data-applies-product]').forEach((cb) => { cb.checked = false; });
        } else {
          list.hidden = false;
        }
      });
    });
  }

  // Returns the productIds the battlecard covers. Empty array = "all products"
  // (master checkbox is on, OR no individual boxes ticked). Caller decides
  // whether to send the field at all when empty.
  function readAppliesToProductIds(lane) {
    const master = document.querySelector(`[data-applies-all][data-lane="${lane}"]`);
    if (!master || master.checked) return [];
    const list = document.querySelector(`[data-applies-list][data-lane="${lane}"]`);
    if (!list) return [];
    return Array.from(list.querySelectorAll('[data-applies-product]:checked')).map((cb) => cb.value);
  }

  function resetAppliesTo(lane) {
    const master = document.querySelector(`[data-applies-all][data-lane="${lane}"]`);
    if (master) master.checked = true;
    const list = document.querySelector(`[data-applies-list][data-lane="${lane}"]`);
    if (list) {
      list.hidden = true;
      list.querySelectorAll('[data-applies-product]').forEach((cb) => { cb.checked = false; });
    }
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
        ['file', 'web'].forEach((t) => {
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

  // After an upload, jump to wherever the new document actually lives and
  // highlight it. TENANT intel lives on the Company page; COMPETITOR / PROSPECT
  // intel lives in the Library (under its entity tile). `doc` is the document
  // object returned by the upload endpoint.
  async function revealDocument(doc) {
    if (!doc) return;
    const scope = String(doc.scope || 'TENANT').toUpperCase();
    if (scope === 'COMPETITOR' || scope === 'PROSPECT') {
      // Pre-select the owning entity tile so the Library opens on its detail
      // view (where the doc card is rendered) rather than the tile grid.
      if (scope === 'COMPETITOR') {
        const cid = Array.isArray(doc.competitor_ids) ? doc.competitor_ids[0] : null;
        if (cid) _libSelected.competitor = cid;
      } else if (doc.company_id) {
        _libSelected.prospect = doc.company_id;
      }
      loaded.knowledge = false;
      await switchSection('knowledge');
      history.replaceState(null, '', '#knowledge');
      await switchKbTab('library');
    } else {
      loaded.company = false;
      await switchSection('company');
      history.replaceState(null, '', '#company');
    }
    // Social syncs ingest many posts with no single target — navigate only.
    if (doc.id) flashDocCard(doc.id);
  }

  // Scroll to a doc card by id and pulse it. The card may render a frame or
  // two after the section loader resolves, so retry briefly before giving up.
  function flashDocCard(id) {
    const sel = `[data-doc-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`;
    let tries = 0;
    const tick = () => {
      const card = document.querySelector(sel);
      if (card) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.add('doc-flash');
        setTimeout(() => card.classList.remove('doc-flash'), 2600);
        return;
      }
      if (++tries < 25) setTimeout(tick, 80);
    };
    tick();
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
    const streams = s.byStreamType || { FILE: 0, WEB: 0 };
    $('kb-stat-cards').innerHTML = [
      // Top row: category split
      statCard('Product Intel',   `${fmtNum(cats.PRODUCT_INTEL?.documents)} docs`),
      statCard('Org Intelligence', `${fmtNum(cats.ORG_INTELLIGENCE?.documents)} docs`),
      statCard('Battlecards',     `${fmtNum(cats.BATTLECARDS?.documents)} docs`),
      statCard('Total Chunks',    fmtNum(s.totals.chunks)),
      // Bottom row: Omni-Sync source split
      streamStatCard('Files',     streams.FILE, 'file'),
      streamStatCard('Web Pages', streams.WEB,  'web'),
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
      if (r.status === 'RUNNING') return ` <span class="lib-badge lib-badge-running">researching</span>`;
      if (r.status === 'FAILED')  return ` <span class="lib-badge lib-badge-failed">⚠︎ research failed</span>`;
      return ` <span class="lib-badge lib-badge-done">researched · ${escapeHtml(fmtDate(r.updated_at || r.created_at))}</span>`;
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
    wireDocDetails(host);
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
        <button class="kb-link-btn research-btn" data-research-start="${escapeHtml(companyId)}">Deep research</button>
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
      <div class="research-h">Deep research <span class="kb-subtle" style="font-weight:400">· ${fmtNum(r.source_count)} source${r.source_count === 1 ? '' : 's'} · ${escapeHtml(fmtDate(r.updated_at || r.created_at))}</span>
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
        // Battlecard product scope — COMPETITOR intel only; empty = all products.
        if (ent.scope === 'COMPETITOR') {
          const applies = readAppliesToProductIds('web');
          if (applies.length) body.appliesToProductIds = applies;
        }
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
            <a href="#" id="kb-web-go-doc">View document →</a>
          `;
          form.reset();
          $('kb-web-dryrun').checked = true;
          resetEntitySelector('web');
          loaded.knowledge = false;
          loaded.company = false; // a TENANT page changes the Company profile
          const go = document.getElementById('kb-web-go-doc');
          if (go) go.addEventListener('click', (ev) => {
            ev.preventDefault();
            revealDocument(d);
          });
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
        // Battlecard product scope — only meaningful for COMPETITOR intel.
        // Empty = "all products" (master checkbox on); field is omitted then.
        if (ent.scope === 'COMPETITOR') {
          for (const id of readAppliesToProductIds('file')) fd.append('appliesToProductIds', id);
        }
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
          ${fmtNum(d.token_count)} tokens. <a href="#" id="kb-go-doc">View document →</a>
        `;
        form.reset();
        resetEntitySelector('file');
        // Invalidate the Knowledge status cache (hero number) and the Company
        // profile (its intel grouping + doc counts change on a TENANT upload).
        loaded.knowledge = false;
        loaded.company = false;
        const goDoc = document.getElementById('kb-go-doc');
        if (goDoc) goDoc.addEventListener('click', (ev) => {
          ev.preventDefault();
          revealDocument(d);
        });
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
  // SETTINGS — API tokens for non-browser clients (MCP clients, AI agents, scripts).
  // See api/src/auth-tokens.js and docs/rfcs/0001-lili-integration.md §5.
  // ===========================================================================

  async function loadSettings() {
    await Promise.all([
      loadApiTokensTable(),
      loadSettingsKbStatus(),
    ]);
    wireApiTokensForm();
    wireSettingsKbTools();
  }

  // ── Market Watch ──────────────────────────────────────────────────────────
  // Premium agentic monitoring: rep marks prospects/competitors "Watch", a
  // tenant-wide cadence runs the agent, findings land in the review queue
  // (Market signals) + an optional email digest. Separate from intel until
  // a rep accepts a finding (which promotes it to a kb_documents row).

  const WATCH_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  // The browser's IANA timezone (e.g. "America/New_York"), best-effort.
  function browserTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
  }

  // <option> list for the timezone picker. Uses the full IANA set when the
  // browser exposes it (modern Chrome/FF/Safari), else a curated fallback.
  const WATCH_TZ_FALLBACK = [
    'UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'Africa/Lagos', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore',
    'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney',
  ];
  function watchTzOptions(selected) {
    let zones;
    try { zones = (Intl.supportedValuesOf && Intl.supportedValuesOf('timeZone')) || WATCH_TZ_FALLBACK; }
    catch { zones = WATCH_TZ_FALLBACK; }
    // Ensure the saved value (and UTC) are present even if not in the list.
    if (selected && !zones.includes(selected)) zones = [selected, ...zones];
    if (!zones.includes('UTC')) zones = ['UTC', ...zones];
    return zones.map((z) => `<option value="${escapeHtml(z)}" ${z === selected ? 'selected' : ''}>${escapeHtml(z.replace(/_/g, ' '))}</option>`).join('');
  }

  // <option> list for the day picker, keyed to the cadence.
  function watchDayOptions(freq, selected) {
    if (freq === 'weekly') {
      return WATCH_WEEKDAYS.map((name, i) => `<option value="${i}" ${Number(selected) === i ? 'selected' : ''}>${name}</option>`).join('');
    }
    if (freq === 'monthly') {
      let html = '';
      for (let d = 1; d <= 28; d++) html += `<option value="${d}" ${Number(selected) === d ? 'selected' : ''}>${ordinal(d)}</option>`;
      return html;
    }
    return '';
  }

  // ── Per-entity Market Watch panel ─────────────────────────────────────────
  // Each watched prospect/competitor carries its OWN schedule. The panel lives
  // on the entity's detail page: enable toggle + cadence/day/timezone/email +
  // Save + Run now. `marketWatchAvailable` (set at init from entitlements)
  // decides whether the schedule shows or an upsell does.

  function watchPanelHtml(scope, e, available) {
    const noun = scope === 'PROSPECT' ? 'prospect' : 'competitor';
    if (!available) {
      return `<div class="watch-panel">
        <div class="watch-panel-h">Market Watch</div>
        <div class="upsell-note">Monitoring is a <strong>Pro</strong> feature. <a href="#billing">Upgrade your plan</a> to have the AI track this ${noun} for new developments — funding, launches, leadership moves and more.</div>
      </div>`;
    }
    const on = !!e.watch_enabled;
    const freq = String(e.watch_frequency || 'weekly');
    const day = e.watch_day == null ? 1 : Number(e.watch_day);
    const tz = (e.watch_timezone && e.watch_timezone !== 'UTC') ? e.watch_timezone : browserTz();
    const next = e.watch_next_run_at ? new Date(e.watch_next_run_at).toLocaleString() : null;
    const last = e.watch_last_run_at ? new Date(e.watch_last_run_at).toLocaleString() : null;
    return `<div class="watch-panel">
      <div class="watch-panel-h">Market Watch
        <label class="watch-switch"><input type="checkbox" id="wp-enabled" ${on ? 'checked' : ''}> Watch this ${noun}</label>
      </div>
      <div class="watch-panel-body${on ? '' : ' hidden'}" id="wp-body">
        <div class="watch-schedule">
          <label class="watch-field">How often
            <select id="wp-frequency">
              <option value="daily"   ${freq === 'daily' ? 'selected' : ''}>Every day</option>
              <option value="weekly"  ${freq === 'weekly' ? 'selected' : ''}>Every week</option>
              <option value="monthly" ${freq === 'monthly' ? 'selected' : ''}>Every month</option>
            </select>
          </label>
          <label class="watch-field${freq === 'daily' ? ' hidden' : ''}" id="wp-day-field">
            <span id="wp-day-label">${freq === 'monthly' ? 'On day' : 'On'}</span>
            <select id="wp-day">${watchDayOptions(freq, day)}</select>
          </label>
          <label class="watch-field watch-tz-field">Timezone
            <select id="wp-timezone">${watchTzOptions(tz)}</select>
          </label>
        </div>
        <label class="watch-row">
          <input type="checkbox" id="wp-email" ${e.watch_email_digest === false ? '' : 'checked'}>
          <span>Email me a digest when new signals are found for this ${noun}</span>
        </label>
        <div class="watch-meta kb-subtle">
          Runs at 8:00 AM in the selected timezone.
          ${on && next ? ` Next: ${escapeHtml(next)}.` : ''} ${last ? `Last: ${escapeHtml(last)}.` : 'Never run yet.'}
        </div>
      </div>
      <div class="watch-actions">
        <button class="primary-cta" id="wp-save">Save</button>
        <button class="kb-secondary-btn" id="wp-run" title="Research this ${noun} right now">Run now</button>
        <span class="kb-result hidden" id="wp-result"></span>
      </div>
    </div>`;
  }

  // Render + wire the panel into `hostId` for one entity. `invalidate` marks the
  // owning list stale so a re-open reflects the new schedule.
  function mountWatchPanel(hostId, scope, entity, invalidate) {
    const host = $(hostId);
    if (!host) return;
    const url = scope === 'PROSPECT'
      ? `/api/companies/${encodeURIComponent(entity.id)}`
      : `/api/portfolio/competitors/${encodeURIComponent(entity.id)}`;

    const render = () => { host.innerHTML = watchPanelHtml(scope, entity, marketWatchAvailable); wire(); };

    function wire() {
      if (!marketWatchAvailable) return;
      const enabledEl = $('wp-enabled');
      const body = $('wp-body');
      enabledEl.addEventListener('change', () => body.classList.toggle('hidden', !enabledEl.checked));
      $('wp-frequency').addEventListener('change', (ev) => {
        const f = ev.target.value, field = $('wp-day-field'), sel = $('wp-day');
        if (f === 'daily') { field.classList.add('hidden'); return; }
        field.classList.remove('hidden');
        $('wp-day-label').textContent = f === 'monthly' ? 'On day' : 'On';
        sel.innerHTML = watchDayOptions(f, 1);
      });

      $('wp-save').addEventListener('click', async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Saving…';
        const res = $('wp-result');
        try {
          const fr = $('wp-frequency').value;
          const payload = {
            watchEnabled: $('wp-enabled').checked,
            watchFrequency: fr,
            watchTimezone: $('wp-timezone').value,
            watchEmailDigest: $('wp-email').checked,
          };
          if (fr !== 'daily') payload.watchDay = parseInt($('wp-day').value, 10);
          const out = await fetchJson(url, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          // Refresh the local entity from the server echo, then re-render.
          const row = (out && (out.company || out.competitor)) || null;
          if (row) Object.assign(entity, row);
          else Object.assign(entity, { watch_enabled: payload.watchEnabled, watch_frequency: fr, watch_email_digest: payload.watchEmailDigest });
          if (typeof invalidate === 'function') invalidate();
          render();
          const r2 = $('wp-result'); if (r2) { r2.classList.remove('hidden', 'error'); r2.classList.add('success'); r2.textContent = 'Saved.'; }
        } catch (err) {
          res.classList.remove('hidden', 'success'); res.classList.add('error'); res.textContent = err.message;
          btn.disabled = false; btn.textContent = 'Save';
        }
      });

      $('wp-run').addEventListener('click', (ev) => triggerEntityRun(scope, entity.id, ev.currentTarget));
    }

    render();
  }

  // Manual per-entity "run now" → POST /watch/run {scope, id}.
  async function triggerEntityRun(scope, id, btn) {
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Starting…';
    try {
      await fetchJson('/api/watch/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, id }),
      });
      btn.textContent = '✓ Running — check Market signals soon';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 4000);
      setTimeout(refreshWatchBadge, 20000);
    } catch (err) { alert(`Couldn't start: ${err.message}`); btn.textContent = orig; btn.disabled = false; }
  }

  // Unread-signals badge on the sidebar nav. Polled on load + after actions.
  async function refreshWatchBadge() {
    try {
      const { count } = await fetchJson('/api/watch/findings/count');
      for (const id of ['watch-badge', 'bell-badge']) {
        const badge = $(id);
        if (!badge) continue;
        if (count > 0) { badge.textContent = count > 99 ? '99+' : String(count); badge.classList.remove('hidden'); }
        else badge.classList.add('hidden');
      }
    } catch { /* non-fatal — leave badges as-is */ }
  }

  // ── Header notification bell — new market-signal developments at a glance ──
  function wireBell() {
    const btn = $('bell-btn'), panel = $('bell-panel');
    if (!btn || !panel) return;
    const close = () => { panel.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!panel.classList.contains('hidden')) { close(); return; }
      panel.classList.remove('hidden');
      btn.setAttribute('aria-expanded', 'true');
      panel.innerHTML = '<div class="bell-empty kb-subtle">Loading…</div>';
      let items = [];
      try {
        const data = await fetchJson('/api/watch/findings?limit=40');
        items = (data.findings || []).filter((f) => f.status === 'NEW').slice(0, 8);
      } catch { /* gated or unavailable */ }
      if (!items.length) {
        panel.innerHTML = `<div class="bell-h">Market signals</div>
          <div class="bell-empty kb-subtle">No new developments. Turn on Market Watch for a prospect or competitor and new findings will land here.</div>`;
        return;
      }
      panel.innerHTML = `<div class="bell-h">New developments <span class="bell-h-n">${items.length}</span></div>
        ${items.map((f) => `
          <button class="bell-item" data-goto-signals="1">
            <span class="bell-cat">${WATCH_CAT_ICON[f.category] || '•'}</span>
            <span class="bell-body">
              <span class="bell-who">${escapeHtml(f.subject_name || '')}<i>${f.scope === 'COMPETITOR' ? 'competitor' : 'prospect'}</i></span>
              <span class="bell-title">${escapeHtml(f.title || '')}</span>
            </span>
            <span class="bell-mat" title="Materiality">${'●'.repeat(Math.max(1, Math.min(5, f.materiality || 3)))}</span>
          </button>`).join('')}
        <button class="bell-foot" data-goto-signals="1">Review all in Market signals →</button>`;
      panel.querySelectorAll('[data-goto-signals]').forEach((el) => el.addEventListener('click', () => {
        close();
        loaded['market-signals'] = false;
        window.location.hash = '#market-signals';
        if (currentSection === 'market-signals') switchSection('market-signals');
      }));
    });
    document.addEventListener('click', (e) => { if (!panel.classList.contains('hidden') && !panel.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // Keep the bell current while the app is open.
    setInterval(refreshWatchBadge, 120000);
  }
  wireBell();

  const WATCH_CAT_ICON = { funding: '💰', product: '🚀', leadership: '👤', partnership: '🤝', 'm&a': '🏛️', regulatory: '⚖️', expansion: '🌐', hiring: '📈', incident: '⚠️', other: '•' };

  async function loadMarketSignals() {
    const host = $('market-signals-body');
    if (!host) return;
    const refreshBtn = $('watch-refresh-btn');
    if (refreshBtn && refreshBtn.dataset.wired !== '1') {
      refreshBtn.dataset.wired = '1';
      refreshBtn.addEventListener('click', () => { loaded['market-signals'] = false; switchSection('market-signals'); });
    }
    let data;
    try { data = await fetchJson('/api/watch/findings?limit=200'); }
    catch (err) { host.innerHTML = `<div class="kb-subtle">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
    renderMarketSignals(host, (data && data.findings) || []);
    refreshWatchBadge();
  }

  function renderMarketSignals(host, findings) {
    if (!findings.length) {
      host.innerHTML = `<div class="empty" style="padding:20px 0">
        No market signals yet. Open a <a href="#prospects">prospect</a> or <a href="#competitors">competitor</a>,
        turn on its <strong>Market Watch</strong> panel and pick a schedule, and the AI will start surfacing
        developments here.</div>`;
      return;
    }
    // Group by entity; NEW first (the list is already ordered NEW→materiality→date).
    const groups = new Map();
    for (const f of findings) {
      const key = `${f.scope}:${f.subject_id}`;
      if (!groups.has(key)) groups.set(key, { name: f.subject_name, scope: f.scope, items: [] });
      groups.get(key).items.push(f);
    }
    const card = (f) => {
      const stale = f.status !== 'NEW';
      const dt = f.published_at ? new Date(f.published_at).toLocaleDateString() : '';
      const statusPill = {
        NEW: '<span class="pill pill-new">New</span>',
        REVIEWED: '<span class="pill">Reviewed</span>',
        ACCEPTED: '<span class="pill pill-success">In intel</span>',
        DISMISSED: '<span class="pill pill-muted">Dismissed</span>',
      }[f.status] || '';
      return `
        <div class="watch-finding${stale ? ' is-stale' : ''}" data-finding="${f.id}">
          <div class="watch-finding-h">
            <span class="watch-cat" title="${escapeHtml(f.category || '')}">${WATCH_CAT_ICON[f.category] || '•'}</span>
            <span class="watch-finding-title">${escapeHtml(f.title)}</span>
            <span class="watch-mat" title="Materiality">${'●'.repeat(Math.max(1, Math.min(5, f.materiality || 3)))}</span>
            ${statusPill}
          </div>
          <div class="watch-finding-body">${escapeHtml(f.summary || '')}</div>
          <div class="watch-finding-foot">
            ${f.source_url ? `<a href="${escapeHtml(f.source_url)}" target="_blank" rel="noopener">${escapeHtml(f.source_title || 'Source')} ↗</a>` : '<span class="kb-subtle">No source link</span>'}
            ${dt ? `<span class="kb-subtle"> · ${escapeHtml(dt)}</span>` : ''}
            ${f.status === 'NEW' || f.status === 'REVIEWED' ? `
              <span class="watch-finding-actions">
                <button class="kb-link-btn" data-watch-accept="${f.id}" title="File this into the company's intel">✓ Accept to intel</button>
                <button class="kb-link-btn" data-watch-dismiss="${f.id}">Dismiss</button>
              </span>` : ''}
          </div>
        </div>`;
    };
    host.innerHTML = [...groups.values()].map((g) => `
      <div class="watch-group">
        <div class="watch-group-h">
          <span class="pill ${g.scope === 'PROSPECT' ? 'pill-info' : 'pill-warn'}">${g.scope === 'PROSPECT' ? 'Prospect' : 'Competitor'}</span>
          <strong>${escapeHtml(g.name)}</strong>
          <span class="kb-subtle">${g.items.length} signal${g.items.length === 1 ? '' : 's'}</span>
        </div>
        ${g.items.map(card).join('')}
      </div>`).join('');

    host.querySelectorAll('[data-watch-accept]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.watchAccept;
      b.disabled = true; b.textContent = 'Filing…';
      try {
        await fetchJson(`/api/watch/findings/${id}/accept`, { method: 'POST' });
        loaded['market-signals'] = false; await loadMarketSignals();
      } catch (err) { alert(`Couldn't accept: ${err.message}`); b.disabled = false; b.textContent = '✓ Accept to intel'; }
    }));
    host.querySelectorAll('[data-watch-dismiss]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.watchDismiss;
      try {
        await fetchJson(`/api/watch/findings/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'DISMISSED' }),
        });
        loaded['market-signals'] = false; await loadMarketSignals();
      } catch (err) { alert(`Couldn't dismiss: ${err.message}`); }
    }));
  }

  // ── Profile (the signed-in user's own account) ────────────────────────────
  // Read view with inline edit: each field shows its current value with an
  // Edit affordance; the input only appears while editing.
  let _profile = null;

  function initialsOf(name, fallbackEmail) {
    const n = (name || '').trim();
    if (n) return n.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
    return (fallbackEmail || '?')[0].toUpperCase();
  }

  async function loadProfile() {
    try { ({ profile: _profile } = await fetchJson('/api/auth/profile')); }
    catch (err) {
      $('name-display').textContent = `Couldn't load profile: ${err.message}`;
      return;
    }
    renderProfile();
    wireProfileForms();
    renderProfileSubscription();
    renderProfileDevices();
  }

  // Friendly-ish browser/OS label from a raw User-Agent string.
  function uaLabel(ua) {
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua) ? 'Edge'
      : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows'
      : /iPhone|iPad|iOS/.test(ua) ? 'iOS'
      : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
      : /Android/.test(ua) ? 'Android'
      : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
  }

  async function renderProfileDevices() {
    const host = $('profile-devices-body');
    if (!host) return;
    let list;
    try { ({ devices: list } = await fetchJson('/api/auth/devices')); }
    catch (err) { host.innerHTML = `<div class="empty">Couldn't load devices: ${escapeHtml(err.message)}</div>`; return; }
    if (!list || !list.length) {
      host.innerHTML = '<div class="kb-subtle">No trusted devices yet — sign in and tick "Trust this device" to add one.</div>';
      return;
    }
    host.innerHTML = `<table class="dt">
      <thead><tr><th>Device</th><th>Network</th><th>Last used</th><th>Trusted until</th><th></th></tr></thead>
      <tbody>${list.map((d) => `
        <tr data-device-row="${escapeHtml(d.id)}">
          <td>${escapeHtml(uaLabel(d.userAgent))}${d.current ? ' <span class="pill pill-ok">This device</span>' : ''}</td>
          <td class="kb-subtle">${escapeHtml(d.ipPrefix || '—')}</td>
          <td class="kb-subtle">${d.lastSeenAt ? fmtDate(d.lastSeenAt) : '—'}</td>
          <td class="kb-subtle">${d.expiresAt ? fmtDate(d.expiresAt) : '—'}</td>
          <td><button class="kb-link-btn danger" data-device-revoke="${escapeHtml(d.id)}">Revoke</button></td>
        </tr>`).join('')}
      </tbody></table>`;
    host.querySelectorAll('[data-device-revoke]').forEach((b) => b.addEventListener('click', () => revokeDevice(b.dataset.deviceRevoke)));
  }

  async function revokeDevice(id) {
    try {
      await fetchJson(`/api/auth/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast('Device revoked — it will need a new code next sign-in.');
      renderProfileDevices();
    } catch (err) { toast(err.message || 'Could not revoke device', 'warn'); }
  }

  // Subscription summary + Manage-billing inside the profile page (full plan
  // grid + usage live on the Billing page).
  async function renderProfileSubscription() {
    const host = $('profile-sub-body');
    if (!host) return;
    let b;
    try { ({ billing: b } = await fetchJson('/api/billing')); }
    catch (err) { host.innerHTML = `<div class="empty">Couldn't load subscription: ${escapeHtml(err.message)}</div>`; return; }
    const statusPill = b.active
      ? `<span class="pill pill-ok">${escapeHtml(b.status || 'ACTIVE')}</span>`
      : `<span class="pill pill-warn">${escapeHtml(b.status || 'INACTIVE')}</span>`;
    let sub = '';
    if (b.status === 'TRIAL' && b.daysLeft != null) sub = `${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left in your free trial.`;
    else if (b.currentPeriodEnd) sub = `Renews ${fmtDate(b.currentPeriodEnd)}.`;
    else if (!b.active) sub = 'Read-only — choose a plan to resume.';
    const manage = b.manageable ? '<button class="kb-secondary-btn" id="profile-manage-btn">Manage billing</button>' : '';
    host.innerHTML = `
      <div class="bill-summary-row">
        <div>
          <div class="bill-plan-name">${escapeHtml(b.planName || '—')} plan ${statusPill}</div>
          ${sub ? `<div class="bill-sub">${escapeHtml(sub)}</div>` : ''}
        </div>
        <div class="bill-summary-actions">
          ${manage}
          <button class="kb-secondary-btn" id="profile-plans-btn">View plans &amp; usage →</button>
        </div>
      </div>`;
    if (b.manageable) $('profile-manage-btn').addEventListener('click', () => openBillingPortal($('profile-manage-btn')));
    $('profile-plans-btn').addEventListener('click', () => { location.hash = '#billing'; });
  }

  function renderProfile() {
    const p = _profile || {};
    const roleLabel = (p.role || '').replace(/^\w/, (c) => c.toUpperCase());
    $('profile-avatar').textContent = initialsOf(p.name, p.email);
    $('profile-hero-name').textContent = p.name || '—';
    $('profile-hero-email').textContent = p.email || '';
    $('profile-hero-role').textContent = roleLabel;
    $('name-display').textContent = p.name || 'Not set';
    $('email-display').textContent = p.email || '—';
    $('role-display').textContent = roleLabel;
    $('created-display').textContent = p.createdAt ? fmtDate(p.createdAt) : '—';
  }

  function setMsg(id, text, kind) {
    const el = $(id);
    el.textContent = text || '';
    el.className = `profile-msg ${kind || ''}` + (text ? '' : ' hidden');
  }

  function setNameEditing(on) {
    $('name-display').classList.toggle('hidden', on);
    $('name-edit').classList.toggle('hidden', !on);
    $('name-edit-btn').classList.toggle('hidden', on);
    $('name-editing-actions').classList.toggle('hidden', !on);
    if (on) {
      $('profile-first-name').value = (_profile && _profile.firstName) || '';
      $('profile-last-name').value = (_profile && _profile.lastName) || '';
      $('profile-first-name').focus();
    } else {
      setMsg('profile-msg', '');
    }
  }

  function setPasswordEditing(on) {
    $('password-form').classList.toggle('hidden', !on);
    $('pw-edit-btn').classList.toggle('hidden', on);
    if (on) { $('pw-current').focus(); }
    else { $('password-form').reset(); setMsg('password-msg', ''); }
  }

  function wireProfileForms() {
    const root = $('section-profile');
    if (root.dataset.wired === '1') return;
    root.dataset.wired = '1';

    // ── Name: inline edit ──
    $('name-edit-btn').addEventListener('click', () => setNameEditing(true));
    $('name-cancel-btn').addEventListener('click', () => setNameEditing(false));
    $('name-save-btn').addEventListener('click', async () => {
      const firstName = $('profile-first-name').value.trim();
      const lastName = $('profile-last-name').value.trim();
      if (!firstName || !lastName) { setMsg('profile-msg', 'Please enter your first and last name.', 'err'); return; }
      const btn = $('name-save-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/auth/me', {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ firstName, lastName }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        _profile = { ..._profile, ...body.profile };
        renderProfile();
        setNameEditing(false);
        refreshSidebarName(body.profile && body.profile.name);
        toast('Profile updated.');
      } catch (err) {
        setMsg('profile-msg', err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });

    // ── Password: reveal-on-demand changer ──
    $('pw-edit-btn').addEventListener('click', () => setPasswordEditing(true));
    $('pw-cancel-btn').addEventListener('click', () => setPasswordEditing(false));
    $('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = $('pw-current').value;
      const newPassword = $('pw-new').value;
      const confirm = $('pw-new2').value;
      if (newPassword.length < 12) { setMsg('password-msg', 'New password must be at least 12 characters.', 'err'); return; }
      if (newPassword !== confirm) { setMsg('password-msg', "The new passwords don't match.", 'err'); return; }
      if (newPassword === currentPassword) { setMsg('password-msg', 'New password must be different from the current one.', 'err'); return; }
      const btn = $('password-save-btn');
      btn.disabled = true;
      try {
        const r = await fetch('/api/auth/change-password', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
        setPasswordEditing(false);
        setMsg('password-msg', '');
        toast('Password updated.');
      } catch (err) {
        setMsg('password-msg', err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Update the sidebar name + avatar in place after a profile save (the JWT
  // cookie was re-issued server-side, so no reload is needed).
  function refreshSidebarName(name) {
    if (!name) return;
    const nameEl = $('user-name');
    nameEl.textContent = name;
    nameEl.classList.remove('hidden');
    $('user-avatar').textContent = initialsOf(name);
  }

  // ── Subscription / Billing ────────────────────────────────────────────────
  const FEATURE_LABELS = {
    discovery: 'AI prospect discovery',
    competitor_research: 'AI competitor research',
    engagements: 'AI-joined engagements',
    arena: 'Arena practice + scorecards',
    crm: 'CRM integrations',
    api_tokens: 'API / MCP access',
    calendly: 'Calendly auto-booking',
    market_monitoring: 'Market Watch monitoring',
    sub_accounts: 'Team-member workspaces',
  };
  const METER_LABELS = {
    discovery: 'Prospect discovery runs',
    competitor_research: 'Competitor research runs',
    research: 'Research runs', // v2 merged pool (prospect + competitor + reveals)
    engagements: 'Engagements scheduled',
    market_monitoring: 'Market Watch checks',
    arena: 'Arena practice sessions',
  };

  // Top-of-page banner: trial countdown, or a paywall when inactive.
  // Sidebar plan chip, directly under the name/email/role. Mirrors the banner's
  // state machine but stays visible for active plans too (banner hides those).
  function renderUserPlan(ent) {
    const el = $('user-plan');
    if (!el) return;
    if (!ent) { el.classList.add('hidden'); return; }
    let text = '';
    let cls = 'user-plan';
    if (!ent.active) {
      text = 'Read-only — upgrade';
      cls += ' is-danger';
    } else if (ent.status === 'TRIAL' && ent.daysLeft != null) {
      text = `Trial — ${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left`;
      cls += ent.daysLeft <= 3 ? ' is-warn' : ' is-trial';
    } else if (ent.reason === 'internal') {
      text = ent.planName || 'Internal';
    } else {
      text = `${ent.planName || ent.plan || 'Plan'} plan`;
    }
    el.textContent = text;
    el.className = cls;
    el.classList.remove('hidden');
  }

  // Sidebar credit chip, under the plan chip. Shows the tenant's live add-on
  // balance (engagement + research) so it's visible everywhere, not just on
  // Billing. Hidden entirely when the tenant holds no credits.
  function renderUserCredits(credits) {
    const el = $('user-credits');
    if (!el) return;
    const c = credits || {};
    const eng = (c.engagements && c.engagements.remaining) || 0;
    const research = (c.research && c.research.remaining) || 0;
    if (!eng && !research) { el.classList.add('hidden'); el.textContent = ''; return; }
    const parts = [];
    if (eng) parts.push(`${eng} call`);
    if (research) parts.push(`${research} research`);
    el.innerHTML = `<span class="uc-dot">◆</span> ${parts.join(' · ')} credit${eng + research === 1 ? '' : 's'}`;
    el.title = 'Add-on credits available — click to manage';
    el.classList.remove('hidden');
    el.onclick = () => { location.hash = '#billing'; };
  }

  function renderSubBanner(ent) {
    renderUserPlan(ent);
    const el = $('sub-banner');
    if (!el || !ent) { if (el) el.classList.add('hidden'); return; }
    const goBilling = `onclick="location.hash='#billing'"`;
    if (!ent.active) {
      const why = ent.reason === 'trial_expired' ? 'Your free trial has ended.'
        : ent.reason === 'past_due' ? 'Your payment is past due.'
        : ent.reason === 'cancelled' ? 'Your subscription was cancelled.'
        : 'Your subscription is inactive.';
      el.className = 'sub-banner danger';
      el.innerHTML = `<span>${why} You have read-only access until you upgrade.</span>
        <button class="sub-banner-cta" ${goBilling}>Upgrade now →</button>`;
      el.classList.remove('hidden');
      return;
    }
    if (ent.status === 'TRIAL' && ent.daysLeft != null) {
      el.className = ent.daysLeft <= 3 ? 'sub-banner warn' : 'sub-banner info';
      el.innerHTML = `<span><strong>${ent.daysLeft} day${ent.daysLeft === 1 ? '' : 's'} left</strong> in your free trial${ent.planName ? ` · ${ent.planName} features` : ''}.</span>
        <button class="sub-banner-cta" ${goBilling}>Choose a plan →</button>`;
      el.classList.remove('hidden');
      return;
    }
    el.classList.add('hidden'); // ACTIVE / INTERNAL — no banner
  }

  // Plan-gate responses (USAGE_LIMIT / FEATURE_NOT_IN_PLAN / SUBSCRIPTION_REQUIRED)
  // → toast + route to Billing with a contextual notice so the rep can upgrade or
  // add credits right there. The notice is consumed (one-shot) by loadBilling.
  let _lastPaywallAt = 0;
  let _billingNotice = null;
  function handlePaywall(body) {
    const code = body && body.code;
    const msg = (body && body.error) || 'Upgrade required to do that.';
    toast(msg, 'warn');
    if (code === 'USAGE_LIMIT' || code === 'FEATURE_NOT_IN_PLAN' || code === 'SUBSCRIPTION_REQUIRED') {
      _billingNotice = { code, meter: (body && body.meter) || null, message: msg };
      // Throttle so a burst of gated calls doesn't yank the page repeatedly.
      if (Date.now() - _lastPaywallAt > 1500) {
        _lastPaywallAt = Date.now();
        location.hash = '#billing';
      }
    }
  }

  // Renders the one-shot limit/upgrade banner at the top of the Billing page.
  function renderBillNotice() {
    const el = $('bill-notice');
    if (!el) return;
    if (!_billingNotice) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    const n = _billingNotice; _billingNotice = null; // consume
    let headline, detail, showCredits = true;
    if (n.code === 'USAGE_LIMIT') {
      const label = (METER_LABELS[n.meter] || 'this action').toLowerCase();
      headline = `You've reached your ${label} limit on your current plan.`;
      detail = 'Upgrade for higher limits, or add a credit pack to keep going right now.';
    } else if (n.code === 'FEATURE_NOT_IN_PLAN') {
      headline = n.message || "That feature isn't in your current plan.";
      detail = 'Upgrade your plan to unlock it.';
    } else {
      headline = n.message || 'Your subscription is inactive.';
      detail = 'Choose a plan below to continue.';
      showCredits = false;
    }
    el.innerHTML = `
      <div class="bill-notice-inner">
        <span class="bill-notice-icon" aria-hidden="true">⛔</span>
        <div class="bill-notice-text"><strong>${escapeHtml(headline)}</strong><br><span class="kb-subtle">${escapeHtml(detail)}</span></div>
        <div class="bill-notice-cta">
          <button class="primary-cta" data-bill-scroll="bill-plans">Upgrade →</button>
          ${showCredits ? '<button class="kb-secondary-btn" data-bill-scroll="bill-credits">Add credits</button>' : ''}
        </div>
      </div>`;
    el.classList.remove('hidden');
    el.querySelectorAll('[data-bill-scroll]').forEach((b) => b.addEventListener('click', () => {
      const t = document.getElementById(b.dataset.billScroll);
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  }

  async function loadBilling(query) {
    renderBillNotice(); // contextual limit/upgrade banner (one-shot, if set)
    if (query && query.checkout === 'success') {
      toast('Subscription activated — welcome aboard!');
      history.replaceState(null, '', '#billing');
    } else if (query && query.checkout === 'cancel') {
      toast('Checkout cancelled.', 'warn');
      history.replaceState(null, '', '#billing');
    } else if (query && query.credits === 'success') {
      toast('Credits added — they’re ready to use.');
      history.replaceState(null, '', '#billing');
    } else if (query && query.credits === 'cancel') {
      toast('Credit purchase cancelled.', 'warn');
      history.replaceState(null, '', '#billing');
    }
    let data;
    try { data = await fetchJson('/api/billing'); }
    catch (err) { $('bill-summary').innerHTML = `<div class="empty">Couldn't load billing: ${escapeHtml(err.message)}</div>`; return; }
    renderBillingSummary(data.billing);
    renderBillingUsage(data.billing);
    renderBillingSeats(data.billing);
    renderBillingCredits(data.billing, data.creditPacks || []);
    renderBillingPlans(data.billing, data.plans || []);
    // Keep the top banner + sidebar credit chip in sync with the freshest state.
    renderSubBanner(data.billing);
    renderUserCredits(data.billing.credits);
  }

  function renderBillingSummary(b) {
    const statusPill = b.active
      ? `<span class="pill pill-ok">${escapeHtml(b.status || 'ACTIVE')}</span>`
      : `<span class="pill pill-warn">${escapeHtml(b.status || 'INACTIVE')}</span>`;
    let line2 = '';
    if (b.cancelAtPeriodEnd && b.currentPeriodEnd) {
      line2 = `Your ${b.planName || 'paid'} plan ends ${fmtDate(b.currentPeriodEnd)} — you'll move to the Free plan then.`;
    } else if (b.status === 'TRIAL' && b.daysLeft != null) {
      line2 = `${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} left in your free trial.`;
    } else if (b.currentPeriodEnd) {
      line2 = `Renews ${fmtDate(b.currentPeriodEnd)}.`;
    } else if (!b.active) {
      line2 = 'Read-only access — upgrade to resume creating and running AI actions.';
    }
    const manageBtn = b.manageable
      ? `<button class="kb-secondary-btn" id="bill-manage-btn">Manage billing</button>` : '';
    // Cancel/resume only apply to a live paid subscription (b.manageable).
    let cancelBtn = '';
    if (b.manageable) {
      cancelBtn = b.cancelAtPeriodEnd
        ? `<button class="primary-cta" id="bill-resume-btn">Resume plan</button>`
        : `<button class="kb-danger-btn" id="bill-cancel-btn">Cancel plan</button>`;
    }
    $('bill-summary').innerHTML = `
      <div class="bill-summary-row">
        <div>
          <div class="bill-plan-name">${escapeHtml(b.planName || '—')} plan ${statusPill}</div>
          ${line2 ? `<div class="bill-sub${b.cancelAtPeriodEnd ? ' bill-sub-warn' : ''}">${escapeHtml(line2)}</div>` : ''}
        </div>
        <div class="bill-summary-actions">${manageBtn}${cancelBtn}</div>
      </div>`;
    if (b.manageable) {
      $('bill-manage-btn').addEventListener('click', () => openBillingPortal($('bill-manage-btn')));
      if (b.cancelAtPeriodEnd) {
        $('bill-resume-btn').addEventListener('click', () => resumeSubscription($('bill-resume-btn')));
      } else {
        $('bill-cancel-btn').addEventListener('click', () => openCancelModal(b));
      }
    }
  }

  function renderBillingUsage(b) {
    // Meter keys follow the tenant's catalog version: v1 splits discovery /
    // competitor research, v2 has the merged research pool. The API sends
    // matching keys in caps + usage — render whichever arrive.
    const meters = (b.planVersion || 1) >= 2
      ? ['research', 'engagements', 'market_monitoring', 'arena']
      : ['discovery', 'competitor_research', 'engagements', 'market_monitoring', 'arena'];
    $('bill-usage').innerHTML = meters.map((m) => {
      const cap = b.caps ? b.caps[m] : null;
      const used = (b.usage && b.usage[m]) || 0;
      // Hide meters the current plan can't use at all (cap 0 and no usage) so a
      // Starter doesn't see "Market Watch 0/0".
      if (cap === 0 && !used) return '';
      const capLabel = cap == null ? '∞' : cap;
      const pct = cap == null || cap === 0 ? 0 : Math.min(100, Math.round((used / cap) * 100));
      const over = cap != null && used >= cap;
      return `
        <div class="usage-row">
          <div class="usage-top"><span>${escapeHtml(METER_LABELS[m] || m)}</span><span class="${over ? 'usage-over' : ''}">${used} / ${capLabel}</span></div>
          <div class="usage-bar"><i style="width:${pct}%" class="${over ? 'over' : ''}"></i></div>
        </div>`;
    }).join('') + `<div class="bill-sub" style="margin-top:10px">${
      b.lifetimeCaps
        ? 'One-time allowance on the Free plan — upgrade for monthly limits, or buy credits to keep going.'
        : 'Resets on the 1st of each month (UTC).'
    }</div>`;
  }

  // Seats (v2 plans) — paid extra seats grow the monthly research/engagement
  // allowances; the card only shows on a live v2 subscription whose plan sells
  // seats (Starter/Pro). Sub-tenants manage seats on the parent.
  function renderBillingSeats(b) {
    const card = $('bill-seats-card');
    if (!card) return;
    const s = b.seats;
    const eligible = s && s.priceMonthly && b.manageable && !b.isSubtenant;
    if (!eligible) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const total = (s.included || 0) + (s.extra || 0);
    const maxExtra = s.max != null ? Math.max(0, s.max - s.included) : 200;
    const perBits = [];
    if (s.perSeat && s.perSeat.research) perBits.push(`+${s.perSeat.research} research runs`);
    if (s.perSeat && s.perSeat.engagements) perBits.push(`+${s.perSeat.engagements} engagements`);
    const per = perBits.length ? ` Each extra seat adds ${perBits.join(' and ')} to your monthly allowance.` : '';
    $('bill-seats').innerHTML = `
      <div class="bill-summary-row">
        <div>
          <div class="bill-plan-name">${total} seat${total === 1 ? '' : 's'} <span class="pill pill-ok">${s.included} included</span></div>
          <div class="bill-sub">Extra seats are $${s.priceMonthly}/mo, prorated to your billing period.${per}</div>
        </div>
        <div class="bill-summary-actions">
          <button class="kb-secondary-btn" id="seat-minus">−</button>
          <span class="bill-plan-name" id="seat-extra-num">${s.extra} extra</span>
          <button class="kb-secondary-btn" id="seat-plus">＋</button>
          <button class="primary-cta hidden" id="seat-save">Update seats</button>
        </div>
      </div>`;
    let pending = s.extra || 0;
    const refresh = () => {
      $('seat-extra-num').textContent = `${pending} extra`;
      $('seat-minus').disabled = pending <= 0;
      $('seat-plus').disabled = pending >= maxExtra;
      $('seat-save').classList.toggle('hidden', pending === (s.extra || 0));
    };
    refresh();
    $('seat-minus').addEventListener('click', () => { pending = Math.max(0, pending - 1); refresh(); });
    $('seat-plus').addEventListener('click', () => { pending = Math.min(maxExtra, pending + 1); refresh(); });
    $('seat-save').addEventListener('click', async () => {
      const btn = $('seat-save');
      btn.disabled = true; btn.textContent = 'Updating…';
      try {
        await fetchJson('/api/billing/seats', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ extraSeats: pending }),
        });
        toast('Seats updated.', 'ok');
        loadBilling();
      } catch (err) {
        toast(`Couldn't update seats: ${err.message}`, 'warn');
        btn.disabled = false; btn.textContent = 'Update seats';
      }
    });
  }

  // Add-on credits — top-ups that kick in once a monthly cap is spent. Engagement
  // credits cover AI-joined calls; research credits cover discovery / competitor /
  // Market Watch / Arena. Bought as one-time payments; expire 90 days after purchase.
  const CREDIT_KIND_META = {
    engagements: { label: 'Engagement credits', icon: '🎧', desc: 'Extra AI-joined calls beyond your monthly plan allowance.' },
    research:    { label: 'Research credits',   icon: '🔍', desc: 'Cover prospect &amp; competitor research, proposals, contact reveals, Market Watch &amp; Arena practice.' },
  };
  function fmtCreditDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function renderBillingCredits(b, packs) {
    const bal = b.credits || {};
    const haveAny = ['engagements', 'research'].some((k) => bal[k] && bal[k].remaining > 0);

    // ── Balance band — prominent tiles for whatever the tenant currently holds.
    let balance;
    if (haveAny) {
      const tiles = ['engagements', 'research'].map((k) => {
        const c = bal[k] || { remaining: 0, nextExpiry: null };
        if (!c.remaining) return '';
        const m = CREDIT_KIND_META[k];
        const exp = c.nextExpiry ? `<div class="cbt-exp">Expires ${fmtCreditDate(c.nextExpiry)}</div>` : '';
        return `
          <div class="credit-bal-tile">
            <div class="cbt-icon">${m.icon}</div>
            <div class="cbt-body">
              <div class="cbt-num">${c.remaining}</div>
              <div class="cbt-label">${m.label}</div>
              ${exp}
            </div>
          </div>`;
      }).join('');
      balance = `<div class="credit-bal-band">${tiles}</div>`;
    } else {
      balance = `<div class="credit-bal-empty">
        <div class="cbe-icon">＋</div>
        <div>
          <div class="cbe-title">No add-on credits yet</div>
          <div class="cbe-sub">Top-up packs extend your monthly limits — buy one below and it’s ready instantly.</div>
        </div>
      </div>`;
    }

    // ── Pack ledger — grouped by kind, one hairline row per pack with a
    // compact Buy action (no full-block buttons).
    const stripeOff = !b.stripeConfigured;
    const row = (p) => {
      const dis = stripeOff ? 'disabled title="Billing not set up yet"' : '';
      const unit = p.perCredit ? `$${p.perCredit.toFixed(2)}/credit` : '';
      return `
        <div class="cp-row">
          <span class="cp-qty">${p.credits}<i>credits</i></span>
          <span class="cp-unit">${unit}</span>
          <span class="cp-price">$${p.priceUsd}</span>
          <button class="cp-buy" data-credit-pack="${escapeHtml(p.key)}" ${dis}>Buy</button>
        </div>`;
    };
    const group = (kind, list) => {
      if (!list.length) return '';
      const m = CREDIT_KIND_META[kind];
      return `
        <div class="credit-group">
          <div class="credit-group-h">
            <span class="cg-icon">${m.icon}</span>
            <span class="cg-title">${m.label}</span>
            <span class="cg-desc">${m.desc}</span>
          </div>
          <div class="credit-pack-rows">${list.map(row).join('')}</div>
        </div>`;
    };

    $('bill-credits').innerHTML = `
      ${balance}
      <div class="credit-groups">
        ${group('engagements', packs.filter((p) => p.kind === 'engagements'))}
        ${group('research', packs.filter((p) => p.kind === 'research'))}
      </div>
      <div class="bill-sub credit-foot">Credits are drawn only after your monthly plan allowance is used up, and expire 90 days after purchase. One-time payment — separate from your subscription.</div>`;

    $('bill-credits').querySelectorAll('[data-credit-pack]').forEach((btn) => {
      btn.addEventListener('click', () => startCreditCheckout(btn.dataset.creditPack, btn));
    });
  }

  // Features that carry a monthly cap — show the per-plan allowance inline so the
  // value ladder (25 vs 50 discovery, limited vs unlimited Arena) is visible.
  const METERED_FEATURES = new Set(['discovery', 'competitor_research', 'engagements', 'market_monitoring', 'arena']);
  function capBadge(v, lifetime) { return v == null ? 'unlimited' : `${v}${lifetime ? ' total' : '/mo'}`; }

  // Table-stakes capabilities included on every plan (not gated, so they're not
  // in the catalog's feature list). Calendar connect is listed because AI-joined
  // engagements run off the rep's connected calendar.
  const ALWAYS_INCLUDED = ['Connect Google &amp; Outlook calendars'];

  function renderBillingPlans(b, catalog) {
    $('bill-plans').innerHTML = catalog.map((p) => {
      const isCurrent = b.plan === p.key;
      // Enterprise is custom-priced — never surface per-meter caps (or "unlimited")
      // on its card; volume is set in the sales conversation.
      const isEnterprise = !!p.contactSales;
      const isV2 = (p.version || 1) >= 2;
      const gated = (p.features || []).map((f) => {
        // v2 merges prospect + competitor research into one metered pool —
        // render them as a single line carrying the shared cap.
        if (isV2 && f === 'competitor_research') return '';
        let label = escapeHtml(FEATURE_LABELS[f] || f);
        let capKey = f;
        if (isV2 && f === 'discovery') { label = 'Prospect &amp; competitor research'; capKey = 'research'; }
        // Skip a feature the plan can't actually use (cap 0, e.g. Market Watch on Starter).
        if (METERED_FEATURES.has(f) && p.caps && p.caps[capKey] === 0) return '';
        const cap = (!isEnterprise && METERED_FEATURES.has(f) && p.caps && capKey in p.caps)
          ? ` <span class="plan-cap">${capBadge(p.caps[capKey], p.lifetimeCaps)}</span>` : '';
        return `<li>${label}${cap}</li>`;
      }).join('');
      // v2 commercial shape: included seats (+price per extra), paid
      // sub-accounts, metered engagement overage.
      const extras = [];
      if (!isEnterprise && p.seats && p.seats.included != null) {
        const inc = `${p.seats.included} seat${p.seats.included === 1 ? '' : 's'} included`;
        const extra = p.seats.priceMonthly ? ` · +$${p.seats.priceMonthly}/mo per extra seat` : '';
        extras.push(`<li>${inc}${extra}</li>`);
      }
      if (!isEnterprise && p.subTenants) {
        extras.push(`<li>${p.subTenants.included} team member included · +$${p.subTenants.priceMonthly}/mo each</li>`);
      }
      if (!isEnterprise && p.overage && p.overage.engagements) {
        extras.push(`<li>$${p.overage.engagements.toFixed(2)} per engagement past your allowance</li>`);
      }
      const included = ALWAYS_INCLUDED.map((l) => `<li>${l}</li>`).join('');
      const enterpriseLead = isEnterprise ? '<li>Volume tailored to your team</li>' : '';
      const feats = enterpriseLead + gated + extras.join('') + included;
      let btn;
      if (isCurrent) {
        btn = `<button class="primary-cta" disabled>Current plan</button>`;
      } else if (p.contactSales) {
        btn = `<button class="kb-secondary-btn" data-contact-sales="1">Contact sales</button>`;
      } else if (p.selfServe) {
        const disabled = (!b.stripeConfigured || !p.hasPrice) ? 'disabled title="Billing not set up yet"' : '';
        btn = `<button class="primary-cta" data-upgrade="${escapeHtml(p.key)}" ${disabled}>Upgrade to ${escapeHtml(p.name)}</button>`;
      } else {
        btn = '';
      }
      const price = p.monthly === 0
        ? '<div class="plan-price">Free</div>'
        : p.monthly != null
          ? `<div class="plan-price">$${p.monthly}<span>/mo</span></div>`
          : '<div class="plan-price">Custom</div>';
      return `
        <div class="plan-card ${isCurrent ? 'current' : ''}">
          <div class="plan-name">${escapeHtml(p.name)}${isCurrent ? ' <span class="pill pill-ok">Current</span>' : ''}</div>
          ${price}
          <div class="plan-blurb">${escapeHtml(p.blurb || '')}</div>
          <ul class="plan-feats">${feats}</ul>
          <div class="plan-cta">${btn}</div>
        </div>`;
    }).join('');
    $('bill-plans').querySelectorAll('[data-upgrade]').forEach((btn) => {
      btn.addEventListener('click', () => startCheckout(btn.dataset.upgrade, btn));
    });
    $('bill-plans').querySelectorAll('[data-contact-sales]').forEach((btn) => {
      btn.addEventListener('click', () => openEnterpriseInquiryModal());
    });
  }

  // ── Enterprise "Contact sales" inquiry ─────────────────────────────────────
  function _enterpriseEsc(e) { if (e.key === 'Escape') closeEnterpriseInquiryModal(); }
  function closeEnterpriseInquiryModal() {
    const o = $('enterprise-modal-overlay'); if (o) o.classList.add('hidden');
  }
  function openEnterpriseInquiryModal() {
    let overlay = $('enterprise-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'enterprise-modal-overlay';
      overlay.className = 'cal-picker-overlay';
      overlay.innerHTML = `
        <div class="cal-picker enterprise-modal">
          <div class="cal-picker-h">
            <span class="cal-picker-title">Talk to sales — Enterprise</span>
            <button type="button" class="kb-link-btn cal-picker-close">✕</button>
          </div>
          <div class="cal-picker-body">
            <p class="kb-subtle" style="margin:0 0 14px">Tell us about your team and we'll tailor a plan and price. The numbers below help us scope it — estimates are fine.</p>
            <div class="kb-form enterprise-form">
              <div class="field kb-inline-pair">
                <div><label for="ent-name">Your name</label><input id="ent-name" type="text" maxlength="200"></div>
                <div><label for="ent-email">Work email *</label><input id="ent-email" type="email" maxlength="320"></div>
              </div>
              <div class="field"><label for="ent-company">Company</label><input id="ent-company" type="text" maxlength="200"></div>
              <div class="field kb-inline-pair">
                <div><label for="ent-reps">Sales reps (seats)</label><input id="ent-reps" type="number" min="0" inputmode="numeric" placeholder="e.g. 25"></div>
                <div><label for="ent-engagements">AI-joined calls / month</label><input id="ent-engagements" type="number" min="0" inputmode="numeric" placeholder="e.g. 400"></div>
              </div>
              <div class="field kb-inline-pair">
                <div><label for="ent-watched">Prospects/competitors to monitor</label><input id="ent-watched" type="number" min="0" inputmode="numeric" placeholder="e.g. 50"></div>
                <div><label for="ent-research">Discovery + competitor runs / month</label><input id="ent-research" type="number" min="0" inputmode="numeric" placeholder="e.g. 200"></div>
              </div>
              <div class="field"><label for="ent-crm">CRM in use <span class="kb-subtle">(optional)</span></label>
                <select id="ent-crm">
                  <option value="">Select a CRM…</option>
                  <option value="HubSpot">HubSpot</option>
                  <option value="Salesforce">Salesforce</option>
                  <option value="Pipedrive">Pipedrive</option>
                  <option value="Zoho CRM">Zoho CRM</option>
                  <option value="Microsoft Dynamics 365">Microsoft Dynamics 365</option>
                  <option value="Other">Other</option>
                  <option value="None">None</option>
                </select>
              </div>
              <div class="field"><label for="ent-notes">Anything else? <span class="kb-subtle">(optional)</span></label><textarea id="ent-notes" rows="3" placeholder="Compliance needs, timeline, integrations…"></textarea></div>
              <div class="teams-modal-actions">
                <button type="button" class="kb-secondary-btn" id="ent-cancel-btn">Cancel</button>
                <button type="button" class="primary-cta" id="ent-submit-btn">Send to sales</button>
              </div>
              <div class="kb-result hidden" id="ent-modal-result"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closeEnterpriseInquiryModal(); });
      overlay.querySelector('.cal-picker-close').addEventListener('click', closeEnterpriseInquiryModal);
      $('ent-cancel-btn').addEventListener('click', closeEnterpriseInquiryModal);
      $('ent-submit-btn').addEventListener('click', submitEnterpriseInquiry);
      document.addEventListener('keydown', _enterpriseEsc);
    }
    // Prefill from the signed-in user.
    if (me && me.name) $('ent-name').value = me.name;
    if (me && me.email) $('ent-email').value = me.email;
    $('ent-modal-result').classList.add('hidden');
    overlay.classList.remove('hidden');
    setTimeout(() => $('ent-reps').focus(), 50);
  }

  async function submitEnterpriseInquiry() {
    const email = $('ent-email').value.trim();
    const result = $('ent-modal-result');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      result.textContent = 'Please enter a valid work email.';
      result.className = 'kb-result error';
      return;
    }
    const btn = $('ent-submit-btn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/billing/enterprise-inquiry', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactName: $('ent-name').value.trim(),
          contactEmail: email,
          companyName: $('ent-company').value.trim(),
          salesReps: $('ent-reps').value,
          monthlyEngagements: $('ent-engagements').value,
          watchedEntities: $('ent-watched').value,
          monthlyResearchRuns: $('ent-research').value,
          crm: $('ent-crm').value.trim(),
          notes: $('ent-notes').value.trim(),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      closeEnterpriseInquiryModal();
      toast('Thanks — our team will be in touch shortly.', 'ok');
    } catch (err) {
      result.textContent = `Couldn't send: ${err.message}`;
      result.className = 'kb-result error';
    } finally {
      btn.disabled = false; btn.textContent = 'Send to sales';
    }
  }

  async function startCheckout(plan, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
    try {
      const r = await fetch('/api/billing/checkout', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.url) throw new Error(body.error || `HTTP ${r.status}`);
      window.location.href = body.url;
    } catch (err) {
      toast(`Couldn't start checkout: ${err.message}`, 'warn');
      if (btn) { btn.disabled = false; btn.textContent = `Upgrade`; loadBilling(); }
    }
  }

  async function startCreditCheckout(pack, btn) {
    const label = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Redirecting…'; }
    try {
      const r = await fetch('/api/billing/credits/checkout', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pack }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.url) throw new Error(body.error || `HTTP ${r.status}`);
      window.location.href = body.url;
    } catch (err) {
      toast(`Couldn't start checkout: ${err.message}`, 'warn');
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  async function openBillingPortal(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
      const r = await fetch('/api/billing/portal', { method: 'POST', credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.url) throw new Error(body.error || `HTTP ${r.status}`);
      window.location.href = body.url;
    } catch (err) {
      toast(`Couldn't open billing portal: ${err.message}`, 'warn');
      if (btn) { btn.disabled = false; btn.textContent = 'Manage billing'; }
    }
  }

  async function resumeSubscription(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Resuming…'; }
    try {
      const r = await fetch('/api/billing/resume', { method: 'POST', credentials: 'include' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      toast('Your plan is back on — no change to your billing.');
      loadBilling();
    } catch (err) {
      toast(`Couldn't resume: ${err.message}`, 'warn');
      if (btn) { btn.disabled = false; btn.textContent = 'Resume plan'; }
    }
  }

  // ── Cancellation — 3-step exit survey then cancel-at-period-end ────────────
  const CANCEL_REASONS = [
    ['too_expensive', 'Too expensive'],
    ['missing_features', 'Missing features I need'],
    ['not_enough_value', 'Didn\'t get enough value'],
    ['switching_tool', 'Switching to another tool'],
    ['temporary_need', 'Only needed it temporarily'],
    ['technical_issues', 'Technical issues / bugs'],
    ['other', 'Other'],
  ];
  const CANCEL_CONTEXT_LABEL = {
    too_expensive: 'What would have felt like fair pricing?',
    missing_features: 'Which feature were you missing?',
    not_enough_value: 'What were you hoping DealScope would do for you?',
    switching_tool: 'Which tool are you switching to?',
    temporary_need: 'What did you use DealScope for?',
    technical_issues: 'What went wrong? We\'ll look into it.',
    other: 'Tell us more',
  };
  let _cancel = { step: 1, reason: null, wouldReturn: null, plan: null, periodEnd: null };

  function _cancelEsc(e) { if (e.key === 'Escape') closeCancelModal(); }
  function closeCancelModal() { const o = $('cancel-modal-overlay'); if (o) o.classList.add('hidden'); }

  function updateCancelStep() {
    const ov = $('cancel-modal-overlay'); if (!ov) return;
    ov.querySelectorAll('.cancel-step').forEach((el) => el.classList.toggle('hidden', +el.dataset.step !== _cancel.step));
    ov.querySelectorAll('.cancel-dot').forEach((el) => el.classList.toggle('is-on', +el.dataset.dot <= _cancel.step));
    $('cancel-back-btn').style.visibility = _cancel.step === 1 ? 'hidden' : 'visible';
    const next = $('cancel-next-btn');
    if (_cancel.step === 3) { next.textContent = 'Cancel subscription'; next.classList.add('is-danger'); }
    else { next.textContent = 'Next'; next.classList.remove('is-danger'); }
    next.disabled = (_cancel.step === 1 && !_cancel.reason);
    if (_cancel.step === 2) $('cancel-context-label').textContent = CANCEL_CONTEXT_LABEL[_cancel.reason] || 'Tell us more';
    if (_cancel.step === 3) {
      $('cancel-confirm-note').textContent = _cancel.periodEnd
        ? `You'll keep ${_cancel.plan || 'your'} plan until ${fmtDate(_cancel.periodEnd)}, then move to the Free plan. No further charges.`
        : `Your plan will be cancelled at the end of the current period, then you'll move to the Free plan.`;
    }
  }

  function openCancelModal(b) {
    _cancel = { step: 1, reason: null, wouldReturn: null, plan: b.planName, periodEnd: b.currentPeriodEnd };
    let ov = $('cancel-modal-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'cancel-modal-overlay';
      ov.className = 'cal-picker-overlay';
      ov.innerHTML = `
        <div class="cal-picker cancel-modal">
          <div class="cal-picker-h">
            <span class="cal-picker-title">Cancel subscription</span>
            <button type="button" class="kb-link-btn cal-picker-close">✕</button>
          </div>
          <div class="cal-picker-body">
            <div class="cancel-dots"><span class="cancel-dot is-on" data-dot="1"></span><span class="cancel-dot" data-dot="2"></span><span class="cancel-dot" data-dot="3"></span></div>
            <div class="cancel-step" data-step="1">
              <p class="kb-subtle" style="margin:0 0 12px">We're sorry to see you go. What's the main reason you're cancelling?</p>
              <div class="cancel-reasons" id="cancel-reasons">
                ${CANCEL_REASONS.map(([v, l]) => `<label class="cancel-reason"><input type="radio" name="cancel-reason" value="${v}"><span>${escapeHtml(l)}</span></label>`).join('')}
              </div>
            </div>
            <div class="cancel-step hidden" data-step="2">
              <div class="field"><label id="cancel-context-label">Tell us more</label><textarea id="cancel-context" rows="3" placeholder="A sentence or two helps us improve."></textarea></div>
              <div class="field"><label>How likely are you to come back?</label>
                <div class="cancel-return" id="cancel-return">
                  <button type="button" data-return="unlikely">Unlikely</button>
                  <button type="button" data-return="maybe">Maybe</button>
                  <button type="button" data-return="likely">Likely</button>
                </div>
              </div>
            </div>
            <div class="cancel-step hidden" data-step="3">
              <div class="field"><label for="cancel-comments">Anything else? <span class="kb-subtle">(optional)</span></label><textarea id="cancel-comments" rows="3"></textarea></div>
              <div class="cancel-confirm-note" id="cancel-confirm-note"></div>
            </div>
            <div class="teams-modal-actions cancel-actions">
              <button type="button" class="kb-secondary-btn" id="cancel-back-btn">Back</button>
              <span class="grow"></span>
              <button type="button" class="kb-secondary-btn" id="cancel-keep-btn">Never mind</button>
              <button type="button" class="primary-cta" id="cancel-next-btn">Next</button>
            </div>
            <div class="kb-result hidden" id="cancel-modal-result"></div>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeCancelModal(); });
      ov.querySelector('.cal-picker-close').addEventListener('click', closeCancelModal);
      $('cancel-keep-btn').addEventListener('click', closeCancelModal);
      document.addEventListener('keydown', _cancelEsc);
      $('cancel-reasons').addEventListener('change', (e) => {
        if (e.target.name === 'cancel-reason') { _cancel.reason = e.target.value; updateCancelStep(); }
      });
      $('cancel-return').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-return]'); if (!btn) return;
        _cancel.wouldReturn = btn.dataset.return;
        $('cancel-return').querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === btn));
      });
      $('cancel-back-btn').addEventListener('click', () => { if (_cancel.step > 1) { _cancel.step--; updateCancelStep(); } });
      $('cancel-next-btn').addEventListener('click', () => {
        if (_cancel.step < 3) { _cancel.step++; updateCancelStep(); } else { submitCancel(); }
      });
    } else {
      // Reset fields on reopen.
      ov.querySelectorAll('input[name="cancel-reason"]').forEach((r) => { r.checked = false; });
      $('cancel-context').value = ''; $('cancel-comments').value = '';
      $('cancel-return').querySelectorAll('button').forEach((x) => x.classList.remove('is-on'));
      $('cancel-modal-result').classList.add('hidden');
    }
    updateCancelStep();
    ov.classList.remove('hidden');
  }

  async function submitCancel() {
    const result = $('cancel-modal-result');
    const btn = $('cancel-next-btn');
    btn.disabled = true; btn.textContent = 'Cancelling…';
    try {
      const r = await fetch('/api/billing/cancel', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: _cancel.reason,
          context: $('cancel-context').value.trim(),
          wouldReturn: _cancel.wouldReturn,
          comments: $('cancel-comments').value.trim(),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      closeCancelModal();
      toast('Your plan is set to cancel at the end of the period. You can resume any time before then.');
      loadBilling();
    } catch (err) {
      result.textContent = `Couldn't cancel: ${err.message}`;
      result.className = 'kb-result error';
      btn.disabled = false; btn.textContent = 'Cancel subscription';
    }
  }

  // ── Team members (internally: sub-accounts; parent → child workspaces) ───────────────────────────────
  let _saData = null;
  async function loadSubaccounts() {
    let d;
    try { d = await fetchJson('/api/account/subaccounts'); }
    catch (err) { $('subaccounts-body').innerHTML = `<div class="empty">Couldn't load team members: ${escapeHtml(err.message)}</div>`; return; }
    _saData = d;
    renderSubaccounts(d);
    loadSubaccountMonitor();
  }

  // Feature checkbox + (for metered features) cap-input rows, shared by the invite
  // and edit modals. `selected`/`caps` prefill the current grant when editing.
  function saFeatureRows(grant, selected, caps) {
    selected = selected || []; caps = caps || {};
    // v2 parents allocate the merged `research` pool (grant.caps carries a
    // `research` key) — the cap input rides on the discovery row, labelled by
    // the meter, and the competitor row gets none (same shared pool).
    const v2 = !!(grant.caps && 'research' in grant.caps);
    const meterOf = (f) => (v2 && (f === 'discovery' || f === 'competitor_research')) ? 'research' : f;
    return (grant.features || []).map((f) => {
      const meter = meterOf(f);
      const metered = METERED_FEATURES.has(f) && !(v2 && f === 'competitor_research');
      const max = grant.caps && Number.isFinite(grant.caps[meter]) ? grant.caps[meter] : null;
      const checked = selected.includes(f);
      const capVal = caps[meter] != null ? caps[meter] : '';
      const capInput = metered
        ? `<input type="number" min="0" ${max != null ? `max="${max}"` : ''} class="sa-cap" data-meter="${meter}" placeholder="${max != null ? max : '∞'}" value="${checked ? escapeHtml(String(capVal)) : ''}" ${checked ? '' : 'disabled'}>`
        : '';
      return `<label class="sa-feat">
        <input type="checkbox" class="sa-feat-cb" value="${f}" ${checked ? 'checked' : ''}>
        <span class="sa-feat-label">${escapeHtml(FEATURE_LABELS[f] || f)}</span>
        ${capInput}</label>`;
    }).join('');
  }
  // Collect ticked features + their cap inputs from a feature-rows container.
  function saCollect(containerId) {
    const features = []; const caps = {};
    document.querySelectorAll(`#${containerId} .sa-feat-cb:checked`).forEach((cb) => features.push(cb.value));
    document.querySelectorAll(`#${containerId} .sa-cap`).forEach((ci) => { if (!ci.disabled && ci.value !== '') caps[ci.dataset.meter] = ci.value; });
    return { features, caps };
  }
  // Enable a feature's cap input only while its checkbox is ticked.
  function saWireToggle(container) {
    container.addEventListener('change', (e) => {
      if (!e.target.classList.contains('sa-feat-cb')) return;
      const cap = e.target.parentElement.querySelector('.sa-cap');
      if (cap) { cap.disabled = !e.target.checked; if (!e.target.checked) cap.value = ''; }
    });
  }

  async function loadSubaccountMonitor() {
    let m;
    try { m = await fetchJson('/api/account/subaccounts/monitor'); }
    catch (err) { $('subaccounts-monitor').innerHTML = `<div class="empty">Couldn't load activity: ${escapeHtml(err.message)}</div>`; return; }
    if (!m.children || !m.children.length) { $('subaccounts-monitor').innerHTML = '<div class="kb-subtle">No team activity yet.</div>'; return; }
    const col = (label, count, rows) => `
      <div class="sam-col">
        <div class="sam-col-h">${label} <span class="sam-count">${count}</span></div>
        ${rows.length ? rows.map((r) => `<div class="sam-item"><span class="sam-item-t">${escapeHtml(r.t)}</span><span class="sam-item-d">${r.d ? escapeHtml(fmtDate(r.d)) : ''}</span></div>`).join('') : '<div class="sam-empty">—</div>'}
      </div>`;
    $('subaccounts-monitor').innerHTML = m.children.map((c) => `
      <div class="sam-card">
        <div class="sam-name">${escapeHtml(c.name)}${c.domain ? ` <span class="sam-domain">${escapeHtml(c.domain)}</span>` : ''}${c.status === 'SUSPENDED' ? ' <span class="pill pill-warn">Suspended</span>' : ''}</div>
        <div class="sam-cols">
          ${col('Intel', c.intel.count, c.intel.recent.map((r) => ({ t: r.title || 'Document', d: r.at })))}
          ${col('Call reports', c.calls.count, c.calls.recent.map((r) => ({ t: r.company, d: r.at })))}
          ${col('Upcoming', c.upcoming.count, c.upcoming.items.map((r) => ({ t: r.company, d: r.at })))}
        </div>
      </div>`).join('');
  }

  function renderSubaccounts(d) {
    const limitTxt = d.limit == null ? '∞' : d.limit;
    const atLimit = d.limit != null && d.used >= d.limit;
    const featNames = (arr) => (arr || []).map((f) => FEATURE_LABELS[f] || f).join(', ') || 'no features';
    const children = (d.children || []).map((c) => {
      const pill = c.suspended ? '<span class="pill pill-warn">Suspended</span>' : `<span class="pill pill-ok">${escapeHtml(c.status || 'Active')}</span>`;
      const action = c.suspended
        ? `<button class="kb-secondary-btn" data-unsuspend="${escapeHtml(c.id)}">Resume</button>`
        : `<button class="kb-danger-btn" data-suspend="${escapeHtml(c.id)}">Suspend</button>`;
      const who = c.ownerEmail ? `${escapeHtml(c.ownerEmail)} · ` : '';
      return `<div class="sa-row">
        <div class="sa-info"><div class="sa-name">${escapeHtml(c.name)} ${pill}</div>
          <div class="sa-sub">${who}${escapeHtml(featNames(c.features))}</div></div>
        <div class="sa-actions"><button class="kb-secondary-btn" data-edit="${escapeHtml(c.id)}">Edit</button>${action}</div></div>`;
    }).join('');
    const invites = (d.invites || []).map((iv) => `<div class="sa-row">
        <div class="sa-info"><div class="sa-name">${escapeHtml(iv.company_name)} <span class="pill">Invite pending</span></div>
          <div class="sa-sub">${escapeHtml(iv.email)} · expires ${fmtDate(iv.expires_at)}</div></div>
        <div class="sa-actions"><button class="kb-secondary-btn" data-revoke="${escapeHtml(iv.id)}">Revoke</button></div></div>`).join('');
    const empty = (!children && !invites) ? '<div class="kb-subtle">No team members yet — invite one to get started.</div>' : '';
    $('subaccounts-body').innerHTML = `
      <div class="sa-head">
        <div class="bill-sub" style="margin:0"><strong>${d.used}</strong> of <strong>${limitTxt}</strong> team members used</div>
        <button class="primary-cta" id="sa-invite-btn" ${atLimit ? 'disabled title="Limit reached — remove one or upgrade"' : ''}>+ Invite team member</button>
      </div>
      <div class="sa-list">${children}${invites}${empty}</div>`;
    if (!atLimit) $('sa-invite-btn').addEventListener('click', () => openInviteModal(d.grantOptions || { features: [], caps: {} }));
    $('subaccounts-body').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditChildModal(b.dataset.edit)));
    $('subaccounts-body').querySelectorAll('[data-suspend]').forEach((b) => b.addEventListener('click', () => subaccountAction(`${b.dataset.suspend}/suspend`, b)));
    $('subaccounts-body').querySelectorAll('[data-unsuspend]').forEach((b) => b.addEventListener('click', () => subaccountAction(`${b.dataset.unsuspend}/unsuspend`, b)));
    $('subaccounts-body').querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => revokeInvite(b.dataset.revoke, b)));
  }

  async function subaccountAction(path, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/account/subaccounts/${path}`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      loadSubaccounts();
    } catch (err) { toast(err.message, 'warn'); if (btn) btn.disabled = false; }
  }
  async function revokeInvite(id, btn) {
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(`/api/account/subaccounts/invites/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      toast('Invite revoked.'); loadSubaccounts();
    } catch (err) { toast(err.message, 'warn'); if (btn) btn.disabled = false; }
  }

  function _saEsc(e) { if (e.key === 'Escape') closeInviteModal(); }
  function closeInviteModal() { const o = $('sa-modal-overlay'); if (o) o.classList.add('hidden'); }

  function openInviteModal(grant) {
    let ov = $('sa-modal-overlay');
    const featureRows = saFeatureRows(grant, [], {});
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-modal-overlay'; ov.className = 'cal-picker-overlay';
      ov.innerHTML = `
        <div class="cal-picker sa-modal">
          <div class="cal-picker-h"><span class="cal-picker-title">Invite a team member</span>
            <button type="button" class="kb-link-btn cal-picker-close">✕</button></div>
          <div class="cal-picker-body">
            <div class="kb-form">
              <div class="field"><label for="sa-email">Owner email</label><input id="sa-email" type="email" placeholder="owner@yourcompany.com">
                <div class="field-hint">Must be on your company's domain — they'll get a link to set up their workspace.</div></div>
              <div class="field"><label>Features this team member can use</label>
                <div class="sa-feats" id="sa-feats">${featureRows}</div>
                <div class="field-hint">Tick a feature to enable it; set a monthly cap (blank = your plan's full pool).</div>
              </div>
              <div class="teams-modal-actions">
                <button type="button" class="kb-secondary-btn" id="sa-cancel">Cancel</button>
                <button type="button" class="primary-cta" id="sa-submit">Send invite</button>
              </div>
              <div class="kb-result hidden" id="sa-result"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeInviteModal(); });
      ov.querySelector('.cal-picker-close').addEventListener('click', closeInviteModal);
      $('sa-cancel').addEventListener('click', closeInviteModal);
      $('sa-submit').addEventListener('click', submitInvite);
      document.addEventListener('keydown', _saEsc);
      saWireToggle($('sa-feats'));
    } else {
      $('sa-feats').innerHTML = featureRows;
      $('sa-email').value = '';
      $('sa-result').classList.add('hidden');
    }
    ov.classList.remove('hidden');
    setTimeout(() => $('sa-email').focus(), 50);
  }

  async function submitInvite() {
    const result = $('sa-result');
    const { features, caps } = saCollect('sa-feats');
    const body = { email: $('sa-email').value.trim(), features, caps };
    if (!body.email) {
      result.textContent = 'An owner email is required.'; result.className = 'kb-result error'; return;
    }
    const btn = $('sa-submit'); btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await fetch('/api/account/subaccounts/invite', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      closeInviteModal();
      toast(j.emailSent ? 'Invite sent — they\'ll get an email to set up.' : 'Invite created (email not configured — share the link from the invites list).');
      loadSubaccounts();
    } catch (err) {
      result.textContent = err.message; result.className = 'kb-result error';
    } finally { btn.disabled = false; btn.textContent = 'Send invite'; }
  }

  // Edit an existing team member's feature mask / cap allocation (PATCH).
  function closeEditChildModal() { const o = $('sa-edit-overlay'); if (o) o.classList.add('hidden'); }
  function _saEditEsc(e) { if (e.key === 'Escape') closeEditChildModal(); }
  function openEditChildModal(childId) {
    const child = (_saData && _saData.children || []).find((c) => String(c.id) === String(childId));
    const grant = (_saData && _saData.grantOptions) || { features: [], caps: {} };
    if (!child) return;
    let ov = $('sa-edit-overlay');
    const rows = saFeatureRows(grant, child.features || [], child.caps || {});
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'sa-edit-overlay'; ov.className = 'cal-picker-overlay';
      ov.innerHTML = `
        <div class="cal-picker sa-modal">
          <div class="cal-picker-h"><span class="cal-picker-title">Edit team member</span>
            <button type="button" class="kb-link-btn cal-picker-close">✕</button></div>
          <div class="cal-picker-body">
            <div class="kb-form">
              <p class="bill-sub" id="sa-edit-name" style="margin-top:0"></p>
              <div class="field"><label>Features this team member can use</label>
                <div class="sa-feats" id="sa-edit-feats"></div>
                <div class="field-hint">Tick a feature to enable it; set a monthly cap (blank = your plan's full pool). Changes apply immediately.</div>
              </div>
              <div class="teams-modal-actions">
                <button type="button" class="kb-secondary-btn" id="sa-edit-cancel">Cancel</button>
                <button type="button" class="primary-cta" id="sa-edit-save">Save changes</button>
              </div>
              <div class="kb-result hidden" id="sa-edit-result"></div>
            </div>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => { if (e.target === ov) closeEditChildModal(); });
      ov.querySelector('.cal-picker-close').addEventListener('click', closeEditChildModal);
      $('sa-edit-cancel').addEventListener('click', closeEditChildModal);
      $('sa-edit-save').addEventListener('click', () => submitEditChild(ov.dataset.childId));
      document.addEventListener('keydown', _saEditEsc);
      saWireToggle($('sa-edit-feats'));
    }
    ov.dataset.childId = child.id;
    $('sa-edit-name').textContent = `${child.name} · ${child.domain}`;
    $('sa-edit-feats').innerHTML = rows;
    $('sa-edit-result').classList.add('hidden');
    ov.classList.remove('hidden');
  }
  async function submitEditChild(childId) {
    const result = $('sa-edit-result');
    const { features, caps } = saCollect('sa-edit-feats');
    const btn = $('sa-edit-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch(`/api/account/subaccounts/${childId}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ features, caps }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      closeEditChildModal();
      toast('Team member updated.');
      loadSubaccounts();
    } catch (err) {
      result.textContent = err.message; result.className = 'kb-result error';
    } finally { btn.disabled = false; btn.textContent = 'Save changes'; }
  }

  // Transient bottom-right confirmation toast (reusable).
  function toast(msg, kind) {
    let host = document.getElementById('gs-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'gs-toast-host';
      host.className = 'gs-toast-host';
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = `gs-toast ${kind || 'ok'}`;
    t.textContent = msg;
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2600);
  }

  // ── KB system (moved from the old Knowledge tab) ──────────────────────────
  async function loadSettingsKbStatus() {
    const host = $('settings-kb-status');
    if (!host) return;
    try {
      const s = await fetchJson('/api/knowledge/status');
      const totals = s.totals || {};
      const streams = s.byStreamType || {};
      host.innerHTML = `
        <div class="prospect-quick-row" style="grid-template-columns: repeat(4, 1fr); gap: 8px">
          ${statCard('Documents',     fmtNum(totals.documents))}
          ${statCard('Chunks indexed', fmtNum(totals.chunks))}
          ${statCard('Files',     `${fmtNum(streams.FILE   || 0)} doc${(streams.FILE   || 0) === 1 ? '' : 's'}`)}
          ${statCard('Web pages', `${fmtNum(streams.WEB    || 0)} doc${(streams.WEB    || 0) === 1 ? '' : 's'}`)}
        </div>`;
    } catch (err) {
      host.innerHTML = `<div class="empty">Couldn't load status: ${escapeHtml(err.message)}</div>`;
    }
  }

  function wireSettingsKbTools() {
    const probeBtn = $('settings-kb-search-btn');
    if (probeBtn && probeBtn.dataset.wired !== '1') {
      probeBtn.dataset.wired = '1';
      probeBtn.addEventListener('click', async () => {
        const q = $('settings-kb-search-q').value.trim();
        const k = parseInt($('settings-kb-search-k').value, 10) || 8;
        const out = $('settings-kb-search-results');
        if (!q) { out.innerHTML = '<div class="kb-subtle">Type a query first.</div>'; return; }
        probeBtn.disabled = true; const orig = probeBtn.textContent; probeBtn.textContent = 'Probing…';
        try {
          const r = await fetchJson('/api/knowledge/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: q, k }),
          });
          const hits = r.hits || r.chunks || [];
          if (hits.length === 0) {
            out.innerHTML = '<div class="empty">No chunks matched. The KB might be empty or the query too narrow.</div>';
          } else {
            out.innerHTML = `<div style="font-size:13px">Top ${hits.length} match${hits.length === 1 ? '' : 'es'}:</div>` +
              hits.map((h, i) => `
                <div class="intel-lib-row" style="margin-top:6px">
                  <div class="intel-lib-row-main">
                    <div class="intel-lib-title">${escapeHtml(h.document_title || h.title || '(untitled)')} <span class="kb-subtle">· distance ${(h.distance != null ? h.distance.toFixed(3) : '?')}</span></div>
                    <div class="intel-lib-meta">${escapeHtml((h.text || h.content || '').slice(0, 200))}${(h.text || h.content || '').length > 200 ? '…' : ''}</div>
                  </div>
                </div>`).join('');
          }
        } catch (err) {
          out.innerHTML = `<div class="kb-result error">${escapeHtml(err.message)}</div>`;
        } finally { probeBtn.disabled = false; probeBtn.textContent = orig; }
      });
    }
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
      tbl.innerHTML = '<div class="empty">No API tokens yet. Create one above to connect an MCP client, AI agent, or script.</div>';
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

  // ===================== Platform Admin Console (superadmin, read-only) =====================
  function _saGuard(hostId) {
    if (isSuperadmin) return false;
    $(hostId).innerHTML = '<div class="empty">Superadmin only.</div>';
    return true;
  }
  function chip(label, ok) {
    return `<span class="dash-found-item ${ok ? 'ok' : 'todo'}">${ok ? '✓' : '○'} ${escapeHtml(label)}</span>`;
  }

  async function loadPlatform() {
    if (_saGuard('platform-body')) return;
    let d;
    try { d = await fetchJson('/api/admin/platform/overview'); }
    catch (err) { $('platform-body').innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
    const chips = (obj) => Object.entries(obj || {}).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${v}</span>`).join(' ') || '<span class="kb-subtle">none</span>';
    $('platform-body').innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
        ${kpiCell('Tenants', d.tenants, null, 'instances')}
        ${kpiCell('Users', d.users, null, 'instances')}
        ${kpiCell('Active (30d)', d.activeTenants30d, 'logged in ≤30d', 'instances')}
        ${kpiCell('Signups (30d)', d.signups30d, null, 'instances')}
      </div>
      <div class="card"><div class="card-h">By subscription status</div><div class="card-b">${chips(d.tenantsByStatus)}</div></div>
      <div class="card"><div class="card-h">By plan</div><div class="card-b">${chips(d.tenantsByPlan)}</div></div>
      <div class="card"><div class="card-h">Usage this month (${escapeHtml(d.period || '')})</div><div class="card-b">${chips(d.usageThisMonth)}</div></div>`;
    $('platform-body').querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => switchSection(b.dataset.goto)));
  }

  let _instancesState = { selectedId: null };
  async function loadInstances() {
    if (_saGuard('instances-body')) return;
    let data;
    try { data = await fetchJson('/api/admin/platform/tenants'); }
    catch (err) { $('instances-body').innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
    const rows = data.tenants || [];
    $('instances-body').innerHTML = `
      <table class="dt">
        <thead><tr><th>Tenant</th><th>Plan</th><th>Status</th><th>Users</th><th>Last active</th><th>Created</th></tr></thead>
        <tbody>${rows.map((t) => `
          <tr data-tenant-pick="${escapeHtml(t.id)}" role="button" tabindex="0" class="${t.id === _instancesState.selectedId ? 'active' : ''}">
            <td class="dt-name"><strong>${escapeHtml(t.name || '—')}</strong>${t.domain ? `<div class="kb-subtle">${escapeHtml(t.domain)}</div>` : ''}</td>
            <td>${escapeHtml(t.plan || '—')}</td>
            <td><span class="pill">${escapeHtml(t.subscription_status || '—')}</span></td>
            <td>${fmtNum(t.user_count || 0)}</td>
            <td class="kb-subtle">${t.last_active ? fmtDate(t.last_active) : '—'}</td>
            <td class="kb-subtle">${fmtDate(t.created_at)}</td>
          </tr>`).join('')}</tbody>
      </table>
      <div id="instance-detail" style="margin-top:16px">${_instancesState.selectedId ? '<div class="kb-subtle">Loading…</div>' : '<div class="kb-subtle">Pick a tenant above to inspect it.</div>'}</div>`;
    $('instances-body').querySelectorAll('[data-tenant-pick]').forEach((el) => el.addEventListener('click', () => selectInstance(el.dataset.tenantPick)));
    if (_instancesState.selectedId) selectInstance(_instancesState.selectedId, true);
  }
  async function selectInstance(id, keep) {
    _instancesState.selectedId = id;
    if (!keep) document.querySelectorAll('#instances-body [data-tenant-pick]').forEach((el) => el.classList.toggle('active', el.dataset.tenantPick === id));
    const host = $('instance-detail');
    if (host) host.innerHTML = '<div class="kb-subtle">Loading…</div>';
    let d;
    try { d = await fetchJson(`/api/admin/platform/tenants/${encodeURIComponent(id)}`); }
    catch (err) { if (host) host.innerHTML = `<div class="empty">Couldn't load tenant: ${escapeHtml(err.message)}</div>`; return; }
    renderInstanceDetail(d);
  }
  function renderInstanceDetail(d) {
    const host = $('instance-detail');
    if (!host) return;
    const t = d.tenant || {}, e = d.entitlements || {}, cnt = d.counts || {}, ig = d.integrations || {};
    const usageRows = (d.usage || []).map((u) => `<span class="pill">${escapeHtml(u.meter)}: ${u.count}</span>`).join(' ') || '<span class="kb-subtle">no usage this month</span>';
    const crmRows = (ig.crm || []).map((c) => `<span class="pill">${escapeHtml(c.provider)}: ${escapeHtml(c.status || '—')}</span>`).join(' ') || '';
    const users = (d.users || []).map((u) => `
      <tr><td>${escapeHtml(u.email)}${u.is_admin ? ' <span class="pill pill-ok">superadmin</span>' : ''}</td>
          <td>${escapeHtml(u.name || '—')}</td><td>${escapeHtml(u.role || '—')}</td>
          <td>${u.email_verified ? '✓' : '○'}</td><td class="kb-subtle">${u.last_login_at ? fmtDate(u.last_login_at) : 'never'}</td></tr>`).join('');
    const tokens = (d.apiTokens || []).map((k) => `
      <tr><td>${escapeHtml(k.label || '—')}</td><td class="mono">${escapeHtml(k.prefix || '')}…</td>
          <td class="kb-subtle">${fmtDate(k.created_at)}</td><td class="kb-subtle">${k.last_used_at ? fmtDate(k.last_used_at) : '—'}</td>
          <td>${k.revoked_at ? '<span class="pill pill-warn">revoked</span>' : (k.expires_at && new Date(k.expires_at) < new Date() ? '<span class="pill pill-warn">expired</span>' : '<span class="pill pill-ok">active</span>')}</td>
          <td>${k.revoked_at ? '' : `<button class="kb-link-btn danger" data-token-revoke="${escapeHtml(k.id)}">Revoke</button>`}</td></tr>`).join('')
      || '<tr><td colspan="6" class="kb-subtle">No API tokens.</td></tr>';
    const activity = (d.recentActivity || []).map((a) => `
      <tr><td class="kb-subtle">${fmtDate(a.at)}</td><td>${escapeHtml(a.action)}</td><td>${escapeHtml(a.actor_email || '—')}</td><td class="mono kb-subtle">${escapeHtml(a.ip || '')}</td></tr>`).join('')
      || '<tr><td colspan="4" class="kb-subtle">No recent activity.</td></tr>';
    host.innerHTML = `
      <div class="card">
        <div class="card-h">${escapeHtml(t.name || '—')} <span class="kb-subtle">${escapeHtml(t.domain || '')}</span></div>
        <div class="card-b">
          <p><span class="pill">${escapeHtml(e.planName || t.plan || '—')}</span>
             <span class="pill">${escapeHtml(e.status || t.subscription_status || '—')}</span>
             ${e.active ? '<span class="pill pill-ok">active</span>' : '<span class="pill pill-warn">inactive</span>'}
             ${e.daysLeft != null ? `<span class="kb-subtle">· ${e.daysLeft} trial day(s) left</span>` : ''}
             ${t.current_period_end ? `<span class="kb-subtle">· renews ${fmtDate(t.current_period_end)}</span>` : ''}</p>
          <p><strong>Data:</strong>
             <span class="pill">${cnt.companies || 0} companies</span>
             <span class="pill">${cnt.contacts || 0} contacts</span>
             <span class="pill">${cnt.kbDocuments || 0} KB docs</span>
             <span class="pill">${cnt.engagements || 0} engagements</span>
             <span class="pill">${cnt.arenaSessions || 0} arena</span></p>
          <p><strong>Usage (${escapeHtml(d.tenant ? '' : '')}this month):</strong> ${usageRows}</p>
          <p><strong>Integrations:</strong> ${chip('Microsoft', ig.microsoft)} ${chip('Calendly', ig.calendly)} ${chip('Calendar', ig.calendar)} ${crmRows}</p>
        </div>
      </div>
      <div class="card"><div class="card-h">Users (${(d.users || []).length})</div>
        <div class="card-b table-wrap"><table class="dt"><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Verified</th><th>Last login</th></tr></thead><tbody>${users}</tbody></table></div></div>
      <div class="card"><div class="card-h">API tokens</div>
        <div class="card-b table-wrap"><table class="dt"><thead><tr><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th>State</th><th></th></tr></thead><tbody>${tokens}</tbody></table></div></div>
      <div class="card"><div class="card-h">Recent activity</div>
        <div class="card-b table-wrap"><table class="dt"><thead><tr><th>When</th><th>Action</th><th>Actor</th><th>IP</th></tr></thead><tbody>${activity}</tbody></table></div></div>
      ${renderManageCard(t)}`;
    wireManageCard(host, t);
  }

  // --- Phase 2: management actions (superadmin) ---
  function renderManageCard(t) {
    const planOpts = ['trial', 'starter', 'pro', 'enterprise', 'internal']
      .map((p) => `<option value="${p}" ${p === t.plan ? 'selected' : ''}>${p}</option>`).join('');
    const statusOpts = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'INTERNAL']
      .map((s) => `<option value="${s}" ${s === t.subscription_status ? 'selected' : ''}>${s}</option>`).join('');
    return `
      <div class="card" data-manage>
        <div class="card-h">Manage <span class="pf-hint">Superadmin actions — audited. Changing plan/status does not touch Stripe.</span></div>
        <div class="card-b">
          ${t.suspended_at ? `<div class="sub-banner danger" style="margin-bottom:12px">SUSPENDED since ${fmtDate(t.suspended_at)} — the org is fully locked out.</div>` : ''}
          <div class="kb-inline-pair" style="align-items:flex-end;gap:10px;flex-wrap:wrap">
            <label class="comp-finder-field">Plan<select data-mng="plan">${planOpts}</select></label>
            <label class="comp-finder-field">Status<select data-mng="status">${statusOpts}</select></label>
            <button class="kb-secondary-btn" data-mng-apply-plan>Apply plan</button>
          </div>
          <div class="kb-inline-pair" style="align-items:flex-end;gap:10px;margin-top:10px">
            <label class="comp-finder-field">Trial days<input type="number" min="1" max="3650" value="14" data-mng="trial-days" style="width:90px"></label>
            <button class="kb-secondary-btn" data-mng-trial>Set trial</button>
          </div>
          <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap">
            ${t.suspended_at
              ? '<button class="primary-cta" data-mng-reactivate>Reactivate</button>'
              : '<button class="kb-secondary-btn danger" data-mng-suspend>Suspend (lock out)</button>'}
            <button class="kb-secondary-btn" data-mng-logout>Force-logout everyone</button>
            <button class="kb-link-btn danger" data-mng-erase>Erase tenant…</button>
          </div>
        </div>
      </div>`;
  }

  async function _mngPost(path, body, okMsg) {
    try {
      await fetchJson('/api/admin/platform' + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      toast(okMsg);
      selectInstance(_instancesState.selectedId, true);
    } catch (err) { toast(err.message || 'Action failed', 'warn'); }
  }

  function wireManageCard(host, t) {
    const id = t.id;
    const card = host.querySelector('[data-manage]');
    if (!card) return;
    card.querySelector('[data-mng-apply-plan]').addEventListener('click', () => {
      const plan = card.querySelector('[data-mng="plan"]').value;
      const subscription_status = card.querySelector('[data-mng="status"]').value;
      if (!confirm(`Set ${t.name} to plan=${plan}, status=${subscription_status}?`)) return;
      _mngPost(`/tenants/${encodeURIComponent(id)}/plan`, { plan, subscription_status }, 'Plan updated');
    });
    card.querySelector('[data-mng-trial]').addEventListener('click', () => {
      const days = parseInt(card.querySelector('[data-mng="trial-days"]').value, 10);
      _mngPost(`/tenants/${encodeURIComponent(id)}/trial`, { days }, `Trial set to ${days} days`);
    });
    const susBtn = card.querySelector('[data-mng-suspend]');
    if (susBtn) susBtn.addEventListener('click', () => {
      const typed = prompt(`SUSPEND will lock out ${t.name} entirely (kills all sessions, blocks login).\nType the tenant id to confirm:\n${id}`);
      if (typed !== id) { if (typed != null) toast('Tenant id did not match — not suspended.', 'warn'); return; }
      _mngPost(`/tenants/${encodeURIComponent(id)}/suspend`, { confirm: id }, 'Tenant suspended');
    });
    const reBtn = card.querySelector('[data-mng-reactivate]');
    if (reBtn) reBtn.addEventListener('click', () => {
      if (!confirm(`Reactivate ${t.name}?`)) return;
      _mngPost(`/tenants/${encodeURIComponent(id)}/reactivate`, null, 'Tenant reactivated');
    });
    card.querySelector('[data-mng-logout]').addEventListener('click', () => {
      if (!confirm(`Force-logout every user in ${t.name}?`)) return;
      _mngPost(`/tenants/${encodeURIComponent(id)}/logout-all`, null, 'All sessions revoked');
    });
    card.querySelector('[data-mng-erase]').addEventListener('click', () => eraseTenantFlow(t));
    // per-token revoke (in the API tokens table above)
    host.querySelectorAll('[data-token-revoke]').forEach((b) => b.addEventListener('click', () => {
      if (!confirm('Revoke this API token? It will stop working immediately.')) return;
      _mngPost(`/tokens/${encodeURIComponent(b.dataset.tokenRevoke)}/revoke`, null, 'Token revoked');
    }));
  }

  async function eraseTenantFlow(t) {
    const id = t.id;
    // Show the dry-run manifest first, then require typed confirmation.
    let manifest;
    try { manifest = (await fetchJson(`/api/admin/tenants/${encodeURIComponent(id)}?dryRun=1`, { method: 'DELETE' })).manifest; }
    catch (err) { toast(err.message || 'Could not preview erase', 'warn'); return; }
    const m = manifest || {};
    const summary = `ERASE ${t.name} — irreversible. This will delete:\n` +
      `• Postgres: ${(m.postgres && m.postgres.users) || 0} users + all tenant rows\n` +
      `• R2 objects: ${(m.r2 && (m.r2.kbObjects + m.r2.recordingObjects)) || 0}\n` +
      `• Redis keys: ${(m.redis && m.redis.total) || 0}\n\nType the tenant id to confirm:\n${id}`;
    const typed = prompt(summary);
    if (typed !== id) { if (typed != null) toast('Tenant id did not match — not erased.', 'warn'); return; }
    try {
      await fetchJson(`/api/admin/tenants/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(`Tenant ${t.name} erased.`);
      _instancesState.selectedId = null;
      loadInstances();
    } catch (err) { toast(err.message || 'Erase failed', 'warn'); }
  }

  async function loadPlatformAudit() {
    if (_saGuard('platform-audit-body')) return;
    $('platform-audit-body').innerHTML = `
      <div class="prospect-discover-form" style="margin-bottom:12px">
        <input id="pa-tenant" type="text" placeholder="Tenant id (optional)">
        <input id="pa-action" type="text" placeholder="Action (e.g. auth.login.* )">
        <input id="pa-actor" type="text" placeholder="Actor email">
        <button type="button" class="primary-cta" id="pa-refresh">Filter</button>
      </div>
      <div id="pa-results"><div class="kb-subtle">Loading…</div></div>`;
    $('pa-refresh').addEventListener('click', runPlatformAudit);
    runPlatformAudit();
  }
  async function runPlatformAudit() {
    const qs = new URLSearchParams();
    const tenant = $('pa-tenant') && $('pa-tenant').value.trim();
    const action = $('pa-action') && $('pa-action').value.trim();
    const actor = $('pa-actor') && $('pa-actor').value.trim();
    if (tenant) qs.set('tenant', tenant);
    if (action) qs.set('action', action);
    if (actor) qs.set('actor', actor);
    qs.set('limit', '200');
    let data;
    try { data = await fetchJson('/api/admin/platform/audit?' + qs.toString()); }
    catch (err) { $('pa-results').innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
    const ev = data.events || [];
    $('pa-results').innerHTML = ev.length === 0 ? '<div class="empty">No events.</div>' : `
      <table class="dt"><thead><tr><th>When</th><th>Action</th><th>Result</th><th>Actor</th><th>Tenant</th><th>IP</th></tr></thead>
        <tbody>${ev.map((a) => `
          <tr><td class="kb-subtle">${fmtDate(a.at)}</td><td>${escapeHtml(a.action)}</td>
              <td>${a.result === 'failure' ? '<span class="pill pill-warn">failure</span>' : escapeHtml(a.result || '—')}</td>
              <td>${escapeHtml(a.actor_email || '—')}</td><td class="mono kb-subtle">${escapeHtml((a.tenant_id || '').slice(0, 8))}</td>
              <td class="mono kb-subtle">${escapeHtml(a.ip || '')}</td></tr>`).join('')}</tbody></table>`;
  }

  async function loadPlatformKeys() {
    if (_saGuard('platform-keys-body')) return;
    let sec, tok;
    try { [sec, tok] = await Promise.all([fetchJson('/api/admin/platform/secrets'), fetchJson('/api/admin/platform/tokens')]); }
    catch (err) { $('platform-keys-body').innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
    const groups = Object.entries(sec.groups || {}).map(([g, items]) => `
      <div class="card"><div class="card-h">${escapeHtml(g)}</div><div class="card-b">${items.map((i) => chip(i.name, i.configured)).join(' ')}</div></div>`).join('');
    const flags = Object.entries(sec.flags || {}).map(([k, v]) => `<span class="pill">${escapeHtml(k)}: ${escapeHtml(String(v))}</span>`).join(' ');
    const tokens = (tok.tokens || []).map((k) => `
      <tr><td>${escapeHtml(k.tenant_name || '—')}</td><td>${escapeHtml(k.owner_email || '—')}</td>
          <td>${escapeHtml(k.label || '—')}</td><td class="mono">${escapeHtml(k.prefix || '')}…</td>
          <td class="kb-subtle">${fmtDate(k.created_at)}</td><td class="kb-subtle">${k.last_used_at ? fmtDate(k.last_used_at) : '—'}</td>
          <td>${k.revoked_at ? '<span class="pill pill-warn">revoked</span>' : '<span class="pill pill-ok">active</span>'}</td></tr>`).join('')
      || '<tr><td colspan="7" class="kb-subtle">No tokens.</td></tr>';
    $('platform-keys-body').innerHTML = `
      <p class="kb-subtle">Secret presence only — values are never exposed. Flags: ${flags}</p>
      ${groups}
      <div class="card"><div class="card-h">API tokens (all tenants)</div>
        <div class="card-b table-wrap"><table class="dt"><thead><tr><th>Tenant</th><th>Owner</th><th>Label</th><th>Prefix</th><th>Created</th><th>Last used</th><th>State</th></tr></thead><tbody>${tokens}</tbody></table></div></div>`;
  }
})();
