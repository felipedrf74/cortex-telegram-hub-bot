import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const READINESS = join(ROOT, 'scripts', 'deploy-readiness-check.sh');
const ENV_PARITY = join(ROOT, 'scripts', 'env-parity-check.sh');
const VERIFY_CONTAINER = join(ROOT, 'scripts', 'release-verify-container.sh');
const RELEASE_SANDBOX_UP = join(ROOT, 'scripts', 'release-sandbox-up.sh');
const RELEASE_SANDBOX_SMOKE = join(ROOT, 'scripts', 'release-sandbox-smoke.sh');
const RELEASE_SANDBOX_DEPLOY_HARNESS = join(ROOT, 'scripts', 'release-sandbox-deploy-harness.sh');

function prependPath(binDir: string) {
  return `${binDir}:${process.env.PATH ?? ''}`;
}

function writeExecutable(path: string, contents: string) {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function writeInjectionDetectingSsh(binDir: string, logPath?: string) {
  writeExecutable(
    join(binDir, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
${logPath ? `printf 'ssh called\\n' >> "${logPath}"\n` : ''}
shift
if [ "$#" -eq 1 ]; then
  bash -c "$1"
fi
exit 0
`,
  );
}

function writeExecSsh(binDir: string) {
  writeExecutable(
    join(binDir, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
shift
exec "$@"
`,
  );
}

function writeNodeTransformingSsh(binDir: string) {
  writeExecutable(
    join(binDir, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
shift
script="$(mktemp)"
node_bin="\${NODE_BIN:-node}"
sed "s|/usr/bin/node|$node_bin|g" > "$script"
if [ "\${1:-}" = "bash" ] && [ "\${2:-}" = "-s" ]; then
  shift 2
  if [ "\${1:-}" = "--" ]; then
    shift
  fi
  exec bash "$script" "$@"
fi
exec "$@"
`,
  );
}

describe('deploy shell hardening', () => {
  it.each([
    ['command substitution', '/tmp/x$(touch __PWN__)'],
    ['backtick substitution', '/tmp/x`touch __PWN__`'],
    ['semicolon injection', '/tmp/x;touch __PWN__'],
  ])('rejects unsafe readiness remote-dir before ssh: %s', (_label, maliciousTemplate) => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-injection-'));
    const binDir = join(root, 'bin');
    const sshLog = join(root, 'ssh.log');
    const pwn = join(root, 'PWN');
    const maliciousRemoteDir = maliciousTemplate.replace('__PWN__', pwn);
    mkdirSync(binDir);
    writeInjectionDetectingSsh(binDir, sshLog);
    try {
      const result = execFileSync(
        'bash',
        [
          '-c',
          `set +e; "${READINESS}" --target prod --server fake-server --remote-dir '${maliciousRemoteDir}' --portal-port 8200 --content-port 8100 >/tmp/readiness.out 2>/tmp/readiness.err; printf '%s' "$?"`,
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: prependPath(binDir),
            NEXUS_DEPLOY_PM2_SAMPLE_DELAY_S: '0',
          },
        },
      );
      expect(result).toBe('2');
      expect(() => readFileSync(sshLog, 'utf8')).toThrow();
      expect(() => readFileSync(pwn, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['command substitution', '/tmp/staging$(touch __PWN__)'],
    ['backtick substitution', '/tmp/staging`touch __PWN__`'],
    ['semicolon injection', '/tmp/staging;touch __PWN__'],
  ])('rejects unsafe env parity directory before ssh: %s', (_label, maliciousTemplate) => {
    const root = mkdtempSync(join(tmpdir(), 'env-parity-injection-'));
    const binDir = join(root, 'bin');
    const sshLog = join(root, 'ssh.log');
    const pwn = join(root, 'PWN');
    const maliciousStagingDir = maliciousTemplate.replace('__PWN__', pwn);
    mkdirSync(binDir);
    writeInjectionDetectingSsh(binDir, sshLog);
    try {
      const result = execFileSync(
        'bash',
        [
          '-c',
          `set +e; "${ENV_PARITY}" --server fake-server --staging-dir '${maliciousStagingDir}' --prod-dir /tmp/prod >/tmp/env-parity.out 2>/tmp/env-parity.err; printf '%s' "$?"`,
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, PATH: prependPath(binDir) },
        },
      );
      expect(result).toBe('2');
      expect(() => readFileSync(sshLog, 'utf8')).toThrow();
      expect(() => readFileSync(pwn, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('compares env key presence while allowing staging/prod secret values to differ', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-parity-values-'));
    const binDir = join(root, 'bin');
    const staging = join(root, 'staging');
    const prod = join(root, 'prod');
    mkdirSync(binDir);
    mkdirSync(staging);
    mkdirSync(prod);
    writeExecSsh(binDir);
    writeFileSync(
      join(staging, '.env'),
      [
        'NODE_ENV=staging',
        'BACKUP_ENCRYPT=false',
        'AI_CALL_TIMEOUT_MS=60',
        'OAUTH_ENCRYPTION_KEY=staging-key',
        'INTERNAL_API_SECRET=staging-secret',
        'STRIPE_SECRET_KEY=sk_test_example',
      ].join('\n'),
    );
    writeFileSync(
      join(prod, '.env'),
      [
        'NODE_ENV=production',
        'BACKUP_ENCRYPT=true',
        'AI_CALL_TIMEOUT_MS=30',
        'OAUTH_ENCRYPTION_KEY=prod-key',
        'INTERNAL_API_SECRET=prod-secret',
        'STRIPE_SECRET_KEY=sk_live_example',
      ].join('\n'),
    );
    try {
      const output = execFileSync(
        'bash',
        [ENV_PARITY, '--server', 'fake-server', '--staging-dir', staging, '--prod-dir', prod],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, PATH: prependPath(binDir) },
        },
      );
      expect(output).toContain('env_parity_ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows documented staging/prod-only env keys and reads prod NODE_ENV from ecosystem config', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-parity-shape-'));
    const binDir = join(root, 'bin');
    const staging = join(root, 'staging');
    const prod = join(root, 'prod');
    mkdirSync(binDir);
    mkdirSync(staging);
    mkdirSync(prod);
    writeExecSsh(binDir);
    writeFileSync(
      join(staging, '.env'),
      [
        'NODE_ENV=staging',
        'AI_CALL_TIMEOUT_MS=60',
        'OAUTH_ENCRYPTION_KEY=staging-key',
        'INTERNAL_API_SECRET=staging-secret',
        'PORTAL_ADMIN_ACTORS=deploy-staging@example.invalid',
        'STAGING=true',
        'STRIPE_NEXUS_POINTS_ENABLED=false',
      ].join('\n'),
    );
    writeFileSync(
      join(staging, 'ecosystem.staging.config.js'),
      "module.exports = { apps: [{ env: { NODE_ENV: 'staging' } }] };\n",
    );
    writeFileSync(
      join(prod, '.env'),
      [
        'BACKUP_ENCRYPT=true',
        'BACKUP_KEY=prod-backup-key',
        'AI_CALL_TIMEOUT_MS=30',
        'OAUTH_ENCRYPTION_KEY=prod-key',
        'INTERNAL_API_SECRET=prod-secret',
        'TELEGRAM_BOT_TOKEN=prod-bot',
        'APNS_ENABLED=true',
        'PAYWALL_ENABLED=true',
      ].join('\n'),
    );
    writeFileSync(
      join(prod, 'ecosystem.config.js'),
      "module.exports = { apps: [{ env: { NODE_ENV: 'production' } }] };\n",
    );
    try {
      const output = execFileSync(
        'bash',
        [ENV_PARITY, '--server', 'fake-server', '--staging-dir', staging, '--prod-dir', prod],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, PATH: prependPath(binDir) },
        },
      );
      expect(output).toContain('env_parity_ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails env parity when an unallowlisted key only exists in one environment', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-parity-unallowlisted-'));
    const binDir = join(root, 'bin');
    const staging = join(root, 'staging');
    const prod = join(root, 'prod');
    mkdirSync(binDir);
    mkdirSync(staging);
    mkdirSync(prod);
    writeExecSsh(binDir);
    const shared = [
      'BACKUP_ENCRYPT=true',
      'AI_CALL_TIMEOUT_MS=60',
      'OAUTH_ENCRYPTION_KEY=key',
      'INTERNAL_API_SECRET=secret',
    ].join('\n');
    writeFileSync(join(staging, '.env'), `NODE_ENV=staging\n${shared}\nUNEXPECTED_FLAG=true\n`);
    writeFileSync(join(prod, '.env'), `NODE_ENV=production\n${shared}\n`);
    try {
      expect(() =>
        execFileSync(
          'bash',
          [ENV_PARITY, '--server', 'fake-server', '--staging-dir', staging, '--prod-dir', prod],
          {
            cwd: ROOT,
            env: { ...process.env, PATH: prependPath(binDir) },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      ).toThrow(/UNEXPECTED_FLAG:staging=set:prod=missing/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails env parity when production NODE_ENV or backup encryption is unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'env-parity-prod-required-'));
    const binDir = join(root, 'bin');
    const staging = join(root, 'staging');
    const prod = join(root, 'prod');
    mkdirSync(binDir);
    mkdirSync(staging);
    mkdirSync(prod);
    writeExecSsh(binDir);
    const shared = [
      'BACKUP_ENCRYPT=false',
      'AI_CALL_TIMEOUT_MS=60',
      'OAUTH_ENCRYPTION_KEY=key',
      'INTERNAL_API_SECRET=secret',
    ].join('\n');
    writeFileSync(join(staging, '.env'), `NODE_ENV=staging\n${shared}\n`);
    writeFileSync(join(prod, '.env'), `NODE_ENV=staging\n${shared}\n`);
    try {
      expect(() =>
        execFileSync(
          'bash',
          [ENV_PARITY, '--server', 'fake-server', '--staging-dir', staging, '--prod-dir', prod],
          {
            cwd: ROOT,
            env: { ...process.env, PATH: prependPath(binDir) },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      ).toThrow(/NODE_ENV:prod_expected_production|BACKUP_ENCRYPT:prod_expected_enabled/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails production readiness when INTERNAL_API_SECRET is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-missing-secret-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    const dataDir = join(remoteDir, 'data');
    mkdirSync(binDir);
    mkdirSync(dataDir, { recursive: true });
    writeNodeTransformingSsh(binDir);
    writeExecutable(
      join(binDir, 'sqlite3'),
      `#!/usr/bin/env bash
echo ok
`,
    );
    writeExecutable(
      join(binDir, 'curl'),
      `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  */health) echo '{"status":"healthy","server":{"database":"connected"}}' ;;
  */ready) echo '{"status":"ready","internalAuthConfigured":true}' ;;
  *) exit 22 ;;
esac
`,
    );
    writeFileSync(join(remoteDir, '.env'), 'DATABASE_PATH="./data/bot.db"\n', {
      mode: 0o600,
    });
    writeFileSync(join(dataDir, 'bot.db'), '');
    symlinkSync(join(ROOT, 'node_modules'), join(remoteDir, 'node_modules'), 'dir');
    try {
      let combined = '';
      try {
        execFileSync(
          'bash',
          [
            READINESS,
            '--target',
            'prod',
            '--server',
            'fake-server',
            '--remote-dir',
            remoteDir,
            '--portal-port',
            '8200',
            '--content-port',
            '8100',
          ],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              PATH: prependPath(binDir),
              NODE_BIN: process.execPath,
              NEXUS_DEPLOY_PM2_SAMPLE_DELAY_S: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        throw new Error('expected readiness to fail without INTERNAL_API_SECRET');
      } catch (error) {
        const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
        combined = `${String(failure.stdout ?? '')}\n${String(failure.stderr ?? '')}`;
      }
      expect(combined).toContain('INTERNAL_API_SECRET missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows historical PM2 restart counters when no restart happens during readiness', () => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-pm2-history-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    const dataDir = join(remoteDir, 'data');
    const pm2Bin = join(binDir, 'pm2');
    mkdirSync(binDir);
    mkdirSync(dataDir, { recursive: true });
    writeNodeTransformingSsh(binDir);
    writeExecutable(
      join(binDir, 'sqlite3'),
      `#!/usr/bin/env bash
echo ok
`,
    );
    writeExecutable(
      join(binDir, 'curl'),
      `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  *:8201/health) echo '{"status":"healthy","server":{"database":"connected"}}' ;;
  *:8101/health) echo '{"status":"ok"}' ;;
  *) exit 22 ;;
esac
`,
    );
    writeExecutable(
      pm2Bin,
      `#!/usr/bin/env bash
if [ "\${1:-}" != "jlist" ]; then exit 1; fi
now=$(node -p 'Date.now()')
uptime=$((now - 20000))
cat <<JSON
[
  {"name":"nexus-hub-staging","pid":123,"pm2_env":{"status":"online","pm_uptime":$uptime,"restart_time":19}},
  {"name":"content-engine-staging","pid":124,"pm2_env":{"status":"online","pm_uptime":$uptime,"restart_time":2}}
]
JSON
`,
    );
    writeFileSync(join(remoteDir, '.env'), 'DATABASE_PATH="./data/bot.db"\n', {
      mode: 0o600,
    });
    writeFileSync(join(dataDir, 'bot.db'), '');
    symlinkSync(join(ROOT, 'node_modules'), join(remoteDir, 'node_modules'), 'dir');
    try {
      const output = execFileSync(
        'bash',
        [
          READINESS,
          '--target',
          'staging',
          '--server',
          'fake-server',
          '--remote-dir',
          remoteDir,
          '--portal-port',
          '8201',
          '--content-port',
          '8101',
        ],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: prependPath(binDir),
            NODE_BIN: process.execPath,
            NEXUS_DEPLOY_PM2_BIN: pm2Bin,
            NEXUS_DEPLOY_PM2_SAMPLE_DELAY_S: '0',
          },
        },
      );
      expect(output).toContain('PM2 historical restarts high for nexus-hub-staging: 19');
      expect(output).toContain('PM2 apps online and stable');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails readiness when PM2 restart count increases during the sample', () => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-pm2-delta-'));
    const binDir = join(root, 'bin');
    const remoteDir = join(root, 'remote');
    const dataDir = join(remoteDir, 'data');
    const pm2Bin = join(binDir, 'pm2');
    const pm2Count = join(root, 'pm2-count');
    mkdirSync(binDir);
    mkdirSync(dataDir, { recursive: true });
    writeNodeTransformingSsh(binDir);
    writeExecutable(
      join(binDir, 'sqlite3'),
      `#!/usr/bin/env bash
echo ok
`,
    );
    writeExecutable(
      join(binDir, 'curl'),
      `#!/usr/bin/env bash
url="\${@: -1}"
case "$url" in
  *:8201/health) echo '{"status":"healthy","server":{"database":"connected"}}' ;;
  *:8101/health) echo '{"status":"ok"}' ;;
  *) exit 22 ;;
esac
`,
    );
    writeExecutable(
      pm2Bin,
      `#!/usr/bin/env bash
if [ "\${1:-}" != "jlist" ]; then exit 1; fi
count=0
if [ -f "${pm2Count}" ]; then count=$(cat "${pm2Count}"); fi
count=$((count + 1))
printf '%s' "$count" > "${pm2Count}"
now=$(node -p 'Date.now()')
uptime=$((now - 20000))
restarts=19
if [ "$count" -gt 1 ]; then restarts=20; fi
cat <<JSON
[
  {"name":"nexus-hub-staging","pid":123,"pm2_env":{"status":"online","pm_uptime":$uptime,"restart_time":$restarts}},
  {"name":"content-engine-staging","pid":124,"pm2_env":{"status":"online","pm_uptime":$uptime,"restart_time":2}}
]
JSON
`,
    );
    writeFileSync(join(remoteDir, '.env'), 'DATABASE_PATH="./data/bot.db"\n', {
      mode: 0o600,
    });
    writeFileSync(join(dataDir, 'bot.db'), '');
    symlinkSync(join(ROOT, 'node_modules'), join(remoteDir, 'node_modules'), 'dir');
    try {
      let combined = '';
      try {
        execFileSync(
          'bash',
          [
            READINESS,
            '--target',
            'staging',
            '--server',
            'fake-server',
            '--remote-dir',
            remoteDir,
            '--portal-port',
            '8201',
            '--content-port',
            '8101',
          ],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              PATH: prependPath(binDir),
              NODE_BIN: process.execPath,
              NEXUS_DEPLOY_PM2_BIN: pm2Bin,
              NEXUS_DEPLOY_PM2_SAMPLE_DELAY_S: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        throw new Error('expected readiness to fail on PM2 restart delta');
      } catch (error) {
        const failure = error as { stdout?: Buffer | string; stderr?: Buffer | string };
        combined = `${String(failure.stdout ?? '')}\n${String(failure.stderr ?? '')}`;
      }
      expect(combined).toContain('pm2_restarted_during_readiness_nexus-hub-staging:19->20');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails readiness before ssh when PM2 stability env values are invalid', () => {
    const root = mkdtempSync(join(tmpdir(), 'readiness-invalid-env-'));
    const binDir = join(root, 'bin');
    const sshLog = join(root, 'ssh.log');
    mkdirSync(binDir);
    writeExecutable(
      join(binDir, 'ssh'),
      `#!/usr/bin/env bash
printf 'ssh called\\n' >> "${sshLog}"
exit 0
`,
    );
    try {
      expect(() =>
        execFileSync(
          'bash',
          [
            READINESS,
            '--target',
            'prod',
            '--server',
            'fake-server',
            '--remote-dir',
            join(root, 'remote'),
            '--portal-port',
            '8200',
            '--content-port',
            '8100',
          ],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              PATH: prependPath(binDir),
              NEXUS_DEPLOY_MAX_PM2_RESTARTS: 'not-a-number',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ),
      ).toThrow(/Invalid NEXUS_DEPLOY_MAX_PM2_RESTARTS/);
      expect(() => readFileSync(sshLog, 'utf8')).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs release-verify-container with default args on bash 3 compatible array expansion', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-verify-container-'));
    const binDir = join(root, 'bin');
    const dockerLog = join(root, 'docker.log');
    mkdirSync(binDir);
    writeExecutable(
      join(binDir, 'docker'),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dockerLog}"
`,
    );
    try {
      execFileSync('bash', [VERIFY_CONTAINER], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: prependPath(binDir),
          NEXUS_RELEASE_TEST_SKIP_BUILD: '1',
        },
      });
      const log = readFileSync(dockerLog, 'utf8');
      expect(log).toContain('run --rm');
      expect(log).toContain('./scripts/release-verify.sh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps release sandbox entrypoints local-only wrappers', () => {
    const up = readFileSync(RELEASE_SANDBOX_UP, 'utf8');
    const smoke = readFileSync(RELEASE_SANDBOX_SMOKE, 'utf8');
    const harness = readFileSync(RELEASE_SANDBOX_DEPLOY_HARNESS, 'utf8');

    expect(up).toContain('scripts/local-up.sh');
    expect(smoke).toContain('scripts/local-smoke.sh');
    expect(smoke).toContain('docker compose -f docker-compose.local.yml exec -T nexus-hub node');
    expect(smoke).toContain('x-internal-secret');
    expect(harness).toContain('__tests__/scripts/release-deploy-dry-runs.test.ts');
    expect(harness).toContain('__tests__/scripts/deploy-shell-hardening.test.ts');
    expect(up + smoke + harness).not.toContain('dominguez@serverdominguez');
    expect(up + smoke + harness).not.toContain('rsync ');
  });
});
