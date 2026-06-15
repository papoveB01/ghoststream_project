(function () {
  const form = document.getElementById('login-form');
  const errBox = document.getElementById('error');
  const submit = document.getElementById('submit-btn');

  const otpForm = document.getElementById('otp-form');
  const otpErr = document.getElementById('otp-error');
  const otpSubmit = document.getElementById('otp-submit-btn');
  const otpCode = document.getElementById('otp-code');
  const otpTrust = document.getElementById('otp-trust');
  const otpLede = document.getElementById('otp-lede');
  const loginFoot = document.getElementById('login-foot');

  // Forgot / reset password views (live alongside #login-form on the same page).
  const forgotForm = document.getElementById('forgot-form');
  const forgotEmail = document.getElementById('forgot-email');
  const forgotErr = document.getElementById('forgot-error');
  const forgotNote = document.getElementById('forgot-note');
  const forgotSubmit = document.getElementById('forgot-submit-btn');
  const resetForm = document.getElementById('reset-form');
  const resetErr = document.getElementById('reset-error');
  const resetNote = document.getElementById('reset-note');
  const resetSubmit = document.getElementById('reset-submit-btn');

  // A reset link lands here as ?token=… — that puts us straight into reset mode.
  const resetToken = new URLSearchParams(window.location.search).get('token');

  let challengeId = null;

  function showError(box, msg) { box.textContent = msg; box.classList.remove('hidden'); }
  function clearError(box) { box.textContent = ''; box.classList.add('hidden'); }
  function showNote(box, msg) { box.textContent = msg; box.classList.remove('hidden'); }

  // Client-side device fingerprint: a persisted random id + stable browser
  // signals (canvas/screen/timezone/UA), hashed in-browser. Sent as X-Device-FP
  // so the server recognizes this device independent of IP (see devices.js).
  // Degrades silently (no header) when crypto.subtle/localStorage are absent.
  let _fp;
  function canvasFp() {
    try {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#069'; ctx.fillText('ghoststream-fp-§™', 2, 2);
      ctx.fillStyle = 'rgba(102,200,0,0.7)'; ctx.fillText('ghoststream-fp-§™', 4, 4);
      return c.toDataURL();
    } catch { return ''; }
  }
  async function deviceFp() {
    if (_fp !== undefined) return _fp;
    try {
      let id = localStorage.getItem('gs_device_id');
      if (!id) { id = (crypto.randomUUID && crypto.randomUUID()) || (String(Date.now()) + Math.random()); localStorage.setItem('gs_device_id', id); }
      const signals = [
        id, navigator.userAgent, navigator.language, (navigator.languages || []).join(','),
        screen.width + 'x' + screen.height + 'x' + (screen.colorDepth || ''), window.devicePixelRatio,
        Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.hardwareConcurrency, navigator.platform,
        canvasFp(),
      ].join('|');
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signals));
      _fp = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { _fp = null; }
    return _fp;
  }
  async function fpHeaders(base) {
    const fp = await deviceFp();
    return fp ? Object.assign({}, base, { 'X-Device-FP': fp }) : base;
  }

  // If already authenticated, jump straight to the dashboard — UNLESS the user
  // arrived via a reset link, in which case let them set a new password first.
  if (!resetToken) {
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => { if (r.ok) window.location.href = '/admin/'; })
      .catch(() => {});
  }

  // Swap the password form for the code-entry form (and back).
  function showOtp(payload) {
    challengeId = payload.challengeId;
    otpLede.textContent = payload.emailHint
      ? `Enter the 6-digit code we emailed to ${payload.emailHint}.`
      : 'Enter the 6-digit code we emailed you.';
    form.classList.add('hidden');
    loginFoot.classList.add('hidden');
    otpForm.classList.remove('hidden');
    clearError(otpErr);
    otpCode.value = payload.devCode || ''; // dev fallback when email unconfigured
    otpCode.focus();
  }
  function showLogin() {
    challengeId = null;
    otpForm.classList.add('hidden');
    forgotForm.classList.add('hidden');
    resetForm.classList.add('hidden');
    form.classList.remove('hidden');
    loginFoot.classList.remove('hidden');
    submit.disabled = false;
    submit.textContent = 'Sign in';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(errBox);
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: await fpHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const payload = await res.json().catch(() => ({}));

      // 202 + OTP_REQUIRED → unrecognized device, switch to code entry.
      if (res.status === 202 && payload.code === 'OTP_REQUIRED') {
        showOtp(payload);
        return;
      }
      if (!res.ok) {
        showError(errBox, payload.error || `Sign-in failed (${res.status})`);
        submit.disabled = false;
        submit.textContent = 'Sign in';
        return;
      }
      window.location.href = '/admin/';
    } catch (err) {
      showError(errBox, err.message || 'Network error');
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  otpForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(otpErr);
    otpSubmit.disabled = true;
    otpSubmit.textContent = 'Verifying…';
    try {
      const res = await fetch('/api/auth/verify-device', {
        method: 'POST',
        headers: await fpHeaders({ 'Content-Type': 'application/json' }),
        credentials: 'include',
        body: JSON.stringify({ challengeId, code: otpCode.value.trim(), trust: otpTrust.checked }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) { window.location.href = '/admin/'; return; }

      // Expired / too many attempts → bounce back to the password form.
      if (res.status === 410 || res.status === 429) {
        showLogin();
        showError(errBox, payload.error || 'Please sign in again.');
        return;
      }
      const left = typeof payload.attemptsLeft === 'number' ? ` ${payload.attemptsLeft} attempt(s) left.` : '';
      showError(otpErr, (payload.error || 'Incorrect code.') + left);
    } catch (err) {
      showError(otpErr, err.message || 'Network error');
    } finally {
      otpSubmit.disabled = false;
      otpSubmit.textContent = 'Verify & sign in';
    }
  });

  document.getElementById('otp-resend').addEventListener('click', async (e) => {
    e.preventDefault();
    clearError(otpErr);
    try {
      const res = await fetch('/api/auth/resend-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challengeId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) { showError(otpErr, 'A new code is on its way.'); otpErr.classList.remove('hidden'); }
      else if (res.status === 410) { showLogin(); showError(errBox, 'Please sign in again.'); }
      else showError(otpErr, payload.error || 'Could not resend the code.');
    } catch (err) {
      showError(otpErr, err.message || 'Network error');
    }
  });

  document.getElementById('otp-back').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
    clearError(errBox);
  });

  // ── Forgot password ──────────────────────────────────────────────────────
  // Swap the sign-in form for the "email me a link" form (and back).
  document.getElementById('forgot-link').addEventListener('click', (e) => {
    e.preventDefault();
    clearError(errBox);
    form.classList.add('hidden');
    loginFoot.classList.add('hidden');
    forgotForm.classList.remove('hidden');
    clearError(forgotErr); forgotNote.classList.add('hidden');
    // Carry over whatever they typed in the sign-in email field.
    forgotEmail.value = document.getElementById('email').value.trim();
    forgotEmail.focus();
  });

  document.getElementById('forgot-back').addEventListener('click', (e) => {
    e.preventDefault();
    showLogin();
  });

  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(forgotErr); forgotNote.classList.add('hidden');
    forgotSubmit.disabled = true; forgotSubmit.textContent = 'Sending…';
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: forgotEmail.value.trim() }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        // Enumeration-safe: same confirmation whether or not the email exists.
        showNote(forgotNote, "If an account exists for that email, a reset link is on its way. Check your inbox (and spam).");
        forgotSubmit.textContent = 'Sent';
        return;
      }
      showError(forgotErr, payload.error || `Couldn't send the link (${res.status}).`);
      forgotSubmit.disabled = false; forgotSubmit.textContent = 'Send reset link';
    } catch (err) {
      showError(forgotErr, err.message || 'Network error');
      forgotSubmit.disabled = false; forgotSubmit.textContent = 'Send reset link';
    }
  });

  // ── Reset password (arrived via emailed link) ────────────────────────────
  function showReset() {
    form.classList.add('hidden');
    loginFoot.classList.add('hidden');
    resetForm.classList.remove('hidden');
    document.getElementById('reset-password').focus();
  }

  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError(resetErr); resetNote.classList.add('hidden');
    const pw = document.getElementById('reset-password').value;
    const pw2 = document.getElementById('reset-password2').value;
    if (pw.length < 12) { showError(resetErr, 'New password must be at least 12 characters.'); return; }
    if (pw !== pw2) { showError(resetErr, 'The two passwords don\'t match.'); return; }
    resetSubmit.disabled = true; resetSubmit.textContent = 'Saving…';
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: resetToken, newPassword: pw }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        showNote(resetNote, 'Password updated. Redirecting you to sign in…');
        setTimeout(() => { window.location.href = '/admin/login.html'; }, 1500);
        return;
      }
      showError(resetErr, payload.error || `Couldn't reset your password (${res.status}).`);
      resetSubmit.disabled = false; resetSubmit.textContent = 'Set new password';
    } catch (err) {
      showError(resetErr, err.message || 'Network error');
      resetSubmit.disabled = false; resetSubmit.textContent = 'Set new password';
    }
  });

  // On load: a reset link (?token=…) opens straight into the reset form.
  if (resetToken) showReset();
})();
