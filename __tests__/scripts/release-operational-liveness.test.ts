import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKUP_HEARTBEAT_MAX_AGE_SECONDS,
  BackupLivenessError,
  RESTORE_HEARTBEAT_MAX_AGE_SECONDS,
  inspectBackupLiveness,
} from '../../scripts/lib/release-backup-liveness.mjs';
import {
  RELEASE_NOTIFICATION_KINDS,
  buildReleaseNotification,
  createReleaseNotifier,
} from '../../scripts/lib/release-notify.mjs';
import { RELEASE_STATUSES } from '../../scripts/lib/release-state-store.mjs';
import {
  createReleaseBackupAlertStore,
  deliverDueReleaseBackupAlert,
  RELEASE_BACKUP_ALERT_SOURCES,
  RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS,
} from '../../scripts/lib/release-backup-alert-state.mjs';
import {
  commitReleaseBackupLivenessCheck,
  inspectReleaseBackupLiveness,
  parseReleaseHeartbeatArgv,
  prepareReleaseBackupLivenessCheck,
  runReleaseBackupLivenessCheck,
  runReleaseHeartbeat,
  runReleaseHeartbeatCli,
} from '../../scripts/release-heartbeat.mjs';
import {
  parseOperationalAlertArgv,
  runOperationalAlert,
  runOperationalAlertCli,
} from '../../scripts/release-operational-alert.mjs';

type JsonObject = Record<string, any>;

const repoRoot = resolve(process.cwd());
const fixtureRoots: string[] = [];
const fixtureDescriptors: number[] = [];
const expectedUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const expectedGid = typeof process.getgid === 'function' ? process.getgid() : 0;

function temporaryRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  fixtureRoots.push(root);
  return root;
}

function governedTemporaryRoot(prefix: string) {
  const root = nodeFs.realpathSync(mkdtempSync(join(repoRoot, `.${prefix}`)));
  chmodSync(root, 0o700);
  fixtureRoots.push(root);
  return root;
}

function boundLockTemporaryRoot(prefix: string) {
  if (process.platform === 'linux') return governedTemporaryRoot(prefix);
  const root = nodeFs.realpathSync(temporaryRoot(prefix));
  chmodSync(root, 0o700);
  return root;
}

function writePrivate(file: string, body: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(dirname(file), 0o700);
  writeFileSync(file, body);
  chmodSync(file, 0o600);
}

function writePrivateJson(file: string, value: unknown) {
  writePrivate(file, `${JSON.stringify(value)}\n`);
}

function makeLivenessEvidence({
  nowMs = Date.parse('2026-08-11T09:00:00.000Z'),
  backupAgeSeconds = 60,
  restoreAgeSeconds = 24 * 60 * 60,
  restoreArtifactPresent = true,
  root = temporaryRoot('nexus-backup-liveness-'),
} = {}) {
  const receiptPath = join(root, 'state', 'last-success.json');
  const restoreVerificationReceiptPath = join(
    root,
    'state',
    'last-restore-verification.json',
  );
  const completedAtMs = nowMs - backupAgeSeconds * 1000;
  const startedAtMs = completedAtMs - 5_000;
  const started = new Date(startedAtMs).toISOString();
  const producerTimestamp = `${started.slice(0, 10).replaceAll('-', '')}T${started
    .slice(11, 19).replaceAll(':', '')}Z`;
  const backupArtifact = join(root, 'hourly', `nexus-db-${producerTimestamp}.sqlite.age`);
  const restoreArtifact = restoreArtifactPresent
    ? backupArtifact
    : join(root, 'hourly', 'nexus-db-20260803T040000Z.sqlite.age');
  const encrypted = Buffer.from('encrypted fixture bytes');
  const encryptedSha256 = createHash('sha256').update(encrypted).digest('hex');
  const credentialRoot = temporaryRoot('nexus-backup-credentials-');
  const backupConfigPath = join(credentialRoot, 'backup.env');
  const ageIdentityPath = join(credentialRoot, 'age-identity.txt');
  const ageKeygenBin = join(credentialRoot, 'age-keygen');
  const ageRecipient = `age1${'q'.repeat(58)}`;
  const backupLock = join(root, '.backup.lock');
  writePrivate(backupLock, '');
  writePrivate(ageIdentityPath, 'AGE-SECRET-KEY-1FIXTURE\n');
  writePrivate(ageKeygenBin, '#!/bin/sh\nexit 0\n');
  chmodSync(ageKeygenBin, 0o755);
  writePrivate(backupConfigPath, [
    'NEXUS_LOCAL_BACKUP_DATABASE_PATH=/var/lib/nexus-hub/production/data/bot.db',
    `NEXUS_LOCAL_BACKUP_ROOT=${root}`,
    `NEXUS_LOCAL_BACKUP_AGE_RECIPIENT=${ageRecipient}`,
    `NEXUS_LOCAL_BACKUP_AGE_IDENTITY=${ageIdentityPath}`,
    '',
  ].join('\n'));
  writePrivate(backupArtifact, encrypted);
  const backupChecksum = `${backupArtifact}.sha256`;
  writePrivate(
    backupChecksum,
    `${encryptedSha256}  ${basename(backupArtifact)}\n`,
  );
  if (restoreArtifactPresent && restoreArtifact !== backupArtifact) {
    writePrivate(restoreArtifact, encrypted);
    writePrivate(
      `${restoreArtifact}.sha256`,
      `${encryptedSha256}  ${basename(restoreArtifact)}\n`,
    );
  }
  writePrivateJson(receiptPath, {
    schema: 'nexus.local-backup.v1',
    status: 'passed',
    kind: 'backup',
    database: '/var/lib/nexus-hub/production/data/bot.db',
    backupRoot: root,
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: new Date(completedAtMs).toISOString(),
    encryptedSha256,
    encryptedSizeBytes: encrypted.length,
    installed: {
      hourly: backupArtifact,
      daily: join(root, 'daily', `nexus-db-${producerTimestamp.slice(0, 8)}.sqlite.age`),
      weekly: join(root, 'weekly', 'nexus-db-2026-W33.sqlite.age'),
    },
    retention: {
      hourly: 24,
      daily: 30,
      weekly: 4,
      'pre-promotion': 10,
    },
    plaintextSha256: 'a'.repeat(64),
    plaintextSizeBytes: 4_096,
    integrityCheck: 'ok',
    foreignKeyCheck: 'ok',
  });
  writePrivateJson(restoreVerificationReceiptPath, {
    schema: 'nexus.local-backup-restore-verification.v1',
    status: 'passed',
    backup: restoreArtifact,
    encryptedSha256,
    verifiedAt: new Date(nowMs - restoreAgeSeconds * 1000).toISOString(),
    plaintextSha256: 'a'.repeat(64),
    plaintextSizeBytes: 4_096,
    integrityCheck: 'ok',
    foreignKeyCheck: 'ok',
  });
  return {
    nowMs,
    root,
    backupLock,
    receiptPath,
    restoreVerificationReceiptPath,
    backupArtifact,
    backupChecksum,
    restoreArtifact,
    restoreChecksum: `${restoreArtifact}.sha256`,
    encryptedSha256,
    backupConfigPath,
    ageIdentityPath,
    ageKeygenBin,
    ageRecipient,
    policy: {
      backup: {
        root,
        receiptPath,
        maxReceiptAgeSeconds: 15 * 60,
        expectedDatabase: '/var/lib/nexus-hub/production/data/bot.db',
      },
    },
  };
}

function inspectFixture(
  fixture: ReturnType<typeof makeLivenessEvidence>,
  fsImpl: typeof nodeFs | JsonObject = nodeFs,
) {
  const backupLockDescriptor = nodeFs.openSync(fixture.backupLock, nodeFs.constants.O_RDWR);
  try {
    return inspectBackupLiveness({
      policy: fixture.policy,
      now: () => fixture.nowMs,
      fsImpl,
      expectedUid,
      expectedGid,
      backupConfigPath: fixture.backupConfigPath,
      ageIdentityPath: fixture.ageIdentityPath,
      ageKeygenBin: fixture.ageKeygenBin,
      credentialTrustAnchor: fixture.backupConfigPath.slice(
        0,
        fixture.backupConfigPath.lastIndexOf('/'),
      ),
      ageKeygenTrustAnchor: dirname(fixture.ageKeygenBin),
      backupTrustAnchor: fixture.root,
      backupLockDescriptor,
      execImpl: (command: string, args: string[], options: JsonObject) => ({
        status: command === '/proc/self/fd/4'
          && args.join(' ') === '-y /proc/self/fd/3'
          && Number.isInteger(options.stdio?.[3])
          && Number.isInteger(options.stdio?.[4])
          && readFileSync(fixture.ageIdentityPath, 'utf8').startsWith('AGE-SECRET-KEY-1') ? 0 : 1,
        stdout: `${fixture.ageRecipient}\n`,
        stderr: '',
      }),
    });
  } finally {
    nodeFs.closeSync(backupLockDescriptor);
  }
}

function mutatePrivateJson(file: string, mutate: (value: JsonObject) => void) {
  const value = JSON.parse(readFileSync(file, 'utf8')) as JsonObject;
  mutate(value);
  writePrivateJson(file, value);
}

function expectEvidenceFailure(run: () => unknown, code = 'backup_evidence_invalid') {
  try {
    run();
    throw new Error('expected backup evidence to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(BackupLivenessError);
    expect((error as BackupLivenessError).code).toBe(code);
  }
}

function heartbeatState() {
  return {
    active: {
      releaseId: 'a'.repeat(32),
      sourceSha: 'b'.repeat(40),
      status: RELEASE_STATUSES.COMPLETED,
    },
    blocked: null,
    history: [
      { status: RELEASE_STATUSES.COMPLETED },
      { status: RELEASE_STATUSES.ROLLED_BACK },
    ],
  };
}

function makeAlertStoreFixture(nowMs = Date.parse('2026-08-11T09:07:00.000Z')) {
  const stateDirectory = temporaryRoot('nexus-backup-alert-state-');
  const stateFile = join(stateDirectory, 'state.json');
  const lockFile = join(stateDirectory, 'alert.lock');
  writeFileSync(lockFile, '');
  chmodSync(lockFile, 0o600);
  const lockDescriptor = nodeFs.openSync(lockFile, nodeFs.constants.O_RDWR);
  fixtureDescriptors.push(lockDescriptor);
  const clock = { nowMs };
  const alertStore = createReleaseBackupAlertStore({
    stateDirectory,
    stateFile,
    lockFile,
    lockDescriptor,
    expectedUid,
    expectedGid,
    now: () => clock.nowMs,
    lockHeld: true,
  });
  return {
    alertStore,
    clock,
    stateDirectory,
    stateFile,
    lockFile,
    advance(milliseconds: number) {
      clock.nowMs += milliseconds;
    },
  };
}

afterEach(() => {
  for (const descriptor of fixtureDescriptors.splice(0)) {
    nodeFs.closeSync(descriptor);
  }
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('backup and restore evidence inspection', () => {
  it('exports the fixed reviewed heartbeat freshness thresholds', () => {
    expect(BACKUP_HEARTBEAT_MAX_AGE_SECONDS).toBe(2 * 60 * 60);
    expect(RESTORE_HEARTBEAT_MAX_AGE_SECONDS).toBe(8 * 24 * 60 * 60);
  });

  it('descriptor-verifies current evidence and returns only bounded ages', () => {
    const fixture = makeLivenessEvidence();
    const result = inspectFixture(fixture);

    expect(result.schema).toBe('nexus.release-backup-liveness.v1');
    expect(result.backup.ageSeconds).toBe(60);
    expect(result.restoreVerification.ageSeconds).toBe(24 * 60 * 60);
  });

  it('accepts a safely pruned artifact named by a still-fresh immutable restore receipt', () => {
    const fixture = makeLivenessEvidence({ restoreArtifactPresent: false });
    const result = inspectFixture(fixture);

    expect(result.restoreVerification.ageSeconds).toBe(24 * 60 * 60);
  });

  it.each([
    [
      'backup receipt',
      { backupAgeSeconds: BACKUP_HEARTBEAT_MAX_AGE_SECONDS + 1 },
      'backup_receipt_stale',
    ],
    [
      'restore verification',
      { restoreAgeSeconds: RESTORE_HEARTBEAT_MAX_AGE_SECONDS + 1 },
      'restore_verification_stale',
    ],
  ])('rejects stale %s evidence', (_label, options, expectedCode) => {
    const fixture = makeLivenessEvidence(options);
    expectEvidenceFailure(() => inspectFixture(fixture), expectedCode);
  });

  it.each([
    ['backup receipt', (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.receiptPath],
    [
      'restore receipt',
      (fixture: ReturnType<typeof makeLivenessEvidence>) => (
        fixture.restoreVerificationReceiptPath
      ),
    ],
    ['backup artifact', (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.backupArtifact],
  ])('rejects a symlinked %s', (_label, selectPath) => {
    const fixture = makeLivenessEvidence();
    const selected = selectPath(fixture);
    const target = `${selected}.target`;
    renameSync(selected, target);
    symlinkSync(target, selected);
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['backup receipt', (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.receiptPath],
    [
      'restore receipt',
      (fixture: ReturnType<typeof makeLivenessEvidence>) => (
        fixture.restoreVerificationReceiptPath
      ),
    ],
    ['backup artifact', (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.backupArtifact],
  ])('rejects a hard-linked %s', (_label, selectPath) => {
    const fixture = makeLivenessEvidence();
    linkSync(selectPath(fixture), join(fixture.root, `unexpected-${_label.replace(' ', '-')}`));
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['backup receipt', (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.receiptPath],
    [
      'restore receipt',
      (fixture: ReturnType<typeof makeLivenessEvidence>) => (
        fixture.restoreVerificationReceiptPath
      ),
    ],
    ['backup artifact', (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.backupArtifact],
  ])('rejects an unsafe-mode %s', (_label, selectPath) => {
    const fixture = makeLivenessEvidence();
    chmodSync(selectPath(fixture), 0o640);
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects an encrypted artifact whose digest no longer matches its receipt', () => {
    const fixture = makeLivenessEvidence();
    writePrivate(fixture.backupArtifact, 'substituted encrypted bytes');
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['missing', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      unlinkSync(fixture.backupChecksum);
    }],
    ['symlinked', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      const target = `${fixture.backupChecksum}.target`;
      renameSync(fixture.backupChecksum, target);
      symlinkSync(target, fixture.backupChecksum);
    }],
    ['hard-linked', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      linkSync(fixture.backupChecksum, `${fixture.backupChecksum}.unexpected`);
    }],
    ['unsafe-mode', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      chmodSync(fixture.backupChecksum, 0o640);
    }],
  ])('rejects a %s current checksum companion', (_label, mutate) => {
    const fixture = makeLivenessEvidence();
    mutate(fixture);
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['wrong digest', (fixture: ReturnType<typeof makeLivenessEvidence>) => (
      `${'0'.repeat(64)}  ${basename(fixture.backupArtifact)}\n`
    )],
    ['wrong basename', (fixture: ReturnType<typeof makeLivenessEvidence>) => (
      `${fixture.encryptedSha256}  unrelated.sqlite.age\n`
    )],
    ['extra bytes', (fixture: ReturnType<typeof makeLivenessEvidence>) => (
      `${fixture.encryptedSha256}  ${basename(fixture.backupArtifact)}\nextra\n`
    )],
  ])('rejects a checksum with %s', (_label, checksum) => {
    const fixture = makeLivenessEvidence();
    writePrivate(fixture.backupChecksum, checksum(fixture));
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['artifact only', true],
    ['checksum only', false],
  ])('rejects a pruned restore %s orphan', (_label, artifactOnly) => {
    const fixture = makeLivenessEvidence({ restoreArtifactPresent: false });
    if (artifactOnly) {
      writePrivate(fixture.restoreArtifact, 'encrypted fixture bytes');
    } else {
      writePrivate(
        fixture.restoreChecksum,
        `${fixture.encryptedSha256}  ${basename(fixture.restoreArtifact)}\n`,
      );
    }
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects a pruned restore pair that appears at the final relational boundary', () => {
    const fixture = makeLivenessEvidence({ restoreArtifactPresent: false });
    let artifactChecks = 0;
    const fsImpl = {
      openSync: nodeFs.openSync,
      fstatSync: nodeFs.fstatSync,
      readFileSync: nodeFs.readFileSync,
      readSync: nodeFs.readSync,
      closeSync: nodeFs.closeSync,
      lstatSync(candidate: nodeFs.PathLike, ...args: unknown[]) {
        if (resolve(String(candidate)) === fixture.restoreArtifact && ++artifactChecks === 2) {
          writePrivate(fixture.restoreArtifact, 'encrypted fixture bytes');
          writePrivate(
            fixture.restoreChecksum,
            `${fixture.encryptedSha256}  ${basename(fixture.restoreArtifact)}\n`,
          );
        }
        return (nodeFs.lstatSync as (...values: unknown[]) => nodeFs.Stats)(
          candidate,
          ...args,
        );
      },
    };
    expectEvidenceFailure(() => inspectFixture(fixture, fsImpl));
    expect(artifactChecks).toBe(2);
  });

  it.each([
    ['startedAt', (receipt: JsonObject) => { delete receipt.startedAt; }],
    ['plaintextSha256', (receipt: JsonObject) => { delete receipt.plaintextSha256; }],
    ['encrypted size', (receipt: JsonObject) => { receipt.encryptedSizeBytes += 1; }],
    ['integrity result', (receipt: JsonObject) => { receipt.integrityCheck = 'failed'; }],
    ['retention', (receipt: JsonObject) => { receipt.retention.hourly = 25; }],
    ['installed tiers', (receipt: JsonObject) => { receipt.installed.extra = '/tmp/extra'; }],
    ['timestamp order', (receipt: JsonObject) => {
      receipt.startedAt = '2026-08-11T10:00:00.000Z';
    }],
  ])('rejects a backup receipt with invalid %s claims', (_label, mutate) => {
    const fixture = makeLivenessEvidence();
    mutatePrivateJson(fixture.receiptPath, mutate);
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['missing plaintext digest', (receipt: JsonObject) => { delete receipt.plaintextSha256; }],
    ['failed integrity', (receipt: JsonObject) => { receipt.foreignKeyCheck = 'failed'; }],
    ['manual destination', (receipt: JsonObject) => { receipt.destination = '/tmp/restore.sqlite'; }],
    ['wrong artifact name', (receipt: JsonObject, fixture: ReturnType<typeof makeLivenessEvidence>) => {
      receipt.backup = join(fixture.root, 'hourly', 'unrelated.sqlite.age');
    }],
  ])('rejects a restore receipt with %s', (_label, mutate) => {
    const fixture = makeLivenessEvidence();
    mutatePrivateJson(fixture.restoreVerificationReceiptPath, (receipt) => mutate(receipt, fixture));
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    ['missing identity', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      unlinkSync(fixture.ageIdentityPath);
    }],
    ['symlinked identity', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      const target = `${fixture.ageIdentityPath}.target`;
      renameSync(fixture.ageIdentityPath, target);
      symlinkSync(target, fixture.ageIdentityPath);
    }],
    ['hard-linked identity', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      linkSync(fixture.ageIdentityPath, `${fixture.ageIdentityPath}.unexpected`);
    }],
    ['unsafe identity mode', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      chmodSync(fixture.ageIdentityPath, 0o640);
    }],
    ['corrupt identity', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      writePrivate(fixture.ageIdentityPath, 'corrupt\n');
    }],
    ['recipient mismatch', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      const config = readFileSync(fixture.backupConfigPath, 'utf8');
      writePrivate(
        fixture.backupConfigPath,
        config.replace(fixture.ageRecipient, `age1${'p'.repeat(58)}`),
      );
    }],
    ['invalid UTF-8 backup config', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      writePrivate(
        fixture.backupConfigPath,
        Buffer.concat([
          readFileSync(fixture.backupConfigPath),
          Buffer.from([0x23, 0xff, 0x0a]),
        ]),
      );
    }],
    ['unsafe credential parent', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      chmodSync(dirname(fixture.backupConfigPath), 0o750);
    }],
    ['unsafe age-keygen', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      chmodSync(fixture.ageKeygenBin, 0o777);
    }],
    ['symlinked age-keygen', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      const target = `${fixture.ageKeygenBin}.target`;
      renameSync(fixture.ageKeygenBin, target);
      symlinkSync(target, fixture.ageKeygenBin);
    }],
    ['hard-linked age-keygen', (fixture: ReturnType<typeof makeLivenessEvidence>) => {
      linkSync(fixture.ageKeygenBin, `${fixture.ageKeygenBin}.unexpected`);
    }],
  ])('rejects %s', (_label, mutate) => {
    const fixture = makeLivenessEvidence();
    mutate(fixture);
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it.each([
    [
      'backup',
      (fixture: ReturnType<typeof makeLivenessEvidence>) => fixture.receiptPath,
      'completedAt',
    ],
    [
      'restore verification',
      (fixture: ReturnType<typeof makeLivenessEvidence>) => (
        fixture.restoreVerificationReceiptPath
      ),
      'verifiedAt',
    ],
  ])('rejects future-dated %s evidence', (_label, selectReceipt, timestampField) => {
    const fixture = makeLivenessEvidence();
    mutatePrivateJson(selectReceipt(fixture), (receipt) => {
      receipt[timestampField] = new Date(fixture.nowMs + 1_000).toISOString();
    });
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects impossible calendar dates in producer receipts', () => {
    const fixture = makeLivenessEvidence();
    mutatePrivateJson(fixture.receiptPath, (receipt) => {
      receipt.startedAt = '2026-02-31T09:00:00.000Z';
      receipt.completedAt = '2026-02-31T09:00:00.000Z';
    });
    expectEvidenceFailure(() => inspectFixture(fixture), 'backup_evidence_invalid');
  });

  it.each([
    ['database', '/var/lib/nexus-hub/staging/data/bot.db'],
    ['backupRoot', '/srv/nexus-backups/unrelated'],
  ])('rejects a backup receipt with the wrong %s', (field, value) => {
    const fixture = makeLivenessEvidence();
    mutatePrivateJson(fixture.receiptPath, (receipt) => {
      receipt[field] = value;
    });
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects a restore receipt that points outside the governed hourly tier', () => {
    const fixture = makeLivenessEvidence();
    const dailyArtifact = join(
      fixture.root,
      'daily',
      'nexus-db-20260811T080000Z.sqlite.age',
    );
    writePrivate(dailyArtifact, 'encrypted fixture bytes');
    mutatePrivateJson(fixture.restoreVerificationReceiptPath, (receipt) => {
      receipt.backup = dailyArtifact;
    });
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects a symlinked governed backup root', () => {
    const realRoot = temporaryRoot('nexus-backup-real-root-');
    const linkParent = temporaryRoot('nexus-backup-link-parent-');
    const linkedRoot = join(linkParent, 'application');
    symlinkSync(realRoot, linkedRoot, 'dir');
    const fixture = makeLivenessEvidence({ root: linkedRoot });
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects a symlinked in-root state parent', () => {
    const fixture = makeLivenessEvidence();
    const relocatedState = join(temporaryRoot('nexus-backup-state-target-'), 'state');
    renameSync(join(fixture.root, 'state'), relocatedState);
    symlinkSync(relocatedState, join(fixture.root, 'state'), 'dir');
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects an in-root parent whose mode is no longer private', () => {
    const fixture = makeLivenessEvidence();
    chmodSync(join(fixture.root, 'hourly'), 0o750);
    expectEvidenceFailure(() => inspectFixture(fixture));
  });

  it('rejects a parent-directory identity change observed after a bound read', () => {
    const fixture = makeLivenessEvidence();
    const stateDirectory = join(fixture.root, 'state');
    let stateReads = 0;
    const fsImpl = {
      openSync: nodeFs.openSync,
      fstatSync: nodeFs.fstatSync,
      readFileSync: nodeFs.readFileSync,
      readSync: nodeFs.readSync,
      closeSync: nodeFs.closeSync,
      lstatSync(candidate: nodeFs.PathLike, ...args: unknown[]) {
        const metadata = (nodeFs.lstatSync as (...values: unknown[]) => nodeFs.Stats)(
          candidate,
          ...args,
        );
        if (resolve(String(candidate)) !== stateDirectory || ++stateReads < 2) {
          return metadata;
        }
        return new Proxy(metadata, {
          get(target, property) {
            if (property === 'ino') return Number(target.ino) + 1;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    expectEvidenceFailure(() => inspectFixture(fixture, fsImpl));
  });

  it('rejects an age-keygen ancestor identity change around recipient derivation', () => {
    const fixture = makeLivenessEvidence();
    const binaryDirectory = dirname(fixture.ageKeygenBin);
    let binaryDirectoryReads = 0;
    const fsImpl = {
      openSync: nodeFs.openSync,
      fstatSync: nodeFs.fstatSync,
      readFileSync: nodeFs.readFileSync,
      readSync: nodeFs.readSync,
      closeSync: nodeFs.closeSync,
      lstatSync(candidate: nodeFs.PathLike, ...args: unknown[]) {
        const metadata = (nodeFs.lstatSync as (...values: unknown[]) => nodeFs.Stats)(
          candidate,
          ...args,
        );
        if (resolve(String(candidate)) !== binaryDirectory || ++binaryDirectoryReads < 3) {
          return metadata;
        }
        return new Proxy(metadata, {
          get(target, property) {
            if (property === 'ino') return Number(target.ino) + 1;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    expectEvidenceFailure(() => inspectFixture(fixture, fsImpl));
  });

  it('rejects evidence whose opened descriptor disagrees with its path identity', () => {
    const fixture = makeLivenessEvidence();
    const fsImpl = {
      openSync: nodeFs.openSync,
      lstatSync: nodeFs.lstatSync,
      readFileSync: nodeFs.readFileSync,
      readSync: nodeFs.readSync,
      closeSync: nodeFs.closeSync,
      fstatSync(descriptor: number, ...args: unknown[]) {
        const metadata = (nodeFs.fstatSync as (...values: unknown[]) => nodeFs.Stats)(
          descriptor,
          ...args,
        );
        return new Proxy(metadata, {
          get(target, property) {
            if (property === 'ino') return Number(target.ino) + 1;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };

    expectEvidenceFailure(() => inspectFixture(fixture, fsImpl));
  });

  it('rejects an in-place receipt mutation observed after its descriptor read', () => {
    const fixture = makeLivenessEvidence();
    let receiptPathReads = 0;
    const fsImpl = {
      openSync: nodeFs.openSync,
      fstatSync: nodeFs.fstatSync,
      readFileSync: nodeFs.readFileSync,
      readSync: nodeFs.readSync,
      closeSync: nodeFs.closeSync,
      lstatSync(candidate: nodeFs.PathLike, ...args: unknown[]) {
        const metadata = (nodeFs.lstatSync as (...values: unknown[]) => nodeFs.Stats)(
          candidate,
          ...args,
        );
        if (resolve(String(candidate)) !== fixture.receiptPath || ++receiptPathReads < 2) {
          return metadata;
        }
        return new Proxy(metadata, {
          get(target, property) {
            if (property === 'size') return Number(target.size) + 1;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
    expectEvidenceFailure(() => inspectFixture(fixture, fsImpl));
  });
});

describe('release heartbeat liveness verdict', () => {
  it('sends a healthy heartbeat with sanitized ages', async () => {
    const calls: JsonObject[] = [];
    const result = await runReleaseHeartbeat({
      policy: {},
      store: { readState: heartbeatState },
      notifier: {
        send: async (message: JsonObject) => {
          calls.push(message);
          return { delivered: true, reason: 'sent' };
        },
      },
      inspectLiveness: () => ({
        backup: { ageSeconds: 61 },
        restoreVerification: { ageSeconds: 7_201 },
      }),
    });

    expect(result).toMatchObject({
      healthy: true,
      delivered: true,
      backupAgeSeconds: 61,
      restoreVerificationAgeSeconds: 7_201,
      exitCode: 0,
    });
    expect(calls).toEqual([expect.objectContaining({
      kind: RELEASE_NOTIFICATION_KINDS.HEARTBEAT,
      release: expect.objectContaining({
        backupAgeSeconds: 61,
        restoreVerificationAgeSeconds: 7_201,
        completedCount: 1,
      }),
    })]);
  });

  it.each([
    'backup_policy_invalid',
    'backup_evidence_invalid',
    'backup_receipt_stale',
    'restore_verification_stale',
  ])('pages and exits nonzero for %s', async (failureCode) => {
    const calls: JsonObject[] = [];
    const result = await runReleaseHeartbeat({
      policy: {},
      store: { readState: heartbeatState },
      notifier: {
        send: async (message: JsonObject) => {
          calls.push(message);
          return { delivered: true, reason: 'sent' };
        },
      },
      inspectLiveness: () => {
        throw new BackupLivenessError(failureCode, 'untrusted detail is not forwarded');
      },
    });

    expect(result).toMatchObject({
      healthy: false,
      delivered: true,
      failureCode,
      exitCode: 1,
    });
    expect(calls).toEqual([{
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: expect.objectContaining({
        phase: 'backup_liveness',
        outcome: 'heartbeat_failed',
        failureCode,
        actionRequired: 'inspect_backup_evidence',
      }),
    }]);
    expect(JSON.stringify(calls)).not.toContain('untrusted detail');
  });

  it('pages a liveness failure even when release state is unreadable', async () => {
    const calls: JsonObject[] = [];
    const result = await runReleaseHeartbeat({
      policy: {},
      store: {
        readState() {
          throw new Error('untrusted state detail');
        },
      },
      notifier: {
        send: async (message: JsonObject) => {
          calls.push(message);
          return { delivered: true, reason: 'sent' };
        },
      },
      inspectLiveness: () => {
        throw new BackupLivenessError('backup_receipt_stale', 'untrusted evidence detail');
      },
    });

    expect(result).toMatchObject({
      healthy: false,
      delivered: true,
      failureCode: 'backup_receipt_stale',
      exitCode: 1,
    });
    expect(calls).toEqual([{
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: {
        releaseId: null,
        sourceSha: null,
        phase: 'backup_liveness',
        outcome: 'heartbeat_failed',
        failureCode: 'backup_receipt_stale',
        rollbackResult: 'not_applicable',
        actionRequired: 'inspect_backup_evidence',
      },
    }]);
    expect(JSON.stringify(calls)).not.toContain('untrusted');
  });

  it.each([
    'backup_policy_invalid',
    'backup_evidence_invalid',
    'backup_receipt_stale',
    'restore_verification_stale',
  ])('preserves the governed %s failure code after sanitization', (failureCode) => {
    const text = buildReleaseNotification({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      policy: { notifications: { maxMessageChars: 900 } },
      release: {
        releaseId: null,
        sourceSha: null,
        phase: 'backup_liveness',
        outcome: 'heartbeat_failed',
        failureCode,
        rollbackResult: 'not_applicable',
        actionRequired: 'inspect_backup_evidence',
      },
    });
    expect(text).toContain('phase: backup_liveness');
    expect(text).toContain('outcome: heartbeat_failed');
    expect(text).toContain(`reason: ${failureCode}`);
    expect(text).toContain('action: inspect_backup_evidence');
    expect(text).not.toContain('[redacted]');
  });

  it('formats healthy ages without timestamps, paths, or digests', () => {
    const text = buildReleaseNotification({
      kind: RELEASE_NOTIFICATION_KINDS.HEARTBEAT,
      policy: { notifications: { maxMessageChars: 900 } },
      release: {
        releaseId: null,
        status: 'completed',
        blocked: null,
        completedCount: 1,
        backupAgeSeconds: 61.4,
        restoreVerificationAgeSeconds: 7_201.4,
        completedAt: '2026-08-11T08:58:59.000Z',
        encryptedSha256: 'f'.repeat(64),
        artifactPath: '/srv/nexus-backups/application/hourly/private.sqlite.age',
      },
    });

    expect(text).toContain('encrypted backup age seconds: 61');
    expect(text).toContain('restore verification age seconds: 7201');
    expect(text).not.toContain('2026-08-11');
    expect(text).not.toContain('private.sqlite.age');
    expect(text).not.toContain('f'.repeat(64));
  });
});

describe('durable backup alert lifecycle', () => {
  it('persists three asynchronous attempts at 60s/120s before dead-letter', async () => {
    const fixture = makeAlertStoreFixture();
    const opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP,
      failureCode: 'local_backup_failed',
    });
    const attemptTimes: number[] = [];
    const notifier = {
      send: async () => {
        attemptTimes.push(fixture.clock.nowMs);
        return { delivered: false, reason: 'transport_failed' };
      },
    };

    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: opened.event,
      notifier,
    });
    let event = fixture.alertStore.readState().events[0];
    expect(event).toMatchObject({
      source: 'nexus-local-backup.service',
      severity: 'critical',
      runbookUrl: 'file:///opt/nexus-release/checkout/ops/local-backup/README.md',
      dedupeKey: 'local_backup:local_backup_failed',
      lifecycle: 'open',
      deliveryAttempts: 1,
    });
    expect(Date.parse(event.nextAttemptAt) - fixture.clock.nowMs)
      .toBe(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[0]);
    fixture.advance(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[0] - 1);
    expect(fixture.alertStore.dueEvents()).toHaveLength(0);
    fixture.advance(1);
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier,
    });
    event = fixture.alertStore.readState().events[0];
    expect(event.deliveryAttempts).toBe(2);
    expect(Date.parse(event.nextAttemptAt) - fixture.clock.nowMs)
      .toBe(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[1]);
    fixture.advance(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[1]);
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier,
    });
    event = fixture.alertStore.readState().events[0];
    expect(event).toMatchObject({ lifecycle: 'dead_letter', deliveryAttempts: 3 });
    expect(event.nextAttemptAt).toBeNull();
    expect(attemptTimes).toEqual([
      Date.parse('2026-08-11T09:07:00.000Z'),
      Date.parse('2026-08-11T09:08:00.000Z'),
      Date.parse('2026-08-11T09:10:00.000Z'),
    ]);
  });

  it('dedupes only delivered incidents and rearms after a durable success', async () => {
    const fixture = makeAlertStoreFixture();
    let sends = 0;
    const notifier = {
      send: async () => {
        sends += 1;
        return { delivered: true, reason: 'sent' };
      },
    };
    let opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.RESTORE_VERIFICATION,
      failureCode: 'restore_verification_failed',
    });
    await deliverDueReleaseBackupAlert({ store: fixture.alertStore, event: opened.event, notifier });
    opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.RESTORE_VERIFICATION,
      failureCode: 'restore_verification_failed',
    });
    expect(opened.deduped).toBe(true);
    expect(sends).toBe(1);

    fixture.alertStore.resolveSource(RELEASE_BACKUP_ALERT_SOURCES.RESTORE_VERIFICATION);
    expect(fixture.alertStore.readState().events[0].lifecycle).toBe('recovered');
    opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.RESTORE_VERIFICATION,
      failureCode: 'restore_verification_failed',
    });
    expect(opened).toMatchObject({ deduped: false, due: true });
    await deliverDueReleaseBackupAlert({ store: fixture.alertStore, event: opened.event, notifier });
    expect(sends).toBe(2);
  });

  it('preserves an undelivered incident through a later successful operation', async () => {
    const fixture = makeAlertStoreFixture();
    const opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP,
      failureCode: 'local_backup_failed',
    });
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: opened.event,
      notifier: { send: async () => ({ delivered: false, reason: 'transport_failed' }) },
    });
    fixture.alertStore.resolveSource(RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP);
    expect(fixture.alertStore.readState().events[0].lifecycle).toBe('open');
    fixture.advance(60_000);
    let sends = 0;
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier: {
        send: async () => {
          sends += 1;
          return { delivered: true, reason: 'sent' };
        },
      },
    });
    expect(sends).toBe(1);
    expect(fixture.alertStore.readState().events[0].lifecycle).toBe('recovered');
  });

  it('closes a recovered source after its third failed delivery and rearms it', async () => {
    const fixture = makeAlertStoreFixture();
    const failedNotifier = {
      send: async () => ({ delivered: false, reason: 'transport_failed' }),
    };
    let opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP,
      failureCode: 'local_backup_failed',
    });
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: opened.event,
      notifier: failedNotifier,
    });
    fixture.alertStore.resolveSource(RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP);
    fixture.advance(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[0]);
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier: failedNotifier,
    });
    fixture.advance(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[1]);
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier: failedNotifier,
    });
    expect(fixture.alertStore.readState().events[0]).toMatchObject({
      lifecycle: 'recovered',
      deliveryAttempts: 3,
      nextAttemptAt: null,
    });
    expect(fixture.alertStore.dueEvents()).toHaveLength(0);

    opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP,
      failureCode: 'local_backup_failed',
    });
    expect(opened).toMatchObject({ deduped: false, due: true });
    expect(opened.event).toMatchObject({ lifecycle: 'open', deliveryAttempts: 0 });
  });

  it('recovers a dead letter on health and rearms the same failure code', async () => {
    const fixture = makeAlertStoreFixture();
    const failedNotifier = {
      send: async () => ({ delivered: false, reason: 'transport_failed' }),
    };
    let opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS,
      failureCode: 'backup_evidence_invalid',
    });
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: opened.event,
      notifier: failedNotifier,
    });
    fixture.advance(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[0]);
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier: failedNotifier,
    });
    fixture.advance(RELEASE_BACKUP_ALERT_RETRY_DELAYS_MS[1]);
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: fixture.alertStore.dueEvents()[0],
      notifier: failedNotifier,
    });
    expect(fixture.alertStore.readState().events[0]).toMatchObject({
      lifecycle: 'dead_letter',
      deliveryAttempts: 3,
    });

    fixture.alertStore.resolveSource(RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS);
    expect(fixture.alertStore.readState().events[0]).toMatchObject({
      lifecycle: 'recovered',
      deliveryAttempts: 3,
    });
    expect(fixture.alertStore.dueEvents()).toHaveLength(0);

    opened = fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS,
      failureCode: 'backup_evidence_invalid',
    });
    expect(opened).toMatchObject({ deduped: false, due: true });
    expect(opened.event).toMatchObject({ lifecycle: 'open', deliveryAttempts: 0 });
    let sends = 0;
    await deliverDueReleaseBackupAlert({
      store: fixture.alertStore,
      event: opened.event,
      notifier: {
        send: async () => {
          sends += 1;
          return { delivered: true, reason: 'sent' };
        },
      },
    });
    expect(sends).toBe(1);
  });

  it('preserves distinct pending liveness failure codes', () => {
    const fixture = makeAlertStoreFixture();
    fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS,
      failureCode: 'backup_evidence_invalid',
    });
    fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS,
      failureCode: 'backup_receipt_stale',
    });
    expect(fixture.alertStore.readState().events).toEqual([
      expect.objectContaining({
        dedupeKey: 'backup_liveness:backup_evidence_invalid',
        lifecycle: 'open',
      }),
      expect.objectContaining({
        dedupeKey: 'backup_liveness:backup_receipt_stale',
        lifecycle: 'open',
      }),
    ]);
  });

  it('aligns completed full checks to the next wall-clock minute 20', () => {
    const fixture = makeAlertStoreFixture(Date.parse('2026-08-11T09:07:00.000Z'));
    expect(fixture.alertStore.markLivenessChecked()).toBe('2026-08-11T09:20:00.000Z');
    fixture.clock.nowMs = Date.parse('2026-08-11T09:21:00.000Z');
    expect(fixture.alertStore.markLivenessChecked()).toBe('2026-08-11T10:20:00.000Z');
  });

  it('drains minute retries while descriptor inspection remains gated', async () => {
    const fixture = makeAlertStoreFixture();
    let inspections = 0;
    const notifier = { send: async () => ({ delivered: true, reason: 'sent' }) };
    let result = await runReleaseBackupLivenessCheck({
      policy: {},
      notifier,
      alertStore: fixture.alertStore,
      inspectLiveness: () => {
        inspections += 1;
        return { backup: { ageSeconds: 1 }, restoreVerification: { ageSeconds: 1 } };
      },
    });
    expect(result).toMatchObject({ inspected: true, healthy: true, exitCode: 0 });
    expect(inspections).toBe(1);
    fixture.clock.nowMs = Date.parse('2026-08-11T09:19:59.999Z');
    result = await runReleaseBackupLivenessCheck({
      policy: {}, notifier, alertStore: fixture.alertStore,
      inspectLiveness: () => { inspections += 1; },
    });
    expect(result.inspected).toBe(false);
    expect(inspections).toBe(1);
    fixture.advance(1);
    result = await runReleaseBackupLivenessCheck({
      policy: {}, notifier, alertStore: fixture.alertStore,
      inspectLiveness: () => { inspections += 1; },
    });
    expect(result.inspected).toBe(true);
    expect(inspections).toBe(2);
  });

  it('forces an attended post-gate proof even when the hourly check is not due', async () => {
    const fixture = makeAlertStoreFixture();
    const notifier = { send: async () => ({ delivered: true, reason: 'sent' }) };
    fixture.alertStore.markLivenessChecked();
    let inspections = 0;
    const result = await runReleaseBackupLivenessCheck({
      policy: {},
      notifier,
      alertStore: fixture.alertStore,
      force: true,
      inspectLiveness: () => {
        inspections += 1;
        return { backup: { ageSeconds: 1 }, restoreVerification: { ageSeconds: 1 } };
      },
    });
    expect(result).toMatchObject({ inspected: true, healthy: true, exitCode: 0 });
    expect(inspections).toBe(1);
  });

  it.each([
    ['malformed JSON', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      writePrivate(fixture.stateFile, '{');
    }],
    ['unsafe mode', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      chmodSync(fixture.stateFile, 0o640);
    }],
    ['hard link', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      linkSync(fixture.stateFile, `${fixture.stateFile}.unexpected`);
    }],
    ['symlink', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      const target = `${fixture.stateFile}.target`;
      renameSync(fixture.stateFile, target);
      symlinkSync(target, fixture.stateFile);
    }],
    ['far-future liveness gate', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.nextLivenessCheckAt = '2026-08-11T12:00:00.000Z';
      });
    }],
    ['invalid retry timing', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.events[0].nextAttemptAt = '2026-08-11T11:00:00.000Z';
      });
    }],
    ['zero-attempt recovered latch', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.events[0].lifecycle = 'recovered';
        state.events[0].nextAttemptAt = null;
      });
    }],
    ['open event at the attempt cap', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.events[0].deliveryAttempts = 3;
      });
    }],
    ['impossible calendar timestamp', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.events[0].openedAt = '2026-02-31T09:07:00.000Z';
        state.events[0].updatedAt = '2026-02-31T09:07:00.000Z';
        state.events[0].nextAttemptAt = '2026-02-31T09:07:00.000Z';
      });
    }],
    ['event without source condition', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.conditions = [];
      });
    }],
    ['delivered latch under a healthy condition', (
      fixture: ReturnType<typeof makeAlertStoreFixture>,
    ) => {
      mutatePrivateJson(fixture.stateFile, (state) => {
        state.conditions[0].status = 'healthy';
        state.events[0].lifecycle = 'delivered';
        state.events[0].deliveryAttempts = 1;
        state.events[0].nextAttemptAt = null;
      });
    }],
  ])('fails closed for %s alert state', (_label, mutate) => {
    const fixture = makeAlertStoreFixture();
    fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP,
      failureCode: 'local_backup_failed',
    });
    mutate(fixture);
    expect(() => fixture.alertStore.readState()).toThrow(/alert state invalid/u);
  });

  it.each([
    ['unsafe directory mode', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      chmodSync(fixture.stateDirectory, 0o750);
    }],
    ['unsafe lock mode', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      chmodSync(fixture.lockFile, 0o640);
    }],
    ['hard-linked lock', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      linkSync(fixture.lockFile, `${fixture.lockFile}.unexpected`);
    }],
    ['symlinked lock', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      const target = `${fixture.lockFile}.target`;
      renameSync(fixture.lockFile, target);
      symlinkSync(target, fixture.lockFile);
    }],
    ['nonempty lock', (fixture: ReturnType<typeof makeAlertStoreFixture>) => {
      writePrivate(fixture.lockFile, 'not-a-lock-authority');
    }],
  ])('fails closed for %s', (_label, mutate) => {
    const fixture = makeAlertStoreFixture();
    mutate(fixture);
    expect(() => fixture.alertStore.readState()).toThrow(/alert state invalid/u);
  });

  it('uses the kernel lock to serialize competing Linux processes', async () => {
    if (process.platform !== 'linux' || !nodeFs.existsSync('/usr/bin/flock')) return;
    const fixture = makeAlertStoreFixture();
    const holder = spawn('/usr/bin/flock', [
      '--exclusive',
      fixture.lockFile,
      '/bin/sh',
      '-c',
      'printf ready; /bin/sleep 1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(holder.stdout, 'data');
    const contender = spawnSync('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      '75',
      fixture.lockFile,
      '/bin/true',
    ]);
    expect(contender.status).toBe(75);
    const [status] = await once(holder, 'exit');
    expect(status).toBe(0);
  });

  it('descriptor-binds lock parents, lock paths, and the exact inherited child fd', () => {
    const root = boundLockTemporaryRoot('nexus-bound-lock-runner-');
    const runner = join(repoRoot, 'scripts', 'release-bound-lock-runner.py');
    const execute = (body: string, ...args: string[]) => spawnSync('python3', [
      '-c',
      [
        'import importlib.util, os, pathlib, sys',
        'spec=importlib.util.spec_from_file_location("bound_runner", sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        body,
      ].join('\n'),
      runner,
      ...args,
    ], { encoding: 'utf8' });

    const safe = join(root, 'safe');
    mkdirSync(safe, { mode: 0o700 });
    const safeLock = join(safe, 'alert.lock');
    let result = execute([
      'path=pathlib.Path(sys.argv[2])',
      'real_open=module.os.open',
      'real_fsync=module.os.fsync',
      'opened={}',
      'events=[]',
      'def tracked_open(target,flags,mode=0o777):',
      '  descriptor=real_open(target,flags,mode)',
      '  opened[descriptor]=str(target)',
      '  return descriptor',
      'def tracked_fsync(descriptor):',
      '  events.append(opened[descriptor])',
      '  return real_fsync(descriptor)',
      'module.os.open=tracked_open',
      'module.os.fsync=tracked_fsync',
      'with module.bound_lock(path, create=True, expected_uid=os.getuid(), expected_gid=os.getgid()) as fd:',
      '  assert os.fstat(fd).st_size == 0',
      '  status=module.run_child([sys.executable,"-c","import os; os.fstat(int(os.environ[\\"BOUND_FD\\"]))"], lock_descriptor=fd, descriptor_environment="BOUND_FD")',
      'assert events[-3:] == [str(path),str(path.parent),str(path.parent.parent)], events',
      'raise SystemExit(status)',
    ].join('\n'), safeLock);
    expect(result.status, result.stderr).toBe(0);

    for (const [label, setup] of [
      ['symlink', [
        'target=path.with_name("target")',
        'target.write_bytes(b"")',
        'target.chmod(0o600)',
        'path.symlink_to(target)',
      ]],
      ['hardlink', [
        'path.write_bytes(b"")',
        'path.chmod(0o600)',
        'os.link(path, path.with_name("second-link"))',
      ]],
      ['wrong mode', [
        'path.write_bytes(b"")',
        'path.chmod(0o640)',
      ]],
      ['nonempty', [
        'path.write_bytes(b"not-empty")',
        'path.chmod(0o600)',
      ]],
    ] as const) {
      const directory = join(root, label.replace(' ', '-'));
      mkdirSync(directory, { mode: 0o700 });
      const lock = join(directory, 'alert.lock');
      result = execute([
        'path=pathlib.Path(sys.argv[2])',
        ...setup,
        'with module.bound_lock(path, create=False, expected_uid=os.getuid(), expected_gid=os.getgid()):',
        '  pass',
      ].join('\n'), lock);
      expect(result.status, `${label}: ${result.stderr}`).toBe(70);
    }

    const swapDirectory = join(root, 'swap');
    mkdirSync(swapDirectory, { mode: 0o700 });
    const swapLock = join(swapDirectory, 'alert.lock');
    writePrivate(swapLock, '');
    result = execute([
      'path=pathlib.Path(sys.argv[2])',
      'with module.bound_lock(path, create=False, expected_uid=os.getuid(), expected_gid=os.getgid()):',
      '  path.rename(path.with_name("parked"))',
      '  path.write_bytes(b"")',
      '  path.chmod(0o600)',
    ].join('\n'), swapLock);
    expect(result.status, result.stderr).toBe(70);

    const realParent = join(root, 'real-parent');
    const linkedParent = join(root, 'linked-parent');
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent, 'dir');
    result = execute([
      'path=pathlib.Path(sys.argv[2])',
      'with module.bound_lock(path, create=True, expected_uid=os.getuid(), expected_gid=os.getgid()):',
      '  pass',
    ].join('\n'), join(linkedParent, 'alert.lock'));
    expect(result.status, result.stderr).toBe(70);
  });

  it('rejects Linux-style sticky world-writable lock ancestors', () => {
    const root = governedTemporaryRoot('nexus-bound-lock-untrusted-');
    chmodSync(root, 0o1777);
    const safe = join(root, 'safe');
    mkdirSync(safe, { mode: 0o700 });
    const lock = join(safe, 'alert.lock');
    const runner = join(repoRoot, 'scripts', 'release-bound-lock-runner.py');
    const execution = spawnSync('python3', [
      '-c',
      [
        'import importlib.util,os,pathlib,sys',
        'spec=importlib.util.spec_from_file_location("bound_runner",sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'with module.bound_lock(pathlib.Path(sys.argv[2]),create=True,expected_uid=os.getuid(),expected_gid=os.getgid()):',
        '  pass',
      ].join('\n'),
      runner,
      lock,
    ], { encoding: 'utf8' });
    expect(execution.status, execution.stderr).toBe(70);
  });

  it('passes the exact bound lock descriptor through GNU timeout on Linux', () => {
    if (process.platform !== 'linux' || !nodeFs.existsSync('/usr/bin/timeout')) return;
    const root = boundLockTemporaryRoot('nexus-bound-lock-timeout-');
    const lock = join(root, 'alert.lock');
    const runner = join(repoRoot, 'scripts', 'release-bound-lock-runner.py');
    const execution = spawnSync('python3', [
      '-c',
      [
        'import importlib.util, os, pathlib, sys',
        'spec=importlib.util.spec_from_file_location("bound_runner", sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'path=pathlib.Path(sys.argv[2])',
        'with module.bound_lock(path, create=True, expected_uid=os.getuid(), expected_gid=os.getgid()) as fd:',
        '  status=module.run_child(["/usr/bin/timeout","5s",sys.executable,"-c","import os; os.fstat(int(os.environ[\\"BOUND_FD\\"]))"], lock_descriptor=fd, descriptor_environment="BOUND_FD")',
        '  raise SystemExit(status)',
      ].join('\n'),
      runner,
      lock,
    ], { encoding: 'utf8' });
    expect(execution.status, execution.stderr).toBe(0);
  });

  it('reopens the governed alert lock when concurrent writers race its first creation', async () => {
    const root = boundLockTemporaryRoot('nexus-bound-lock-create-race-');
    const lock = join(root, 'alert.lock');
    const barrier = join(root, 'creator-ready-');
    const runner = join(repoRoot, 'scripts', 'release-bound-lock-runner.py');
    const program = [
      'import glob, importlib.util, os, pathlib, sys, time',
      'spec=importlib.util.spec_from_file_location("bound_runner", sys.argv[1])',
      'module=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'real_open=module.os.open',
      'def synchronized_open(path, flags, mode=0o777):',
      '  if flags & os.O_EXCL:',
      '    pathlib.Path(sys.argv[3] + str(os.getpid())).write_text("ready")',
      '    deadline=time.monotonic()+5',
      '    while len(glob.glob(sys.argv[3] + "*")) < 2:',
      '      if time.monotonic() >= deadline: raise RuntimeError("barrier timeout")',
      '      time.sleep(0.01)',
      '  return real_open(path, flags, mode)',
      'module.os.open=synchronized_open',
      'with module.bound_lock(pathlib.Path(sys.argv[2]), create=True, expected_uid=os.getuid(), expected_gid=os.getgid()):',
      '  time.sleep(0.05)',
    ].join('\n');
    const children = [0, 1].map(() => spawn('python3', [
      '-c',
      program,
      runner,
      lock,
      barrier,
    ], { stdio: ['ignore', 'pipe', 'pipe'] }));
    const results = await Promise.all(children.map(async (child) => {
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const [status] = await once(child, 'exit');
      return { status, stderr };
    }));
    expect(results, JSON.stringify(results)).toEqual([
      { status: 0, stderr: '' },
      { status: 0, stderr: '' },
    ]);
    const metadata = nodeFs.statSync(lock);
    expect(metadata.size).toBe(0);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
  });

  it('coordinates the producer and liveness lock in both directions', async () => {
    const fixtureRoot = temporaryRoot('nexus-backup-coordination-');
    const root = join(fixtureRoot, 'backups');
    const lock = join(root, '.backup.lock');
    writePrivate(lock, '');
    const producerModule = join(repoRoot, 'scripts', 'local-backup.py');
    const importProducer = [
      'import importlib.util, os, pathlib, sys, time',
      'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"] = "1"',
      'os.environ["NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR"] = str(pathlib.Path(sys.argv[2]).parent)',
      'spec = importlib.util.spec_from_file_location("nexus_local_backup", sys.argv[1])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
    ].join('\n');
    const sharedHolder = spawn('python3', [
      '-c',
      [
        'import fcntl, pathlib, sys, time',
        'with pathlib.Path(sys.argv[1]).open("a+") as handle:',
        '  fcntl.flock(handle.fileno(), fcntl.LOCK_SH)',
        '  print("ready", flush=True)',
        '  time.sleep(0.5)',
      ].join('\n'),
      lock,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(sharedHolder.stdout, 'data');
    const startedAt = Date.now();
    const producerAfterLiveness = spawnSync('python3', [
      '-c',
      [
        importProducer,
        'with module.backup_lock(pathlib.Path(sys.argv[2])):',
        '  print("acquired")',
      ].join('\n'),
      producerModule,
      root,
    ], { encoding: 'utf8' });
    expect(producerAfterLiveness.status, producerAfterLiveness.stderr).toBe(0);
    expect(producerAfterLiveness.stdout).toContain('acquired');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    if (sharedHolder.exitCode === null) await once(sharedHolder, 'exit');

    const timeoutHolder = spawn('python3', [
      '-c',
      [
        'import fcntl, pathlib, sys, time',
        'with pathlib.Path(sys.argv[1]).open("a+") as handle:',
        '  fcntl.flock(handle.fileno(), fcntl.LOCK_SH)',
        '  print("ready", flush=True)',
        '  time.sleep(0.6)',
      ].join('\n'),
      lock,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(timeoutHolder.stdout, 'data');
    const timeoutStartedAt = Date.now();
    const boundedProducer = spawnSync('python3', [
      '-c',
      [
        importProducer,
        'module.BACKUP_LOCK_WAIT_SECONDS = 0.2',
        'module.BACKUP_LOCK_RETRY_SECONDS = 0.02',
        'with module.backup_lock(pathlib.Path(sys.argv[2])):',
        '  print("unexpected")',
      ].join('\n'),
      producerModule,
      root,
    ], { encoding: 'utf8' });
    expect(boundedProducer.status).toBe(1);
    expect(boundedProducer.stderr).toContain(
      'another backup or restore verification remained active',
    );
    expect(Date.now() - timeoutStartedAt).toBeGreaterThanOrEqual(175);
    expect(Date.now() - timeoutStartedAt).toBeLessThan(1_000);
    if (timeoutHolder.exitCode === null) await once(timeoutHolder, 'exit');

    const exclusiveProducer = spawn('python3', [
      '-c',
      [
        importProducer,
        'with module.backup_lock(pathlib.Path(sys.argv[2])):',
        '  print("ready", flush=True)',
        '  time.sleep(0.5)',
      ].join('\n'),
      producerModule,
      root,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(exclusiveProducer.stdout, 'data');
    const livenessWhileProducerRuns = spawnSync('python3', [
      '-c',
      [
        'import fcntl, pathlib, sys',
        'with pathlib.Path(sys.argv[1]).open("r") as handle:',
        '  try:',
        '    fcntl.flock(handle.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)',
        '  except BlockingIOError:',
        '    raise SystemExit(74)',
      ].join('\n'),
      lock,
    ]);
    expect(livenessWhileProducerRuns.status).toBe(74);
    if (exclusiveProducer.exitCode === null) await once(exclusiveProducer, 'exit');
  });

  it('coordinates the actual bound runner and producer in both directions on Linux', async () => {
    if (process.platform !== 'linux' || !nodeFs.existsSync('/usr/bin/timeout')) return;
    const fixtureRoot = governedTemporaryRoot('nexus-bound-runner-integration-');
    const root = join(fixtureRoot, 'backups');
    mkdirSync(root, { mode: 0o700 });
    const lock = join(root, '.backup.lock');
    writePrivate(lock, '');
    const ready = join(root, 'reader-ready');
    const heartbeat = join(root, 'heartbeat.py');
    writePrivate(heartbeat, [
      '#!/usr/bin/python3',
      'import pathlib,time',
      `pathlib.Path(${JSON.stringify(ready)}).write_text("ready")`,
      'print("ready",flush=True)',
      'time.sleep(0.5)',
    ].join('\n'));
    chmodSync(heartbeat, 0o700);
    const runner = join(root, 'release-bound-lock-runner.py');
    writePrivate(
      runner,
      readFileSync(join(repoRoot, 'scripts', 'release-bound-lock-runner.py'), 'utf8')
        .replace(
          'BACKUP_LOCK = Path("/srv/nexus-backups/application/.backup.lock")',
          `BACKUP_LOCK = Path(${JSON.stringify(lock)})`,
        )
        .replace(
          'HEARTBEAT = "/opt/nexus-release/checkout/scripts/release-heartbeat.mjs"',
          `HEARTBEAT = ${JSON.stringify(heartbeat)}`,
        )
        .replaceAll('"/usr/bin/node"', '"/usr/bin/python3"')
        .replaceAll(
          'expected_uid: int = 0',
          `expected_uid: int = ${process.getuid?.() ?? 0}`,
        )
        .replaceAll(
          'expected_gid: int = 0',
          `expected_gid: int = ${process.getgid?.() ?? 0}`,
        )
        .replaceAll('Path("/run/nexus-local-backup-active")', `Path(${JSON.stringify(join(root, 'backup-active'))})`)
        .replaceAll('Path("/run/nexus-local-backup-restore-verify-active")', `Path(${JSON.stringify(join(root, 'restore-active'))})`)
        .replaceAll('Path("/run/nexus-local-backup-pre-promotion-active")', `Path(${JSON.stringify(join(root, 'prepromotion-active'))})`),
    );
    chmodSync(runner, 0o700);
    const reader = spawn('python3', [runner, '--failure-only-inspect'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await once(reader.stdout, 'data');
    const producerModule = join(repoRoot, 'scripts', 'local-backup.py');
    const startedAt = Date.now();
    const producer = spawnSync('python3', [
      '-c',
      [
        'import importlib.util,os,pathlib,sys',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"]="1"',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR"]=str(pathlib.Path(sys.argv[2]).parent)',
        'spec=importlib.util.spec_from_file_location("local_backup",sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'with module.backup_lock(pathlib.Path(sys.argv[2])): print("acquired")',
      ].join('\n'),
      producerModule,
      root,
    ], { encoding: 'utf8' });
    expect(producer.status, producer.stderr).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
    if (reader.exitCode === null) await once(reader, 'exit');

    rmSync(ready, { force: true });
    const writer = spawn('python3', [
      '-c',
      [
        'import importlib.util,os,pathlib,sys,time',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_MODE"]="1"',
        'os.environ["NEXUS_LOCAL_BACKUP_TEST_TRUST_ANCHOR"]=str(pathlib.Path(sys.argv[2]).parent)',
        'spec=importlib.util.spec_from_file_location("local_backup",sys.argv[1])',
        'module=importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        'with module.backup_lock(pathlib.Path(sys.argv[2])):',
        '  print("ready",flush=True)',
        '  time.sleep(0.5)',
      ].join('\n'),
      producerModule,
      root,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await once(writer.stdout, 'data');
    const blockedReader = spawnSync('python3', [runner, '--failure-only-inspect'], {
      encoding: 'utf8',
    });
    expect(blockedReader.status, blockedReader.stderr).toBe(74);
    expect(nodeFs.existsSync(ready)).toBe(false);
    if (writer.exitCode === null) await once(writer, 'exit');
  });

  it('keeps CLI phase arguments closed', () => {
    expect(parseReleaseHeartbeatArgv([])).toBe('weekly');
    expect(parseReleaseHeartbeatArgv(['--failure-only-prepare']))
      .toBe('failure_only_prepare');
    expect(parseReleaseHeartbeatArgv(['--failure-only-force-prepare']))
      .toBe('failure_only_force_prepare');
    expect(parseReleaseHeartbeatArgv(['--failure-only-inspect']))
      .toBe('failure_only_inspect');
    expect(parseReleaseHeartbeatArgv(['--failure-only-commit=healthy']))
      .toBe('failure_only_commit:healthy');
    expect(parseReleaseHeartbeatArgv(['--failure-only'])).toBeNull();
    expect(parseReleaseHeartbeatArgv(['--failure-only-commit=unknown'])).toBeNull();
  });

  it('executes prepare, inspect, and commit as separate bounded phases', async () => {
    const fixture = makeAlertStoreFixture();
    const notifier = { send: async () => ({ delivered: true, reason: 'sent' }) };
    const prepared = await prepareReleaseBackupLivenessCheck({
      notifier,
      alertStore: fixture.alertStore,
    });
    expect(prepared.due).toBe(true);
    const inspection = inspectReleaseBackupLiveness({
      policy: {},
      inspectLiveness: () => {
        throw new BackupLivenessError('backup_receipt_stale', 'untrusted');
      },
    });
    expect(inspection).toMatchObject({ verdict: 'backup_receipt_stale', exitCode: 23 });
    const committed = await commitReleaseBackupLivenessCheck({
      verdict: inspection.verdict,
      notifier,
      alertStore: fixture.alertStore,
    });
    expect(committed).toMatchObject({
      healthy: false,
      delivered: true,
      failureCode: 'backup_receipt_stale',
      exitCode: 1,
    });
  });

  it('maps an unknown inspection error code to the closed evidence verdict', () => {
    const result = inspectReleaseBackupLiveness({
      policy: {},
      inspectLiveness: () => {
        throw new BackupLivenessError('unknown_future_code', 'untrusted');
      },
    });
    expect(result).toMatchObject({
      verdict: 'backup_evidence_invalid',
      failureCode: 'backup_evidence_invalid',
      exitCode: 22,
    });
  });

  it('drains retries and commits a policy-invalid verdict when policy loading fails', async () => {
    const fixture = makeAlertStoreFixture();
    fixture.alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.LOCAL_BACKUP,
      failureCode: 'local_backup_failed',
    });
    let sends = 0;
    const createNotifier = () => ({
      send: async () => {
        sends += 1;
        return { delivered: true, reason: 'sent' };
      },
    });
    const common = {
      loadPolicy: () => { throw new Error('corrupt governed policy'); },
      createNotifier,
      createAlertStore: () => fixture.alertStore,
    };
    const prepared = await runReleaseHeartbeatCli({
      ...common,
      argv: ['--failure-only-prepare'],
    });
    expect(prepared).toMatchObject({ due: true, drained: 1, exitCode: 10 });
    expect(sends).toBe(1);

    const inspected = await runReleaseHeartbeatCli({
      ...common,
      argv: ['--failure-only-inspect'],
    });
    expect(inspected).toMatchObject({
      verdict: 'backup_policy_invalid',
      failureCode: 'backup_policy_invalid',
      exitCode: 21,
    });

    const committed = await runReleaseHeartbeatCli({
      ...common,
      argv: ['--failure-only-commit=backup_policy_invalid'],
    });
    expect(committed).toMatchObject({
      healthy: false,
      delivered: true,
      failureCode: 'backup_policy_invalid',
      exitCode: 1,
    });
    expect(fixture.alertStore.readState().events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        dedupeKey: 'backup_liveness:backup_policy_invalid',
        lifecycle: 'delivered',
      }),
    ]));
  });
});

describe('immediate systemd operational alerts', () => {
  it('does nothing when systemd reports success', async () => {
    let sends = 0;
    const fixture = makeAlertStoreFixture();
    const result = await runOperationalAlert({
      unit: 'nexus-local-backup.service',
      env: {
        SERVICE_RESULT: 'success',
      },
      policy: {},
      alertStore: fixture.alertStore,
      notifier: {
        send: async () => {
          sends += 1;
          throw new Error('success must not notify');
        },
      },
    });

    expect(result).toMatchObject({ alerted: false, reason: 'service_succeeded', exitCode: 0 });
    expect(sends).toBe(0);
  });

  it('does not open, resolve, or send for governed restartable lock contention', async () => {
    const calls: string[] = [];
    const result = await runOperationalAlert({
      unit: 'nexus-local-backup.service',
      env: {
        SERVICE_RESULT: 'exit-code',
        EXIT_CODE: 'exited',
        EXIT_STATUS: '75',
      },
      alertStore: {
        openFailure: () => { calls.push('open'); },
        resolveSource: () => { calls.push('resolve'); },
      },
      notifier: { send: async () => { calls.push('send'); } },
    });
    expect(result).toMatchObject({
      alerted: false,
      reason: 'lock_retry_pending',
      exitCode: 0,
    });
    expect(calls).toEqual([]);
  });

  it('persists and sends a unit failure even when policy loading fails', async () => {
    const fixture = makeAlertStoreFixture();
    let sends = 0;
    const result = await runOperationalAlertCli({
      argv: ['--unit=nexus-local-backup.service'],
      env: { SERVICE_RESULT: 'exit-code' },
      loadPolicy: () => { throw new Error('corrupt governed policy'); },
      createAlertStore: () => fixture.alertStore,
      notifier: {
        send: async () => {
          sends += 1;
          return { delivered: true, reason: 'sent' };
        },
      },
    });
    expect(result).toMatchObject({ alerted: true, delivered: true, exitCode: 0 });
    expect(sends).toBe(1);
    expect(fixture.alertStore.readState().events[0]).toMatchObject({
      dedupeKey: 'local_backup:local_backup_failed',
      lifecycle: 'delivered',
      deliveryAttempts: 1,
    });
  });

  it.each([
    [
      'nexus-local-backup.service',
      'local_backup',
      'local_backup_failed',
      'inspect_local_backup_unit',
    ],
    [
      'nexus-local-backup-restore-verify.service',
      'restore_verification',
      'restore_verification_failed',
      'inspect_restore_verification_unit',
    ],
  ])('sends one closed alert for %s failure', async (
    unit,
    phase,
    failureCode,
    actionRequired,
  ) => {
    const calls: JsonObject[] = [];
    const fixture = makeAlertStoreFixture();
    const result = await runOperationalAlert({
      unit,
      env: {
        NEXUS_RELEASE_OPERATION_UNIT: 'nexus-release-poller.service',
        SERVICE_RESULT: 'exit-code',
        UNTRUSTED_JOURNAL_TEXT: 'credential-shaped raw failure',
      },
      policy: {},
      alertStore: fixture.alertStore,
      notifier: {
        send: async (message: JsonObject) => {
          calls.push(message);
          return { delivered: true, reason: 'sent' };
        },
      },
    });

    expect(result).toMatchObject({ alerted: true, delivered: true, unit, exitCode: 0 });
    expect(calls).toEqual([{
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: {
        releaseId: null,
        sourceSha: null,
        phase,
        outcome: 'systemd_unit_failed',
        failureCode,
        rollbackResult: 'not_applicable',
        actionRequired,
        alertSource: unit,
        alertSeverity: 'critical',
        alertRunbookUrl: 'file:///opt/nexus-release/checkout/ops/local-backup/README.md',
        alertDedupeKey: `${phase}:${failureCode}`,
      },
    }]);
    expect(JSON.stringify(calls)).not.toContain('credential-shaped');
    expect(JSON.stringify(calls)).not.toContain('exit-code');
  });

  it('accepts only one exact governed unit argument', () => {
    expect(parseOperationalAlertArgv(['--unit=nexus-local-backup.service']))
      .toBe('nexus-local-backup.service');
    expect(parseOperationalAlertArgv([
      '--unit=nexus-local-backup-restore-verify.service',
    ])).toBe('nexus-local-backup-restore-verify.service');
    expect(parseOperationalAlertArgv([])).toBeNull();
    expect(parseOperationalAlertArgv(['--unit=nexus-local-backup.service', '--extra']))
      .toBeNull();
    expect(parseOperationalAlertArgv(['--unit=nexus-release-poller.service'])).toBeNull();
  });

  it('never reads a Telegram provider response body', async () => {
    let responseBodyRead = false;
    let requestBody: JsonObject | null = null;
    const response = { ok: true } as Record<string, unknown>;
    Object.defineProperty(response, 'body', {
      get() {
        responseBodyRead = true;
        throw new Error('provider response body must stay unread');
      },
    });
    const notifier = createReleaseNotifier({
      policy: {
        notifications: {
          failureEnabled: true,
          recoveryEnabled: true,
          heartbeatEnabled: true,
          maxMessageChars: 900,
        },
      },
      env: {
        NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
      },
      fetchImpl: async (_url: unknown, init: JsonObject) => {
        requestBody = JSON.parse(String(init.body));
        return response;
      },
    });

    const result = await notifier.send({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: {
        releaseId: null,
        sourceSha: null,
        phase: 'local_backup',
        outcome: 'systemd_unit_failed',
        failureCode: 'local_backup_failed',
        rollbackResult: 'not_applicable',
        actionRequired: 'inspect_local_backup_unit',
        alertSource: 'nexus-local-backup.service',
        alertSeverity: 'critical',
        alertRunbookUrl: 'file:///opt/nexus-release/checkout/ops/local-backup/README.md',
        alertDedupeKey: 'local_backup:local_backup_failed',
      },
    });

    expect(result.delivered).toBe(true);
    expect(responseBodyRead).toBe(false);
    expect(requestBody?.text).toContain('phase: local_backup');
    expect(requestBody?.text).toContain('outcome: systemd_unit_failed');
    expect(requestBody?.text).toContain('reason: local_backup_failed');
    expect(requestBody?.text).toContain('action: inspect_local_backup_unit');
    expect(requestBody?.text).toContain('source: nexus-local-backup.service');
    expect(requestBody?.text).toContain('severity: critical');
    expect(requestBody?.text).toContain('dedupe: local_backup:local_backup_failed');
    expect(requestBody?.text).toContain(
      'runbook: file:///opt/nexus-release/checkout/ops/local-backup/README.md',
    );
    expect(requestBody?.text).not.toContain('[redacted]');
    expect(requestBody?.text).not.toContain('fixture-bot-token');
  });
});

describe('systemd environment isolation', () => {
  it.each([
    'nexus-local-backup.service',
    'nexus-local-backup-restore-verify.service',
  ])('scrubs Python and forwards only the alert allowlist in %s', (unit) => {
    const service = readFileSync(join(repoRoot, 'ops', 'local-backup', 'systemd', unit), 'utf8');
    const execStart = service.split('\n').find((line) => line.startsWith('ExecStart='));
    const execStopPost = service.split('\n').find((line) => line.startsWith('ExecStopPost='));

    expect(service).toContain('EnvironmentFile=-/etc/nexus-release/poller.env');
    expect(service).toContain(
      'UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE '
      + 'BASH_ENV ENV SHELLOPTS BASHOPTS PS4 NODE_OPTIONS NODE_PATH '
      + 'NEXUS_RELEASE_AUDIT_MIRROR_HOST',
    );
    expect(service).not.toContain('Environment=NEXUS_RELEASE_OPERATION_UNIT=');
    expect(service).toContain(
      `RuntimeDirectory=${unit === 'nexus-local-backup.service'
        ? 'nexus-local-backup-active'
        : 'nexus-local-backup-restore-verify-active'}`,
    );
    expect(service).toContain('RuntimeDirectoryMode=0700');
    expect(service).toContain('RuntimeDirectoryPreserve=restart');
    expect(service).toContain('StartLimitIntervalSec=0');
    expect(service).toContain('Restart=no');
    expect(service).toContain('RestartForceExitStatus=75');
    expect(service).toContain('RestartSec=1min');
    expect(service).not.toContain('SuccessExitStatus=75');
    expect(service).not.toContain('ExecStartPre=/usr/bin/systemctl stop');
    expect(execStart).toMatch(/^ExecStart=\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin /);
    expect(execStart).toContain('/usr/local/libexec/nexus-local-backup/local-backup.py');
    expect(execStart).not.toContain('TELEGRAM');
    expect(execStopPost).toBe(
      'ExecStopPost=/opt/nexus-release/checkout/scripts/'
      + `release-operational-alert-launcher.sh --unit=${unit}`,
    );
    expect(execStopPost).not.toContain('TELEGRAM');
    expect(execStopPost).not.toContain('SERVICE_RESULT');
    expect(execStopPost).not.toContain('/usr/bin/env');
    expect(execStopPost).not.toContain('/usr/bin/node');
    expect(execStopPost).not.toContain('NEXUS_RELEASE_AUDIT_MIRROR_HOST');
    expect(execStopPost).not.toContain('local-backup.py');
    expect(service).not.toMatch(/ExecStopPost=.*NEXUS_RELEASE_TELEGRAM/u);
  });

  it('executes the launcher with only its fixed runtime and notification allowlist', () => {
    const root = temporaryRoot('nexus-alert-launcher-');
    const launcherSource = readFileSync(
      join(repoRoot, 'scripts', 'release-operational-alert-launcher.sh'),
      'utf8',
    );
    const launcher = join(root, 'release-operational-alert-launcher.sh');
    const fakeNode = join(root, 'node');
    const fakeHelper = join(root, 'fake-runner.mjs');
    const observed = join(root, 'observed.json');
    const bashEnvironment = join(root, 'untrusted-bash-environment.sh');
    const bashEnvironmentMarker = join(root, 'bash-environment-ran');
    symlinkSync(process.execPath, fakeNode);
    writePrivate(
      bashEnvironment,
      `/usr/bin/touch ${JSON.stringify(bashEnvironmentMarker)}\n`,
    );
    writePrivate(fakeHelper, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({`,
      '  env: process.env,',
      '  argv: process.argv.slice(2),',
      '}));',
      '',
    ].join('\n'));
    writePrivate(
      launcher,
      launcherSource
        .replace('/usr/bin/python3', fakeNode)
        .replace('/opt/nexus-release/checkout/scripts/release-bound-lock-runner.py', fakeHelper),
    );
    chmodSync(launcher, 0o700);

    const execution = spawnSync(launcher, ['--unit=nexus-local-backup.service'], {
      env: {
        PATH: '/untrusted/bin',
        HOME: '/untrusted/home',
        SERVICE_RESULT: 'exit-code',
        NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
        NEXUS_RELEASE_OPERATION_UNIT: 'nexus-release-poller.service',
        NEXUS_RELEASE_AUDIT_MIRROR_HOST: 'audit.invalid',
        NODE_DEBUG: 'http',
        NODE_OPTIONS: '--require=/definitely/missing/injected-module.cjs',
        BASH_ENV: bashEnvironment,
        ARBITRARY_SENTINEL: 'must-not-reach-node',
      },
      encoding: 'utf8',
    });

    expect(execution.status, execution.stderr).toBe(0);
    const result = JSON.parse(readFileSync(observed, 'utf8')) as JsonObject;
    expect(result.argv).toEqual(['--operational=nexus-local-backup.service']);
    expect(result.env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/var/lib/nexus-release',
      SERVICE_RESULT: 'exit-code',
      NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
      NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
      NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD: '1',
    });
    expect(result.env.NEXUS_RELEASE_OPERATION_UNIT).toBeUndefined();
    expect(result.env.NEXUS_RELEASE_AUDIT_MIRROR_HOST).toBeUndefined();
    expect(result.env.NODE_DEBUG).toBeUndefined();
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.env.ARBITRARY_SENTINEL).toBeUndefined();
    expect(nodeFs.existsSync(bashEnvironmentMarker)).toBe(false);
  });

  it('short-circuits exact exit75 contention before the alert-lock runner starts', () => {
    const root = temporaryRoot('nexus-alert-retry-short-circuit-');
    const launcher = join(root, 'release-operational-alert-launcher.sh');
    const marker = join(root, 'runner-started');
    const fakeRunner = join(root, 'fake-runner');
    writePrivate(fakeRunner, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(marker)}\nexit 99\n`);
    chmodSync(fakeRunner, 0o700);
    writePrivate(
      launcher,
      readFileSync(
        join(repoRoot, 'scripts', 'release-operational-alert-launcher.sh'),
        'utf8',
      )
        .replace('/usr/bin/python3', fakeRunner)
        .replace('/opt/nexus-release/checkout/scripts/release-bound-lock-runner.py', 'unused'),
    );
    chmodSync(launcher, 0o700);
    const result = spawnSync(launcher, ['--unit=nexus-local-backup.service'], {
      env: {
        SERVICE_RESULT: 'exit-code',
        EXIT_CODE: 'exited',
        EXIT_STATUS: '75',
        NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
      },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(nodeFs.existsSync(marker)).toBe(false);
  });

  it('keeps liveness inspection outside the lock and notification environment', () => {
    const root = temporaryRoot('nexus-liveness-launcher-');
    const launcherSource = readFileSync(
      join(repoRoot, 'scripts', 'release-backup-liveness-launcher.sh'),
      'utf8',
    );
    const launcher = join(root, 'release-backup-liveness-launcher.sh');
    const fakeNode = join(root, 'node');
    const fakeHeartbeat = join(root, 'fake-runner.mjs');
    const observed = join(root, 'observed.jsonl');
    symlinkSync(process.execPath, fakeNode);
    writePrivate(fakeHeartbeat, [
      "import fs from 'node:fs';",
      'const mode = process.argv[2];',
      `fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({`,
      '  mode,',
      '  env: process.env,',
      "}) + '\\n');",
      "if (mode === '--alert-prepare') process.exit(10);",
      "if (mode === '--failure-only-inspect') process.exit(20);",
      "if (mode === '--alert-commit=healthy') process.exit(0);",
      'process.exit(64);',
      '',
    ].join('\n'));
    writePrivate(
      launcher,
      launcherSource
        .replaceAll('/usr/bin/python3', fakeNode)
        .replaceAll('/opt/nexus-release/checkout/scripts/release-bound-lock-runner.py', fakeHeartbeat),
    );
    chmodSync(launcher, 0o700);

    const execution = spawnSync(launcher, ['--failure-only'], {
      env: {
        PATH: '/untrusted/bin',
        HOME: '/untrusted/home',
        NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
        NEXUS_RELEASE_AUDIT_MIRROR_HOST: 'audit.invalid',
        NODE_DEBUG: 'http',
        NODE_OPTIONS: '--require=/definitely/missing/injected-module.cjs',
        ARBITRARY_SENTINEL: 'must-not-reach-node',
      },
      encoding: 'utf8',
    });

    expect(execution.status, execution.stderr).toBe(0);
    const records = readFileSync(observed, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as JsonObject);
    expect(records.map((record) => record.mode)).toEqual([
      '--alert-prepare',
      '--failure-only-inspect',
      '--alert-commit=healthy',
    ]);
    for (const record of [records[0], records[2]]) {
      expect(record.env).toMatchObject({
        PATH: '/usr/bin:/bin',
        HOME: '/var/lib/nexus-release/home',
        NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
        NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD: '1',
      });
    }
    expect(records[1].env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/var/lib/nexus-release/home',
    });
    for (const key of [
      'NEXUS_RELEASE_TELEGRAM_BOT_TOKEN',
      'NEXUS_RELEASE_TELEGRAM_CHAT_ID',
      'NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD',
    ]) {
      expect(records[1].env[key]).toBeUndefined();
    }
    for (const record of records) {
      expect(record.env.NEXUS_RELEASE_AUDIT_MIRROR_HOST).toBeUndefined();
      expect(record.env.NODE_DEBUG).toBeUndefined();
      expect(record.env.NODE_OPTIONS).toBeUndefined();
      expect(record.env.ARBITRARY_SENTINEL).toBeUndefined();
    }
  });

  it('serializes catch-up readers behind bounded producer intent', () => {
    const liveness = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-backup-liveness.service'),
      'utf8',
    );
    const launcher = readFileSync(
      join(repoRoot, 'scripts', 'release-backup-liveness-launcher.sh'),
      'utf8',
    );
    const runner = readFileSync(
      join(repoRoot, 'scripts', 'release-bound-lock-runner.py'),
      'utf8',
    );
    const heartbeat = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-heartbeat.service'),
      'utf8',
    );
    for (const [unit, marker, execStart, timeout] of [
      [
        'nexus-local-backup.service',
        'nexus-local-backup-active',
        'ExecStart=/usr/bin/env -i',
        'TimeoutStartSec=18min',
      ],
      [
        'nexus-local-backup-restore-verify.service',
        'nexus-local-backup-restore-verify-active',
        'ExecStart=/usr/bin/env -i',
        'TimeoutStartSec=36min',
      ],
      [
        'nexus-local-backup-pre-promotion.service',
        'nexus-local-backup-pre-promotion-active',
        'ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin '
          + '/usr/local/libexec/nexus-local-backup/local-backup.py',
        'TimeoutStartSec=18min',
      ],
    ]) {
      const producer = readFileSync(
        join(repoRoot, 'ops', 'local-backup', 'systemd', unit),
        'utf8',
      );
      expect(producer).toContain(`RuntimeDirectory=${marker}`);
      expect(producer).toContain('RuntimeDirectoryMode=0700');
      expect(producer).not.toContain('ExecStartPre=/usr/bin/systemctl stop');
      expect(producer).toContain(execStart);
      expect(producer).toContain(timeout);
      expect(liveness).not.toContain(`/run/${marker}`);
      expect(heartbeat).not.toContain(`/run/${marker}`);
      expect(runner).toContain(`Path("/run/${marker}")`);
    }
    expect(liveness).toContain('TimeoutStopSec=15s');
    expect(heartbeat).toContain('TimeoutStopSec=15s');
    expect(heartbeat).toContain('TimeoutStartSec=100min');
    expect(heartbeat).not.toContain('Restart=');
    expect(liveness).not.toContain('/usr/bin/systemctl stop');
    expect(heartbeat).not.toContain('/usr/bin/systemctl stop');
    expect(runner).toContain('BACKUP_LOCK = Path("/srv/nexus-backups/application/.backup.lock")');
    expect(runner).toContain('WEEKLY_PRODUCER_DEADLINE_SECONDS = 5400.0');
    expect(runner).toContain('fcntl.LOCK_SH');
    expect(runner).toContain('pass_fds=(lock_descriptor,)');
    expect(runner).toContain('"--kill-after=15s"');
    expect(runner).toContain('"5m"');
    expect(liveness).toContain('TimeoutStartSec=11min');
    const producerSource = readFileSync(join(repoRoot, 'scripts', 'local-backup.py'), 'utf8');
    expect(producerSource).toContain('BACKUP_LOCK_WAIT_SECONDS = 330.0');
    expect(producerSource).toContain('deadline = time.monotonic() + BACKUP_LOCK_WAIT_SECONDS');
  });

  it('runner-side marker rechecks defer evidence hashing without consuming the minute retry', () => {
    const root = temporaryRoot('nexus-liveness-producer-marker-');
    const marker = join(root, 'pre-promotion-active');
    mkdirSync(marker, { mode: 0o700 });
    const runner = join(root, 'release-bound-lock-runner.py');
    const runnerSource = readFileSync(
      join(repoRoot, 'scripts', 'release-bound-lock-runner.py'),
      'utf8',
    );
    writePrivate(
      runner,
      runnerSource
        .replaceAll('/run/nexus-local-backup-active', join(root, 'backup-active'))
        .replaceAll(
          '/run/nexus-local-backup-restore-verify-active',
          join(root, 'restore-active'),
        )
        .replaceAll('/run/nexus-local-backup-pre-promotion-active', marker),
    );
    chmodSync(runner, 0o700);
    const execution = spawnSync('python3', [runner, '--failure-only-inspect'], {
      encoding: 'utf8',
    });
    expect(execution.status, execution.stderr).toBe(74);
  });

  it('refuses an attended forced proof when producer contention defers inspection', () => {
    const root = temporaryRoot('nexus-liveness-force-contention-');
    const launcher = join(root, 'release-backup-liveness-launcher.sh');
    const fakeNode = join(root, 'node');
    const fakeRunner = join(root, 'fake-runner.mjs');
    symlinkSync(process.execPath, fakeNode);
    writePrivate(fakeRunner, [
      "const mode = process.argv[2];",
      "if (mode === '--alert-force-prepare') process.exit(10);",
      "if (mode === '--failure-only-inspect') process.exit(74);",
      'process.exit(64);',
      '',
    ].join('\n'));
    const source = readFileSync(
      join(repoRoot, 'scripts', 'release-backup-liveness-launcher.sh'),
      'utf8',
    );
    writePrivate(
      launcher,
      source
        .replaceAll('/usr/bin/python3', fakeNode)
        .replaceAll('/opt/nexus-release/checkout/scripts/release-bound-lock-runner.py', fakeRunner),
    );
    chmodSync(launcher, 0o700);
    const result = spawnSync(launcher, ['--failure-only-force'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(74);
  });

  it('executes the weekly heartbeat without credentials in argv or inherited exports', () => {
    const root = temporaryRoot('nexus-weekly-heartbeat-launcher-');
    const launcherSource = readFileSync(
      join(repoRoot, 'scripts', 'release-backup-liveness-launcher.sh'),
      'utf8',
    );
    const launcher = join(root, 'release-backup-liveness-launcher.sh');
    const fakeNode = join(root, 'node');
    const fakeHeartbeat = join(root, 'fake-runner.mjs');
    const observed = join(root, 'observed.json');
    symlinkSync(process.execPath, fakeNode);
    writePrivate(fakeHeartbeat, [
      "import fs from 'node:fs';",
      `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({`,
      '  env: process.env,',
      '  argv: process.argv.slice(2),',
      '}));',
      '',
    ].join('\n'));
    writePrivate(
      launcher,
      launcherSource
        .replaceAll('/usr/bin/python3', fakeNode)
        .replaceAll('/opt/nexus-release/checkout/scripts/release-bound-lock-runner.py', fakeHeartbeat),
    );
    chmodSync(launcher, 0o700);

    const execution = spawnSync(launcher, ['--weekly'], {
      env: {
        PATH: '/untrusted/bin',
        HOME: '/untrusted/home',
        NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
        NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
        NEXUS_RELEASE_AUDIT_MIRROR_HOST: 'audit.invalid',
        NODE_OPTIONS: '--require=/definitely/missing/injected-module.cjs',
        ARBITRARY_SENTINEL: 'must-not-reach-node',
      },
      encoding: 'utf8',
    });

    expect(execution.status, execution.stderr).toBe(0);
    const result = JSON.parse(readFileSync(observed, 'utf8')) as JsonObject;
    expect(result.argv).toEqual(['--weekly']);
    expect(result.env).toMatchObject({
      PATH: '/usr/bin:/bin',
      HOME: '/var/lib/nexus-release/home',
      NEXUS_RELEASE_TELEGRAM_BOT_TOKEN: 'fixture-bot-token',
      NEXUS_RELEASE_TELEGRAM_CHAT_ID: '12345',
    });
    expect(result.env.NEXUS_RELEASE_BACKUP_ALERT_LOCK_HELD).toBeUndefined();
    expect(result.env.NEXUS_RELEASE_AUDIT_MIRROR_HOST).toBeUndefined();
    expect(result.env.NODE_OPTIONS).toBeUndefined();
    expect(result.env.ARBITRARY_SENTINEL).toBeUndefined();
    expect(JSON.stringify(result.argv)).not.toContain('fixture-bot-token');
  });

  it('governs the minute retry timer and hourly evidence checker', () => {
    const service = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-backup-liveness.service'),
      'utf8',
    );
    const timer = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-backup-liveness.timer'),
      'utf8',
    );
    const forceService = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-backup-liveness-force.service'),
      'utf8',
    );
    expect(service).toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-transaction.json',
    );
    expect(service).toContain(
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json',
    );
    expect(service).toContain(
      'ConditionPathExists=!/var/lib/nexus-release/state/pm2-fallback-retirement.json',
    );
    expect(service).toContain(
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/pm2-fallback-retirement.json',
    );
    expect(service).toContain(
      'ExecStart=/opt/nexus-release/checkout/scripts/'
      + 'release-backup-liveness-launcher.sh --failure-only',
    );
    expect(service).toContain('StateDirectory=nexus-release/operational-alerts');
    expect(service).toContain('StateDirectoryMode=0700');
    expect(service).toContain(
      'ReadOnlyPaths=/opt/nexus-release /var/lib/nexus-release/state '
      + '/etc/nexus-local-backup -/srv/nexus-backups/application',
    );
    expect(service).toContain(
      'ReadWritePaths=/var/lib/nexus-release/operational-alerts',
    );
    expect(service).not.toMatch(/ExecStart=.*TELEGRAM/u);
    expect(timer).toContain('OnCalendar=*-*-* *:*:20');
    expect(timer).toContain('AccuracySec=1s');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('Unit=nexus-release-backup-liveness.service');
    expect(forceService).toContain(
      'ExecStart=/opt/nexus-release/checkout/scripts/'
      + 'release-backup-liveness-launcher.sh --failure-only-force',
    );
    expect(forceService).toContain('TimeoutStartSec=11min');
    expect(forceService).not.toContain('[Install]');

    const descriptor = JSON.parse(readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'release-control-plane-inputs.json'),
      'utf8',
    )) as JsonObject;
    expect(descriptor.staticFiles).toEqual(expect.arrayContaining([
      'ops/nexus-release/nexus-release-backup-liveness.service',
      'ops/nexus-release/nexus-release-backup-liveness-force.service',
      'ops/nexus-release/nexus-release-backup-liveness.timer',
      'scripts/release-backup-liveness-launcher.sh',
      'scripts/release-bound-lock-runner.py',
    ]));
  });

  it('governs the launcher as an immutable control-plane input', () => {
    const descriptor = JSON.parse(readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'release-control-plane-inputs.json'),
      'utf8',
    )) as JsonObject;

    expect(descriptor.staticFiles).toContain(
      'scripts/release-operational-alert-launcher.sh',
    );
    expect(descriptor.staticFiles).toContain('scripts/release-bound-lock-runner.py');
  });

  it('mounts backup evidence read-only for the weekly heartbeat', () => {
    const service = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-heartbeat.service'),
      'utf8',
    );
    expect(service).toContain(
      'ReadOnlyPaths=/opt/nexus-release /var/lib/nexus-release '
      + '/etc/nexus-local-backup -/srv/nexus-backups/application',
    );
    expect(service).toContain(
      'ExecStart=/opt/nexus-release/checkout/scripts/'
      + 'release-backup-liveness-launcher.sh --weekly',
    );
    expect(service).toContain('TimeoutStartSec=100min');
    expect(service).toContain(
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json',
    );
    expect(service).not.toContain('Restart=');
    expect(service).not.toMatch(/ExecStart=.*TELEGRAM/u);
    expect(service).not.toMatch(/ExecStart=.*\$\{/u);
    expect(service).not.toContain('ReadWritePaths=');
    const timer = readFileSync(
      join(repoRoot, 'ops', 'nexus-release', 'nexus-release-heartbeat.timer'),
      'utf8',
    );
    expect(timer).toContain('OnCalendar=Mon 09:30');
  });
});
