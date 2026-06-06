/*
 * Nexus Hub — Local Dev Cockpit (frontend)
 *
 * Plain ES2020. No bundler. No framework.
 *
 * Responsibilities:
 *   - Wire button clicks → POST /api/run/:cmd, stream SSE to output panel
 *   - Poll /api/status every 5s and render header chips + spend pill + git log
 *   - Confirmation modal for destructive actions
 *   - JWT modal that surfaces accessToken from `mint-jwt` output
 *   - Disable all action buttons while a run is active (one-at-a-time)
 */

'use strict';

const STATUS_POLL_MS = 5_000;
const STATUS_POLL_MS_FAST = 1_500; // when a run is active, poll faster for activeRun signal
const MAX_OUTPUT_LINES = 500;

// ── DOM refs ───────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const containerChips = $('#container-chips');
const spendPill = $('#spend-pill');
const spendValue = $('#spend-value');
const spendCap = $('#spend-cap');
const outputBody = $('#output-body');
const outputStatus = $('#output-status');
const outputTitleText = $('#output-title-text');
const outputStopBtn = $('#output-stop');
const outputClearBtn = $('#output-clear');
const modalBackdrop = $('#modal-backdrop');
const modalConfirm = $('#modal-confirm');
const modalCancel = $('#modal-cancel');
const modalBody = $('#modal-body');
const modalTitle = $('#modal-title');
const jwtModal = $('#jwt-modal-backdrop');
const jwtText = $('#jwt-text');
const jwtCopy = $('#jwt-copy');
const jwtClose = $('#jwt-close');
const lastSmokeSummary = $('#last-smoke-summary');
const gitLog = $('#git-log');
const gitMeta = $('#git-meta');
const footerVersion = $('#footer-version');
const footerHost = $('#footer-host');
const footerStarted = $('#footer-started');

// ── State ──────────────────────────────────────────────────────────
let activeSSE = null; // current EventSource-like stream
let activeRunBuffer = []; // accumulated lines for JWT extraction etc.
let runInProgress = false;
let pendingConfirmCmd = null;
let pendingConfirmLabel = null;
let cockpitToken = null;
let cockpitTokenHeader = 'x-nexus-cockpit-token';
let commandManifest = null;
let lastManifestWarning = '';

// ── Output panel ───────────────────────────────────────────────────
function appendLine(stream, text, modifier) {
  const div = document.createElement('div');
  if (stream === 'stderr') div.classList.add('line-stderr');
  else if (stream === 'meta') div.classList.add('line-meta');
  if (modifier === 'ok') div.classList.add('line-ok');
  if (modifier === 'fail') div.classList.add('line-fail');
  div.textContent = text;
  outputBody.appendChild(div);

  // Trim to MAX_OUTPUT_LINES
  while (outputBody.childNodes.length > MAX_OUTPUT_LINES) {
    outputBody.removeChild(outputBody.firstChild);
  }
  outputBody.scrollTop = outputBody.scrollHeight;
}

function clearOutput() {
  outputBody.innerHTML = '';
  outputStatus.textContent = '';
  outputStatus.className = 'output-status';
  outputTitleText.textContent = 'Output';
}

outputClearBtn.addEventListener('click', clearOutput);

outputStopBtn.addEventListener('click', () => {
  if (activeSSE) {
    activeSSE.close();
    activeSSE = null;
    appendLine('meta', '[cockpit] stream closed by user');
    finishRun(null, null);
  }
});

// ── Command runner ─────────────────────────────────────────────────
function setActionsDisabled(disabled, exceptCard) {
  $$('.action-card[data-cmd], .action-input-btn[data-cmd], button[data-open]').forEach((btn) => {
    if (exceptCard && btn === exceptCard) return;
    const cmd = btn.getAttribute('data-cmd');
    btn.disabled = Boolean(cmd && !isKnownCommand(cmd)) || disabled;
  });
}

function isKnownCommand(cmd) {
  return !commandManifest || commandManifest.has(cmd);
}

function unknownCommandMessage(cmd) {
  return `[cockpit] command "${cmd}" is not available in this server process. Restart cockpit with ./scripts/cockpit.sh.`;
}

async function ensureCockpitSession() {
  if (cockpitToken) return cockpitToken;
  const res = await fetch('/api/session', { cache: 'no-store' });
  if (!res.ok) throw new Error(`session ${res.status}`);
  const session = await res.json();
  if (!session.csrfToken) throw new Error('missing cockpit token');
  cockpitToken = session.csrfToken;
  cockpitTokenHeader = session.tokenHeader || cockpitTokenHeader;
  return cockpitToken;
}

async function cockpitJsonHeaders(extra = {}) {
  const token = await ensureCockpitSession();
  return {
    'Content-Type': 'application/json',
    [cockpitTokenHeader]: token,
    ...extra,
  };
}

async function isCockpitTokenRejected(res) {
  if (res.status !== 403) return false;
  const json = await res.clone().json().catch(() => ({}));
  return json.error === 'cockpit_token_required';
}

async function fetchWithCockpitToken(url, init = {}, extraHeaders = {}) {
  const body = init.body;
  const buildRequest = async () => ({
    ...init,
    headers: await cockpitJsonHeaders(extraHeaders),
    body,
  });

  let res = await fetch(url, await buildRequest());
  if (await isCockpitTokenRejected(res)) {
    // The server token rotates when Cockpit restarts. Existing browser tabs
    // can have a stale token, so refresh once before surfacing the error.
    cockpitToken = null;
    res = await fetch(url, await buildRequest());
  }
  return res;
}

async function refreshCommandManifest() {
  const res = await fetch('/api/commands', { cache: 'no-store' });
  if (!res.ok) throw new Error(`commands ${res.status}`);
  const json = await res.json();
  const names = new Set((json.commands || []).map((cmd) => cmd.name).filter(Boolean));
  commandManifest = names;

  const missing = $$('[data-cmd]')
    .map((btn) => btn.getAttribute('data-cmd'))
    .filter((cmd, index, all) => cmd && !names.has(cmd) && all.indexOf(cmd) === index);

  $$('[data-cmd]').forEach((btn) => {
    const cmd = btn.getAttribute('data-cmd');
    if (cmd && !names.has(cmd)) btn.title = 'Restart Cockpit to load this command';
    else if (btn.title === 'Restart Cockpit to load this command') btn.removeAttribute('title');
  });

  setActionsDisabled(runInProgress);
  const warningKey = missing.join(',');
  if (missing.length && warningKey !== lastManifestWarning) {
    appendLine(
      'stderr',
      `[cockpit] server command registry is stale or missing: ${missing.join(', ')}. Restart cockpit with ./scripts/cockpit.sh.`,
    );
    lastManifestWarning = warningKey;
  }
  if (!missing.length) lastManifestWarning = '';
}

function startRun(cmd, label, body = {}) {
  if (runInProgress) {
    appendLine('meta', `[cockpit] cannot run "${cmd}" — another command is active`);
    return;
  }
  if (!isKnownCommand(cmd)) {
    appendLine('stderr', unknownCommandMessage(cmd));
    refreshCommandManifest().catch(() => {});
    return;
  }
  runInProgress = true;
  activeRunBuffer = [];
  setActionsDisabled(true);
  outputStopBtn.disabled = false;

  outputTitleText.textContent = label || cmd;
  outputStatus.textContent = 'running…';
  outputStatus.className = 'output-status output-status--running';

  // Mark the originating card as running
  const card = document.querySelector(`[data-cmd="${cmd}"]`);
  if (card?.classList) card.classList.add('running');

  appendLine('meta', `[cockpit] starting ${cmd}`);

  // SSE over POST: EventSource doesn't support POST, so we use fetch
  // with the streaming body parser.
  fetchWithCockpitToken(`/api/run/${cmd}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }, { Accept: 'text/event-stream' })
    .then(async (res) => {
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        appendLine('stderr', `[cockpit] server rejected: ${res.status} ${errJson.error || ''}`);
        if (errJson.error === 'unknown_command') {
          commandManifest = null;
          await refreshCommandManifest().catch(() => {});
          appendLine('stderr', unknownCommandMessage(cmd));
        }
        if (errJson.remainingMs) {
          appendLine('meta', `[cockpit] cooldown remaining: ${Math.ceil(errJson.remainingMs / 1000)}s`);
        }
        finishRun(res.status, null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let pending = '';
      let sawComplete = false;

      const pump = async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, idx);
            pending = pending.slice(idx + 2);
            if (handleSseFrame(cmd, frame) === 'complete') sawComplete = true;
          }
        }
      };
      activeSSE = { close: () => reader.cancel() };
      try {
        await pump();
      } catch (err) {
        if (runInProgress) appendLine('stderr', `[cockpit] stream error: ${err.message}`);
      } finally {
        if (!sawComplete && runInProgress) {
          appendLine('stderr', '[cockpit] stream ended before completion');
          finishRun(null, null);
        }
      }
    })
    .catch((err) => {
      appendLine('stderr', `[cockpit] fetch failed: ${err.message}`);
      finishRun(null, null);
    });
}

function handleSseFrame(cmd, frame) {
  let event = 'message';
  let dataRaw = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
  }
  if (!dataRaw) return;
  let data;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    return;
  }

  if (event === 'hello') {
    appendLine('meta', `[cockpit] spawned ${data.bin} ${data.args.join(' ')}`);
    return event;
  }
  if (event === 'line') {
    activeRunBuffer.push(data.text);
    appendLine(data.stream, data.text);
    return event;
  }
  if (event === 'complete') {
    const { exitCode, durationMs } = data;
    const secs = (durationMs / 1000).toFixed(1);
    const ok = exitCode === 0;
    appendLine(
      'meta',
      `[exit code: ${exitCode}] · ran for ${secs}s`,
      ok ? 'ok' : 'fail',
    );
    finishRun(exitCode, durationMs);
    if (cmd === 'mint-jwt') maybeShowJwtModal();
    if (cmd === 'smoke') refreshLastSmokeSummary();
    return event;
  }
  return event;
}

function finishRun(exitCode, durationMs) {
  runInProgress = false;
  activeSSE = null;
  setActionsDisabled(false);
  outputStopBtn.disabled = true;

  $$('.action-card.running').forEach((c) => c.classList.remove('running'));

  if (exitCode === 0) {
    outputStatus.textContent = `✓ done (${(durationMs / 1000).toFixed(1)}s)`;
    outputStatus.className = 'output-status output-status--ok';
  } else if (exitCode === null) {
    outputStatus.textContent = 'stopped';
    outputStatus.className = 'output-status';
  } else {
    outputStatus.textContent = `✗ exit ${exitCode}`;
    outputStatus.className = 'output-status output-status--fail';
  }
}

// ── JWT extraction ─────────────────────────────────────────────────
function maybeShowJwtModal() {
  // mint-jwt output is JSON-ish under {accessToken, refreshToken, ...}.
  // Find a line containing "accessToken" and extract.
  const joined = activeRunBuffer.join('\n');
  const match = joined.match(/"accessToken"\s*:\s*"([^"]+)"/);
  if (!match) {
    appendLine('meta', '[cockpit] no accessToken found in mint-jwt output');
    return;
  }
  jwtText.value = match[1];
  jwtModal.hidden = false;
}

jwtCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(jwtText.value);
    jwtCopy.textContent = 'Copied ✓';
    setTimeout(() => (jwtCopy.textContent = 'Copy'), 1500);
  } catch {
    jwtText.select();
    document.execCommand('copy');
  }
});

jwtClose.addEventListener('click', () => (jwtModal.hidden = true));

// ── Confirmation modal ─────────────────────────────────────────────
function askConfirm(cmd, label) {
  pendingConfirmCmd = cmd;
  pendingConfirmLabel = label;
  modalTitle.textContent = `Confirm: ${label}`;
  modalBackdrop.hidden = false;
}

modalCancel.addEventListener('click', () => {
  pendingConfirmCmd = null;
  pendingConfirmLabel = null;
  modalBackdrop.hidden = true;
});

async function requestDangerConfirmation(cmd) {
  const res = await fetchWithCockpitToken(`/api/confirm/${cmd}`, {
    method: 'POST',
    body: JSON.stringify({ confirmedAt: new Date().toISOString() }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.confirmationNonce) {
    throw new Error(json.error || `confirm ${res.status}`);
  }
  return json.confirmationNonce;
}

modalConfirm.addEventListener('click', async () => {
  const cmd = pendingConfirmCmd;
  const label = pendingConfirmLabel;
  pendingConfirmCmd = null;
  pendingConfirmLabel = null;
  modalBackdrop.hidden = true;
  if (cmd) {
    try {
      const confirmationNonce = await requestDangerConfirmation(cmd);
      const card = document.querySelector(`[data-cmd="${cmd}"]`);
      startRun(cmd, label || card?.querySelector('.action-label')?.textContent || cmd, { confirmationNonce });
    } catch (err) {
      appendLine('stderr', `[cockpit] confirmation failed: ${err.message}`);
    }
  }
});

// ── Button wiring ──────────────────────────────────────────────────
$$('[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', (ev) => {
    const cmd = btn.getAttribute('data-cmd');
    const label = btn.querySelector('.action-label')?.textContent || cmd;

    if (cmd === 'vitest-run') {
      const pattern = ($('#vitest-pattern').value || '').trim();
      startRun(cmd, label, { pattern });
      return;
    }

    if (btn.getAttribute('data-confirm') === 'true') {
      askConfirm(cmd, label);
      return;
    }
    startRun(cmd, label);
  });
});

$$('[data-open]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-open');
    fetchWithCockpitToken('/api/open', {
        method: 'POST',
        body: JSON.stringify({ target }),
      })
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) appendLine('meta', `[cockpit] opened ${target}`);
        else appendLine('stderr', `[cockpit] open ${target} failed: ${j.error}`);
      })
      .catch((err) => appendLine('stderr', `[cockpit] open ${target}: ${err.message}`));
  });
});

$$('[data-action="show-last-smoke"]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/last-smoke');
      const j = await r.json();
      if (!j.available) {
        appendLine('meta', '[cockpit] no smoke result cached yet — run "Run smoke" first');
        return;
      }
      clearOutput();
      outputTitleText.textContent = 'Last smoke result';
      const ok = j.exitCode === 0;
      outputStatus.textContent = ok ? `✓ ${j.finishedAt}` : `✗ exit ${j.exitCode} @ ${j.finishedAt}`;
      outputStatus.className = `output-status ${ok ? 'output-status--ok' : 'output-status--fail'}`;
      for (const l of j.lines) appendLine(l.stream, l.text);
    } catch (err) {
      appendLine('stderr', `[cockpit] failed to fetch last smoke: ${err.message}`);
    }
  });
});

// ── Status polling ─────────────────────────────────────────────────
function chipFromContainer(c) {
  const stateClass =
    c.state === 'running' ? 'chip--running'
    : (c.state === 'restarting' || c.state === 'starting') ? 'chip--restarting'
    : 'chip--down';
  const healthSuffix = c.health ? ` · ${c.health}` : '';
  return `<span class="chip ${stateClass}"><span class="chip-dot"></span>${escapeHtml(c.service || c.name)}${escapeHtml(healthSuffix)}</span>`;
}

function chipFromSandbox(s) {
  const stateClass =
    s.status === 'healthy' ? 'chip--running'
    : s.status === 'degraded' ? 'chip--restarting'
    : 'chip--down';
  const detail = s.error ? ` · ${s.error}` : (s.uptimeSec ? ` · up ${Math.round(s.uptimeSec)}s` : '');
  return `<span class="chip ${stateClass}"><span class="chip-dot"></span>/health${escapeHtml(detail)}</span>`;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderStatus(status) {
  // Chips
  const chips = [];
  for (const c of status.containers || []) chips.push(chipFromContainer(c));
  chips.push(chipFromSandbox(status.sandbox || {}));
  containerChips.innerHTML = chips.join('');

  // Spend
  const today = status.spend?.today;
  const cap = status.spend?.cap || 5.0;
  if (typeof today === 'number') {
    spendValue.textContent = `$${today.toFixed(2)}`;
    spendCap.textContent = `/ $${cap.toFixed(2)}`;
    if (today > cap * 0.8) spendPill.classList.add('spend-pill--high');
    else spendPill.classList.remove('spend-pill--high');
  } else {
    spendValue.textContent = '$—';
    spendPill.classList.remove('spend-pill--high');
  }

  // Git
  if (status.git) {
    const dirtyTag = status.git.dirty > 0 ? ` · ${status.git.dirty} dirty` : '';
    gitMeta.textContent = `${status.git.branch} @ ${status.git.headSha}${dirtyTag}`;
    gitLog.innerHTML = (status.git.recent || [])
      .map((line) => {
        const m = line.match(/^([0-9a-f]+)\s+(.*)$/);
        if (m) {
          return `<li class="git-line"><span class="git-sha">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}</li>`;
        }
        return `<li class="git-line">${escapeHtml(line)}</li>`;
      })
      .join('') || '<li class="git-line git-line--placeholder">no recent commits</li>';
  }

  // Footer
  if (status.cockpit) {
    footerVersion.textContent = status.cockpit.version;
    footerHost.textContent = `127.0.0.1:${status.cockpit.port}`;
    footerStarted.textContent = new Date(status.cockpit.startedAt).toLocaleTimeString();
  }
}

async function pollStatus() {
  try {
    const r = await fetch('/api/status');
    const j = await r.json();
    renderStatus(j);
  } catch (err) {
    // Silent — keep last render
  }
}

async function refreshLastSmokeSummary() {
  try {
    const r = await fetch('/api/last-smoke');
    const j = await r.json();
    if (!j.available) {
      lastSmokeSummary.textContent = 'no result yet';
    } else {
      const ok = j.exitCode === 0;
      const dt = new Date(j.finishedAt).toLocaleTimeString();
      lastSmokeSummary.textContent = `${ok ? '✓ pass' : '✗ fail'} · ${dt}`;
    }
  } catch (err) {
    /* silent */
  }
}

pollStatus();
refreshLastSmokeSummary();
ensureCockpitSession().catch((err) => appendLine('stderr', `[cockpit] session init failed: ${err.message}`));
refreshCommandManifest().catch((err) => appendLine('stderr', `[cockpit] command manifest failed: ${err.message}`));
setInterval(pollStatus, STATUS_POLL_MS);
setInterval(() => refreshCommandManifest().catch(() => {}), 30_000);
setInterval(refreshLastSmokeSummary, 30_000);

// Close modal on Escape
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    modalBackdrop.hidden = true;
    jwtModal.hidden = true;
  }
});
