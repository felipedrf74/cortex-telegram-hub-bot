// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import {
  buildMigratedTestDatabaseTemplate,
  type BuiltMigratedTestDatabaseTemplate,
} from '../../src/testing/migrated-test-database-template';
import { prepareMigratedDatabaseTemplate } from '../../scripts/lib/migrated-test-database-template-runner.mjs';

const templateEnvironmentKeys = [
  'NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH',
  'NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_RECEIPT_PATH',
  'NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_SHA256',
  'NEXUS_MIGRATED_TEST_DATABASE_MIGRATION_SHA256',
] as const;

const originalTemplateEnvironment = Object.fromEntries(
  templateEnvironmentKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof templateEnvironmentKeys)[number], string | undefined>;

let fixtureRoot: string;
let baseTemplate: BuiltMigratedTestDatabaseTemplate;

function restoreTemplateEnvironment(): void {
  for (const key of templateEnvironmentKeys) {
    const original = originalTemplateEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

function useTemplate(
  template: BuiltMigratedTestDatabaseTemplate,
  overrides: Partial<Record<(typeof templateEnvironmentKeys)[number], string>> = {},
): void {
  process.env.NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH = template.databasePath;
  process.env.NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_RECEIPT_PATH = template.receiptPath;
  process.env.NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_SHA256 = template.databaseSha256;
  process.env.NEXUS_MIGRATED_TEST_DATABASE_MIGRATION_SHA256 = template.migrationSha256;
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

function copyBaseTemplate(label: string): BuiltMigratedTestDatabaseTemplate {
  const directory = fs.mkdtempSync(path.join(fixtureRoot, `${label}-`));
  fs.chmodSync(directory, 0o700);
  const databasePath = path.join(directory, 'template.sqlite');
  const receiptPath = path.join(directory, 'template-receipt.json');
  fs.copyFileSync(baseTemplate.databasePath, databasePath);
  fs.copyFileSync(baseTemplate.receiptPath, receiptPath);
  fs.chmodSync(databasePath, 0o600);
  fs.chmodSync(receiptPath, 0o600);
  return { ...baseTemplate, databasePath, receiptPath };
}

function orderedMigrationDigest(
  files: Array<{ filename: string; sha256: string; sizeBytes: number }>,
): string {
  const digest = createHash('sha256');
  digest.update('sha256-ordered-migration-records-v1\0');
  for (const file of files) {
    digest.update(`${Buffer.byteLength(file.filename, 'utf8')}:`);
    digest.update(file.filename, 'utf8');
    digest.update(`:${file.sizeBytes}:${file.sha256}\n`);
  }
  return digest.digest('hex');
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-template-tests-'));
  fs.chmodSync(fixtureRoot, 0o700);
  const baseDirectory = fs.mkdtempSync(path.join(fixtureRoot, 'base-'));
  fs.chmodSync(baseDirectory, 0o700);
  baseTemplate = buildMigratedTestDatabaseTemplate(baseDirectory);
});

afterEach(() => {
  restoreTemplateEnvironment();
});

afterAll(() => {
  restoreTemplateEnvironment();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('migrated test database templates', () => {
  it('returns isolated in-memory copies of one digest-bound full template', () => {
    useTemplate(baseTemplate);
    const first = createMigratedTestDatabase();
    first.exec('CREATE TABLE test_only_mutation (id INTEGER PRIMARY KEY)');
    first.close();

    const second = createMigratedTestDatabase();
    try {
      expect(second.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_only_mutation'",
      ).get()).toBeUndefined();
    } finally {
      second.close();
    }
  });

  it('normalizes exclusion order into one isolated schema-template key', () => {
    process.env.NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH = '/invalid/template.sqlite';
    const first = createMigratedTestDatabase({
      excludeFiles: [
        '231_training_m4_capacity_snapshots.sql',
        '230_training_adaptation_proposals_v1.sql',
      ],
    });
    first.exec('CREATE TABLE excluded_template_mutation (id INTEGER PRIMARY KEY)');
    first.close();

    const second = createMigratedTestDatabase({
      excludeFiles: [
        '230_training_adaptation_proposals_v1.sql',
        '231_training_m4_capacity_snapshots.sql',
      ],
    });
    try {
      expect(second.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'excluded_template_mutation'",
      ).get()).toBeUndefined();
      expect(second.prepare(
        "SELECT filename FROM _migrations WHERE filename IN (?, ?)",
      ).all(
        '230_training_adaptation_proposals_v1.sql',
        '231_training_m4_capacity_snapshots.sql',
      )).toEqual([]);
    } finally {
      second.close();
    }
  });

  it('keeps stop-before and fully migrated templates separate', () => {
    useTemplate(baseTemplate);
    const beforeCapacity = createMigratedTestDatabase({
      stopBefore: '231_training_m4_capacity_snapshots.sql',
    });
    const fullyMigrated = createMigratedTestDatabase();
    try {
      expect(beforeCapacity.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_m4_capacity_snapshots'",
      ).get()).toBeUndefined();
      expect(fullyMigrated.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_m4_capacity_snapshots'",
      ).get()).toBeDefined();
    } finally {
      beforeCapacity.close();
      fullyMigrated.close();
    }
  });

  it('fails closed when the full-template environment is incomplete', () => {
    for (const key of templateEnvironmentKeys) delete process.env[key];
    process.env.NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH = baseTemplate.databasePath;
    expect(() => createMigratedTestDatabase()).toThrow(/environment is incomplete/);
  });

  it('rejects stale migration identity and tampered database bytes', () => {
    const stale = copyBaseTemplate('stale');
    useTemplate(stale, {
      NEXUS_MIGRATED_TEST_DATABASE_MIGRATION_SHA256: '0'.repeat(64),
    });
    expect(() => createMigratedTestDatabase()).toThrow(/stale ordered migration digest/);

    const tampered = copyBaseTemplate('tampered');
    const bytes = fs.readFileSync(tampered.databasePath);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(tampered.databasePath, bytes, { mode: 0o600 });
    fs.chmodSync(tampered.databasePath, 0o600);
    useTemplate(tampered);
    expect(() => createMigratedTestDatabase()).toThrow(/bytes do not match/);
  });

  it('rejects an internally consistent receipt from a stale migration tree', () => {
    const stale = copyBaseTemplate('coherent-stale');
    const receipt = JSON.parse(fs.readFileSync(stale.receiptPath, 'utf8')) as {
      migrationIdentity: {
        count: number;
        files: Array<{ filename: string; sha256: string; sizeBytes: number }>;
        sha256: string;
      };
    };
    receipt.migrationIdentity.files = receipt.migrationIdentity.files.slice(0, -1);
    receipt.migrationIdentity.count = receipt.migrationIdentity.files.length;
    receipt.migrationIdentity.sha256 = orderedMigrationDigest(receipt.migrationIdentity.files);
    fs.writeFileSync(stale.receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    fs.chmodSync(stale.receiptPath, 0o600);
    useTemplate({
      ...stale,
      migrationCount: receipt.migrationIdentity.count,
      migrationSha256: receipt.migrationIdentity.sha256,
    });

    expect(() => createMigratedTestDatabase()).toThrow(/current migration tree/);
  });

  it('rejects symlinked and overly broad template permissions', () => {
    const symlinkDirectory = fs.mkdtempSync(path.join(fixtureRoot, 'symlink-'));
    fs.chmodSync(symlinkDirectory, 0o700);
    const symlinkReceipt = path.join(symlinkDirectory, 'template-receipt.json');
    fs.copyFileSync(baseTemplate.receiptPath, symlinkReceipt);
    fs.chmodSync(symlinkReceipt, 0o600);
    const symlinkDatabase = path.join(symlinkDirectory, 'template.sqlite');
    fs.symlinkSync(baseTemplate.databasePath, symlinkDatabase);
    useTemplate({
      ...baseTemplate,
      databasePath: symlinkDatabase,
      receiptPath: symlinkReceipt,
    });
    expect(() => createMigratedTestDatabase()).toThrow(/regular file, not a symlink/);

    const broad = copyBaseTemplate('broad-permissions');
    fs.chmodSync(broad.databasePath, 0o644);
    useTemplate(broad);
    expect(() => createMigratedTestDatabase()).toThrow(/permissions must be 0600/);
  });

  it('rejects malformed receipts and malformed SQLite even when its digest matches', () => {
    const malformedReceipt = copyBaseTemplate('malformed-receipt');
    fs.writeFileSync(malformedReceipt.receiptPath, '{', { mode: 0o600 });
    fs.chmodSync(malformedReceipt.receiptPath, 0o600);
    useTemplate(malformedReceipt);
    expect(() => createMigratedTestDatabase()).toThrow(/receipt is malformed JSON/);

    const malformedDatabase = copyBaseTemplate('malformed-database');
    const malformedBytes = Buffer.from('not a SQLite database', 'utf8');
    const malformedSha256 = createHash('sha256').update(malformedBytes).digest('hex');
    const receipt = JSON.parse(
      fs.readFileSync(malformedDatabase.receiptPath, 'utf8'),
    ) as {
      database: { sha256: string; sizeBytes: number };
    };
    receipt.database.sha256 = malformedSha256;
    receipt.database.sizeBytes = malformedBytes.length;
    fs.writeFileSync(malformedDatabase.databasePath, malformedBytes, { mode: 0o600 });
    fs.writeFileSync(
      malformedDatabase.receiptPath,
      `${JSON.stringify(receipt)}\n`,
      { mode: 0o600 },
    );
    fs.chmodSync(malformedDatabase.databasePath, 0o600);
    fs.chmodSync(malformedDatabase.receiptPath, 0o600);
    useTemplate({
      ...malformedDatabase,
      databaseSha256: malformedSha256,
    });
    expect(() => createMigratedTestDatabase()).toThrow(/malformed or tampered/);
  });

  it('removes private builder output after builder failure or malformed output', () => {
    const builderTemporaryRoot = fs.mkdtempSync(path.join(fixtureRoot, 'builder-errors-'));
    fs.chmodSync(builderTemporaryRoot, 0o700);
    const repositoryRoot = path.resolve(__dirname, '../..');
    const remainingTemplates = () => fs.readdirSync(builderTemporaryRoot)
      .filter((entry) => entry.startsWith('nexus-migrated-test-database-'));

    expect(() => prepareMigratedDatabaseTemplate(repositoryRoot, {
      temporaryRoot: builderTemporaryRoot,
      executeBuilder: () => ({ status: 1, stdout: '', stderr: '' }),
    })).toThrow(/Failed to build/);
    expect(remainingTemplates()).toEqual([]);

    expect(() => prepareMigratedDatabaseTemplate(repositoryRoot, {
      temporaryRoot: builderTemporaryRoot,
      executeBuilder: () => ({ status: 0, stdout: '{', stderr: '' }),
    })).toThrow(/malformed JSON/);
    expect(remainingTemplates()).toEqual([]);

    expect(() => prepareMigratedDatabaseTemplate(repositoryRoot, {
      temporaryRoot: builderTemporaryRoot,
      executeBuilder: (_command, builderArgs) => {
        const outputDirectory = String(builderArgs.at(-1));
        return {
          status: 0,
          stderr: '',
          stdout: JSON.stringify({
            databasePath: path.join(outputDirectory, 'template.sqlite'),
            receiptPath: path.join(outputDirectory, 'template-receipt.json'),
            databaseSha256: '0'.repeat(64),
            migrationSha256: '1'.repeat(64),
            migrationCount: 1,
          }),
        };
      },
    })).toThrow();
    expect(remainingTemplates()).toEqual([]);
  });

  it('removes the private template when its runner receives SIGTERM', async () => {
    const probeTemporaryDirectory = fs.mkdtempSync(path.join(fixtureRoot, 'signal-probe-'));
    fs.chmodSync(probeTemporaryDirectory, 0o700);
    const repositoryRoot = path.resolve(__dirname, '../..');
    const runnerUrl = pathToFileURL(path.join(
      repositoryRoot,
      'scripts/lib/migrated-test-database-template-runner.mjs',
    )).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          "const { prepareMigratedDatabaseTemplate } = await import(process.env.RUNNER_URL);",
          'const template = prepareMigratedDatabaseTemplate(process.cwd(), { temporaryRoot: process.env.PROBE_ROOT });',
          "const child = template.spawnChild(process.execPath, ['--eval', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' });",
          "child.once('spawn', () => process.stdout.write(`ready:${child.pid}\\n`));",
          'setInterval(() => {}, 1_000);',
        ].join('\n'),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          PROBE_ROOT: probeTemporaryDirectory,
          RUNNER_URL: runnerUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    try {
      const childPid = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`template signal probe did not become ready: ${stderr}`)),
          20_000,
        );
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code, signal) => {
          clearTimeout(timeout);
          reject(new Error(
            `template signal probe exited before ready (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
          ));
        });
        child.stdout.setEncoding('utf8');
        let stdout = '';
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk);
          const match = stdout.match(/ready:([1-9][0-9]*)/);
          if (match) {
            clearTimeout(timeout);
            resolve(Number(match[1]));
          }
        });
      });
      expect(
        fs.readdirSync(probeTemporaryDirectory)
          .filter((entry) => entry.startsWith('nexus-migrated-test-database-')),
      ).toHaveLength(1);

      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      child.kill('SIGTERM');
      const termination = await exited;
      expect(termination.code).toBe(143);
      expect(termination.signal).toBeNull();
      expect(() => process.kill(childPid, 0)).toThrow();
      expect(
        fs.readdirSync(probeTemporaryDirectory)
          .filter((entry) => entry.startsWith('nexus-migrated-test-database-')),
      ).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it(
    'lets the tier runner override ambient template values and clean up after test failure',
    { timeout: 35_000 },
    () => {
      if (process.env.NEXUS_MIGRATED_TEMPLATE_RUNNER_FAILURE_PROBE === '1') {
        throw new Error('intentional migrated-template runner failure probe');
      }

      const probeTemporaryDirectory = fs.mkdtempSync(path.join(fixtureRoot, 'runner-probe-'));
      fs.chmodSync(probeTemporaryDirectory, 0o700);
      const child = spawnSync(
        process.execPath,
        [
          'scripts/run-test-tier.mjs',
          'deterministic',
          '__tests__/testing/migrated-test-database.test.ts',
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            TMPDIR: `${probeTemporaryDirectory}${path.sep}`,
            NEXUS_MIGRATED_TEMPLATE_RUNNER_FAILURE_PROBE: '1',
            NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH: '/ambient/template.sqlite',
            NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_RECEIPT_PATH: '/ambient/template-receipt.json',
            NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_SHA256: '0'.repeat(64),
            NEXUS_MIGRATED_TEST_DATABASE_MIGRATION_SHA256: '1'.repeat(64),
          },
          timeout: 30_000,
        },
      );

      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(`${child.stdout}${child.stderr}`).toContain(
        'intentional migrated-template runner failure probe',
      );
      expect(
        fs.readdirSync(probeTemporaryDirectory)
          .filter((entry) => entry.startsWith('nexus-migrated-test-database-')),
      ).toEqual([]);
    },
  );
});
