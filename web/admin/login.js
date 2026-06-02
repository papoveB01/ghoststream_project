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

  let challengeId = null;

  function showError(box, msg) { box.textContent = msg; box.classList.remove('hidden'); }
  function clearError(box) { box.textContent = ''; box.classList.add('hidden'); }

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

  // If already authenticated, jump straight to the dashboard.
  fetch('/api/auth/me', { credentials: 'include' })
    .then((r) => { if (r.ok) window.location.href = '/admin/'; })
    .catch(() => {});

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
})();
