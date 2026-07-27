import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const healthScript = path.resolve('scripts/application-dr-health-check.py');
const alertScript = path.resolve('scripts/application-dr-alert.py');
const installTransactionScript = path.resolve(
  'scripts/application-dr-install-transaction.py',
);
const systemPython = [
  process.env.CONTENT_ENGINE_PYTHON,
  '/usr/bin/python3',
  '/opt/homebrew/bin/python3',
].find((candidate): candidate is string => (
  typeof candidate === 'string' && fs.existsSync(candidate)
));

interface Fixture {
  root: string;
  state: string;
  alerts: string;
  systemctl: string;
  logger: string;
  output: string;
  env: NodeJS.ProcessEnv;
}

function write(file: string, body: string, mode: number): void {
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
}

function makeFixture(options: {
  completedAt?: string;
  activeState?: string;
  subState?: string;
  result?: string;
  loggerExit?: number;
} = {}): Fixture {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-health-')),
  );
  fs.chmodSync(root, 0o700);
  const state = path.join(root, 'state');
  const alerts = path.join(state, 'alerts');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(alerts, { mode: 0o700 });
  fs.mkdirSync(tools, { mode: 0o700 });
  const systemctl = path.join(tools, 'systemctl');
  const logger = path.join(tools, 'logger');
  const output = path.join(state, 'health-current.v1.json');
  write(
    path.join(state, 'install-recovery-program.v2.py'),
    fs.readFileSync(installTransactionScript, 'utf8'),
    0o600,
  );
  const completedAt = options.completedAt ?? '2026-07-25T11:30:00Z';
  const startedAt = new Date(Date.parse(completedAt) - 10 * 60 * 1000)
    .toISOString()
    .replace('.000Z', 'Z');
  write(
    path.join(state, 'last-success.v1.json'),
    `${JSON.stringify({
      schema: 'nexus.application-dr-last-success.v1',
      status: 'passed',
      startedAt,
      completedAt,
      storageProvider: 'aws-s3',
      storageControlMode: 'versioned-s3',
      lifecyclePhase: 'enabled',
    })}\n`,
    0o600,
  );
  write(
    systemctl,
    '#!/bin/sh\n'
    + 'printf \'ActiveState=%s\\n\' "$FAKE_ACTIVE_STATE"\n'
    + 'printf \'SubState=%s\\n\' "$FAKE_SUB_STATE"\n'
    + 'printf \'Result=%s\\n\' "$FAKE_RESULT"\n',
    0o700,
  );
  write(
    logger,
    '#!/bin/sh\n'
    + `printf '%s\\n' "$*" >> '${path.join(root, 'logger.log')}'\n`
    + `exit ${options.loggerExit ?? 0}\n`,
    0o700,
  );
  return {
    root,
    state,
    alerts,
    systemctl,
    logger,
    output,
    env: {
      ...process.env,
      FAKE_ACTIVE_STATE: options.activeState ?? 'inactive',
      FAKE_SUB_STATE: options.subState ?? 'dead',
      FAKE_RESULT: options.result ?? 'success',
    },
  };
}

function healthArgs(fixture: Fixture): string[] {
  return [
    healthScript,
    '--state-dir', fixture.state,
    '--service', 'nexus-application-dr-backup.service',
    '--systemctl', fixture.systemctl,
    '--max-age-seconds', '3600',
    '--output', fixture.output,
    '--expected-owner-uid', String(process.getuid?.() ?? 0),
    '--trust-boundary', fixture.root,
    '--now', '2026-07-25T12:00:00Z',
    '--test-mode',
  ];
}

function installJournal(
  fixture: Fixture,
  startedAt: string,
): Record<string, unknown> {
  if (!systemPython) throw new Error('Python 3 is required');
  const targetsResult = spawnSync(
    systemPython,
    [
      '-c',
      String.raw`
import importlib.util
import json
import sys
spec = importlib.util.spec_from_file_location("dr_install", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(sorted(module.ALLOWED_TARGETS)))
`,
      installTransactionScript,
    ],
    { encoding: 'utf8' },
  );
  if (targetsResult.status !== 0) {
    throw new Error(targetsResult.stderr);
  }
  const targets = JSON.parse(targetsResult.stdout) as string[];
  const recoveryProgram = path.join(
    fixture.state,
    'install-recovery-program.v2.py',
  );
  return {
    schema: 'nexus.application-dr-install-transaction.v2',
    status: 'in_progress',
    phase: 'committed-0',
    startedAt,
    updatedAt: startedAt,
    sourceRootSha256: 'a'.repeat(64),
    layoutSha256: 'b'.repeat(64),
    recoveryProgram,
    recoveryProgramSha256: createHash('sha256')
      .update(fs.readFileSync(recoveryProgram))
      .digest('hex'),
    transactionDirectory: path.join(
      fixture.state,
      '.install-transaction.v2.fixture',
    ),
    assets: targets.map((target, index) => ({
      index,
      source: `/protected-main/application-dr-asset-${index}`,
      sourceSha256: index.toString(16).padStart(64, '0'),
      target,
      stage: path.join(
        path.dirname(target),
        `.nexus-application-dr.stage.fixture-${index}`,
      ),
      backup: null,
      hadTarget: false,
      predecessorSha256: null,
      predecessorMode: null,
      owner: 'root:root',
      mode: '0644',
    })),
    committedIndices: [0],
    recoveredIndices: [],
    drillUser: 'nexus-dr-drill',
    drillUserCreated: false,
    healthTimerEnabledByInstall: false,
    timerBefore: {
      backupEnabled: false,
      backupEnabledState: 'disabled',
      backupActive: false,
      backupActiveState: 'inactive',
      healthEnabled: false,
      healthEnabledState: 'disabled',
      healthActive: false,
      healthActiveState: 'inactive',
      recoveryServiceEnabled: false,
      recoveryServiceEnabledState: 'disabled',
    },
  };
}

function alertArgs(fixture: Fixture, unit = 'nexus-application-dr-backup.service'): string[] {
  return [
    alertScript,
    '--unit', unit,
    '--state-dir', fixture.state,
    '--systemctl', fixture.systemctl,
    '--logger', fixture.logger,
    '--expected-owner-uid', String(process.getuid?.() ?? 0),
    '--trust-boundary', fixture.root,
    '--now', '2026-07-25T12:01:00Z',
    '--test-mode',
  ];
}

function run(args: string[], fixture: Fixture) {
  if (!systemPython) throw new Error('Python 3 is required');
  return spawnSync(systemPython, args, {
    encoding: 'utf8',
    env: fixture.env,
  });
}

describe.runIf(systemPython !== undefined)(
  'application DR stale/failed recovery-point alerting',
  () => {
    it('writes health and alert evidence completely before fsync and publish', () => {
      const health = fs.readFileSync(healthScript, 'utf8');
      const alert = fs.readFileSync(alertScript, 'utf8');
      for (const source of [health, alert]) {
        expect(source).toContain('while offset < len(body):');
        expect(source).toContain(
          'written = os.write(descriptor, body[offset:])',
        );
        expect(source).toContain('if written <= 0:');
      }
    });

    it('accepts a fresh exact success stamp and writes bounded health evidence', () => {
      const fixture = makeFixture();
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: true,
          schemaVersion: 'NexusApplicationDrHealthV1',
          status: 'healthy',
          ageSeconds: 1800,
        });
        expect(JSON.parse(fs.readFileSync(fixture.output, 'utf8'))).toMatchObject({
          status: 'healthy',
          maximumAgeSeconds: 3600,
          backupService: {
            activeState: 'inactive',
            result: 'success',
          },
        });
        expect(fs.statSync(fixture.output).mode & 0o777).toBe(0o600);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('fails when the last success is older than one hour and no backup runs', () => {
      const fixture = makeFixture({
        completedAt: '2026-07-25T10:59:59Z',
      });
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'application DR recovery point is older than one hour',
        );
        expect(fs.existsSync(fixture.output)).toBe(false);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects mismatched provider and storage-control evidence', () => {
      const fixture = makeFixture();
      const successPath = path.join(fixture.state, 'last-success.v1.json');
      const success = JSON.parse(fs.readFileSync(successPath, 'utf8'));
      success.storageControlMode = 'r2-approved-variance';
      success.lifecyclePhase = 'approved-r2-variance';
      write(successPath, `${JSON.stringify(success)}\n`, 0o600);
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'last-success evidence shape is invalid',
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('reports an in-progress backup instead of a false stale alert', () => {
      const fixture = makeFixture({
        completedAt: '2026-07-25T10:59:59Z',
        activeState: 'activating',
        subState: 'start',
      });
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).status).toBe('in_progress');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('reports a bounded active install but fails a crash-stale install journal', () => {
      const fixture = makeFixture();
      const journal = path.join(fixture.state, 'install-in-progress.v1');
      try {
        fs.rmSync(path.join(fixture.state, 'last-success.v1.json'));
        write(
          journal,
          `${JSON.stringify(
            installJournal(fixture, '2026-07-25T11:50:00Z'),
          )}\n`,
          0o600,
        );
        const active = run(healthArgs(fixture), fixture);
        expect(active.status, active.stderr).toBe(0);
        expect(JSON.parse(active.stdout)).toMatchObject({
          ok: true,
          status: 'installing',
          installAgeSeconds: 600,
        });

        write(
          journal,
          `${JSON.stringify(
            installJournal(fixture, '2026-07-25T11:44:59Z'),
          )}\n`,
          0o600,
        );
        const stale = run(healthArgs(fixture), fixture);
        expect(stale.status).not.toBe(0);
        expect(stale.stderr).toContain(
          'application DR installation has been incomplete for over 15 minutes',
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects obsolete or incomplete install-journal shapes', () => {
      const fixture = makeFixture();
      const journal = path.join(fixture.state, 'install-in-progress.v1');
      try {
        write(
          journal,
          `${JSON.stringify({
            schema: 'nexus.application-dr-install-journal.v1',
            status: 'in_progress',
            startedAt: '2026-07-25T11:50:00Z',
          })}\n`,
          0o600,
        );
        const rejected = run(healthArgs(fixture), fixture);
        expect(rejected.status).not.toBe(0);
        expect(rejected.stderr).toContain('install journal shape is invalid');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('never reports an unrecoverable v2 install journal as installing', () => {
      const mutations: Array<{
        name: string;
        apply: (journal: Record<string, unknown>) => void;
      }> = [
        {
          name: 'out-of-range checkpoint',
          apply: (journal) => {
            const assets = journal.assets as unknown[];
            journal.committedIndices = [assets.length];
          },
        },
        {
          name: 'duplicate checkpoint',
          apply: (journal) => {
            journal.committedIndices = [0, 0];
          },
        },
        {
          name: 'malformed asset',
          apply: (journal) => {
            journal.assets = [{}];
          },
        },
        {
          name: 'missing timer predecessor binding',
          apply: (journal) => {
            journal.timerBefore = {};
          },
        },
        {
          name: 'future update checkpoint',
          apply: (journal) => {
            journal.updatedAt = '2026-07-25T12:06:00Z';
          },
        },
      ];
      for (const mutation of mutations) {
        const fixture = makeFixture();
        try {
          const journalPath = path.join(
            fixture.state,
            'install-in-progress.v1',
          );
          const journal = installJournal(
            fixture,
            '2026-07-25T11:50:00Z',
          );
          mutation.apply(journal);
          write(
            journalPath,
            `${JSON.stringify(journal)}\n`,
            0o600,
          );
          const rejected = run(healthArgs(fixture), fixture);
          expect(
            rejected.status,
            `${mutation.name} unexpectedly passed: ${rejected.stdout}`,
          ).not.toBe(0);
        } finally {
          fs.rmSync(fixture.root, { recursive: true, force: true });
        }
      }
    });

    it('fails on a failed service even when the recovery point is fresh', () => {
      const fixture = makeFixture({
        activeState: 'failed',
        subState: 'failed',
        result: 'exit-code',
      });
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'application DR backup service is failed',
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('persists a redacted alert, logs it, and deduplicates occurrences', () => {
      const fixture = makeFixture({
        activeState: 'failed',
        subState: 'failed',
        result: 'exit-code',
      });
      try {
        const first = run(alertArgs(fixture), fixture);
        expect(first.status, first.stderr).toBe(0);
        const second = run(alertArgs(fixture), fixture);
        expect(second.status, second.stderr).toBe(0);
        const alertPath = path.join(
          fixture.alerts,
          'nexus-application-dr-backup.service.v1.json',
        );
        const alert = JSON.parse(fs.readFileSync(alertPath, 'utf8'));
        expect(alert).toMatchObject({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-backup.service',
          occurrences: 2,
          operatorActionRequired: true,
          systemd: {
            activeState: 'failed',
            result: 'exit-code',
          },
        });
        const raw = fs.readFileSync(alertPath, 'utf8');
        expect(raw).not.toMatch(/access.?key|secret|token/i);
        expect(fs.readFileSync(path.join(fixture.root, 'logger.log'), 'utf8'))
          .toContain('priority auth.alert');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('resolves active alerts only after a fresh healthy observation', () => {
      const fixture = makeFixture();
      const alertPath = path.join(
        fixture.alerts,
        'nexus-application-dr-backup.service.v1.json',
      );
      write(
        alertPath,
        `${JSON.stringify({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-backup.service',
          firstObservedAt: '2026-07-25T11:00:00Z',
          lastObservedAt: '2026-07-25T11:05:00Z',
          occurrences: 2,
          systemd: {
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
          },
          operatorActionRequired: true,
        })}\n`,
        0o600,
      );
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(alertPath, 'utf8'))).toMatchObject({
          status: 'resolved',
          resolvedAt: '2026-07-25T12:00:00Z',
          occurrences: 2,
          operatorActionRequired: false,
        });
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('keeps a backup alert active until a later recovery point succeeds', () => {
      const fixture = makeFixture({
        completedAt: '2026-07-25T11:30:00Z',
      });
      const alertPath = path.join(
        fixture.alerts,
        'nexus-application-dr-backup.service.v1.json',
      );
      write(
        alertPath,
        `${JSON.stringify({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-backup.service',
          firstObservedAt: '2026-07-25T11:45:00Z',
          lastObservedAt: '2026-07-25T11:45:00Z',
          occurrences: 1,
          systemd: {
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
          },
          operatorActionRequired: true,
        })}\n`,
        0o600,
      );
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(alertPath, 'utf8'))).toMatchObject({
          status: 'active',
          operatorActionRequired: true,
        });
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('does not resolve when recovery predates the latest repeated failure', () => {
      const fixture = makeFixture({
        completedAt: '2026-07-25T11:30:00Z',
      });
      const alertPath = path.join(
        fixture.alerts,
        'nexus-application-dr-backup.service.v1.json',
      );
      write(
        alertPath,
        `${JSON.stringify({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-backup.service',
          firstObservedAt: '2026-07-25T11:00:00Z',
          lastObservedAt: '2026-07-25T11:45:00Z',
          occurrences: 2,
          systemd: {
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
          },
          operatorActionRequired: true,
        })}\n`,
        0o600,
      );
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(alertPath, 'utf8'))).toMatchObject({
          status: 'active',
          lastObservedAt: '2026-07-25T11:45:00Z',
          operatorActionRequired: true,
        });
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('keeps a health alert active until a later recovery point succeeds', () => {
      const fixture = makeFixture({
        completedAt: '2026-07-25T11:30:00Z',
      });
      const alertPath = path.join(
        fixture.alerts,
        'nexus-application-dr-health.service.v1.json',
      );
      write(
        alertPath,
        `${JSON.stringify({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-health.service',
          firstObservedAt: '2026-07-25T11:45:00Z',
          lastObservedAt: '2026-07-25T11:45:00Z',
          occurrences: 1,
          systemd: {
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
          },
          operatorActionRequired: true,
        })}\n`,
        0o600,
      );
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(alertPath, 'utf8'))).toMatchObject({
          status: 'active',
          operatorActionRequired: true,
        });
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('does not resolve an alert with a recovery point from the same second', () => {
      const fixture = makeFixture({
        completedAt: '2026-07-25T11:30:00Z',
      });
      const alertPath = path.join(
        fixture.alerts,
        'nexus-application-dr-backup.service.v1.json',
      );
      write(
        alertPath,
        `${JSON.stringify({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-backup.service',
          firstObservedAt: '2026-07-25T11:30:00Z',
          lastObservedAt: '2026-07-25T11:30:00Z',
          occurrences: 1,
          systemd: {
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
          },
          operatorActionRequired: true,
        })}\n`,
        0o600,
      );
      try {
        const result = run(healthArgs(fixture), fixture);
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(fs.readFileSync(alertPath, 'utf8'))).toMatchObject({
          status: 'active',
          operatorActionRequired: true,
        });
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects alert evidence whose embedded unit does not match its path', () => {
      const fixture = makeFixture();
      const alertPath = path.join(
        fixture.alerts,
        'nexus-application-dr-backup.service.v1.json',
      );
      write(
        alertPath,
        `${JSON.stringify({
          schemaVersion: 'NexusApplicationDrAlertV1',
          status: 'active',
          unit: 'nexus-application-dr-health.service',
          firstObservedAt: '2026-07-25T11:00:00Z',
          lastObservedAt: '2026-07-25T11:05:00Z',
          occurrences: 1,
          systemd: {
            activeState: 'failed',
            subState: 'failed',
            result: 'exit-code',
          },
          operatorActionRequired: true,
        })}\n`,
        0o600,
      );
      try {
        const health = run(healthArgs(fixture), fixture);
        expect(health.status).not.toBe(0);
        expect(health.stderr).toContain('active alert evidence is invalid');

        const alert = run(alertArgs(fixture), fixture);
        expect(alert.status).not.toBe(0);
        expect(alert.stderr).toContain('existing alert evidence is invalid');
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it('rejects units outside the exact alert allowlist', () => {
      const fixture = makeFixture();
      try {
        const result = run(alertArgs(fixture, 'ssh.service'), fixture);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          'alert unit is outside the exact allowlist',
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  },
);
