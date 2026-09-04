// auth-password-reset: script moved out of password-reset.html so the page CSP can serve script-src 'self' (no 'unsafe-inline').
(function () {
  'use strict';

  // 1. Read token from URL, then strip it from history so a
  //    screenshot/shoulder-surf doesn't leak the single-use
  //    credential.
  var params = new URLSearchParams(window.location.search);
  var token = params.get('token');

  if (token) {
    try {
      var clean = window.location.pathname;
      window.history.replaceState({}, document.title, clean);
    } catch (_e) { /* old browser; non-fatal */ }
  }

  function show(id) {
    ['state-form', 'state-no-token', 'state-success'].forEach(function (s) {
      var el = document.getElementById(s);
      if (el) el.classList.toggle('hidden', s !== id);
    });
  }

  function showError(msg) {
    var box = document.getElementById('alert-error');
    if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
  }

  function hideError() {
    var box = document.getElementById('alert-error');
    if (box) box.classList.add('hidden');
  }

  if (!token) {
    show('state-no-token');
    return;
  }

  var form = document.getElementById('reset-form');
  var btn = document.getElementById('submitBtn');
  var pwd = document.getElementById('newPassword');
  var confirm = document.getElementById('confirmPassword');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    hideError();

    var newPassword = pwd.value || '';
    var confirmPassword = confirm.value || '';

    if (newPassword.length < 8) {
      showError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showError('Passwords do not match.');
      return;
    }

    // Disable the form to prevent double-submission. The backend
    // would no-op a duplicate (single-use is enforced atomically),
    // but the UX is cleaner.
    btn.disabled = true;
    pwd.disabled = true;
    confirm.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>Resetting…';

    fetch('/api/v1/auth/password-reset/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, newPassword: newPassword }),
      credentials: 'omit',
    })
      .then(function (resp) {
        return resp.json().then(function (body) {
          return { ok: resp.ok, status: resp.status, body: body };
        }).catch(function () {
          return { ok: resp.ok, status: resp.status, body: null };
        });
      })
      .then(function (result) {
        if (result.ok) {
          show('state-success');
          return;
        }

        // Re-enable the form so the user can try a different
        // password (e.g. one their password manager won't reject
        // for length).
        btn.disabled = false;
        pwd.disabled = false;
        confirm.disabled = false;
        btn.textContent = 'Reset password';

        var errCode = result.body && result.body.error && result.body.error.code;
        var errMsg = result.body && result.body.error && result.body.error.message;

        if (errCode === 'TOO_MANY_ATTEMPTS' || result.status === 429) {
          showError(errMsg || 'Too many attempts. Open the Nexus Hub app and request a new link.');
          return;
        }
        if (errCode === 'WEAK_PASSWORD' || errCode === 'PASSWORD_TOO_SHORT') {
          showError(errMsg || 'Please choose a password with at least 8 characters.');
          return;
        }
        if (errCode === 'INVALID_TOKEN' || errCode === 'TOKEN_EXPIRED' || result.status === 400) {
          showError(errMsg || 'This link has expired or already been used. Open the Nexus Hub app and request a new one.');
          return;
        }

        showError(errMsg || 'Something went wrong. Please try again.');
      })
      .catch(function () {
        btn.disabled = false;
        pwd.disabled = false;
        confirm.disabled = false;
        btn.textContent = 'Reset password';
        showError('Network error. Please check your connection and try again.');
      });
  });
})();
