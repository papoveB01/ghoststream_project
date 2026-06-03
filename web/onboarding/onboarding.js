// Free-trial onboarding wizard.
//
// Steps:
//   1. Sign up  — company / industry / website / work email / password →
//                 POST /api/onboarding/start  (validates + stores a PENDING_VERIFY
//                 session holding the bcrypt hash; sends a verification email).
//                 NO company scrape, NO tenant/user created yet.
//   2. Verify   — "check your email" screen. The link in the email confirms,
//                 provisions the tenant + user (already-verified), pulls company
//                 data, and logs in. This tab polls GET /:id/status and redirects
//                 to /admin/ once the session flips to FINALIZED (covers
//                 same-browser verify in another tab).
//
// State (sessionId, email) is held in module scope; a page refresh restarts the
// flow — the server session is keyed separately and expires on its own (24h).

(() => {
  const API = '/api/onboarding';
  const $ = (id) => document.getElementById(id);

  // Plan chosen on the landing page (?plan=starter|pro). Starter = $0 trial,
  // Pro = paid. Tunes the wizard copy so it matches what happens at checkout.
  const PLAN = new URLSearchParams(window.location.search).get('plan') === 'pro' ? 'pro' : 'starter';
  (function tuneCopyForPlan() {
    const setText = (id, t) => { const el = $(id); if (el && t) el.textContent = t; };
    if (PLAN === 'pro' || PLAN === 'starter') {
      const name = PLAN === 'pro' ? 'Pro' : 'Starter';
      const price = PLAN === 'pro' ? '$149/mo' : '$49/mo';
      document.title = `Get started with ${name} · GhostStream`;
      setText('ob-identity-sub', `Create your workspace and set a password. We'll email a confirmation link, then take you to checkout to activate ${name} (${price}).`);
      setText('ob-check-sub-text', `Click it to continue to checkout and activate your ${name} plan.`);
    } else {
      document.title = 'Start free · GhostStream';
      setText('ob-identity-sub', 'Create your workspace and set a password. We\'ll email a confirmation link, then you\'re in — free forever, no credit card required.');
      setText('ob-check-sub-text', 'Click it to finish — your free workspace is ready, no card needed.');
    }
  })();

  const state = {
    sessionId: null,
    email: '',
    pollTimer: null,
  };

  // ---------- step / pane switching ----------
  const PANES = ['identity', 'check'];
  const PANE_STEP = { identity: 1, check: 2 };

  function showPane(name) {
    PANES.forEach((p) => $(`pane-${p}`).classList.toggle('hidden', p !== name));
    const step = PANE_STEP[name];
    document.querySelectorAll('#ob-steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === step);
      li.classList.toggle('done', n < step);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showError(elId, msg) {
    const el = $(elId);
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function clearError(elId) { $(elId).classList.add('hidden'); }

  // ---------- industries dropdown ----------
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

  // ---------- password strength meter ----------
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
    if (!pw) { $('pw-hint').textContent = 'Use 12+ characters. A passphrase works great.'; return; }
    const sc = pwScore(pw);
    if (pw.length < 12 || sc <= 2) {
      meter.classList.add('weak');
      $('pw-hint').textContent = pw.length < 12
        ? `${12 - pw.length} more character${12 - pw.length === 1 ? '' : 's'} needed.`
        : 'Weak — add length or variety.';
    } else if (sc <= 4) {
      meter.classList.add('medium');
      $('pw-hint').textContent = 'Good. A longer passphrase would be even better.';
    } else {
      meter.classList.add('strong');
      $('pw-hint').textContent = 'Strong password.';
    }
  });

  // ---------- step 1: sign up (POST /start) ----------
  // Re-used by the "Resend email" button, which simply re-POSTs the same details.
  async function submitSignup(btn) {
    clearError('err-identity');
    const pw = $('f-password').value;
    const pw2 = $('f-password2').value;
    const body = {
      firstName: $('f-first-name').value.trim(),
      lastName: $('f-last-name').value.trim(),
      // Plan chosen on the landing page (?plan=starter|pro); defaults to starter.
      plan: new URLSearchParams(window.location.search).get('plan') || 'starter',
      companyName: $('f-company').value.trim(),
      industry: $('f-industry').value,
      website: $('f-website').value.trim(),
      email: $('f-email').value.trim(),
      password: pw,
    };
    if (!body.firstName || !body.lastName) {
      showError('err-identity', 'Please enter your first and last name.');
      return;
    }
    if (!body.companyName || !body.industry || !body.website || !body.email) {
      showError('err-identity', 'Please fill in all fields.');
      return;
    }
    if (pw.length < 12) { showError('err-identity', 'Password must be at least 12 characters.'); return; }
    if (pw !== pw2) { showError('err-identity', "The two passwords don't match."); return; }

    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Sending…';
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
      state.email = body.email;
      $('check-email').textContent = body.email;

      // Dev fallback: no email provider configured → expose the link so it's testable.
      const dev = $('check-dev');
      if (data.verifyUrl) {
        dev.innerHTML = `Email delivery isn't configured here. Open your confirmation link directly: <a href="${data.verifyUrl}">confirm &amp; build my workspace →</a>`;
        dev.classList.remove('hidden');
      } else {
        dev.classList.add('hidden');
      }

      showPane('check');
      startPolling();
    } catch (err) {
      showError('err-identity', 'Network error — please try again.');
    } finally {
      btn.disabled = false; btn.textContent = orig;
    }
  }

  $('form-identity').addEventListener('submit', (e) => {
    e.preventDefault();
    submitSignup($('btn-identity'));
  });

  // ---------- step 2: poll for FINALIZED ----------
  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      if (!state.sessionId) return;
      try {
        const r = await fetch(`${API}/${state.sessionId}/status`);
        if (!r.ok) return; // 404 = expired; leave them on the check screen
        const s = await r.json();
        if (s.status === 'FINALIZED') {
          clearInterval(state.pollTimer);
          window.location.href = s.redirectTo || '/admin/';
        }
        // PENDING_VERIFY → keep waiting for the email click
      } catch { /* transient — keep polling */ }
    }, 3000);
  }

  // ---------- check-email actions ----------
  $('btn-resend').addEventListener('click', () => submitSignup($('btn-resend')));
  $('btn-restart').addEventListener('click', (e) => {
    e.preventDefault();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.sessionId = null;
    showPane('identity');
  });

  // ---------- init ----------
  loadIndustries();
  showPane('identity');
})();
