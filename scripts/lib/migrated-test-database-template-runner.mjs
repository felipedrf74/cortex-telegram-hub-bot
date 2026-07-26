import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sha256Pattern = /^[a-f0-9]{64}$/;
const maximumDatabaseBytes = 128 * 1024 * 1024;
const maximumReceiptBytes = 256 * 1024;

function removeTemplateDirectory(outputDirectory) {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
}

function registerTemplateLifecycle(outputDirectory, spawnProcess = spawn) {
  let cleaned = false;
  let terminationSignal = null;
  let terminationTimer = null;
  const activeChildren = new Set();
  const remove = () => {
    if (cleaned) return;
    cleaned = true;
    removeTemplateDirectory(outputDirectory);
  };
  const onExit = () => remove();
  const exitCodeForSignal = (signal) => ({
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
  })[signal] ?? 1;
  const signalChild = (child, signal) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  const detach = () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
  const finishTermination = () => {
    if (!terminationSignal) return;
    if (terminationTimer) clearTimeout(terminationTimer);
    remove();
    detach();
    process.exit(exitCodeForSignal(terminationSignal));
  };
  const terminateWithSignal = (signal) => {
    if (terminationSignal) return;
    terminationSignal = signal;
    for (const child of activeChildren) signalChild(child, signal);
    if (activeChildren.size === 0) {
      finishTermination();
      return;
    }
    terminationTimer = setTimeout(() => {
      for (const child of activeChildren) signalChild(child, 'SIGKILL');
      finishTermination();
    }, 5_000);
  };
  const onSighup = () => terminateWithSignal('SIGHUP');
  const onSigint = () => terminateWithSignal('SIGINT');
  const onSigterm = () => terminateWithSignal('SIGTERM');
  const spawnChild = (command, args, options = {}) => {
    if (terminationSignal) {
      throw new Error('Cannot start a test child while template cleanup is terminating');
    }
    const child = spawnProcess(command, args, {
      ...options,
      detached: options.detached ?? process.platform !== 'win32',
    });
    activeChildren.add(child);
    child.once('close', () => {
      activeChildren.delete(child);
      if (terminationSignal && activeChildren.size === 0) finishTermination();
    });
    child.once('error', () => {
      if (child.pid === undefined) {
        activeChildren.delete(child);
        if (terminationSignal && activeChildren.size === 0) finishTermination();
      }
    });
    return child;
  };

  process.once('exit', onExit);
  process.once('SIGHUP', onSighup);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return {
    cleanup: () => {
      if (activeChildren.size > 0) {
        throw new Error('Cannot remove migrated test database template while test children are active');
      }
      detach();
      remove();
    },
    spawnChild,
  };
}

function readPrivateRegularFile(filePath, maximumBytes, label) {
  const before = fs.lstatSync(filePath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600
    || before.size <= 0
    || before.size > maximumBytes
    || (typeof process.getuid === 'function' && before.uid !== process.getuid())
  ) {
    throw new Error(`${label} is not a private regular file`);
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      throw new Error(`${label} changed while it was opened`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyBuilderFiles(result, databasePath, receiptPath) {
  const databaseBytes = readPrivateRegularFile(
    databasePath,
    maximumDatabaseBytes,
    'Migrated test database template',
  );
  if (createHash('sha256').update(databaseBytes).digest('hex') !== result.databaseSha256) {
    throw new Error('Migrated test database template digest differs from builder output');
  }

  const receiptBytes = readPrivateRegularFile(
    receiptPath,
    maximumReceiptBytes,
    'Migrated test database template receipt',
  );
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new Error('Migrated test database template builder wrote a malformed receipt');
  }
  if (
    !receipt
    || typeof receipt !== 'object'
    || receipt.schema !== 'nexus.migrated-test-database-template.v1'
    || receipt.database?.sha256 !== result.databaseSha256
    || receipt.database?.sizeBytes !== databaseBytes.length
    || receipt.migrationIdentity?.sha256 !== result.migrationSha256
    || receipt.migrationIdentity?.count !== result.migrationCount
  ) {
    throw new Error('Migrated test database template receipt differs from builder output');
  }
}

/**
 * Build one full-schema SQLite image for an existing Vitest launch. This
 * module intentionally imports Node built-ins only; the TypeScript loader is
 * started lazily in the child that builds the image, never in planner/probe
 * startup.
 */
export function prepareMigratedDatabaseTemplate(
  repositoryRoot,
  {
    executeBuilder = spawnSync,
    spawnProcess = spawn,
    temporaryRoot = os.tmpdir(),
  } = {},
) {
  const root = path.resolve(repositoryRoot);
  const outputDirectory = fs.mkdtempSync(
    path.join(path.resolve(temporaryRoot), 'nexus-migrated-test-database-'),
  );
  fs.chmodSync(outputDirectory, 0o700);
  const lifecycle = registerTemplateLifecycle(outputDirectory, spawnProcess);
  try {
    const generated = executeBuilder(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(root, 'scripts/build-migrated-test-database-template.ts'),
        outputDirectory,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'test' },
      },
    );
    if (generated.status !== 0) {
      if (generated.stdout) process.stderr.write(String(generated.stdout));
      if (generated.stderr) process.stderr.write(String(generated.stderr));
      throw new Error('Failed to build the migrated test database template');
    }

    let result;
    try {
      result = JSON.parse(String(generated.stdout).trim());
    } catch {
      throw new Error('Migrated test database template builder returned malformed JSON');
    }
    const expectedDatabasePath = path.join(outputDirectory, 'template.sqlite');
    const expectedReceiptPath = path.join(outputDirectory, 'template-receipt.json');
    if (
      !result
      || typeof result !== 'object'
      || path.resolve(String(result.databasePath ?? '')) !== expectedDatabasePath
      || path.resolve(String(result.receiptPath ?? '')) !== expectedReceiptPath
      || !sha256Pattern.test(String(result.databaseSha256 ?? ''))
      || !sha256Pattern.test(String(result.migrationSha256 ?? ''))
      || !Number.isSafeInteger(result.migrationCount)
      || result.migrationCount < 1
    ) {
      throw new Error('Migrated test database template builder returned an invalid receipt');
    }
    verifyBuilderFiles(result, expectedDatabasePath, expectedReceiptPath);

    return {
      cleanup: lifecycle.cleanup,
      env: {
        NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH: expectedDatabasePath,
        NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_RECEIPT_PATH: expectedReceiptPath,
        NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_SHA256: result.databaseSha256,
        NEXUS_MIGRATED_TEST_DATABASE_MIGRATION_SHA256: result.migrationSha256,
      },
      spawnChild: lifecycle.spawnChild,
    };
  } catch (error) {
    lifecycle.cleanup();
    throw error;
  }
}
