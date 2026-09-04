// auth-forgot-password: script moved out of forgot-password.html so the page CSP can serve script-src 'self' (no 'unsafe-inline').
const form = document.getElementById('forgot-password-form');
const email = document.getElementById('email');
const button = document.getElementById('submit');
const message = document.getElementById('message');

function setMessage(text, kind) {
  message.textContent = text;
  message.className = 'message ' + (kind || '');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  setMessage('', '');
  try {
    const response = await fetch('/api/v1/auth/password-reset/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim() }),
    });
    if (!response.ok) throw new Error('request failed');
    setMessage('If that email is registered, a reset link is on the way.', 'success');
  } catch {
    setMessage('Could not request a reset link. Try again in a moment.', 'error');
  } finally {
    button.disabled = false;
  }
});
