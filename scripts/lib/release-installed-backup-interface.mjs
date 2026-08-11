import fs from 'node:fs';
import path from 'node:path';

import { fail } from './release-canonical.mjs';
import { defaultExec } from './release-registry.mjs';

export const RELEASE_INSTALLED_BACKUP_FILES = Object.freeze([
  Object.freeze({
    source: 'scripts/local-backup.py',
    destination: '/usr/local/libexec/nexus-local-backup/local-backup.py',
    sourceMode: 0o555,
    destinationMode: 0o755,
  }),
  ...[
    'nexus-local-backup.service',
    'nexus-local-backup.timer',
    'nexus-local-backup-pre-promotion.service',
    'nexus-local-backup-restore-verify.service',
    'nexus-local-backup-restore-verify.timer',
  ].map((unit) => Object.freeze({
    source: `ops/local-backup/systemd/${unit}`,
    destination: `/etc/systemd/system/${unit}`,
    sourceMode: 0o444,
    destinationMode: 0o644,
  })),
  Object.freeze({
    source: 'ops/local-backup/nexus-local-backup.sudoers',
    destination: '/etc/sudoers.d/nexus-local-backup',
    sourceMode: 0o444,
    destinationMode: 0o440,
  }),
]);

export const RELEASE_INSTALLED_BACKUP_UNITS = Object.freeze([
  'nexus-local-backup.service',
  'nexus-local-backup.timer',
  'nexus-local-backup-pre-promotion.service',
  'nexus-local-backup-restore-verify.service',
  'nexus-local-backup-restore-verify.timer',
]);

const MAX_INTERFACE_FILE_BYTES = 4 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

function sameIdentity(left, right) {
  return String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && String(left.size) === String(right.size)
    && String(left.nlink) === String(right.nlink)
    && String(left.mtimeMs) === String(right.mtimeMs)
    && String(left.ctimeMs) === String(right.ctimeMs);
}

function assertFileMetadata(stat, {
  label,
  expectedUid,
  expectedGid,
  expectedMode,
}) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || stat.uid !== expectedUid || stat.gid !== expectedGid
      || (stat.mode & 0o777) !== expectedMode
      || stat.size <= 0 || stat.size > MAX_INTERFACE_FILE_BYTES) {
    fail(`${label} metadata does not match the installed backup authority contract`);
  }
}

function captureTrustedAncestorChain(file, {
  fileSystem,
  expectedUid,
  expectedGid,
  trustRoot,
  label,
}) {
  const normalizedRoot = path.resolve(trustRoot);
  const parent = path.dirname(path.resolve(file));
  const relative = path.relative(normalizedRoot, parent);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} leaves its trusted destination root`);
  }
  const components = relative === '' ? [] : relative.split(path.sep);
  const chain = [];
  let current = normalizedRoot;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    let stat;
    try {
      stat = fileSystem.lstatSync(current);
    } catch {
      return fail(`${label} destination ancestor is unreadable: ${current}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || stat.uid !== expectedUid || stat.gid !== expectedGid
        || (stat.mode & 0o022) !== 0) {
      fail(`${label} destination ancestor is unsafe: ${current}`);
    }
    chain.push({
      path: current,
      dev: String(stat.dev),
      ino: String(stat.ino),
      uid: stat.uid,
      gid: stat.gid,
      mode: stat.mode & 0o777,
    });
  }
  return chain;
}

function assertSameAncestorChain(before, after, label) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    fail(`${label} destination ancestor identity changed during verification`);
  }
}

function readBoundFile(file, options, fileSystem) {
  let descriptor;
  const ancestorBefore = options.ancestorRoot
    ? captureTrustedAncestorChain(file, {
      fileSystem,
      expectedUid: options.expectedUid,
      expectedGid: options.expectedGid,
      trustRoot: options.ancestorRoot,
      label: options.label,
    })
    : null;
  try {
    descriptor = fileSystem.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_CLOEXEC | fs.constants.O_NOFOLLOW,
    );
    const opened = fileSystem.fstatSync(descriptor);
    const before = fileSystem.lstatSync(file);
    assertFileMetadata(opened, options);
    assertFileMetadata(before, options);
    if (!sameIdentity(opened, before)) {
      fail(`${options.label} pathname does not name the opened file`);
    }
    const bytes = fileSystem.readFileSync(descriptor);
    const afterDescriptor = fileSystem.fstatSync(descriptor);
    const afterPath = fileSystem.lstatSync(file);
    assertFileMetadata(afterDescriptor, options);
    assertFileMetadata(afterPath, options);
    if (!sameSnapshot(opened, afterDescriptor) || !sameSnapshot(opened, afterPath)) {
      fail(`${options.label} changed during verification`);
    }
    let ancestorAfter = null;
    if (ancestorBefore) {
      ancestorAfter = captureTrustedAncestorChain(file, {
        fileSystem,
        expectedUid: options.expectedUid,
        expectedGid: options.expectedGid,
        trustRoot: options.ancestorRoot,
        label: options.label,
      });
      assertSameAncestorChain(ancestorBefore, ancestorAfter, options.label);
    }
    return { bytes, snapshot: afterPath, ancestors: ancestorAfter };
  } catch (error) {
    if (error instanceof Error
        && error.message.includes('installed backup authority contract')) {
      throw error;
    }
    if (error instanceof Error
        && (error.message.includes('pathname does not name')
          || error.message.includes('changed during verification')
          || error.message.includes('destination ancestor'))) {
      throw error;
    }
    return fail(`${options.label} could not be read without following links`);
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        // A completed descriptor-bound comparison does not depend on close.
      }
    }
  }
}

function commandValue({ exec, command, args, label }) {
  const result = exec(command, args, { timeoutMs: COMMAND_TIMEOUT_MS });
  if (!result || result.status !== 0 || typeof result.stdout !== 'string'
      || result.stdout.length > 4096 || result.stdout.includes('\0')) {
    fail(`${label} could not be proved`);
  }
  const value = result.stdout.trim();
  if (value.includes('\n') || value.includes('\r')) {
    fail(`${label} returned an ambiguous value`);
  }
  return value;
}

/**
 * Prove that the live root authority used for encrypted backups is the exact
 * interface signed into this immutable controller checkout. The comparison is
 * read-only and is run both before candidate discovery and immediately before
 * the backup unit may start.
 */
export function verifyInstalledReleaseBackupInterface({
  root = process.cwd(),
  exec = defaultExec,
  fileSystem = fs,
  files = RELEASE_INSTALLED_BACKUP_FILES,
  units = RELEASE_INSTALLED_BACKUP_UNITS,
  expectedUid = 0,
  expectedGid = 0,
  destinationAncestorRoot = '/',
  systemctlBin = '/usr/bin/systemctl',
  visudoBin = '/usr/sbin/visudo',
} = {}) {
  const normalizedRoot = path.resolve(root);
  const installedBindings = [];
  for (const mapping of files) {
    const source = path.join(normalizedRoot, ...mapping.source.split('/'));
    const sourceRead = readBoundFile(source, {
      label: `governed backup source ${mapping.source}`,
      expectedUid,
      expectedGid,
      expectedMode: mapping.sourceMode,
    }, fileSystem);
    const installedRead = readBoundFile(mapping.destination, {
      label: `installed backup authority ${mapping.destination}`,
      expectedUid,
      expectedGid,
      expectedMode: mapping.destinationMode,
      ancestorRoot: destinationAncestorRoot,
    }, fileSystem);
    if (!sourceRead.bytes.equals(installedRead.bytes)) {
      fail(`installed backup authority differs from governed source: ${mapping.destination}`);
    }
    installedBindings.push({
      mapping,
      ancestors: installedRead.ancestors,
      file: installedRead.snapshot,
    });
  }

  const assertInstalledBindingsUnchanged = () => {
    for (const binding of installedBindings) {
      const label = `installed backup authority ${binding.mapping.destination}`;
      assertSameAncestorChain(binding.ancestors, captureTrustedAncestorChain(
        binding.mapping.destination,
        {
          fileSystem,
          expectedUid,
          expectedGid,
          trustRoot: destinationAncestorRoot,
          label,
        },
      ), label);
      const current = fileSystem.lstatSync(binding.mapping.destination);
      assertFileMetadata(current, {
        label,
        expectedUid,
        expectedGid,
        expectedMode: binding.mapping.destinationMode,
      });
      if (!sameSnapshot(binding.file, current)) {
        fail(`${label} changed while its effective systemd authority was proved`);
      }
    }
  };

  const sudoersPath = files.find((entry) => entry.source.endsWith('.sudoers'))
    ?.destination;
  if (!sudoersPath) fail('installed backup sudoers mapping is missing');
  assertInstalledBindingsUnchanged();
  const visudo = exec(visudoBin, ['-cf', sudoersPath], { timeoutMs: COMMAND_TIMEOUT_MS });
  if (!visudo || visudo.status !== 0) {
    fail('installed backup sudoers policy is invalid');
  }
  assertInstalledBindingsUnchanged();

  for (const unit of units) {
    const expectedFragment = `/etc/systemd/system/${unit}`;
    const property = (name) => {
      assertInstalledBindingsUnchanged();
      const value = commandValue({
        exec,
        command: systemctlBin,
        args: ['show', unit, `--property=${name}`, '--value'],
        label: `${unit} ${name}`,
      });
      assertInstalledBindingsUnchanged();
      return value;
    };
    if (property('LoadState') !== 'loaded'
        || property('FragmentPath') !== expectedFragment
        || property('DropInPaths') !== ''
        || property('NeedDaemonReload') !== 'no') {
      fail(`${unit} effective definition differs from installed backup authority`);
    }
  }
  assertInstalledBindingsUnchanged();

  return {
    schema: 'nexus.release-installed-backup-interface.v1',
    passed: true,
    fileCount: files.length,
    unitCount: units.length,
  };
}
