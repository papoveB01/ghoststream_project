(function () {
  const form = document.getElementById('login-form');
  const errBox = document.getElementById('error');
  const submit = document.getElementById('submit-btn');

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.remove('hidden');
  }
  function clearError() {
    errBox.textContent = '';
    errBox.classList.add('hidden');
  }

  // If already authenticated, jump straight to the dashboard.
  fetch('/api/auth/me', { credentials: 'include' })
    .then((r) => { if (r.ok) window.location.href = '/admin/'; })
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(payload.error || `Sign-in failed (${res.status})`);
        submit.disabled = false;
        submit.textContent = 'Sign in';
        return;
      }
      window.location.href = '/admin/';
    } catch (err) {
      showError(err.message || 'Network error');
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
})();
