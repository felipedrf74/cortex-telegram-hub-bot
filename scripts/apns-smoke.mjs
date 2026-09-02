#!/usr/bin/env node
// apns-smoke.mjs — Diagnostic / smoke test for APNs configuration.
//
// Usage:
//   node scripts/apns-smoke.mjs --check
//     Read env, validate the .p8, and print whether the engine would consider
//     APNs configured. No network call. No data side-effects.
//
//   node scripts/apns-smoke.mjs --user <id> [--message "..."] [--title "..."] [--dry-run]
//     Pick the most recently active push token for the given user_id from
//     ios_devices and POST a single-shot test push to APNs.
//     --dry-run skips the actual HTTP/2 POST (useful to verify the JWT signs).
//
//   node scripts/apns-smoke.mjs --list
//     List ios_devices rows that have a non-empty push_token (no token values
//     printed; only user_id, device_name, length, last_active).
//
// Why not call sendPushNotification() directly?
//   This script is intentionally self-contained so you can run it on a host
//   without the full engine running (e.g. an SSH session into prod). It reads
//   the same env vars as src/services/apns-sender.ts.
//
// Hard guarantees:
//   - Never prints the .p8 contents.
//   - Never prints the device push_token.
//   - Never prints the signed JWT.
//   - Read-only against ios_devices (no UPDATE / DELETE / unregister).
//   - Exit 0 on success, 1 on misconfig, 2 on APNs reject, 3 on transport.

import fs from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── Args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set();
const opts = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      opts[a.slice(2)] = next;
      i++;
    } else {
      flags.add(a.slice(2));
    }
  }
}

const wantCheck = flags.has('check');
const wantList = flags.has('list');
const dryRun = flags.has('dry-run');
const userIdArg = opts.user ? Number.parseInt(opts.user, 10) : null;
const messageBody = opts.message || 'APNs smoke ✅ — Nexus Hub config is alive.';
const messageTitle = opts.title || 'Nexus Hub';

// Default action if no flag was passed.
if (!wantCheck && !wantList && !userIdArg) {
  console.error('apns-smoke: provide --check, --list, or --user <id>. See file header.');
  process.exit(1);
}

// ── Load env from the engine .env if present ──────────────────────────
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const env = {
  enabled: process.env.APNS_ENABLED === 'true',
  teamId: process.env.APNS_TEAM_ID || '',
  keyId: process.env.APNS_KEY_ID || '',
  bundleId: process.env.APNS_BUNDLE_ID || '',
  authKey: process.env.APNS_AUTH_KEY_P8 || '',
  environment: (process.env.APNS_ENVIRONMENT || 'production').toLowerCase(),
};

// ── Config validation (no secrets printed) ────────────────────────────
function describeConfig() {
  const out = {
    enabled: env.enabled,
    teamId: env.teamId ? `set (${env.teamId.length} chars)` : 'missing',
    keyId: env.keyId ? `set (${env.keyId.length} chars)` : 'missing',
    bundleId: env.bundleId || 'missing',
    environment: env.environment,
    authKey: 'missing',
  };
  if (env.authKey) {
    if (env.authKey.startsWith('-----BEGIN')) {
      out.authKey = `inline PEM (${env.authKey.length} chars)`;
    } else if (fs.existsSync(env.authKey)) {
      const stat = fs.statSync(env.authKey);
      out.authKey = `file reference (${stat.size} bytes, mode ${(stat.mode & 0o777).toString(8)})`;
    } else {
      out.authKey = 'file reference (NOT FOUND)';
    }
  }
  return out;
}

function isConfigured() {
  if (!env.enabled || !env.teamId || !env.keyId || !env.bundleId || !env.authKey) return false;
  if (env.authKey.startsWith('-----BEGIN')) return true;
  return fs.existsSync(env.authKey);
}

// ── PEM loader ────────────────────────────────────────────────────────
function loadPem() {
  if (env.authKey.startsWith('-----BEGIN')) return env.authKey.replace(/\\n/g, '\n');
  if (fs.existsSync(env.authKey)) return fs.readFileSync(env.authKey, 'utf8');
  const escaped = env.authKey.replace(/\\n/g, '\n');
  if (escaped.includes('-----BEGIN')) return escaped;
  throw new Error('APNS_AUTH_KEY_P8 is neither a path nor a PEM string');
}

// ── JWT signer (ES256) ────────────────────────────────────────────────
function signJwt() {
  const jwt = require('jsonwebtoken');
  const pem = loadPem();
  return jwt.sign(
    { iss: env.teamId, iat: Math.floor(Date.now() / 1000) },
    pem,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: env.keyId } },
  );
}

// ── DB helpers (better-sqlite3, read-only) ────────────────────────────
function openDb() {
  const candidates = [
    path.resolve(process.cwd(), 'data/bot.db'),
    path.resolve(process.cwd(), 'data/nexushub.db'),
    process.env.DATABASE_PATH,
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const Database = require('better-sqlite3');
      return new Database(p, { readonly: true });
    }
  }
  throw new Error(`No database found. Tried: ${candidates.join(', ')}`);
}

function listTokens(db) {
  return db
    .prepare(
      `SELECT user_id, device_id, device_name, length(push_token) AS token_len,
              datetime(last_active_at) AS last_active, datetime(created_at) AS created
       FROM ios_devices
       WHERE push_token IS NOT NULL AND push_token <> ?
       ORDER BY last_active_at DESC`,
    )
    .all('');
}

function tokenForUser(db, userId) {
  return db
    .prepare(
      `SELECT user_id, device_id, device_name, push_token, length(push_token) AS token_len,
              datetime(last_active_at) AS last_active
       FROM ios_devices
       WHERE user_id = ? AND push_token IS NOT NULL AND push_token <> ?
       ORDER BY last_active_at DESC
       LIMIT 1`,
    )
    .get(userId, '');
}

// ── HTTP/2 POST to APNs ───────────────────────────────────────────────
async function sendPush(token, payload, jwtToken) {
  const host = env.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const client = http2.connect(`https://${host}:443`);

  return new Promise((resolve) => {
    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': env.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    let bodyChunks = [];
    let apnsId = '';

    req.on('response', (headers) => {
      status = Number(headers[':status']) || 0;
      apnsId = headers['apns-id'] || '';
    });
    req.on('data', (c) => bodyChunks.push(c));
    req.on('end', () => {
      client.close();
      const body = Buffer.concat(bodyChunks).toString('utf8');
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : null; } catch { /* not json */ }
      resolve({ status, apnsId, body, parsed, host });
    });
    req.on('error', (err) => {
      client.close();
      resolve({ status: -1, apnsId: '', body: '', parsed: null, host, transportError: err.message });
    });

    req.end(JSON.stringify(payload));
  });
}

// ── Modes ─────────────────────────────────────────────────────────────
async function modeCheck() {
  const cfg = describeConfig();
  console.log('apns-smoke: config inventory');
  for (const [k, v] of Object.entries(cfg)) console.log(`  ${k}: ${v}`);
  const ok = isConfigured();
  console.log('');
  console.log(ok ? '✓ All required env vars are present and the .p8 is reachable.' : '✗ One or more required env vars are missing or invalid.');

  // Sign a JWT to prove the key parses cleanly (without printing the token).
  if (ok) {
    try {
      const tok = signJwt();
      console.log(`✓ JWT signs cleanly (token: ${tok.length} chars, ES256, kid=${env.keyId}).`);
    } catch (err) {
      console.log(`✗ JWT signing failed: ${err.message}`);
      process.exit(1);
    }
  }
  process.exit(ok ? 0 : 1);
}

function modeList() {
  const db = openDb();
  try {
    const rows = listTokens(db);
    console.log(`apns-smoke: ${rows.length} push token(s) in ios_devices`);
    if (rows.length > 0) {
      const fmt = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
      console.log(`  ${fmt('user', 6)} ${fmt('device_name', 24)} ${fmt('len', 5)} ${fmt('last_active', 20)} ${fmt('created', 20)}`);
      for (const r of rows) {
        console.log(`  ${fmt(r.user_id, 6)} ${fmt(r.device_name, 24)} ${fmt(r.token_len, 5)} ${fmt(r.last_active, 20)} ${fmt(r.created, 20)}`);
      }
    }
  } finally {
    db.close();
  }
  process.exit(0);
}

async function modeSend(userId) {
  if (!isConfigured()) {
    console.error('apns-smoke: not configured — run --check first to see what is missing');
    process.exit(1);
  }
  const db = openDb();
  let row;
  try {
    row = tokenForUser(db, userId);
  } finally {
    db.close();
  }
  if (!row) {
    console.error(`apns-smoke: no push token found for user_id=${userId}`);
    process.exit(1);
  }
  console.log(`apns-smoke: sending to user_id=${userId} device="${row.device_name}" token_len=${row.token_len} last_active=${row.last_active}`);
  console.log(`  endpoint: ${env.environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com'}`);
  console.log(`  topic:    ${env.bundleId}`);

  const payload = {
    aps: {
      alert: { title: messageTitle, body: messageBody },
      sound: 'default',
      'thread-id': 'apns-smoke',
    },
    smoke: { version: 1, ts: new Date().toISOString() },
  };

  if (dryRun) {
    const jwtToken = signJwt();
    console.log(`  --dry-run: skipping HTTP/2 POST. JWT signed cleanly (${jwtToken.length} chars).`);
    process.exit(0);
  }

  const jwtToken = signJwt();
  const result = await sendPush(row.push_token, payload, jwtToken);

  if (result.transportError) {
    console.log(`✗ transport error: ${result.transportError}`);
    process.exit(3);
  }

  console.log(`  HTTP ${result.status}  apns-id=${result.apnsId}`);
  if (result.parsed) console.log(`  body: ${JSON.stringify(result.parsed)}`);
  else if (result.body) console.log(`  body: ${result.body}`);

  if (result.status >= 200 && result.status < 300) {
    console.log('✓ APNs accepted the push. Check the device in 1-2 seconds.');
    process.exit(0);
  }
  if (result.status === 410 || (result.parsed && result.parsed.reason === 'Unregistered')) {
    console.log('⚠ APNs reports the token is unregistered (device uninstalled the app or token rotated). Caller should delete the row.');
    process.exit(2);
  }
  if (result.parsed && result.parsed.reason === 'BadDeviceToken') {
    console.log('✗ APNs reports BadDeviceToken — likely an environment mismatch (sandbox token sent to production endpoint, or vice versa). Check APNS_ENVIRONMENT.');
    process.exit(2);
  }
  console.log('✗ APNs rejected the push.');
  process.exit(2);
}

// ── Entry ─────────────────────────────────────────────────────────────
(async () => {
  if (wantCheck) await modeCheck();
  else if (wantList) modeList();
  else if (userIdArg) await modeSend(userIdArg);
})().catch((err) => {
  console.error('apns-smoke fatal:', err.message);
  process.exit(1);
});
