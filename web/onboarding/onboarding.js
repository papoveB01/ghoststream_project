// Free-trial onboarding wizard.
//
// Steps:
//   1. Identity   — company / industry / website / email → POST /api/onboarding/start
//   2. Verify     — poll GET /api/onboarding/:id/status → show the Company
//                   Intelligence Brief (or a "couldn't research" notice)
//   3. Secure     — password → POST /api/onboarding/:id/finalize → auto-login,
//                   redirect to /admin/
//
// State (companyName, sessionId) is held in module scope; a page refresh
// restarts the flow — that's fine, the server session is keyed separately and
// expires on its own.

(() => {
  const API = '/api/onboarding';
  const $ = (id) => document.getElementById(id);

  const state = {
    sessionId: null,
    companyName: '',
    email: '',
    pollTimer: null,
  };

  // ---------- step / pane switching ----------
  const PANES = ['identity', 'researching', 'brief', 'secure', 'done'];
  // which header step (1/2/3) each pane belongs to
  const PANE_STEP = { identity: 1, researching: 2, brief: 2, secure: 3, done: 3 };

  function showPane(name) {
    PANES.forEach((p) => $(`pane-${p}`).classList.toggle('hidden', p !== name));
    const step = PANE_STEP[name];
    document.querySelectorAll('#ob-steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === step);
      li.classList.toggle('done', n < step || name === 'done');
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showError(elId, msg) {
    const el = $(elId);
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function clearError(elId) { $(elId).classList.add('hidden'); }

  // ---------- step 1: identity ----------
  async function loadIndustries() {
    try {
      const r = await fetch(`${API}/industries`);
      const { industries } = await r.json();
      const sel = $('f-industry');
      for (const ind of industries) {
        const opt = document.createElement('option');
        opt.value = ind; opt.textContent = ind;
        sel.appendChild(opt);
      }
    } catch { /* dropdown stays with just the placeholder; server still validates */ }
  }

  $('form-identity').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('err-identity');
    const btn = $('btn-identity');
    const body = {
      companyName: $('f-company').value.trim(),
      industry: $('f-industry').value,
      website: $('f-website').value.trim(),
      email: $('f-email').value.trim(),
    };
    if (!body.companyName || !body.industry || !body.website || !body.email) {
      showError('err-identity', 'Please fill in all fields.');
      return;
    }
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Starting…';
    try {
      const r = await fetch(`${API}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showError('err-identity', data.error || `Something went wrong (HTTP ${r.status}).`);
        return;
      }
      state.sessionId = data.sessionId;
      state.companyName = body.companyName;
      state.email = body.email;
      $('researching-company').textContent = body.companyName;
      $('secure-email').textContent = body.email;
      showPane('researching');
      startPolling();
    } catch (err) {
      showError('err-identity', 'Network error — please try again.');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  // ---------- step 2: poll status ----------
  const RESEARCH_LOG_LINES = [
    'Reaching your website…',
    'Reading your homepage…',
    'Identifying products & value propositions…',
    'Building your Company Intelligence Brief…',
  ];
  let logIdx = 0;
  function tickResearchLog() {
    if (logIdx < RESEARCH_LOG_LINES.length) {
      const li = document.createElement('li');
      li.textContent = RESEARCH_LOG_LINES[logIdx++];
      $('researching-log').appendChild(li);
    }
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    logIdx = 0;
    $('researching-log').innerHTML = '';
    tickResearchLog();
    let ticks = 0;
    state.pollTimer = setInterval(async () => {
      ticks++;
      if (ticks % 2 === 0) tickResearchLog();
      try {
        const r = await fetch(`${API}/${state.sessionId}/status`);
        if (!r.ok) {
          // 404 = session expired — kick back to step 1.
          clearInterval(state.pollTimer);
          showPane('identity');
          showError('err-identity', 'Your session expired. Please start again.');
          return;
        }
        const s = await r.json();
        if (s.status === 'SCRAPE_READY') {
          clearInterval(state.pollTimer);
          renderBrief(s);
        } else if (s.status === 'SCRAPE_FAILED') {
          clearInterval(state.pollTimer);
          renderBrief(s, true);
        }
        // PENDING_SCRAPE → keep polling
      } catch { /* transient — keep polling */ }
    }, 2500);
  }

  // ---------- step 2b: brief ----------
  function renderBrief(s, failed) {
    const b = s.brief || {};
    if (failed || !s.brief) {
      $('brief-headline').textContent = "We couldn't finish researching your site";
      $('brief-mission').textContent = '—';
      $('brief-products-row').style.display = 'none';
      $('brief-audience-row').style.display = 'none';
      const warn = $('brief-warn');
      warn.textContent = s.error || "No problem — you can add details to your workspace after signing up.";
      warn.classList.remove('hidden');
    } else {
      $('brief-headline').textContent = b.headline || 'Here\'s what we found.';
      $('brief-mission').textContent = b.missionStatement || '—';
      const products = Array.isArray(b.keyProducts) ? b.keyProducts.filter(Boolean) : [];
      if (products.length) {
        $('brief-products-row').style.display = '';
        const ul = $('brief-products'); ul.innerHTML = '';
        for (const p of products.slice(0, 12)) {
          const li = document.createElement('li'); li.textContent = p; ul.appendChild(li);
        }
      } else {
        $('brief-products-row').style.display = 'none';
      }
      if (b.primaryAudience) {
        $('brief-audience-row').style.display = '';
        $('brief-audience').textContent = b.primaryAudience;
      } else {
        $('brief-audience-row').style.display = 'none';
      }
      $('brief-warn').classList.add('hidden');
    }
    showPane('brief');
  }

  $('btn-brief-confirm').addEventListener('click', () => showPane('secure'));
  $('btn-brief-back').addEventListener('click', () => {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.sessionId = null;
    showPane('identity');
  });

  // ---------- step 3: secure ----------
  function pwScore(pw) {
    let score = 0;
    if (pw.length >= 12) score++;
    if (pw.length >= 16) score++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    if (pw.length >= 12 && /\s/.test(pw)) score++; // passphrase bonus
    return score; // 0..6
  }
  $('f-password').addEventListener('input', () => {
    const pw = $('f-password').value;
    const meter = $('pw-strength');
    meter.classList.remove('weak', 'medium', 'strong');
    if (!pw) return;
    const sc = pwScore(pw);
    if (pw.length < 12 || sc <= 2) { meter.classList.add('weak'); $('pw-hint').textContent = pw.length < 12 ? `${12 - pw.length} more character${12 - pw.length === 1 ? '' : 's'} needed.` : 'Weak — add length or variety.'; }
    else if (sc <= 4) { meter.classList.add('medium'); $('pw-hint').textContent = 'Good. A longer passphrase would be even better.'; }
    else { meter.classList.add('strong'); $('pw-hint').textContent = 'Strong password.'; }
  });

  $('form-secure').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('err-secure');
    const pw = $('f-password').value;
    const pw2 = $('f-password2').value;
    if (pw.length < 12) { showError('err-secure', 'Password must be at least 12 characters.'); return; }
    if (pw !== pw2) { showError('err-secure', 'The two passwords don\'t match.'); return; }
    const btn = $('btn-secure');
    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Creating your workspace…';
    try {
      const r = await fetch(`${API}/${state.sessionId}/finalize`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ password: pw }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showError('err-secure', data.error || `Something went wrong (HTTP ${r.status}).`);
        return;
      }
      // Success — auto-logged in (cookie set). Show the done pane + redirect.
      const sub = $('done-sub');
      if (data.emailSent) {
        sub.textContent = `We've sent a verification link to ${state.email}. Confirm it when you can — meanwhile, we're taking you to your workspace…`;
      } else {
        sub.textContent = 'Your workspace is ready — taking you there now…';
      }
      showPane('done');
      const dest = data.redirectTo || '/admin/';
      setTimeout(() => { window.location.href = dest; }, 3500);
    } catch (err) {
      showError('err-secure', 'Network error — please try again.');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  });

  // ---------- init ----------
  loadIndustries();
  showPane('identity');
})();
