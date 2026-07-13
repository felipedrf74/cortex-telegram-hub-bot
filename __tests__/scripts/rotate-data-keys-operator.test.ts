import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const PRODUCTION = join(ROOT, 'scripts', 'rotate-production-data-keys.sh');
const STAGING = join(ROOT, 'scripts', 'rotate-staging-data-keys.sh');
const POSTCHECK = join(ROOT, 'scripts', 'production-data-key-rotation-postcheck.mjs');
const ROTATOR = join(ROOT, 'dist', 'tools', 'rotate-data-encryption-keys.js');
const EXPECTED_SHA256 =
  '2efff86ae28c043a7622ed0fa0df8ab738a96115c0337429c4347e21e9412322';
const EXPECTED_TABLES = [
  'user_oauth_tokens',
  'garmin_sessions',
  'garmin_user_tokens',
  'apple_health_data',
  'finance_transactions',
  'finance_tax_events',
];
const POSTCHECK_KEYS = [
  'productionEdgeHealth',
  'stagingPeerHealth',
  'authenticatedOAuthRead',
  'authenticatedGarminRead',
  'authenticatedHealthRead',
  'authenticatedFinanceRead',
  'pm2Stable',
  'noNewAlerts',
];

function sourceAndVerifyDigest(script: string, productionPair: boolean): void {
  const body = productionPair
    ? String.raw`
      set -euo pipefail
      ROTATION_SCRIPT_LIBRARY_MODE=1 source "$1"
      sha256sum() { node -e 'const fs=require("fs");const c=require("crypto");const p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\n")' "$2"; }
      root="$(mktemp -d)"
      trap 'rm -rf "$root"' EXIT
      printf '%s' 'reviewed artifact' > "$root/production.js"
      cp "$root/production.js" "$root/staging.js"
      expected="$(node -e 'const fs=require("fs");const c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$root/production.js")"
      verify_exact_rotator_artifacts "$root/production.js" "$root/staging.js" "$expected"
      if (verify_exact_rotator_artifacts "$root/production.js" "$root/staging.js" "0000000000000000000000000000000000000000000000000000000000000000") >/dev/null 2>&1; then exit 17; fi
      printf 'verified'
    `
    : String.raw`
      set -euo pipefail
      ROTATION_SCRIPT_LIBRARY_MODE=1 source "$1"
      sha256sum() { node -e 'const fs=require("fs");const c=require("crypto");const p=process.argv[1];process.stdout.write(c.createHash("sha256").update(fs.readFileSync(p)).digest("hex")+"  "+p+"\\n")' "$2"; }
      root="$(mktemp -d)"
      trap 'rm -rf "$root"' EXIT
      printf '%s' 'reviewed artifact' > "$root/staging.js"
      expected="$(node -e 'const fs=require("fs");const c=require("crypto");process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$root/staging.js")"
      verify_exact_rotator_artifact "$root/staging.js" "$expected"
      if (verify_exact_rotator_artifact "$root/staging.js" "0000000000000000000000000000000000000000000000000000000000000000") >/dev/null 2>&1; then exit 17; fi
      printf 'verified'
    `;
  expect(execFileSync('bash', ['-c', body, 'operator-test', script], {
    encoding: 'utf8',
  })).toBe('verified');
}

function jwt(exp: number): string {
  const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({ exp })}.${'s'.repeat(43)}`;
}

describe('data-key rotation operators', () => {
  it('keeps both tracked wrappers executable, syntactically valid, and help-only safe', () => {
    for (const script of [PRODUCTION, STAGING]) {
      expect(statSync(script).mode & 0o111).not.toBe(0);
      execFileSync('bash', ['-n', script]);
      const help = execFileSync(script, ['--help'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      });
      expect(help).toContain('Usage:');
    }
  });

  it('pins the reviewed rotator artifact and the complete six-table contract', () => {
    for (const script of [PRODUCTION, STAGING]) {
      const source = readFileSync(script, 'utf8');
      expect(source).toContain(`readonly EXPECTED_ROTATOR_SHA256='${EXPECTED_SHA256}'`);
      for (const table of EXPECTED_TABLES) expect(source).toContain(`'${table}'`);
      for (const variable of [
        'OLD_OAUTH_ENCRYPTION_KEY',
        'OLD_GARMIN_ENCRYPTION_KEY',
        'OLD_HEALTH_DATA_ENCRYPTION_KEY',
        'OLD_FINANCE_ENCRYPTION_KEY',
        'NEW_OAUTH_ENCRYPTION_KEY',
        'NEW_GARMIN_ENCRYPTION_KEY',
        'NEW_HEALTH_DATA_ENCRYPTION_KEY',
        'NEW_FINANCE_ENCRYPTION_KEY',
      ]) {
        expect(source).toContain(variable);
      }
    }

    const production = readFileSync(PRODUCTION, 'utf8');
    expect(production).toContain('verify_exact_rotator_artifacts');
    expect(production).toContain('validate_external_postcheck_result');
    expect(production).toContain("readonly POSTCHECK_CONTRACT_VERSION='2'");
    for (const key of POSTCHECK_KEYS) expect(production).toContain(`'${key}'`);

    const staging = readFileSync(STAGING, 'utf8');
    expect(staging).toContain('verify_exact_rotator_artifact');
    expect(staging).toContain('assert_staging_finance_surface_empty');
    expect(staging).toContain('encrypted Finance surface is not safely empty');
    expect(staging).toContain('Saving here');
    expect(staging).not.toMatch(/\bsanitized_pm2\s+save\b/);
  });

  it('rejects rotator digest mismatches in both library-mode wrappers', () => {
    sourceAndVerifyDigest(PRODUCTION, true);
    sourceAndVerifyDigest(STAGING, false);
  });

  it('matches the reviewed compiled rotator whenever the build artifact is present', () => {
    if (!existsSync(ROTATOR)) return;
    const actual = createHash('sha256').update(readFileSync(ROTATOR)).digest('hex');
    expect(actual).toBe(EXPECTED_SHA256);
  });

  it('keeps the postcheck credential-free, endpoint-pinned, and fail-closed', () => {
    const source = readFileSync(POSTCHECK, 'utf8');
    expect(source).toContain(`export const POSTCHECK_CONTRACT_VERSION = 2`);
    expect(source).toContain(EXPECTED_SHA256);
    expect(source).toContain('https://api.nexushub.me/health');
    expect(source).toContain('http://127.0.0.1:8200');
    expect(source).toContain('http://127.0.0.1:8201');
    expect(source).toContain('production-data-key-rotation-postcheck.config.json');
    expect(source).toContain('production-data-key-rotation-alert-evidence.json');
    expect(source).not.toMatch(/process\.env\.[A-Z_]*URL/);
    expect(source).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    for (const key of POSTCHECK_KEYS) expect(source).toContain(`${key}: true`);

    const result = spawnSync(process.execPath, [POSTCHECK], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^production data-key postcheck failed:/);
  });

  it('validates protected config, phase, and fresh alert evidence exactly', async () => {
    const postcheck = await import(pathToFileURL(POSTCHECK).href);
    const now = Date.parse('2026-07-13T20:00:00.000Z');
    const backupDir =
      '/home/dominguez/telegram-hub-bot/.local/rotation-backups/'
      + 'production-data-keys-20260713T195900Z-ABCDEFGH';
    const config = {
      version: 1,
      ownerIosJwt: jwt(Math.floor(now / 1000) + 600),
      activeTenantId: 1,
    };
    expect(postcheck.validatePostcheckConfig(config, now)).toEqual({
      ownerIosJwt: config.ownerIosJwt,
      activeTenantId: 1,
    });
    expect(() => postcheck.validatePostcheckConfig(
      { ...config, ownerIosJwt: jwt(Math.floor(now / 1000) + 30) },
      now,
    )).toThrow(/expired|expiry/);
    expect(() => postcheck.validatePostcheckConfig(
      { ...config, unexpected: true },
      now,
    )).toThrow(/schema/);

    const marker = {
      version: 1,
      phase: 'runtime_healthy',
      backupDir,
      databasePath: '/home/dominguez/telegram-hub-bot/data/telegram_hub.db',
      expectedRotatorSha256: EXPECTED_SHA256,
      updatedAt: '2026-07-13T19:59:00.000Z',
    };
    const phase = postcheck.validatePhaseMarker(marker, {
      expectedSha256: EXPECTED_SHA256,
      expectedBackupDir: backupDir,
    });
    const evidence = {
      version: 1,
      noNewAlerts: true,
      observedAt: '2026-07-13T19:59:30.000Z',
      expiresAt: '2026-07-13T20:05:00.000Z',
      expectedRotatorSha256: EXPECTED_SHA256,
      rotationBackupDir: backupDir,
    };
    expect(postcheck.validateAlertEvidence(evidence, {
      now,
      expectedSha256: EXPECTED_SHA256,
      expectedBackupDir: backupDir,
      phaseUpdatedAtMs: phase.updatedAtMs,
    })).toBe(true);
    expect(() => postcheck.validateAlertEvidence(
      { ...evidence, expiresAt: '2026-07-13T19:59:59.000Z' },
      {
        now,
        expectedSha256: EXPECTED_SHA256,
        expectedBackupDir: backupDir,
        phaseUpdatedAtMs: phase.updatedAtMs,
      },
    )).toThrow(/expired/);
    expect(() => postcheck.validateAlertEvidence(
      { ...evidence, noNewAlerts: false },
      {
        now,
        expectedSha256: EXPECTED_SHA256,
        expectedBackupDir: backupDir,
        phaseUpdatedAtMs: phase.updatedAtMs,
      },
    )).toThrow(/noNewAlerts/);
  });

  it('requires healthy services and meaningful authenticated reads in every domain', async () => {
    const postcheck = await import(pathToFileURL(POSTCHECK).href);
    const envelope = (data: Record<string, unknown>) => ({
      ok: true,
      data,
      cached: false,
      timestamp: '2026-07-13T20:00:00.000Z',
    });
    const health = {
      status: 'healthy',
      database: 'healthy',
      server: { status: 'running', database: 'healthy' },
    };
    expect(postcheck.validateHealthPayload(health, 'service')).toBe(true);
    expect(() => postcheck.validateHealthPayload(
      { ...health, database: 'unhealthy' },
      'service',
    )).toThrow(/not healthy/);

    const reads = {
      oauth: envelope({
        connections: [{ provider: 'google' }],
        count: 1,
      }),
      garmin: envelope({
        connected: true,
        status: 'active',
        email: 'owner@example.com',
      }),
      health: {
        ok: true,
        types: [{ data_type: 'heart_rate', latest_date: '2026-07-13' }],
      },
      finance: envelope({
        transactions: [{ id: 1, amount: 12.34 }],
        count: 1,
      }),
    };
    expect(postcheck.validateAuthenticatedPayloads(reads)).toBe(true);
    expect(() => postcheck.validateAuthenticatedPayloads({
      ...reads,
      finance: envelope({ transactions: [{ id: 1, amount: null }], count: 1 }),
    })).toThrow(/decrypted transaction/);
  });

  it('requires exactly one stable online production process for each app', async () => {
    const postcheck = await import(pathToFileURL(POSTCHECK).href);
    const now = Date.parse('2026-07-13T20:00:00.000Z');
    const processes = ['nexus-hub', 'content-engine'].map((name, index) => ({
      name,
      pid: 100 + index,
      pm2_env: {
        status: 'online',
        pm_uptime: now - 10_000,
        unstable_restarts: 0,
      },
    }));
    expect(postcheck.validatePm2Processes(processes, now)).toBe(true);
    expect(() => postcheck.validatePm2Processes([
      ...processes,
      { ...processes[0] },
    ], now)).toThrow(/identity mismatch/);
    expect(() => postcheck.validatePm2Processes([
      { ...processes[0], pm2_env: { ...processes[0].pm2_env, unstable_restarts: 1 } },
      processes[1],
    ], now)).toThrow(/not stable/);
  });
});
