#!/usr/bin/env node
/**
 * Local-only iOS debug auth bootstrap.
 *
 * Ensures the local Docker sandbox has a reusable email/password session for
 * the simulator and writes the AuthResponse JSON consumed by
 * DebugAuthTokenImporter in the iOS app. This script is intentionally scoped
 * to loopback development and never talks to production.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_EMAIL = 'nexushubbot@gmail.com';
const DEFAULT_PASSWORD = 'local-nexushubbot-password-2026';
const DEFAULT_FIRST_NAME = 'Nexus';
const DEFAULT_DEVICE_ID = 'local-cockpit-nexushubbot';
const DEFAULT_AUTH_FILE = path.join(ROOT, '.local', 'full-nexus', 'local-ios-auth.json');
const DEFAULT_BASE_URL = 'http://127.0.0.1:8200';
const CURRENT_TERMS_VERSION = '2026-06-05';
const CURRENT_PRIVACY_VERSION = '2026-06-05';

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function envOrArg(envName, argName, fallback) {
  return process.env[envName] || argValue(argName, fallback);
}

function readEnvLocal() {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    result[key] = rawValue.replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function resolveHostDbPath() {
  const env = readEnvLocal();
  const configured = process.env.NEXUS_LOCAL_DB_PATH || env.DATABASE_PATH || '/app/data/local.db';
  if (configured.startsWith('/app/data/')) {
    return path.join(ROOT, 'data', configured.slice('/app/data/'.length));
  }
  return configured;
}

function assertLocalOnlyRuntime(baseUrl) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('local-ios-debug-auth refuses to run with NODE_ENV=production');
  }
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`local-ios-debug-auth requires a valid loopback base URL; got ${baseUrl}`);
  }
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error(`local-ios-debug-auth refuses non-loopback base URL: ${baseUrl}`);
  }
}

function assertLocalDbPath(dbPath) {
  const resolved = path.resolve(dbPath);
  const allowedRoots = [
    ROOT,
    path.resolve('/tmp'),
    path.resolve(process.env.TMPDIR || '/tmp'),
  ];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`local-ios-debug-auth refuses non-local database path: ${resolved}`);
  }
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${route}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Language': 'pt-BR',
      'User-Agent': 'NexusHubLocalCockpit/1',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { response, json, text };
}

function normalizeAuthPayload(json) {
  const payload = json?.data ?? json;
  if (!payload?.accessToken || !payload?.refreshToken || !payload?.user?.id) {
    throw new Error(`auth response missing token shape: ${JSON.stringify(json?.error ?? json)}`);
  }
  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    expiresIn: payload.expiresIn,
    user: payload.user,
  };
}

function writeAuthFile(authFile, payload) {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(payload, null, 2));
}

function grantLocalMaxAccess(db, userId) {
  const periodStart = new Date().toISOString();
  const periodEnd = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    UPDATE users
       SET tier = 'max',
           status = 'active',
           email_verified = 1,
           daily_cost_limit_usd = CASE
             WHEN daily_cost_limit_usd IS NULL OR daily_cost_limit_usd < 5 THEN 5
             ELSE daily_cost_limit_usd
           END
     WHERE id = ?
  `).run(userId);
  db.prepare(`
    INSERT INTO subscriptions (
      user_id, plan, period, status, provider,
      current_period_start, current_period_end, updated_at
    )
    VALUES (?, 'max', 'monthly', 'trialing', 'beta', ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      period = excluded.period,
      status = excluded.status,
      provider = excluded.provider,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      updated_at = datetime('now')
  `).run(userId, periodStart, periodEnd);
}

async function resetLocalPassword(email, password, firstName) {
  const dbPath = resolveHostDbPath();
  assertLocalDbPath(dbPath);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`local database not found at ${dbPath}`);
  }
  const db = new Database(dbPath);
  try {
    db.pragma('busy_timeout = 5000');
    const user = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(email);
    if (!user?.id) {
      throw new Error(`cannot reset local password because ${email} does not exist in ${dbPath}`);
    }
    const hash = await bcrypt.hash(password, 12);
    db.prepare(`
      UPDATE users
         SET password_hash = ?,
             status = 'active',
             email_verified = 1,
             first_name = COALESCE(NULLIF(first_name, ''), ?)
       WHERE id = ?
    `).run(hash, firstName, user.id);
    try {
      db.prepare('DELETE FROM failed_login_attempts WHERE user_id = ?').run(user.id);
    } catch { /* older DBs may not have the table */ }
    grantLocalMaxAccess(db, user.id);
    return user.id;
  } finally {
    db.close();
  }
}

async function main() {
  const email = envOrArg('NEXUS_LOCAL_IOS_EMAIL', '--email', DEFAULT_EMAIL).toLowerCase();
  const password = envOrArg('NEXUS_LOCAL_IOS_PASSWORD', '--password', DEFAULT_PASSWORD);
  const firstName = envOrArg('NEXUS_LOCAL_IOS_FIRST_NAME', '--first-name', DEFAULT_FIRST_NAME);
  const deviceId = envOrArg('NEXUS_LOCAL_IOS_DEVICE_ID', '--device-id', DEFAULT_DEVICE_ID);
  const authFile = path.resolve(envOrArg('NEXUS_LOCAL_AUTH_IMPORT_PATH', '--auth-file', DEFAULT_AUTH_FILE));
  const baseUrl = envOrArg('NEXUS_LOCAL_BASE_URL', '--base-url', DEFAULT_BASE_URL);
  const inviteCode = envOrArg('NEXUS_LOCAL_IOS_INVITE_CODE', '--invite-code', process.env.IOS_INVITE_CODE || 'LOCAL-DEV-INVITE');

  assertLocalOnlyRuntime(baseUrl);

  const loginBody = { email, password, deviceId, deviceName: 'Local Cockpit iOS Simulator' };
  let result = await postJson(baseUrl, '/api/v1/auth/login/email', loginBody);

  if (!result.response.ok) {
    const registerBody = {
      email,
      password,
      firstName,
      deviceId,
      deviceName: 'Local Cockpit iOS Simulator',
      inviteCode,
      acceptedLegal: {
        accepted: true,
        termsVersion: CURRENT_TERMS_VERSION,
        privacyVersion: CURRENT_PRIVACY_VERSION,
      },
    };
    result = await postJson(baseUrl, '/api/v1/auth/register/email', registerBody);

    if (!result.response.ok && inviteCode) {
      const registerWithoutInvite = { ...registerBody };
      delete registerWithoutInvite.inviteCode;
      result = await postJson(baseUrl, '/api/v1/auth/register/email', registerWithoutInvite);
    }
  }

  if (!result.response.ok) {
    await resetLocalPassword(email, password, firstName);
    result = await postJson(baseUrl, '/api/v1/auth/login/email', loginBody);
  }

  if (!result.response.ok) {
    throw new Error(`unable to create local iOS auth session: HTTP ${result.response.status} ${JSON.stringify(result.json?.error ?? result.text)}`);
  }

  const payload = normalizeAuthPayload(result.json);
  writeAuthFile(authFile, payload);
  console.log(JSON.stringify({
    ok: true,
    email,
    userId: payload.user.id,
    firstName: payload.user.firstName,
    authFile,
    onboarding: 'skipped_by_debug_importer',
  }, null, 2));
}

main().catch((err) => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
