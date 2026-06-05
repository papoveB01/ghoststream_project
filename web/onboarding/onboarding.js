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
  // Plan from the landing CTA: ?plan=starter|pro routes to Checkout after signup.
  // No param (or anything else) = the FREE plan — never sent to payment.
  const _planParam = new URLSearchParams(window.location.search).get('plan');
  const PLAN = (_planParam === 'pro' || _planParam === 'starter') ? _planParam : 'free';
  (function tuneCopyForPlan() {
    const setText = (id, t) => { const el = $(id); if (el && t) el.textContent = t; };
    if (PLAN === 'pro' || PLAN === 'starter') {
      const name = PLAN === 'pro' ? 'Pro' : 'Starter';
      const price = PLAN === 'pro' ? '$149/mo' : '$49/mo';
      document.title = `Get started with ${name} · DealScope`;
      setText('ob-check-sub-text', `Click it to continue to checkout and activate your ${name} plan.`);
    } else {
      document.title = 'Start free · DealScope';
      setText('ob-check-sub-text', 'Click it to finish — your free workspace is ready, no card needed.');
    }
  })();

  const state = {
    sessionId: null,
    email: '',
    pollTimer: null,
  };

  // ---------- step / pane switching ----------
  // The signup form is a 3-substep wizard (1 Company · 2 About you · 3 Account)
  // inside #pane-identity; #pane-check is the 4th step (Verify email).
  const PANES = ['identity', 'check'];
  const MAX_SUBSTEP = 3;
  let subStep = 1;

  function setStepper(step) {
    document.querySelectorAll('#ob-steps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === step);
      li.classList.toggle('done', n < step);
    });
  }

  function showSubstep(n) {
    subStep = n;
    document.querySelectorAll('.ob-substep').forEach((el) => {
      el.classList.toggle('hidden', Number(el.dataset.substep) !== n);
    });
    setStepper(n);
    const active = document.querySelector(`.ob-substep[data-substep="${n}"]`);
    if (active) { const f = active.querySelector('input, select'); if (f) setTimeout(() => f.focus(), 50); }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function showPane(name) {
    PANES.forEach((p) => $(`pane-${p}`).classList.toggle('hidden', p !== name));
    if (name === 'identity') showSubstep(subStep);
    else if (name === 'check') { setStepper(4); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }

  // ---------- light client-side validation (server is authoritative) ----------
  const PUBLIC_MAILBOXES = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
    'live.com', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com',
    'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
    'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'fastmail.com',
    'hey.com', 'qq.com', '163.com', '126.com',
  ]);
  function hostFromWebsite(website) {
    let h = String(website || '').trim().toLowerCase();
    h = h.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return h.split('/')[0].split('?')[0].split('#')[0].split(':')[0];
  }
  function emailDomainOf(email) {
    const m = String(email || '').trim().toLowerCase().match(/@(.+)$/);
    return m ? m[1] : '';
  }
  // Mirror of the server's domainsRelated: equal, or one a subdomain of the other.
  function domainsRelated(ed, wd) {
    if (!ed || !wd) return false;
    return ed === wd || ed.endsWith('.' + wd) || wd.endsWith('.' + ed);
  }

  function validateStep1() {
    clearError('err-step1');
    const company = $('f-company').value.trim();
    const website = $('f-website').value.trim();
    if (!company || company.length < 2) { showError('err-step1', 'Please enter your company name.'); return false; }
    if (!website || !hostFromWebsite(website).includes('.')) { showError('err-step1', 'Please enter a valid company website (e.g. acme.com).'); return false; }
    if (!$('f-industry').value) { showError('err-step1', 'Please select your industry.'); return false; }
    if (!$('f-company-size').value) { showError('err-step1', 'Please select your company size.'); return false; }
    return true;
  }
  function validateStep2() {
    clearError('err-step2');
    if (!$('f-first-name').value.trim()) { showError('err-step2', 'Please enter your first name.'); return false; }
    if (!$('f-last-name').value.trim())  { showError('err-step2', 'Please enter your last name.'); return false; }
    if (!$('f-role').value)              { showError('err-step2', 'Please select your role.'); return false; }
    const ed = emailDomainOf($('f-email').value);
    if (!ed) { showError('err-step2', 'Please enter a valid work email.'); return false; }
    if (PUBLIC_MAILBOXES.has(ed)) { showError('err-step2', "Please use your corporate email — public mailboxes (Gmail, Outlook…) aren't supported."); return false; }
    const wd = hostFromWebsite($('f-website').value);
    if (wd && !domainsRelated(ed, wd)) {
      showError('err-step2', `Your email domain (${ed}) doesn't match your company website (${wd}). Use your work email at ${wd}.`);
      return false;
    }
    return true;
  }
  function validateStep3() {
    clearError('err-identity');
    const pw = $('f-password').value, pw2 = $('f-password2').value;
    if (pw.length < 12) { showError('err-identity', 'Password must be at least 12 characters.'); return false; }
    if (pw !== pw2) { showError('err-identity', "The two passwords don't match."); return false; }
    return true;
  }
  function validateSubstep(n) {
    return n === 1 ? validateStep1() : n === 2 ? validateStep2() : validateStep3();
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
    const body = {
      firstName: $('f-first-name').value.trim(),
      lastName: $('f-last-name').value.trim(),
      jobTitle: $('f-role').value,
      // Plan chosen on the landing page (?plan=starter|pro); 'free' otherwise.
      plan: PLAN,
      companyName: $('f-company').value.trim(),
      industry: $('f-industry').value,
      companySize: $('f-company-size').value,
      website: $('f-website').value.trim(),
      email: $('f-email').value.trim(),
      password: $('f-password').value,
    };

    btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Sending…';
    try {
      const r = await fetch(`${API}/start`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Route the server's error back to the substep that owns the field, so
        // the message lands in context rather than on the final screen.
        const code = data.code;
        const msg = data.error || `Something went wrong (HTTP ${r.status}).`;
        showPane('identity');
        if (code === 'TENANT_EXISTS') { showSubstep(1); showError('err-step1', msg); }
        else if (code === 'EMAIL_DOMAIN_MISMATCH' || code === 'PUBLIC_EMAIL' || code === 'EMAIL_EXISTS') { showSubstep(2); showError('err-step2', msg); }
        else { showSubstep(3); showError('err-identity', msg); }
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

  // Substep nav: Next validates the current substep then advances; Back steps
  // down. Both are type="button" so they never submit the form.
  document.querySelectorAll('[data-ob-next]').forEach((b) => b.addEventListener('click', () => {
    const from = Number(b.dataset.obNext);
    if (!validateSubstep(from)) return;
    showSubstep(Math.min(from + 1, MAX_SUBSTEP));
  }));
  document.querySelectorAll('[data-ob-back]').forEach((b) => b.addEventListener('click', () => {
    showSubstep(Math.max(Number(b.dataset.obBack) - 1, 1));
  }));

  // Enter / the final "Create account" submit. On an earlier substep, Enter
  // just advances (validating first) instead of submitting the whole form.
  $('form-identity').addEventListener('submit', (e) => {
    e.preventDefault();
    if (subStep < MAX_SUBSTEP) {
      if (validateSubstep(subStep)) showSubstep(subStep + 1);
      return;
    }
    if (!validateSubstep(MAX_SUBSTEP)) return;
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
    subStep = 1;
    showPane('identity');
  });

  // ---------- init ----------
  loadIndustries();
  showPane('identity');
})();
