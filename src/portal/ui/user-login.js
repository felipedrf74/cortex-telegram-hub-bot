// user-login: script moved out of user-login.html so the page CSP can serve script-src 'self' (no 'unsafe-inline').
  (function() {
const ACCESS_KEY = 'nexus_web_access_token_v1';
const REFRESH_KEY = 'nexus_web_refresh_token_v1';
const DEVICE_KEY = 'nexus_web_device_id_v1';
const message = document.getElementById('message');
const emailForm = document.getElementById('email-form');
const providerPanel = document.getElementById('provider-panel');
const loginPanel = document.getElementById('login-panel');
const signedInPanel = document.getElementById('signed-in-panel');
const pointsBalance = document.getElementById('points-balance');
const pointsPackages = document.getElementById('points-packages');
const pointsMessage = document.getElementById('points-message');
const API_BASE = window.NEXUS_API_BASE || ((location.hostname === 'nexushub.me' || location.hostname === 'www.nexushub.me') ? 'https://api.nexushub.me' : '');

function apiPath(path) {
  return API_BASE + path;
}

function setMessage(text, kind) {
  message.textContent = text || '';
  message.className = 'message ' + (kind || '');
}
function setPointsMessage(text, kind) {
  pointsMessage.textContent = text || '';
  pointsMessage.className = 'message ' + (kind || '');
}
function getDeviceId() {
  try {
    let value = localStorage.getItem(DEVICE_KEY);
    if (!value) {
      value = 'web-' + crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, value);
    }
    return value;
  } catch {
    return 'web-' + Math.random().toString(36).slice(2) + Date.now();
  }
}
function saveSession(payload) {
  sessionStorage.setItem(ACCESS_KEY, payload.accessToken || '');
  sessionStorage.setItem(REFRESH_KEY, payload.refreshToken || '');
  renderSignedIn(payload.user);
}
function clearSession() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
}
function authHeaders() {
  const token = sessionStorage.getItem(ACCESS_KEY);
  return token ? { Authorization: 'Bearer ' + token } : {};
}
async function readError(res) {
  try {
    const body = await res.json();
    return body?.error?.message || body?.message || body?.error?.code || 'Sign-in failed';
  } catch {
    return 'Sign-in failed';
  }
}
function renderSignedIn(user) {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'your account';
  document.getElementById('signed-in-copy').textContent = 'Signed in as ' + name + '. Use the iOS app for the full Nexus experience.';
  loginPanel.style.display = 'none';
  signedInPanel.style.display = 'block';
  loadBillingStatus();
}
async function hydrateExistingSession() {
  const token = sessionStorage.getItem(ACCESS_KEY);
  if (!token) return;
  const res = await fetch(apiPath('/api/v1/auth/me'), { headers: authHeaders() });
  if (!res.ok) {
    clearSession();
    return;
  }
  const body = await res.json();
  renderSignedIn(body.data?.user || body.user || {});
}
function renderPackage(pkg) {
  const priceLabel = Number.isFinite(Number(pkg.priceUsd))
    ? '$' + Number(pkg.priceUsd).toFixed(2)
    : String(pkg.label || 'Boost');
  return '<div class="point-card">' +
    '<div class="point-meta">' +
      '<div class="point-name">' + priceLabel + ' · ' + Number(pkg.points).toLocaleString() + ' NP</div>' +
      '<div class="point-detail">Adds ' + Number(pkg.points).toLocaleString() + ' Nexus Points</div>' +
    '</div>' +
    '<button class="primary point-buy" type="button" data-package-id="' + pkg.productId + '">Buy</button>' +
  '</div>';
}
async function loadBillingStatus() {
  pointsBalance.textContent = 'Loading…';
  pointsPackages.innerHTML = '';
  setPointsMessage('');
  try {
    const res = await fetch(apiPath('/api/v1/billing/status'), { headers: authHeaders() });
    if (!res.ok) {
      setPointsMessage(await readError(res), 'error');
      pointsBalance.textContent = 'Unavailable';
      return;
    }
    const body = await res.json();
    const data = body.data || body;
    pointsBalance.textContent = Number(data.nexusPointsBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' NP';
    const packages = Array.isArray(data.nexusPointPackages) ? data.nexusPointPackages : [];
    pointsPackages.innerHTML = packages.map(renderPackage).join('');
    pointsPackages.querySelectorAll('button[data-package-id]').forEach((button) => {
      button.addEventListener('click', () => buyNexusPoints(button.dataset.packageId, button));
    });
  } catch {
    pointsBalance.textContent = 'Unavailable';
    setPointsMessage('Could not load Nexus Points packages.', 'error');
  }
}
async function buyNexusPoints(packageId, button) {
  if (!packageId) return;
  button.disabled = true;
  setPointsMessage('Opening secure checkout...');
  try {
    const res = await fetch(apiPath('/api/v1/billing/nexus-points/stripe-checkout'), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageId }),
    });
    if (!res.ok) {
      setPointsMessage(await readError(res), 'error');
      return;
    }
    const body = await res.json();
    const checkoutUrl = body.data?.checkoutUrl || body.checkoutUrl;
    if (!checkoutUrl) {
      setPointsMessage('Checkout URL was not returned.', 'error');
      return;
    }
    location.href = checkoutUrl;
  } catch {
    setPointsMessage('Network error. Try again in a moment.', 'error');
  } finally {
    button.disabled = false;
  }
}

document.getElementById('tab-email').addEventListener('click', () => {
  document.getElementById('tab-email').classList.add('active');
  document.getElementById('tab-provider').classList.remove('active');
  emailForm.style.display = '';
  providerPanel.style.display = 'none';
  setMessage('');
});
document.getElementById('tab-provider').addEventListener('click', () => {
  document.getElementById('tab-provider').classList.add('active');
  document.getElementById('tab-email').classList.remove('active');
  emailForm.style.display = 'none';
  providerPanel.style.display = '';
  setMessage('');
});

emailForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = document.getElementById('email-submit');
  btn.disabled = true;
  setMessage('Checking credentials...');
  try {
    const res = await fetch(apiPath('/api/v1/auth/login/email'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value,
        deviceId: getDeviceId(),
        deviceName: 'Nexus Web',
      }),
    });
    if (!res.ok) {
      setMessage(await readError(res), 'error');
      return;
    }
    const body = await res.json();
    saveSession(body.data || body);
    setMessage('', 'ok');
  } catch {
    setMessage('Network error. Try again in a moment.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('google-btn').addEventListener('click', async () => {
  const btn = document.getElementById('google-btn');
  btn.disabled = true;
  setMessage('Opening Google...');
  try {
    const res = await fetch(apiPath('/api/v1/auth/register/google/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId(), deviceName: 'Nexus Web', flow: 'web' }),
    });
    if (!res.ok) {
      setMessage(await readError(res), 'error');
      return;
    }
    const body = await res.json();
    location.href = body.data?.url || body.url;
  } catch {
    setMessage('Network error. Try again in a moment.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('apple-btn').addEventListener('click', async () => {
  const btn = document.getElementById('apple-btn');
  btn.disabled = true;
  setMessage('Opening Apple...');
  try {
    const res = await fetch(apiPath('/api/v1/auth/register/apple/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: getDeviceId(), deviceName: 'Nexus Web', flow: 'web' }),
    });
    if (!res.ok) {
      setMessage(await readError(res), 'error');
      return;
    }
    const body = await res.json();
    location.href = body.data?.url || body.url;
  } catch {
    setMessage('Network error. Try again in a moment.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('sign-out-btn').addEventListener('click', () => {
  clearSession();
  location.href = '/user';
});

async function finishProviderIfNeeded() {
  const params = new URLSearchParams(location.search);
  const checkout = params.get('nexusPointsCheckout');
  if (checkout === 'success') {
    history.replaceState(null, '', location.pathname);
    setMessage('Nexus Points checkout received. Your balance updates after Stripe confirms payment.', '');
    return;
  }
  if (checkout === 'canceled') {
    history.replaceState(null, '', location.pathname);
    setMessage('Nexus Points checkout canceled.', '');
    return;
  }
  const googleAuthCode = params.get('googleAuthCode');
  const appleAuthCode = params.get('appleAuthCode');
  const error = params.get('error');
  if (error) {
    history.replaceState(null, '', location.pathname);
    setMessage(error, 'error');
    return;
  }
  const provider = appleAuthCode ? 'Apple' : 'Google';
  const authCode = appleAuthCode || googleAuthCode;
  if (!authCode) return;
  history.replaceState(null, '', location.pathname);
  setMessage('Finishing ' + provider + ' sign-in...');
  const endpoint = appleAuthCode
    ? '/api/v1/auth/register/apple/finish'
    : '/api/v1/auth/register/google/finish';
  const res = await fetch(apiPath(endpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode }),
  });
  if (!res.ok) {
    setMessage(await readError(res), 'error');
    return;
  }
  const body = await res.json();
  saveSession(body.data || body);
}

finishProviderIfNeeded().then(hydrateExistingSession).catch(() => {
  setMessage('Could not restore the web session. Please sign in again.', 'error');
});
  })();
