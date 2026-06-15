#!/usr/bin/env node
/**
 * Nexus Hub — Local Dev Cockpit server
 *
 * Tiny stdlib-only Node HTTP server that powers a browser-based control
 * panel for the local Docker sandbox. Lives entirely under
 * scripts/cockpit/ — never modifies the production deploy path.
 *
 * Safety:
 *   - Loopback-only bind (127.0.0.1). Never reachable from LAN.
 *   - Hardcoded command whitelist; user input never reaches a shell.
 *   - 30s per-command cooldown (mirrors src/portal/actions.ts).
 *   - Only one spawned child at a time. Concurrent requests get 429.
 *   - POST endpoints require same-origin fetch metadata plus a random
 *     per-process cockpit token.
 *   - Dangerous commands require a one-use server confirmation nonce.
 *   - child_process.spawn is invoked with an array of args (no shell
 *     interpolation).
 *
 * Streaming:
 *   - POST /api/run/:cmd opens an SSE stream of {stream, text, ts}
 *     line events, terminated by a {exitCode, durationMs} complete
 *     event.
 *
 * Run:
 *   node scripts/cockpit/server.js --port 8210
 *   (Usually invoked via scripts/cockpit.sh.)
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

// ──────────────────────────────────────────────────────────────────────
// Config

const ARGS = process.argv.slice(2);
const PORT = (() => {
  const i = ARGS.indexOf('--port');
  if (i >= 0 && ARGS[i + 1]) return Number(ARGS[i + 1]);
  if (process.env.NEXUS_COCKPIT_PORT) return Number(process.env.NEXUS_COCKPIT_PORT);
  return 8210;
})();
const HOST = '127.0.0.1';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');
const COCKPIT_DIR = __dirname;
const COCKPIT_VERSION = '1.1.0';
const STARTED_AT = new Date().toISOString();
const COCKPIT_TOKEN = process.env.NEXUS_COCKPIT_TOKEN || crypto.randomBytes(32).toString('base64url');
const COCKPIT_TOKEN_HEADER = 'x-nexus-cockpit-token';

const COMMAND_COOLDOWN_MS = 30_000;
const SSE_RING_BUFFER_MAX = 500;
const STATUS_POLL_TIMEOUT_MS = 2_000;
const DANGER_CONFIRMATION_TTL_MS = 2 * 60 * 1000;

// ──────────────────────────────────────────────────────────────────────
// Command registry

// Each command is a {bin, args, label, danger}. `args` is a function so we
// can resolve runtime values (e.g. test patterns) safely without ever
// interpolating user input into a shell.
const COMMANDS = {
  boot: {
    label: 'Boot sandbox',
    bin: path.join(SCRIPTS_DIR, 'local-up.sh'),
    args: () => [],
    cwd: REPO_ROOT,
  },
  stop: {
    label: 'Stop sandbox',
    bin: path.join(SCRIPTS_DIR, 'local-down.sh'),
    args: () => [],
    cwd: REPO_ROOT,
  },
  smoke: {
    label: 'Run smoke test',
    bin: path.join(SCRIPTS_DIR, 'local-smoke.sh'),
    args: () => [],
    cwd: REPO_ROOT,
  },
  sim: {
    label: 'Launch iOS Simulator',
    bin: path.join(SCRIPTS_DIR, 'sim-local.sh'),
    args: () => [],
    env: {
      NEXUS_SIM_DEBUG_AUTH_IMPORT: '1',
      NEXUS_SIM_DEBUG_AUTH_EMAIL: 'nexushubbot@gmail.com',
    },
    cwd: REPO_ROOT,
  },
  'sim-stop': {
    label: 'Shutdown iOS Simulator',
    bin: path.join(SCRIPTS_DIR, 'sim-down.sh'),
    args: () => [],
    cwd: REPO_ROOT,
  },
  reset: {
    label: 'Reset sandbox (wipe)',
    bin: path.join(SCRIPTS_DIR, 'local-reset.sh'),
    args: () => ['--yes'],
    cwd: REPO_ROOT,
    danger: true,
  },
  rebuild: {
    label: 'Force rebuild (no cache)',
    bin: 'sh',
    args: () => [
      '-c',
      'docker compose -f docker-compose.local.yml down ' +
        '&& docker compose -f docker-compose.local.yml build --no-cache ' +
        '&& docker compose -f docker-compose.local.yml up -d ' +
        '&& ./scripts/wait-for-health.sh',
    ],
    cwd: REPO_ROOT,
  },
  logs: {
    label: 'Tail container logs',
    bin: 'docker',
    args: () => ['compose', '-f', 'docker-compose.local.yml', 'logs', '--tail=200', '-f'],
    cwd: REPO_ROOT,
    longRunning: true,
  },
  'mint-jwt': {
    label: 'Mint nexushubbot iOS auth',
    bin: 'node',
    args: () => [path.join(SCRIPTS_DIR, 'local-ios-debug-auth.mjs')],
    env: {
      NEXUS_LOCAL_IOS_EMAIL: 'nexushubbot@gmail.com',
    },
    cwd: REPO_ROOT,
  },
  'vitest-run': {
    label: 'Focused vitest run',
    bin: 'npx',
    args: (params) => {
      const pattern = String(params?.pattern || '').trim();
      // Strict allowlist: only [a-zA-Z0-9 / _ . - *] permitted. Rejects
      // shell metacharacters even though spawn-with-array would already
      // make them inert.
      if (!/^[a-zA-Z0-9/_.\-*]*$/.test(pattern) || pattern.length > 200) {
        throw new Error('vitest-run: pattern must match [a-zA-Z0-9/_.*-]{0,200}');
      }
      return pattern ? ['vitest', 'run', '--reporter=default', pattern] : ['vitest', 'run', '--reporter=default'];
    },
    cwd: REPO_ROOT,
  },
};

const OPEN_TARGETS = {
  'backend-portal': { kind: 'url', value: 'http://127.0.0.1:8200' },
  data: { kind: 'path', value: path.join(REPO_ROOT, 'data') },
  logs: { kind: 'path', value: path.join(REPO_ROOT, 'logs') },
  'docker-desktop': { kind: 'app', value: 'Docker' },
  'workspace-root': { kind: 'path', value: REPO_ROOT },
};

// ──────────────────────────────────────────────────────────────────────
// State

const commandCooldowns = new Map(); // cmd → unix ms of last start
const dangerConfirmations = new Map(); // nonce → { cmd, expiresAt }
let activeRun = null; // { cmd, child, startedAt, buffer, clients }
let lastSmokeRingBuffer = null; // last smoke run's tail (for "last smoke result")

function cooldownRemaining(cmd) {
  const last = commandCooldowns.get(cmd);
  if (!last) return 0;
  const elapsed = Date.now() - last;
  return Math.max(0, COMMAND_COOLDOWN_MS - elapsed);
}

// ──────────────────────────────────────────────────────────────────────
// Helpers

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function send404(res) {
  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function send405(res) {
  sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function secureEqualString(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  try {
    return crypto.timingSafeEqual(expectedBuf, providedBuf);
  } catch {
    return false;
  }
}

function sameOriginForRequest(req, origin) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const allowedHosts = new Set([
      `127.0.0.1:${PORT}`,
      `localhost:${PORT}`,
    ]);
    return parsed.protocol === 'http:' && allowedHosts.has(parsed.host);
  } catch {
    return false;
  }
}

function verifyStateChangingRequest(req) {
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { ok: false, status: 403, error: 'cross_site_request_rejected' };
  }

  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!sameOriginForRequest(req, origin)) {
    return { ok: false, status: 403, error: 'origin_rejected' };
  }

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return { ok: false, status: 415, error: 'json_content_type_required' };
  }

  const token = Array.isArray(req.headers[COCKPIT_TOKEN_HEADER])
    ? req.headers[COCKPIT_TOKEN_HEADER][0]
    : req.headers[COCKPIT_TOKEN_HEADER];
  if (!secureEqualString(COCKPIT_TOKEN, token)) {
    return { ok: false, status: 403, error: 'cockpit_token_required' };
  }

  return { ok: true };
}

function rejectUnsafeStateChange(req, res) {
  const verdict = verifyStateChangingRequest(req);
  if (verdict.ok) return false;
  sendJson(res, verdict.status, { ok: false, error: verdict.error });
  return true;
}

function sendStaticFile(res, filename, contentType) {
  const filePath = path.join(COCKPIT_DIR, filename);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 500, { ok: false, error: 'static_read_failed', detail: err.message });
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function cleanupDangerConfirmations(now = Date.now()) {
  for (const [nonce, confirmation] of dangerConfirmations.entries()) {
    if (confirmation.expiresAt <= now) dangerConfirmations.delete(nonce);
  }
}

function createDangerConfirmation(cmd) {
  cleanupDangerConfirmations();
  const nonce = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + DANGER_CONFIRMATION_TTL_MS;
  dangerConfirmations.set(nonce, { cmd, expiresAt });
  return { nonce, expiresAt };
}

function consumeDangerConfirmation(cmd, nonce) {
  cleanupDangerConfirmations();
  if (typeof nonce !== 'string' || !nonce) return false;
  const confirmation = dangerConfirmations.get(nonce);
  dangerConfirmations.delete(nonce);
  return Boolean(confirmation && confirmation.cmd === cmd && confirmation.expiresAt > Date.now());
}

function portalReadAuthHeaders() {
  const token =
    process.env.PORTAL_READ_TOKEN ||
    process.env.PORTAL_WRITE_TOKEN ||
    process.env.PORTAL_ADMIN_TOKEN ||
    process.env.PORTAL_TOKEN ||
    '';
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('body_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

async function fetchSnapshot() {
  // Use http.request (no fetch in older Node) — Node 20 has fetch but
  // sticking to stdlib http keeps this portable.
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port: 8200,
        path: '/api/snapshot',
        timeout: STATUS_POLL_TIMEOUT_MS,
        headers: portalReadAuthHeaders(),
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ ok: true, status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            resolve({ ok: false, error: 'parse_error', status: res.statusCode });
          }
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, error: err.code || err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
  });
}

function dockerPs() {
  try {
    const out = execFileSync(
      'docker',
      ['compose', '-f', 'docker-compose.local.yml', 'ps', '--format', 'json'],
      { cwd: REPO_ROOT, timeout: 3_000, encoding: 'utf-8' },
    );
    // docker compose v2 emits one JSON object per line (NDJSON).
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const item = JSON.parse(line);
          return {
            name: item.Name || item.Service,
            service: item.Service,
            state: item.State,
            health: item.Health || null,
            status: item.Status,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    return [];
  }
}

function gitInfo() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 1_000,
    }).trim();
    const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 1_000,
    }).trim();
    const statusOut = execFileSync('git', ['status', '--porcelain'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 1_500,
    });
    const dirty = statusOut.split('\n').filter((l) => l.trim().length > 0).length;
    const recent = execFileSync('git', ['log', '-10', '--oneline'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 1_500,
    })
      .split('\n')
      .filter(Boolean);
    return { branch, headSha, dirty, recent };
  } catch (err) {
    return { branch: 'unknown', headSha: 'unknown', dirty: 0, recent: [] };
  }
}

// ──────────────────────────────────────────────────────────────────────
// Routes

async function handleStatus(req, res) {
  const snapshotResult = await fetchSnapshot();
  const sandbox = snapshotResult.ok
    ? {
        status: snapshotResult.body?.status || (snapshotResult.status === 200 ? 'healthy' : 'unknown'),
        version: snapshotResult.body?.version || null,
        uptimeSec: snapshotResult.body?.uptime || null,
      }
    : { status: 'down', error: snapshotResult.error || 'unreachable' };

  const apiCostToday =
    snapshotResult.body?.healthSummary?.apiCostToday ??
    snapshotResult.body?.apiUsage?.apiCostToday ??
    null;

  sendJson(res, 200, {
    cockpit: {
      version: COCKPIT_VERSION,
      pid: process.pid,
      port: PORT,
      startedAt: STARTED_AT,
      commands: Object.keys(COMMANDS),
    },
    sandbox,
    spend: { today: apiCostToday, cap: 5.0 },
    containers: dockerPs(),
    git: gitInfo(),
    activeRun: activeRun
      ? { cmd: activeRun.cmd, startedAt: new Date(activeRun.startedAt).toISOString() }
      : null,
    cooldowns: Array.from(commandCooldowns.entries()).map(([cmd, ts]) => ({
      cmd,
      remainingMs: cooldownRemaining(cmd),
    })),
  });
}

function handleSession(_req, res) {
  sendJson(res, 200, {
    ok: true,
    csrfToken: COCKPIT_TOKEN,
    tokenHeader: COCKPIT_TOKEN_HEADER,
  });
}

async function handleConfirm(req, res, cmdName) {
  const spec = COMMANDS[cmdName];
  if (!spec) {
    sendJson(res, 400, { ok: false, error: 'unknown_command', cmd: cmdName });
    return;
  }
  if (!spec.danger) {
    sendJson(res, 400, { ok: false, error: 'confirmation_not_required', cmd: cmdName });
    return;
  }
  try {
    await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: 'bad_body', detail: err.message });
    return;
  }
  const confirmation = createDangerConfirmation(cmdName);
  sendJson(res, 200, {
    ok: true,
    cmd: cmdName,
    confirmationNonce: confirmation.nonce,
    expiresAt: new Date(confirmation.expiresAt).toISOString(),
  });
}

async function handleRun(req, res, cmdName) {
  const spec = COMMANDS[cmdName];
  if (!spec) {
    sendJson(res, 400, { ok: false, error: 'unknown_command', cmd: cmdName });
    return;
  }

  if (activeRun) {
    sendJson(res, 429, { ok: false, error: 'another_command_active', active: activeRun.cmd });
    return;
  }

  const remaining = cooldownRemaining(cmdName);
  if (remaining > 0) {
    sendJson(res, 429, { ok: false, error: 'cooldown', remainingMs: remaining });
    return;
  }

  let body = {};
  if (req.method === 'POST') {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'bad_body', detail: err.message });
      return;
    }
  }

  if (spec.danger && !consumeDangerConfirmation(cmdName, body.confirmationNonce)) {
    sendJson(res, 403, { ok: false, error: 'danger_confirmation_required', cmd: cmdName });
    return;
  }

  let resolvedArgs;
  try {
    resolvedArgs = spec.args(body);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: 'bad_args', detail: err.message });
    return;
  }

  // Open SSE stream
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const startedAt = Date.now();
  commandCooldowns.set(cmdName, startedAt);

  const writeEvent = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      // Client disconnected; ignore.
    }
  };

  writeEvent('hello', {
    cmd: cmdName,
    label: spec.label,
    bin: path.basename(spec.bin),
    args: resolvedArgs,
    startedAt: new Date(startedAt).toISOString(),
  });

  const child = spawn(spec.bin, resolvedArgs, {
    cwd: spec.cwd || REPO_ROOT,
    env: { ...process.env, ...(spec.env || {}), FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const buffer = []; // ring buffer of last N lines
  const pushLine = (stream, text) => {
    const ev = { stream, text, ts: new Date().toISOString() };
    buffer.push(ev);
    if (buffer.length > SSE_RING_BUFFER_MAX) buffer.shift();
    writeEvent('line', ev);
  };

  activeRun = { cmd: cmdName, child, startedAt, buffer, label: spec.label };

  const decodeStream = (stream, label) => {
    let pending = '';
    stream.setEncoding('utf-8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let nlIdx;
      while ((nlIdx = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nlIdx);
        pending = pending.slice(nlIdx + 1);
        if (line.length > 0 || pending.length === 0) pushLine(label, line);
      }
    });
    stream.on('end', () => {
      if (pending) pushLine(label, pending);
    });
  };

  decodeStream(child.stdout, 'stdout');
  decodeStream(child.stderr, 'stderr');

  let completed = false;
  const completeRun = (code, signal) => {
    if (completed) return;
    completed = true;
    const durationMs = Date.now() - startedAt;
    writeEvent('complete', {
      cmd: cmdName,
      exitCode: code,
      signal,
      durationMs,
    });
    res.end();

    if (cmdName === 'smoke') {
      lastSmokeRingBuffer = {
        finishedAt: new Date().toISOString(),
        exitCode: code,
        durationMs,
        lines: buffer.slice(),
      };
    }
    if (activeRun && activeRun.cmd === cmdName) activeRun = null;
  };

  // If the response stream closes before the child exits, the browser
  // intentionally stopped the command or disconnected. Kill only then;
  // IncomingMessage 'close' can fire after the POST body is consumed.
  res.on('close', () => {
    if (!completed && child && !child.killed) {
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }
  });

  child.on('error', (err) => {
    pushLine('stderr', `[cockpit] spawn error: ${err.message}`);
  });

  child.on('close', completeRun);
}

async function handleOpen(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: 'bad_body' });
    return;
  }
  const targetName = String(body.target || '');
  const target = OPEN_TARGETS[targetName];
  if (!target) {
    sendJson(res, 400, { ok: false, error: 'unknown_target', target: targetName });
    return;
  }
  try {
    if (target.kind === 'app') {
      execFileSync('open', ['-a', target.value], { timeout: 3_000 });
    } else {
      execFileSync('open', [target.value], { timeout: 3_000 });
    }
    sendJson(res, 200, { ok: true, target: targetName });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: 'open_failed', detail: err.message });
  }
}

function handleLastSmoke(req, res) {
  if (!lastSmokeRingBuffer) {
    sendJson(res, 200, { ok: true, available: false });
    return;
  }
  sendJson(res, 200, { ok: true, available: true, ...lastSmokeRingBuffer });
}

function handleCommands(req, res) {
  const summary = Object.entries(COMMANDS).map(([name, spec]) => ({
    name,
    label: spec.label,
    danger: !!spec.danger,
    longRunning: !!spec.longRunning,
  }));
  sendJson(res, 200, {
    cockpit: {
      version: COCKPIT_VERSION,
      pid: process.pid,
      startedAt: STARTED_AT,
    },
    commands: summary,
    openTargets: Object.keys(OPEN_TARGETS),
  });
}

// ──────────────────────────────────────────────────────────────────────
// Router

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // Static
  if (req.method === 'GET' && urlPath === '/') return sendStaticFile(res, 'index.html', 'text/html; charset=utf-8');
  if (req.method === 'GET' && urlPath === '/style.css') return sendStaticFile(res, 'style.css', 'text/css; charset=utf-8');
  if (req.method === 'GET' && urlPath === '/app.js') return sendStaticFile(res, 'app.js', 'application/javascript; charset=utf-8');

  // API
  if (urlPath === '/api/status') {
    if (req.method !== 'GET') return send405(res);
    return handleStatus(req, res);
  }
  if (urlPath === '/api/session') {
    if (req.method !== 'GET') return send405(res);
    return handleSession(req, res);
  }
  if (urlPath === '/api/commands') {
    if (req.method !== 'GET') return send405(res);
    return handleCommands(req, res);
  }
  if (urlPath === '/api/last-smoke') {
    if (req.method !== 'GET') return send405(res);
    return handleLastSmoke(req, res);
  }
  if (urlPath === '/api/open') {
    if (req.method !== 'POST') return send405(res);
    if (rejectUnsafeStateChange(req, res)) return;
    return handleOpen(req, res);
  }
  const confirmMatch = urlPath.match(/^\/api\/confirm\/([a-z][a-z0-9-]*)$/);
  if (confirmMatch) {
    if (req.method !== 'POST') return send405(res);
    if (rejectUnsafeStateChange(req, res)) return;
    return handleConfirm(req, res, confirmMatch[1]);
  }
  const runMatch = urlPath.match(/^\/api\/run\/([a-z][a-z0-9-]*)$/);
  if (runMatch) {
    if (req.method !== 'POST') return send405(res);
    if (rejectUnsafeStateChange(req, res)) return;
    return handleRun(req, res, runMatch[1]);
  }

  return send404(res);
});

server.listen(PORT, HOST, () => {
  // Stdout goes to the launcher / parent shell.
  console.log(`[cockpit] http://${HOST}:${PORT}  (PID ${process.pid})`);
  console.log(`[cockpit] commands: ${Object.keys(COMMANDS).join(', ')}`);
});

const shutdown = (signal) => {
  console.log(`[cockpit] received ${signal}, shutting down`);
  if (activeRun?.child && !activeRun.child.killed) {
    try { activeRun.child.kill('SIGTERM'); } catch (_) { /* ignore */ }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
