#!/usr/bin/env node
// One-time v2 normalization bridge. Modern runtimes always use the strict
// network-independent verifier. A legacy installed-tree identity is accepted
// only for the exact predecessor of one separately owner-authorized,
// root-accepted, nonterminal v2 normalization transaction.
//
// This source is deliberately not connected to an operator, signer, sudoers,
// service, or release command. Installation is a separate root transaction.
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() || '';
const has = (name) => args.includes(name);
const value = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const TEST_MODE = process.env.NEXUS_V2_NORMALIZATION_TEST_MODE === '1';
if (TEST_MODE
    && ((typeof process.geteuid === 'function' && process.geteuid() === 0)
      || process.getuid() === 0)) {
  process.stderr.write(
    'trusted_release_runtime_attestation_v2_bridge_failed:'
      + 'test mode may not cross a privileged uid boundary\n',
  );
  process.exit(77);
}
const EXPECTED_V2_CONTROL_SHA256 = TEST_MODE
  ? process.env.NEXUS_V2_NORMALIZATION_EXPECTED_CONTROL_SHA256
    || 'fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1'
  : 'fb66d9257ec0b7b6f2c582d326c5ed3f6c01071f5792a4045c42199b6691edf1';
const EXPECTED_REPLACED_ATTESTOR_SHA256 = TEST_MODE
  ? process.env.NEXUS_V2_NORMALIZATION_EXPECTED_REPLACED_ATTESTOR_SHA256
    || 'c337fb11211b0db1f18a19e31d7f6383a62b2842994725b3c2b2f24c8c5df96d'
  : 'c337fb11211b0db1f18a19e31d7f6383a62b2842994725b3c2b2f24c8c5df96d';
const STATE_ROOT = TEST_MODE
  ? path.resolve(process.env.NEXUS_V2_NORMALIZATION_STATE_ROOT || '.')
  : '/var/lib/nexus-release-promotion';
const BRIDGE_STATE = path.join(STATE_ROOT, 'v2-normalization-attestor-bridge');
const RECEIPT = path.join(BRIDGE_STATE, 'receipt.v1.json');
const PRODUCTION_AUTHORIZATION = path.join(
  BRIDGE_STATE,
  'production-authorization.envelope.json',
);
const ACCEPTANCE = path.join(BRIDGE_STATE, 'acceptance.v1.json');
const NORMALIZATION_JOURNAL = path.join(
  BRIDGE_STATE,
  'normalization-journal.v1.json',
);
const MAINTENANCE_MARKER = path.join(
  BRIDGE_STATE,
  'maintenance.v1.json',
);
const CONTROL_BIN = TEST_MODE
  ? path.resolve(process.env.NEXUS_V2_NORMALIZATION_CONTROL_BIN || 'control')
  : '/usr/local/sbin/nexus-release-promotion-control';
const OWNER_PUBLIC_KEY = TEST_MODE
  ? path.resolve(process.env.NEXUS_V2_NORMALIZATION_OWNER_PUBLIC_KEY || 'owner.pem')
  : '/etc/nexus-release/owner-promotion-public-key.pem';
const RELEASE_EVIDENCE_PUBLIC_KEY = TEST_MODE
  ? path.resolve(
    process.env.NEXUS_V2_NORMALIZATION_RELEASE_EVIDENCE_PUBLIC_KEY
      || 'release-evidence.pem',
  )
  : '/etc/nexus-application-dr/release-evidence-public-key.pem';
const MACHINE_ID_FILE = TEST_MODE
  ? path.resolve(process.env.NEXUS_V2_NORMALIZATION_MACHINE_ID_FILE || 'machine-id')
  : '/etc/machine-id';
const SELF_PATH = fs.realpathSync(process.argv[1]);
const ROOT_OWNER_UID = TEST_MODE ? process.getuid() : 0;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TRANSACTION_ID = /^[0-9]{8}T[0-9]{6}Z-[0-9]+-[a-f0-9]{12}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const AUTHORIZATION_MAX_LIFETIME_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const RELEASE_EVIDENCE_KEY_ID =
  'github-environment-release-signing-2026-07';
const MAX_NORMALIZATION_JOURNAL_BYTES = 64 * 1024 * 1024;

function canonicalJson(input) {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(input[key])}`).join(',')}}`;
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactKeys(input, expected, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error(`${label} schema is invalid`);
  }
}

function assertCanonicalDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    throw new Error(`${label} is not a canonical non-symlink directory`);
  }
}

function pathEntryExists(candidate) {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function assertRootExclusiveParent(base) {
  const parent = path.dirname(base);
  assertCanonicalDirectory(parent, 'normalization base parent');
  const ownerUid = TEST_MODE ? process.getuid() : 0;
  const before = fs.lstatSync(parent, { bigint: true });
  if (Number(before.uid) !== ownerUid
      || (Number(before.mode & 0o777n) & 0o022) !== 0) {
    throw new Error(
      'normalization base parent is not root-exclusive; legacy home layout remains inactive',
    );
  }
  const descriptor = fs.openSync(
    parent,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)
      | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(parent, { bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino
        || opened.nlink !== before.nlink
        || after.dev !== opened.dev || after.ino !== opened.ino
        || after.nlink !== opened.nlink) {
      throw new Error('normalization base parent inode changed while opening');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function stableRegularFile(
  file,
  label,
  {
    modes = [],
    ownerUid = ROOT_OWNER_UID,
    maxBytes = MAX_EVIDENCE_BYTES,
  } = {},
) {
  const resolved = path.resolve(file);
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size <= 0 || before.size > maxBytes
      || fs.realpathSync(resolved) !== resolved
      || before.uid !== ownerUid
      || (modes.length > 0 && !modes.includes(before.mode & 0o777))) {
    throw new Error(`${label} is not an exact trusted regular file`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const descriptor = fs.openSync(resolved, flags);
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.nlink !== 1) {
      throw new Error(`${label} changed while opening`);
    }
    const body = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== body.length || after.nlink !== 1) {
      throw new Error(`${label} changed while reading`);
    }
    return { body, stat: opened, sha256: sha256(body), path: resolved };
  } finally {
    fs.closeSync(descriptor);
  }
}

function stableJson(file, label, options = {}) {
  const evidence = stableRegularFile(file, label, options);
  return { ...evidence, value: JSON.parse(evidence.body.toString('utf8')) };
}

function safeRelative(relative) {
  return typeof relative === 'string'
    && relative.length > 0
    && relative.length <= 4096
    && !path.posix.isAbsolute(relative)
    && !relative.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(relative)
    && path.posix.normalize(relative) === relative
    && relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function regularFile(runtimeRoot, relative, label = relative) {
  const absolute = path.join(runtimeRoot, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  return absolute;
}

function runtimeJson(runtimeRoot, relative) {
  const file = regularFile(runtimeRoot, relative);
  const stat = fs.statSync(file);
  if (stat.size > MAX_EVIDENCE_BYTES) throw new Error(`${relative} is unreasonably large`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function runtimeFileDigest(runtimeRoot, relative) {
  return sha256(fs.readFileSync(regularFile(runtimeRoot, relative)));
}

function assertSafeDependencySymlink(runtimeRoot, relative, absolute) {
  const resolved = fs.realpathSync(absolute);
  if (resolved === runtimeRoot || resolved.startsWith(`${runtimeRoot}${path.sep}`)) return;
  if (/^content-engine\/\.venv\/bin\/python(?:3|3\.12)?$/u.test(relative)
      && resolved === '/usr/bin/python3.12') return;
  throw new Error(`installed dependency symlink escapes the runtime: ${relative}`);
}

function treeIdentity(runtimeRoot, relativeRoot) {
  const absoluteRoot = path.join(runtimeRoot, relativeRoot);
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`installed dependency tree is unsafe: ${relativeRoot}`);
  }
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(absoluteRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isSymbolicLink()) {
        assertSafeDependencySymlink(runtimeRoot, `${relativeRoot}/${relative}`, absolute);
        entries.push({ path: relative, type: 'symlink', target: fs.readlinkSync(absolute) });
      } else if (stat.isFile()) {
        const body = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          type: 'file',
          size: body.length,
          executable: Boolean(stat.mode & 0o111),
          sha256: sha256(body),
        });
      } else {
        throw new Error(`unsupported installed dependency entry: ${relativeRoot}/${relative}`);
      }
    }
  };
  walk(absoluteRoot);
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    path: relativeRoot,
    digest: sha256(canonicalJson(entries)),
    entryCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
  };
}

function networkIdentity(runtimeRoot) {
  const evidenceBytes = fs.readFileSync(
    regularFile(runtimeRoot, '.network-independent-install.json'),
  );
  const evidence = JSON.parse(evidenceBytes.toString('utf8'));
  const lock = runtimeJson(runtimeRoot, 'dist/runtime-dependencies/lock.json');
  const dependencyLockDigest = sha256(canonicalJson(lock));
  if (evidence.schema !== 'nexus.network-independent-install.v1'
      || evidence.status !== 'passed'
      || evidence.dependencyLockDigest !== dependencyLockDigest
      || evidence.packageLockSha256 !== runtimeFileDigest(runtimeRoot, 'package-lock.json')
      || evidence.pythonRequirementsSha256
        !== runtimeFileDigest(runtimeRoot, 'content-engine/requirements.txt')
      || lock.target?.node !== process.version
      || !/^Python 3\.12\.\d+$/u.test(lock.target?.python ?? '')) {
    throw new Error('network-independent install evidence is invalid');
  }
  return {
    identity: {
      schema: evidence.schema,
      status: evidence.status,
      dependencyLockDigest,
      evidenceSha256: sha256(evidenceBytes),
    },
    node: lock.target.node,
    python: lock.target.python,
  };
}

function strictInstalledIdentity(runtimeRoot, runtimeSha, artifactDigest) {
  const packageJson = runtimeJson(runtimeRoot, 'package.json');
  const networkIndependentInstall = networkIdentity(runtimeRoot);
  return {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha,
    artifactDigest,
    packageVersion: packageJson.version,
    inputs: {
      packageLockSha256: runtimeFileDigest(runtimeRoot, 'package-lock.json'),
      requirementsSha256:
        runtimeFileDigest(runtimeRoot, 'content-engine/requirements.txt'),
      node: networkIndependentInstall.node,
      python: networkIndependentInstall.python,
    },
    networkIndependentInstall: networkIndependentInstall.identity,
    trees: [
      treeIdentity(runtimeRoot, 'node_modules'),
      treeIdentity(runtimeRoot, 'content-engine/.venv'),
    ],
  };
}

function legacyInstalledIdentity(runtimeRoot, runtimeSha, artifactDigest) {
  if (pathEntryExists(path.join(runtimeRoot, '.network-independent-install.json'))
      || pathEntryExists(path.join(runtimeRoot, 'dist/runtime-dependencies/lock.json'))) {
    throw new Error('legacy predecessor may not downgrade modern install evidence');
  }
  const packageJson = runtimeJson(runtimeRoot, 'package.json');
  const installed = runtimeJson(runtimeRoot, '.nexus-installed-runtime.json');
  exactKeys(
    installed,
    ['schema', 'identity', 'aggregateDigest'],
    'legacy installed runtime attestation',
  );
  exactKeys(
    installed.identity,
    ['schema', 'runtimeSha', 'artifactDigest', 'packageVersion', 'inputs', 'trees'],
    'legacy installed runtime identity',
  );
  exactKeys(
    installed.identity.inputs,
    ['packageLockSha256', 'requirementsSha256', 'node', 'python'],
    'legacy installed runtime inputs',
  );
  if (!Array.isArray(installed.identity.trees) || installed.identity.trees.length !== 2) {
    throw new Error('legacy installed runtime tree identity is invalid');
  }
  for (const tree of installed.identity.trees) {
    exactKeys(
      tree,
      ['path', 'digest', 'entryCount', 'totalBytes'],
      'legacy installed runtime tree',
    );
  }
  return {
    schema: 'nexus.installed-runtime-identity.v1',
    runtimeSha,
    artifactDigest,
    packageVersion: packageJson.version,
    inputs: {
      packageLockSha256: runtimeFileDigest(runtimeRoot, 'package-lock.json'),
      requirementsSha256:
        runtimeFileDigest(runtimeRoot, 'content-engine/requirements.txt'),
      node: installed.identity.inputs.node,
      python: installed.identity.inputs.python,
    },
    trees: [
      treeIdentity(runtimeRoot, 'node_modules'),
      treeIdentity(runtimeRoot, 'content-engine/.venv'),
    ],
  };
}

function validateArtifact(runtimeRoot, runtimeSha, artifactDigest) {
  const artifact = runtimeJson(runtimeRoot, 'artifact-manifest.json');
  const marker = runtimeJson(runtimeRoot, '.complete.json');
  if (artifact.schema !== 'nexus.release-artifact-manifest.v1'
      || !Array.isArray(artifact.files)) {
    throw new Error('artifact manifest schema is invalid');
  }
  const files = [];
  const declared = new Set();
  let previous = null;
  for (const entry of artifact.files) {
    if (!safeRelative(entry?.path) || declared.has(entry.path)
        || (previous !== null && previous >= entry.path)
        || !Number.isSafeInteger(entry?.size) || entry.size < 0
        || !DIGEST.test(entry?.sha256 ?? '')) {
      throw new Error(`unsafe artifact declaration: ${String(entry?.path)}`);
    }
    previous = entry.path;
    declared.add(entry.path);
    const body = fs.readFileSync(
      regularFile(runtimeRoot, entry.path, `artifact ${entry.path}`),
    );
    const observed = sha256(body);
    if (body.length !== entry.size || observed !== entry.sha256) {
      throw new Error(`artifact byte mismatch: ${entry.path}`);
    }
    files.push({ path: entry.path, size: body.length, sha256: observed });
  }
  const aggregate = sha256(Buffer.from(JSON.stringify({
    schema: artifact.schema,
    files,
  })));
  if (artifact.digest !== aggregate || artifact.fileCount !== files.length
      || aggregate !== artifactDigest || artifact.git?.sha !== runtimeSha
      || marker.schema !== 'nexus.release-bundle.v1'
      || marker.runtimeSha !== runtimeSha
      || marker.artifactDigest !== artifactDigest
      || marker.fileCount !== files.length) {
    throw new Error('artifact aggregate identity mismatch');
  }
  return { aggregate, declared };
}

function verifyRuntimeInventory(runtimeRoot, base, declared) {
  const known = new Set([
    ...declared,
    'artifact-manifest.json',
    '.complete.json',
    '.network-independent-install.json',
    '.nexus-installed-runtime.json',
    '.nexus-release-readiness-staging.json',
    '.nexus-release-readiness-production.json',
  ]);
  const expectedLinks = new Map([
    ['.env', path.join(base, '.env')],
    ['data', path.join(base, 'data')],
    ['logs', path.join(base, 'logs')],
  ]);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runtimeRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isSymbolicLink()) {
        if (expectedLinks.has(relative)) {
          if (fs.readlinkSync(absolute) !== expectedLinks.get(relative)) {
            throw new Error(`runtime link target mismatch: ${relative}`);
          }
        } else if (relative.startsWith('node_modules/')
            || relative.startsWith('content-engine/.venv/')) {
          assertSafeDependencySymlink(runtimeRoot, relative, absolute);
        } else {
          throw new Error(`undeclared runtime symlink: ${relative}`);
        }
      } else if (stat.isFile()) {
        if (!known.has(relative) && !relative.startsWith('node_modules/')
            && !relative.startsWith('content-engine/.venv/')) {
          throw new Error(`undeclared runtime file: ${relative}`);
        }
      } else {
        throw new Error(`unsupported runtime entry: ${relative}`);
      }
    }
  };
  walk(runtimeRoot);
}

function assertSealedPermissions(runtimeRoot, base, groupId) {
  const ownerUid = TEST_MODE ? process.getuid() : 0;
  const anchors = [
    [base, 0o1770, 'production base'],
    [path.join(base, 'releases'), 0o750, 'production releases directory'],
    [runtimeRoot, 0o550, 'release root'],
  ];
  for (const [absolute, expectedMode, label] of anchors) {
    const stat = fs.lstatSync(absolute);
    if (stat.uid !== ownerUid || stat.gid !== groupId
        || (stat.mode & 0o7777) !== expectedMode) {
      throw new Error(`${label} ownership or immutable mode is invalid`);
    }
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(runtimeRoot, absolute).split(path.sep).join('/');
      const stat = fs.lstatSync(absolute);
      if (stat.uid !== ownerUid || stat.gid !== groupId) {
        throw new Error(`sealed runtime ownership mismatch: ${relative}`);
      }
      if (stat.isDirectory()) {
        if ((stat.mode & 0o7777) !== 0o550) {
          throw new Error(`sealed runtime directory is writable: ${relative}`);
        }
        walk(absolute);
      } else if (stat.isSymbolicLink()) {
        // Symlink permissions are not portable. Ownership and the target are
        // independently verified.
      } else if (stat.isFile()) {
        const mode = stat.mode & 0o7777;
        if (mode !== 0o440 && mode !== 0o550) {
          throw new Error(`sealed runtime file mode is invalid: ${relative}`);
        }
      } else {
        throw new Error(`unsupported sealed runtime entry: ${relative}`);
      }
    }
  };
  walk(runtimeRoot);
}

function environmentPolicy(valueToCheck, role) {
  exactKeys(valueToCheck, ['legacy', 'modern'], `${role} environment policy`);
  exactKeys(
    valueToCheck.legacy,
    ['ownerUid', 'groupId', 'mode'],
    `${role} legacy environment policy`,
  );
  exactKeys(
    valueToCheck.modern,
    ['ownerUid', 'groupId', 'mode'],
    `${role} modern environment policy`,
  );
  if (!Number.isSafeInteger(valueToCheck.legacy.ownerUid)
      || valueToCheck.legacy.ownerUid < 1
      || !Number.isSafeInteger(valueToCheck.legacy.groupId)
      || valueToCheck.legacy.groupId < 1
      || valueToCheck.legacy.mode !== '0600'
      || valueToCheck.modern.ownerUid !== 0
      || valueToCheck.modern.groupId !== valueToCheck.legacy.groupId
      || valueToCheck.modern.mode !== '0440') {
    throw new Error(`${role} environment transition policy is invalid`);
  }
  return valueToCheck;
}

function runtimeTuple(valueToCheck, label) {
  exactKeys(
    valueToCheck,
    ['runtime', 'sha', 'artifactDigest', 'installedRuntimeDigest'],
    label,
  );
  if (!path.isAbsolute(valueToCheck.runtime) || !SHA.test(valueToCheck.sha ?? '')
      || !DIGEST.test(valueToCheck.artifactDigest ?? '')
      || !DIGEST.test(valueToCheck.installedRuntimeDigest ?? '')) {
    throw new Error(`${label} identity is invalid`);
  }
  return valueToCheck;
}

function validateBridgeEnvelope(
  evidence,
  role,
  {
    ownerPublicKey,
    machineIdSha256,
    bridgeSha256,
    replacedAttestorSha256,
    controlSha256,
    allowExpired,
  },
) {
  const envelope = evidence.value;
  exactKeys(
    envelope,
    ['schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature'],
    `${role} bridge authorization envelope`,
  );
  if (envelope.schema !== 'nexus.v2-normalization-attestor-bridge-envelope.v1'
      || envelope.keyId !== 'nexus-owner-promotion-2026'
      || envelope.signatureAlgorithm !== 'ed25519') {
    throw new Error(`${role} bridge authorization envelope identity is invalid`);
  }
  const payload = envelope.payload;
  exactKeys(payload, [
    'schema',
    'purpose',
    'authorizationId',
    'nonce',
    'role',
    'serverIdentity',
    'transaction',
    'control',
    'attestors',
    'runtime',
    'environment',
    'mode',
    'issuedAt',
    'expiresAt',
  ], `${role} bridge authorization payload`);
  exactKeys(payload.serverIdentity, ['machineIdSha256'], `${role} server identity`);
  exactKeys(
    payload.transaction,
    ['transactionId', 'requestSha256', 'requestEnvelopeSha256'],
    `${role} transaction identity`,
  );
  exactKeys(payload.control, ['version', 'sha256'], `${role} control identity`);
  exactKeys(payload.attestors, [
    'bridgeSha256',
    'replacedAttestorSha256',
    'strictRestoreSha256',
  ], `${role} attestor identity`);
  exactKeys(
    payload.runtime,
    ['base', 'predecessor', 'target'],
    `${role} runtime transition`,
  );
  exactKeys(payload.mode, [
    'legacyPredecessor',
    'target',
    'strictRestore',
    'selectorAdoption',
  ], `${role} bridge mode`);
  if (payload.schema !== 'nexus.v2-normalization-attestor-bridge-request.v1'
      || payload.purpose !== 'v2_layout_normalization'
      || !UUID.test(payload.authorizationId ?? '')
      || !DIGEST.test(payload.nonce ?? '')
      || payload.role !== role
      || payload.serverIdentity.machineIdSha256 !== machineIdSha256
      || !TRANSACTION_ID.test(payload.transaction.transactionId ?? '')
      || !DIGEST.test(payload.transaction.requestSha256 ?? '')
      || !DIGEST.test(payload.transaction.requestEnvelopeSha256 ?? '')
      || payload.control.version !== 'nexus-release-promotion-control.v2'
      || payload.control.sha256 !== EXPECTED_V2_CONTROL_SHA256
      || payload.control.sha256 !== controlSha256
      || payload.attestors.bridgeSha256 !== bridgeSha256
      || payload.attestors.replacedAttestorSha256
        !== EXPECTED_REPLACED_ATTESTOR_SHA256
      || payload.attestors.replacedAttestorSha256 !== replacedAttestorSha256
      || payload.attestors.strictRestoreSha256
        !== EXPECTED_REPLACED_ATTESTOR_SHA256
      || payload.mode.legacyPredecessor !== 'owner_signed_active_request_only'
      || payload.mode.target !== 'strict_network_independent'
      || payload.mode.strictRestore !== 'completed_escrowed_soaked'
      || payload.mode.selectorAdoption !== 'post_terminal_only') {
    throw new Error(`${role} bridge authorization payload identity is invalid`);
  }
  const expectedBase = role === 'production'
    ? '/home/dominguez/telegram-hub-bot'
    : '/home/dominguez/telegram-hub-bot-staging';
  if (!TEST_MODE && payload.runtime.base !== expectedBase) {
    throw new Error(`${role} bridge base is outside the exact legacy layout`);
  }
  if (!path.isAbsolute(payload.runtime.base)
      || fs.realpathSync(payload.runtime.base) !== payload.runtime.base) {
    throw new Error(`${role} bridge base is not canonical`);
  }
  const predecessor = runtimeTuple(
    payload.runtime.predecessor,
    `${role} predecessor`,
  );
  const target = runtimeTuple(payload.runtime.target, `${role} target`);
  for (const runtime of [predecessor.runtime, target.runtime]) {
    if (!runtime.startsWith(`${payload.runtime.base}${path.sep}releases${path.sep}`)) {
      throw new Error(`${role} bridge runtime is outside its exact base`);
    }
  }
  environmentPolicy(payload.environment, role);
  const issuedAt = Date.parse(payload.issuedAt ?? '');
  const expiresAt = Date.parse(payload.expiresAt ?? '');
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
      || new Date(issuedAt).toISOString() !== payload.issuedAt
      || new Date(expiresAt).toISOString() !== payload.expiresAt
      || expiresAt <= issuedAt || expiresAt - issuedAt > AUTHORIZATION_MAX_LIFETIME_MS
      || issuedAt > Date.now() + CLOCK_SKEW_MS
      || (!allowExpired && Date.now() > expiresAt)) {
    throw new Error(`${role} bridge authorization lifetime is invalid or expired`);
  }
  const valid = verifySignature(
    null,
    Buffer.from(canonicalJson(payload)),
    createPublicKey(ownerPublicKey),
    Buffer.from(envelope.signature ?? '', 'base64'),
  );
  if (!valid) throw new Error(`${role} bridge authorization signature is invalid`);
  return {
    envelope,
    payload,
    envelopeSha256: evidence.sha256,
    payloadSha256: sha256(canonicalJson(payload)),
  };
}

function authorizationInputs({
  productionPath = PRODUCTION_AUTHORIZATION,
  publicKeyPath = OWNER_PUBLIC_KEY,
  machineIdPath = MACHINE_ID_FILE,
  bridgeSha256 = sha256(fs.readFileSync(SELF_PATH)),
  replacedAttestorSha256 = EXPECTED_REPLACED_ATTESTOR_SHA256,
  controlSha256 = sha256(fs.readFileSync(CONTROL_BIN)),
  allowExpired = false,
} = {}) {
  const ownerPublicKey = stableRegularFile(
    publicKeyPath,
    'owner promotion public key',
    { modes: [0o600, 0o644], maxBytes: 128 * 1024 },
  ).body;
  const machineIdSha256 = sha256(stableRegularFile(
    machineIdPath,
    'server machine identity',
    {
      modes: TEST_MODE ? [0o600, 0o644] : [0o444],
      maxBytes: 4096,
    },
  ).body);
  const context = {
    ownerPublicKey,
    machineIdSha256,
    bridgeSha256,
    replacedAttestorSha256,
    controlSha256,
    allowExpired,
  };
  const production = validateBridgeEnvelope(
    stableJson(productionPath, 'production bridge authorization', { modes: [0o600] }),
    'production',
    context,
  );
  return { production, machineIdSha256 };
}

function validateReceipt() {
  const evidence = stableJson(RECEIPT, 'bridge installation receipt', { modes: [0o600] });
  const receipt = evidence.value;
  exactKeys(receipt, [
    'schema',
    'status',
    'source',
    'installed',
    'authorizations',
    'transaction',
    'environmentPolicy',
    'installedAt',
  ], 'bridge installation receipt');
  exactKeys(
    receipt.source,
    ['sourceRoot', 'sourceSha', 'archiveSha256'],
    'bridge receipt source',
  );
  exactKeys(
    receipt.installed,
    ['controlSha256', 'bridgeSha256', 'replacedAttestorSha256', 'strictRestoreSha256'],
    'bridge receipt installed identity',
  );
  exactKeys(
    receipt.authorizations,
    ['productionSha256'],
    'bridge receipt authorization identity',
  );
  exactKeys(
    receipt.transaction,
    ['transactionId', 'requestSha256', 'requestEnvelopeSha256'],
    'bridge receipt transaction',
  );
  exactKeys(
    receipt.environmentPolicy,
    ['legacyMode', 'modernMode'],
    'bridge receipt environment policy',
  );
  const selfSha256 = stableRegularFile(
    SELF_PATH,
    'installed v2 normalization bridge',
    { modes: TEST_MODE ? [0o644, 0o700] : [0o700] },
  ).sha256;
  const controlSha256 = sha256(fs.readFileSync(
    stableRegularFile(CONTROL_BIN, 'v2 promotion control', { modes: [0o700] }).path,
  ));
  if (receipt.schema !== 'nexus.v2-normalization-attestor-install-receipt.v1'
      || receipt.status !== 'active'
      || !SHA.test(receipt.source.sourceSha ?? '')
      || !DIGEST.test(receipt.source.archiveSha256 ?? '')
      || receipt.installed.controlSha256 !== EXPECTED_V2_CONTROL_SHA256
      || controlSha256 !== EXPECTED_V2_CONTROL_SHA256
      || receipt.installed.bridgeSha256 !== selfSha256
      || receipt.installed.replacedAttestorSha256
        !== EXPECTED_REPLACED_ATTESTOR_SHA256
      || receipt.installed.strictRestoreSha256
        !== EXPECTED_REPLACED_ATTESTOR_SHA256
      || receipt.authorizations.productionSha256
        !== sha256(fs.readFileSync(PRODUCTION_AUTHORIZATION))
      || !TRANSACTION_ID.test(receipt.transaction.transactionId ?? '')
      || !DIGEST.test(receipt.transaction.requestSha256 ?? '')
      || !DIGEST.test(receipt.transaction.requestEnvelopeSha256 ?? '')
      || receipt.environmentPolicy.legacyMode !== 'worker:worker:0600'
      || receipt.environmentPolicy.modernMode !== 'root:worker:0440'
      || !Number.isFinite(Date.parse(receipt.installedAt ?? ''))) {
    throw new Error('bridge installation receipt identity is invalid');
  }
  return receipt;
}

function strictBase64(valueToCheck, label) {
  if (typeof valueToCheck !== 'string' || valueToCheck.length === 0
      || valueToCheck.length > 24 * 1024 * 1024
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(valueToCheck)) {
    throw new Error(`${label} encoding is invalid`);
  }
  const decoded = Buffer.from(valueToCheck, 'base64');
  if (decoded.length === 0 || decoded.length > MAX_EVIDENCE_BYTES
      || decoded.toString('base64') !== valueToCheck) {
    throw new Error(`${label} encoding is non-canonical`);
  }
  return decoded;
}

function signedEvidenceEnvelope(body, schema, label, publicKey) {
  let envelope;
  try {
    envelope = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  exactKeys(
    envelope,
    ['schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature'],
    `${label} envelope`,
  );
  if (envelope.schema !== schema
      || envelope.keyId !== RELEASE_EVIDENCE_KEY_ID
      || envelope.signatureAlgorithm !== 'ed25519'
      || typeof envelope.signature !== 'string'
      || !verifySignature(
        null,
        Buffer.from(canonicalJson(envelope.payload)),
        createPublicKey(publicKey),
        Buffer.from(envelope.signature, 'base64'),
      )) {
    throw new Error(`${label} is not signed by the ordinary production release key`);
  }
  return envelope;
}

function verifyActiveReleaseEvidence(request, expectedTarget) {
  const evidence = request.releaseEvidence;
  exactKeys(evidence, [
    'releaseManifestBase64',
    'releaseManifestSha256',
    'stagingAttestationBase64',
    'stagingAttestationSha256',
  ], 'accepted release evidence');
  const manifestBody = strictBase64(
    evidence.releaseManifestBase64,
    'accepted release manifest',
  );
  const stagingBody = strictBase64(
    evidence.stagingAttestationBase64,
    'accepted staging attestation',
  );
  if (sha256(manifestBody) !== evidence.releaseManifestSha256
      || sha256(stagingBody) !== evidence.stagingAttestationSha256) {
    throw new Error('accepted release evidence digest mismatch');
  }
  const publicKey = stableRegularFile(
    RELEASE_EVIDENCE_PUBLIC_KEY,
    'production release evidence public key',
    { modes: [0o600, 0o644], maxBytes: 128 * 1024 },
  ).body;
  const manifest = signedEvidenceEnvelope(
    manifestBody,
    'nexus.release-manifest.v2',
    'accepted release manifest',
    publicKey,
  );
  const staging = signedEvidenceEnvelope(
    stagingBody,
    'nexus.staging-attestation.v1',
    'accepted staging attestation',
    publicKey,
  );
  if (manifest.payload?.schema !== 'nexus.release-manifest-payload.v2'
      || manifest.payload?.runtimeSha !== expectedTarget.sha
      || manifest.payload?.artifact?.digest !== expectedTarget.artifactDigest
      || manifest.payload?.source?.dirty === true
      || !Number.isFinite(Date.parse(manifest.payload?.generatedAt ?? ''))
      || !Number.isFinite(Date.parse(manifest.payload?.expiresAt ?? ''))) {
    throw new Error('accepted release manifest target binding is invalid');
  }
  const stagingPayload = staging.payload;
  if (stagingPayload?.schema !== 'nexus.staging-attestation-request.v1'
      || stagingPayload.runtimeSha !== expectedTarget.sha
      || stagingPayload.artifactDigest !== expectedTarget.artifactDigest
      || stagingPayload.installedRuntimeDigest
        !== expectedTarget.installedRuntimeDigest
      || stagingPayload.recoveryRuntimeDigest
        !== request.target?.recoveryRuntimeDigest
      || stagingPayload.releaseManifestSha256 !== evidence.releaseManifestSha256
      || !stagingPayload.releaseDir?.startsWith('/srv/nexus-release/staging/releases/')
      || stagingPayload.smoke?.status !== 'passed'
      || !DIGEST.test(stagingPayload.smoke?.logSha256 ?? '')
      || stagingPayload.remoteReadiness?.schema !== 'nexus.release-readiness.v1'
      || stagingPayload.remoteReadiness?.role !== 'staging'
      || stagingPayload.remoteReadiness?.runtimeSha !== expectedTarget.sha
      || stagingPayload.protectedSigning?.workflow
        !== '.github/workflows/sign-staging-attestation.yml'
      || !/^[1-9][0-9]*$/u.test(stagingPayload.protectedSigning?.runId ?? '')
      || !/^[1-9][0-9]*$/u.test(stagingPayload.protectedSigning?.runAttempt ?? '')
      || !Number.isFinite(Date.parse(stagingPayload.protectedSigning?.signedAt ?? ''))
      || !Number.isFinite(Date.parse(stagingPayload.verifiedAt ?? ''))
      || !Number.isFinite(Date.parse(stagingPayload.expiresAt ?? ''))) {
    throw new Error('accepted ordinary staging evidence target binding is invalid');
  }
  return {
    releaseManifestSha256: evidence.releaseManifestSha256,
    stagingAttestationSha256: evidence.stagingAttestationSha256,
  };
}

function activeRequestAuthority(authorization, { requireJournal = false } = {}) {
  const transaction = authorization.payload.transaction;
  const active = stableJson(
    path.join(STATE_ROOT, 'active.json'),
    'active promotion state',
    { modes: [0o600] },
  ).value;
  exactKeys(
    active,
    ['schema', 'transactionId', 'requestSha256', 'envelopeSha256', 'activatedAt'],
    'active promotion state',
  );
  if (active.schema !== 'nexus.promotion-active.v1'
      || active.transactionId !== transaction.transactionId
      || active.requestSha256 !== transaction.requestSha256
      || active.envelopeSha256 !== transaction.requestEnvelopeSha256) {
    throw new Error('active promotion state does not match bridge authorization');
  }
  const transactionRoot = path.join(
    STATE_ROOT,
    'transactions',
    transaction.transactionId,
  );
  const authority = stableJson(
    path.join(transactionRoot, 'authority.json'),
    'accepted promotion authority',
    { modes: [0o600] },
  ).value;
  exactKeys(
    authority,
    ['schema', 'transactionId', 'requestSha256', 'envelopeSha256'],
    'accepted promotion authority',
  );
  if (authority.schema !== 'nexus.promotion-authority.v1'
      || authority.transactionId !== transaction.transactionId
      || authority.requestSha256 !== transaction.requestSha256
      || authority.envelopeSha256 !== transaction.requestEnvelopeSha256) {
    throw new Error('accepted promotion authority does not match bridge authorization');
  }
  const requestEnvelopeEvidence = stableJson(
    path.join(
      STATE_ROOT,
      'requests',
      `${transaction.transactionId}.envelope.json`,
    ),
    'accepted promotion request envelope',
    { modes: [0o600] },
  );
  const requestEvidence = stableJson(
    path.join(STATE_ROOT, 'requests', `${transaction.transactionId}.json`),
    'accepted promotion request',
    { modes: [0o644] },
  );
  const requestEnvelope = requestEnvelopeEvidence.value;
  exactKeys(
    requestEnvelope,
    ['schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature'],
    'accepted promotion request envelope',
  );
  if (requestEnvelope.schema !== 'nexus.promotion-transaction-request-envelope.v1'
      || requestEnvelope.keyId !== 'nexus-owner-promotion-2026'
      || requestEnvelope.signatureAlgorithm !== 'ed25519'
      || sha256(canonicalJson(requestEnvelope))
        !== transaction.requestEnvelopeSha256
      || canonicalJson(requestEnvelope.payload) !== canonicalJson(requestEvidence.value)
      || sha256(canonicalJson(requestEvidence.value)) !== transaction.requestSha256) {
    throw new Error('accepted promotion request bytes do not match bridge authorization');
  }
  const ownerPublicKey = stableRegularFile(
    OWNER_PUBLIC_KEY,
    'owner promotion public key',
    { modes: [0o600, 0o644], maxBytes: 128 * 1024 },
  ).body;
  if (!verifySignature(
    null,
    Buffer.from(canonicalJson(requestEnvelope.payload)),
    createPublicKey(ownerPublicKey),
    Buffer.from(requestEnvelope.signature ?? '', 'base64'),
  )) {
    throw new Error('accepted promotion request signature is invalid');
  }
  const request = requestEvidence.value;
  if (request.schema !== 'nexus.promotion-transaction-request.v1'
      || request.transactionId !== transaction.transactionId
      || request.ownerAuthorization !== 'explicit'
      || request.transition !== 'v2_layout_normalization') {
    throw new Error('accepted promotion request is not a v2 normalization transition');
  }
  const expected = authorization.payload.runtime;
  if (request.productionBase !== expected.base
      || canonicalJson(request.predecessor) !== canonicalJson(expected.predecessor)
      || request.target?.runtime !== expected.target.runtime
      || request.target?.sha !== expected.target.sha
      || request.target?.artifactDigest !== expected.target.artifactDigest
      || request.target?.installedRuntimeDigest !== expected.target.installedRuntimeDigest) {
    throw new Error('accepted promotion request runtime tuple differs from bridge authorization');
  }
  verifyActiveReleaseEvidence(request, expected.target);
  const journalPath = path.join(transactionRoot, 'state', 'journal.json');
  let journal = null;
  if (pathEntryExists(journalPath)) {
    journal = stableJson(
      journalPath,
      'promotion transaction journal',
      { modes: [0o600] },
    ).value;
    if (journal.schema !== 'nexus.promotion-transaction-journal.v1'
        || journal.transactionId !== transaction.transactionId
        || journal.requestSha256 !== transaction.requestSha256
        || !['running', 'recovery_required', 'escrow_pending'].includes(journal.status)) {
      throw new Error('promotion transaction is terminal or its journal is invalid');
    }
  } else if (requireJournal) {
    throw new Error('expired bridge authorization requires a durable nonterminal journal');
  }
  return { active, authority, request, requestEnvelopeEvidence, journal };
}

function atomicPrivateJson(file, valueToWrite) {
  const parent = path.dirname(file);
  assertCanonicalDirectory(parent, 'bridge state directory');
  const body = Buffer.from(`${JSON.stringify(valueToWrite, null, 2)}\n`);
  if (pathEntryExists(file)) {
    const current = stableRegularFile(file, 'bridge acceptance', { modes: [0o600] });
    if (!current.body.equals(body)) throw new Error('bridge acceptance is immutable');
    return;
  }
  const temporary = path.join(
    parent,
    `.${path.basename(file)}.next.${process.pid}.${Date.now()}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!TEST_MODE) fs.chownSync(temporary, 0, 0);
    fs.renameSync(temporary, file);
    const parentDescriptor = fs.openSync(parent, 'r');
    try {
      fs.fsyncSync(parentDescriptor);
    } finally {
      fs.closeSync(parentDescriptor);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function durablePrivateJson(file, valueToWrite) {
  const parent = path.dirname(file);
  assertCanonicalDirectory(parent, 'durable state directory');
  const temporary = path.join(
    parent,
    `.${path.basename(file)}.next.${process.pid}.${Date.now()}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(
      descriptor,
      Buffer.from(`${JSON.stringify(valueToWrite, null, 2)}\n`),
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (!TEST_MODE) fs.chownSync(temporary, 0, 0);
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
    fsyncDirectory(parent);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function durableRemove(file) {
  if (!pathEntryExists(file)) return;
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`unsafe durable removal target: ${file}`);
  }
  fs.unlinkSync(file);
  fsyncDirectory(path.dirname(file));
}

function acceptedAuthorization(receipt) {
  let priorAcceptance = null;
  if (pathEntryExists(ACCEPTANCE)) {
    priorAcceptance = stableJson(
      ACCEPTANCE,
      'bridge acceptance',
      { modes: [0o600] },
    ).value;
  }
  const authorizations = authorizationInputs({
    allowExpired: priorAcceptance !== null,
  });
  const production = authorizations.production;
  const transaction = production.payload.transaction;
  if (receipt.transaction.transactionId !== transaction.transactionId
      || receipt.transaction.requestSha256 !== transaction.requestSha256
      || receipt.transaction.requestEnvelopeSha256
        !== transaction.requestEnvelopeSha256
      || receipt.authorizations.productionSha256
        !== production.envelopeSha256) {
    throw new Error('bridge receipt differs from signed normalization authority');
  }
  const authorizationExpired =
    Date.now() > Date.parse(production.payload.expiresAt);
  const active = activeRequestAuthority(production, {
    requireJournal: authorizationExpired,
  });
  const expectedAcceptance = {
    schema: 'nexus.v2-normalization-attestor-acceptance.v1',
    transactionId: transaction.transactionId,
    requestSha256: transaction.requestSha256,
    requestEnvelopeSha256: transaction.requestEnvelopeSha256,
    productionAuthorizationSha256: production.envelopeSha256,
    productionAuthorizationId: production.payload.authorizationId,
    productionNonce: production.payload.nonce,
    acceptedAt: priorAcceptance?.acceptedAt ?? new Date().toISOString(),
  };
  if (priorAcceptance !== null
      && canonicalJson(priorAcceptance) !== canonicalJson(expectedAcceptance)) {
    throw new Error('bridge acceptance does not match the active signed transaction');
  }
  if (priorAcceptance !== null
      && (!Number.isFinite(Date.parse(priorAcceptance.acceptedAt ?? ''))
        || new Date(Date.parse(priorAcceptance.acceptedAt)).toISOString()
          !== priorAcceptance.acceptedAt
        || Date.parse(priorAcceptance.acceptedAt)
          > Date.parse(production.payload.expiresAt))) {
    throw new Error('bridge acceptance timestamp is invalid');
  }
  atomicPrivateJson(ACCEPTANCE, expectedAcceptance);
  if (TEST_MODE
      && process.env.NEXUS_V2_NORMALIZATION_TEST_MUTATE_ACTIVE_AFTER_ACCEPT === '1') {
    fs.writeFileSync(
      path.join(STATE_ROOT, 'active.json'),
      `${JSON.stringify({ ...active.active, requestSha256: '0'.repeat(64) }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  activeRequestAuthority(production, {
    requireJournal: authorizationExpired,
  });
  return { production, authority: active };
}

function verifyEnvironmentMode(base, policy, phase) {
  const environment = stableRegularFile(
    path.join(base, '.env'),
    `${phase} environment`,
    {
      modes: [Number.parseInt(policy.mode, 8)],
      ownerUid: TEST_MODE && phase === 'modern'
        ? process.getuid()
        : policy.ownerUid,
      maxBytes: 4 * 1024 * 1024,
    },
  );
  if (environment.stat.gid !== policy.groupId) {
    throw new Error(`${phase} environment group identity is invalid`);
  }
}

function verifyRuntime({
  runtimeRoot,
  base,
  runtimeSha,
  artifactDigest,
  installedRuntimeDigest,
  groupId,
  requireSealed,
  mode,
}) {
  if (!SHA.test(runtimeSha) || !DIGEST.test(artifactDigest)
      || !DIGEST.test(installedRuntimeDigest)) {
    throw new Error('expected runtime identity is invalid');
  }
  assertCanonicalDirectory(base, 'production base');
  assertCanonicalDirectory(path.join(base, 'releases'), 'production releases directory');
  assertCanonicalDirectory(runtimeRoot, 'release root');
  if (!runtimeRoot.startsWith(`${base}${path.sep}releases${path.sep}`)) {
    throw new Error('release root is outside production releases');
  }
  const { aggregate, declared } = validateArtifact(runtimeRoot, runtimeSha, artifactDigest);
  const installed = runtimeJson(runtimeRoot, '.nexus-installed-runtime.json');
  const current = mode === 'strict'
    ? strictInstalledIdentity(runtimeRoot, runtimeSha, artifactDigest)
    : legacyInstalledIdentity(runtimeRoot, runtimeSha, artifactDigest);
  const installedAggregate = sha256(canonicalJson(current));
  if (installed.schema !== 'nexus.installed-runtime-attestation.v1'
      || canonicalJson(installed.identity) !== canonicalJson(current)
      || installed.aggregateDigest !== installedAggregate
      || installedAggregate !== installedRuntimeDigest) {
    throw new Error(`${mode} installed runtime identity mismatch`);
  }
  verifyRuntimeInventory(runtimeRoot, base, declared);
  if (requireSealed) assertSealedPermissions(runtimeRoot, base, groupId);
  return {
    runtimeSha,
    artifactDigest: aggregate,
    installedRuntimeDigest: installedAggregate,
  };
}

function inodeIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    nlink: String(stat.nlink),
  };
}

function entryKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  throw new Error('unsupported normalization filesystem entry');
}

function stableEntryContent(absolute, stat, kind) {
  if (kind === 'directory') {
    return { contentSha256: null, size: null };
  }
  if (kind === 'symlink') {
    const target = fs.readlinkSync(absolute);
    const after = fs.lstatSync(absolute, { bigint: true });
    if (!sameInode(after, inodeIdentity(stat))) {
      throw new Error(`normalization symbolic entry changed while reading: ${absolute}`);
    }
    const body = Buffer.from(target);
    return { contentSha256: sha256(body), size: String(body.length) };
  }
  const descriptor = fs.openSync(
    absolute,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.dev !== stat.dev || opened.ino !== stat.ino
        || opened.nlink !== stat.nlink || opened.size !== stat.size) {
      throw new Error(`normalization file changed while opening: ${absolute}`);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0n;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      size += BigInt(count);
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const reproved = fs.lstatSync(absolute, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino
        || after.nlink !== opened.nlink || after.size !== size
        || reproved.dev !== after.dev || reproved.ino !== after.ino
        || reproved.nlink !== after.nlink || reproved.size !== after.size) {
      throw new Error(`normalization file changed while reading: ${absolute}`);
    }
    return { contentSha256: digest.digest('hex'), size: String(size) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function snapshotEntry(absolute, scope, relative) {
  const stat = fs.lstatSync(absolute, { bigint: true });
  const kind = entryKind(stat);
  if ((kind === 'file' || kind === 'symlink') && stat.nlink !== 1n) {
    throw new Error(`normalization entry has an unsafe link count: ${absolute}`);
  }
  return {
    scope,
    relative,
    kind,
    ...inodeIdentity(stat),
    ...stableEntryContent(absolute, stat, kind),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o7777n),
  };
}

function direntKind(entry) {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  throw new Error(`unsupported normalization directory entry: ${entry.name}`);
}

function descriptorDirectoryPath(descriptor, logicalDirectory) {
  if (process.platform === 'linux') {
    return `/proc/self/fd/${descriptor}`;
  }
  if (TEST_MODE) return logicalDirectory;
  throw new Error(
    'descriptor-bound normalization traversal requires Linux procfs',
  );
}

function reproveTraversalChain(chain) {
  for (const { absolute, record } of chain) {
    reproveEntry(absolute, record);
  }
}

let traversalRaceInjected = false;
function injectTestTraversalRace(runtimeRoot, absolute, relative) {
  if (!TEST_MODE || traversalRaceInjected
      || process.env.NEXUS_V2_NORMALIZATION_TEST_ATTACK
        !== 'directory_to_symlink') {
    return;
  }
  const selected = process.env.NEXUS_V2_NORMALIZATION_TEST_RACE_RELATIVE
    || 'node_modules';
  if (!safeRelative(selected) || relative !== selected) return;
  const target = process.env.NEXUS_V2_NORMALIZATION_TEST_RACE_TARGET || '';
  if (!path.isAbsolute(target)
      || path.resolve(target) === runtimeRoot
      || path.resolve(target).startsWith(`${runtimeRoot}${path.sep}`)) {
    throw new Error('test traversal race target is invalid');
  }
  const targetStat = fs.lstatSync(target);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    throw new Error('test traversal race target is not a directory');
  }
  const displaced = path.join(
    path.dirname(absolute),
    `.nexus-v2-test-displaced-${path.basename(absolute)}`,
  );
  if (pathEntryExists(displaced)) {
    throw new Error('test traversal displacement path already exists');
  }
  fs.renameSync(absolute, displaced);
  fs.symlinkSync(target, absolute, 'dir');
  fsyncDirectory(path.dirname(absolute));
  traversalRaceInjected = true;
}

function runtimeSnapshot(runtimeRoot, base, transitionEnvironment) {
  const baseRecord = snapshotEntry(base, 'base', '.');
  const releasesRecord = snapshotEntry(
    path.join(base, 'releases'),
    'releases',
    '.',
  );
  const runtimeRecord = snapshotEntry(runtimeRoot, 'runtime', '.');
  if (baseRecord.kind !== 'directory'
      || releasesRecord.kind !== 'directory'
      || runtimeRecord.kind !== 'directory') {
    throw new Error('normalization roots must remain directories');
  }
  const records = [baseRecord, releasesRecord, runtimeRecord];
  const walk = (
    logicalDirectory,
    bindingDirectory,
    directoryRecord,
    ancestors,
  ) => {
    const descriptor = boundDescriptor(bindingDirectory, directoryRecord);
    const chain = [...ancestors, {
      absolute: logicalDirectory,
      record: directoryRecord,
    }];
    try {
      const descriptorPath = descriptorDirectoryPath(
        descriptor,
        logicalDirectory,
      );
      reproveTraversalChain(chain);
      const entries = fs.readdirSync(
        descriptorPath,
        { withFileTypes: true },
      );
      for (const entry of entries) {
        reproveTraversalChain(chain);
        const absolute = path.join(logicalDirectory, entry.name);
        const relative = path.relative(runtimeRoot, absolute)
          .split(path.sep)
          .join('/');
        injectTestTraversalRace(runtimeRoot, absolute, relative);
        const boundAbsolute = path.join(descriptorPath, entry.name);
        const record = snapshotEntry(boundAbsolute, 'runtime', relative);
        if (record.kind !== direntKind(entry)) {
          throw new Error(
            `normalization entry kind changed during traversal: ${absolute}`,
          );
        }
        reproveEntry(absolute, record);
        records.push(record);
        if (record.kind === 'directory') {
          walk(absolute, boundAbsolute, record, chain);
        }
        reproveTraversalChain(chain);
      }
      reproveTraversalChain(chain);
    } finally {
      fs.closeSync(descriptor);
    }
  };
  walk(runtimeRoot, runtimeRoot, runtimeRecord, []);
  if (transitionEnvironment) {
    const environmentRecord = snapshotEntry(
      path.join(base, '.env'),
      'environment',
      '.',
    );
    if (environmentRecord.kind !== 'file') {
      throw new Error('normalization environment must remain a regular file');
    }
    records.push(environmentRecord);
  }
  return records;
}

function recordPath(record, runtimeRoot, base) {
  if (record.scope === 'base') return base;
  if (record.scope === 'releases') return path.join(base, 'releases');
  if (record.scope === 'environment') return path.join(base, '.env');
  if (record.scope === 'runtime') {
    return record.relative === '.'
      ? runtimeRoot
      : path.join(runtimeRoot, record.relative);
  }
  throw new Error('normalization metadata scope is invalid');
}

function sameInode(stat, record) {
  return String(stat.dev) === record.dev
    && String(stat.ino) === record.ino
    && (record.kind === 'directory' || String(stat.nlink) === record.nlink);
}

function reproveEntry(absolute, record) {
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error(`normalization path-to-inode binding changed: ${absolute}`);
    }
    throw error;
  }
  if (entryKind(stat) !== record.kind || !sameInode(stat, record)) {
    throw new Error(`normalization path-to-inode binding changed: ${absolute}`);
  }
  return stat;
}

function boundDescriptor(absolute, record) {
  const before = reproveEntry(absolute, record);
  if (record.kind === 'symlink') {
    throw new Error(`cannot open a symbolic normalization entry: ${absolute}`);
  }
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_NOFOLLOW || 0)
    | (record.kind === 'directory' ? (fs.constants.O_DIRECTORY || 0) : 0);
  const descriptor = fs.openSync(absolute, flags);
  const opened = fs.fstatSync(descriptor, { bigint: true });
  if (entryKind(opened) !== record.kind || !sameInode(opened, record)
      || opened.nlink !== before.nlink) {
    fs.closeSync(descriptor);
    throw new Error(`normalization inode changed while opening: ${absolute}`);
  }
  const reproved = reproveEntry(absolute, record);
  if (reproved.nlink !== opened.nlink) {
    fs.closeSync(descriptor);
    throw new Error(`normalization link count changed while opening: ${absolute}`);
  }
  return descriptor;
}

function normalizationRecordIdentity(record) {
  return `${record.scope}:${record.relative}`;
}

function normalizationParentIdentity(record) {
  if (record.scope === 'base') return null;
  if (record.scope === 'releases' || record.scope === 'environment') {
    return 'base:.';
  }
  if (record.scope === 'runtime' && record.relative === '.') {
    return 'releases:.';
  }
  if (record.scope === 'runtime') {
    const parent = path.posix.dirname(record.relative);
    return `runtime:${parent === '.' ? '.' : parent}`;
  }
  throw new Error('normalization descriptor graph scope is invalid');
}

function normalizationRecordComponent(record, runtimeRoot) {
  if (record.scope === 'releases') return 'releases';
  if (record.scope === 'environment') return '.env';
  if (record.scope === 'runtime' && record.relative === '.') {
    return path.basename(runtimeRoot);
  }
  if (record.scope === 'runtime') return path.posix.basename(record.relative);
  throw new Error('normalization descriptor graph component is invalid');
}

function closeBoundRecordChain(chain) {
  for (const descriptor of [...chain.descriptors].reverse()) {
    fs.closeSync(descriptor);
  }
}

function openBoundRecordChain(target, recordsByIdentity, runtimeRoot, base) {
  const records = [];
  let current = target;
  while (current) {
    records.unshift(current);
    const parentIdentity = normalizationParentIdentity(current);
    if (parentIdentity === null) break;
    current = recordsByIdentity.get(parentIdentity);
    if (!current) {
      throw new Error('normalization descriptor chain is incomplete');
    }
    if (records.length > recordsByIdentity.size) {
      throw new Error('normalization descriptor chain contains a cycle');
    }
  }
  if (normalizationRecordIdentity(records[0]) !== 'base:.') {
    throw new Error('normalization descriptor chain is not base-anchored');
  }

  const descriptors = [];
  let boundPath = base;
  try {
    for (const [index, record] of records.entries()) {
      const final = index === records.length - 1;
      const logical = recordPath(record, runtimeRoot, base);
      if (index === 0) {
        boundPath = logical;
      } else {
        const parent = records[index - 1];
        const parentLogical = recordPath(parent, runtimeRoot, base);
        boundPath = path.join(
          descriptorDirectoryPath(
            descriptors[descriptors.length - 1],
            parentLogical,
          ),
          normalizationRecordComponent(record, runtimeRoot),
        );
      }
      if (!final && record.kind !== 'directory') {
        throw new Error(
          'normalization descriptor chain crosses a non-directory',
        );
      }
      if (final && record.kind === 'symlink') {
        reproveEntry(boundPath, record);
      } else {
        descriptors.push(boundDescriptor(boundPath, record));
      }
    }
    return {
      boundPath,
      descriptors,
      targetDescriptor:
        target.kind === 'symlink'
          ? null
          : descriptors[descriptors.length - 1],
    };
  } catch (error) {
    closeBoundRecordChain({ descriptors });
    throw error;
  }
}

function reproveLogicalMutationChain(
  target,
  recordsByIdentity,
  runtimeRoot,
  base,
) {
  const records = [];
  let current = target;
  while (current) {
    records.unshift(current);
    const parentIdentity = normalizationParentIdentity(current);
    if (parentIdentity === null) break;
    current = recordsByIdentity.get(parentIdentity);
    if (!current) {
      throw new Error('normalization logical mutation chain is incomplete');
    }
    if (records.length > recordsByIdentity.size) {
      throw new Error('normalization logical mutation chain contains a cycle');
    }
  }
  if (normalizationRecordIdentity(records[0]) !== 'base:.') {
    throw new Error('normalization logical mutation chain is not base-anchored');
  }
  for (const record of records) {
    reproveEntry(recordPath(record, runtimeRoot, base), record);
  }
}

let descriptorDetachmentRaceInjected = false;
function injectTestDescriptorDetachmentRace(observed, logical, guard) {
  if (!TEST_MODE || descriptorDetachmentRaceInjected
      || process.env.NEXUS_V2_NORMALIZATION_TEST_ATTACK
        !== 'descriptor_detachment') {
    return;
  }
  const selected = process.env.NEXUS_V2_NORMALIZATION_TEST_RACE_IDENTITY
    || 'releases:.';
  if (normalizationRecordIdentity(observed) !== selected) return;
  const external = process.env.NEXUS_V2_NORMALIZATION_TEST_RACE_TARGET || '';
  if (!path.isAbsolute(external)
      || path.resolve(external) === guard.base
      || path.resolve(external).startsWith(`${guard.base}${path.sep}`)
      || pathEntryExists(external)
      || path.dirname(external) !== path.dirname(guard.base)) {
    throw new Error('test descriptor detachment target is invalid');
  }
  fs.renameSync(logical, external);
  fsyncDirectory(path.dirname(logical));
  fsyncDirectory(path.dirname(external));
  descriptorDetachmentRaceInjected = true;
}

function preflightBoundMutationGraph(records, runtimeRoot, base) {
  const allowedScopes = [...new Set(records.map((record) => record.scope))];
  validateNormalizationRecords(
    records,
    'normalization mutation graph',
    allowedScopes,
  );
  const recordsByIdentity = new Map(
    records.map((record) => [
      normalizationRecordIdentity(record),
      record,
    ]),
  );
  for (const record of records) {
    const chain = openBoundRecordChain(
      record,
      recordsByIdentity,
      runtimeRoot,
      base,
    );
    closeBoundRecordChain(chain);
  }
  return recordsByIdentity;
}

function writeBoundDescriptorMetadata({
  descriptor,
  desired,
  observed,
  logical,
  unlockLast,
}) {
  if (unlockLast) {
    fs.fchmodSync(descriptor, 0o000);
    fs.fchownSync(descriptor, desired.uid, desired.gid);
    fs.fchmodSync(descriptor, desired.mode);
  } else {
    fs.fchownSync(descriptor, desired.uid, desired.gid);
    fs.fchmodSync(descriptor, desired.mode);
  }
  const after = fs.fstatSync(descriptor, { bigint: true });
  if (!sameInode(after, observed)
      || Number(after.uid) !== desired.uid
      || Number(after.gid) !== desired.gid
      || Number(after.mode & 0o7777n) !== desired.mode) {
    throw new Error(`normalization inode mutation did not persist: ${logical}`);
  }
  reproveEntry(logical, observed);
}

function assertBoundMutationGuard(guard) {
  const ownerUid = TEST_MODE ? process.getuid() : 0;
  const ownerGid = TEST_MODE ? process.getgid() : 0;
  const stat = fs.fstatSync(guard.chain.targetDescriptor, { bigint: true });
  if (!sameInode(stat, guard.baseRecord)
      || Number(stat.uid) !== ownerUid
      || Number(stat.gid) !== ownerGid
      || Number(stat.mode & 0o7777n) !== 0o700) {
    throw new Error('normalization namespace mutation guard is not exclusive');
  }
  reproveEntry(guard.base, guard.baseRecord);
}

function beginBoundMutationGuard(records, runtimeRoot, base) {
  const initial = preflightBoundMutationGraph(records, runtimeRoot, base);
  const baseRecord = initial.get('base:.');
  if (!baseRecord || baseRecord.kind !== 'directory') {
    throw new Error('normalization mutation graph has no directory base anchor');
  }
  if ((baseRecord.mode & 0o002) !== 0) {
    throw new Error('normalization base is world-writable');
  }
  const chain = openBoundRecordChain(
    baseRecord,
    initial,
    runtimeRoot,
    base,
  );
  const currentBase = fs.fstatSync(chain.targetDescriptor, { bigint: true });
  if ((Number(currentBase.mode & 0o7777n) & 0o002) !== 0) {
    closeBoundRecordChain(chain);
    throw new Error('normalization base became world-writable');
  }
  const locked = {
    ...baseRecord,
    uid: TEST_MODE ? process.getuid() : 0,
    gid: TEST_MODE ? process.getgid() : 0,
    mode: 0o700,
  };
  let descendantLockingStarted = false;
  try {
    writeBoundDescriptorMetadata({
      descriptor: chain.targetDescriptor,
      desired: locked,
      observed: baseRecord,
      logical: base,
      unlockLast: false,
    });
    const recordsByIdentity = preflightBoundMutationGraph(
      records,
      runtimeRoot,
      base,
    );
    const guard = {
      base,
      baseRecord,
      chain,
      recordsByIdentity,
      runtimeRoot,
    };
    assertBoundMutationGuard(guard);
    const directories = records
      .filter(
        (record) => record.kind === 'directory' && record.scope !== 'base',
      )
      .sort((left, right) => {
        const leftPath = recordPath(left, runtimeRoot, base);
        const rightPath = recordPath(right, runtimeRoot, base);
        return leftPath.split(path.sep).length - rightPath.split(path.sep).length;
      });
    for (const record of directories) {
      mutateBoundGraphEntry(
        {
          ...record,
          uid: TEST_MODE ? process.getuid() : 0,
          gid: TEST_MODE ? process.getgid() : 0,
          mode: 0o700,
        },
        record,
        guard,
        {
          onMutationStart() {
            descendantLockingStarted = true;
          },
        },
      );
    }
    guard.recordsByIdentity = preflightBoundMutationGraph(
      records,
      runtimeRoot,
      base,
    );
    assertBoundMutationGuard(guard);
    return guard;
  } catch (error) {
    if (descendantLockingStarted) {
      closeBoundRecordChain(chain);
      throw error;
    }
    try {
      writeBoundDescriptorMetadata({
        descriptor: chain.targetDescriptor,
        desired: baseRecord,
        observed: baseRecord,
        logical: base,
        unlockLast: true,
      });
    } catch (restoreError) {
      closeBoundRecordChain(chain);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; `
        + 'descriptor-bound base restore failed: '
        + `${restoreError instanceof Error
          ? restoreError.message
          : String(restoreError)}`,
      );
    }
    closeBoundRecordChain(chain);
    throw error;
  }
}

function finishBoundMutationGuard(guard, desiredBase) {
  assertBoundMutationGuard(guard);
  writeBoundDescriptorMetadata({
    descriptor: guard.chain.targetDescriptor,
    desired: desiredBase,
    observed: guard.baseRecord,
    logical: guard.base,
    unlockLast: true,
  });
}

function mutateBoundGraphEntry(
  desired,
  observed,
  guard,
  { onMutationStart = () => {} } = {},
) {
  assertBoundMutationGuard(guard);
  const chain = openBoundRecordChain(
    observed,
    guard.recordsByIdentity,
    guard.runtimeRoot,
    guard.base,
  );
  const logical = recordPath(desired, guard.runtimeRoot, guard.base);
  try {
    injectTestDescriptorDetachmentRace(observed, logical, guard);
    reproveLogicalMutationChain(
      observed,
      guard.recordsByIdentity,
      guard.runtimeRoot,
      guard.base,
    );
    if (observed.kind === 'symlink') {
      reproveEntry(chain.boundPath, observed);
      onMutationStart();
      fs.lchownSync(chain.boundPath, desired.uid, desired.gid);
      const after = reproveEntry(chain.boundPath, observed);
      if (Number(after.uid) !== desired.uid
          || Number(after.gid) !== desired.gid) {
        throw new Error(
          `normalization symlink mutation did not persist: ${logical}`,
        );
      }
      reproveLogicalMutationChain(
        observed,
        guard.recordsByIdentity,
        guard.runtimeRoot,
        guard.base,
      );
      assertBoundMutationGuard(guard);
      return;
    }
    onMutationStart();
    writeBoundDescriptorMetadata({
      descriptor: chain.targetDescriptor,
      desired,
      observed,
      logical,
      unlockLast: false,
    });
    reproveLogicalMutationChain(
      observed,
      guard.recordsByIdentity,
      guard.runtimeRoot,
      guard.base,
    );
  } finally {
    closeBoundRecordChain(chain);
  }
  assertBoundMutationGuard(guard);
}

function normalizationGeneratedPaths(runtimeRoot, base, transactionId) {
  const token = `${transactionId}-${path.basename(runtimeRoot)}`;
  return {
    stage: path.join(base, 'releases', `.nexus-v2-${token}.stage`),
    quarantine: path.join(base, 'releases', `.nexus-v2-${token}.source`),
    failed: path.join(base, 'releases', `.nexus-v2-${token}.failed`),
    environmentStage: path.join(base, `.nexus-v2-${token}.env.stage`),
    environmentQuarantine: path.join(base, `.nexus-v2-${token}.env.source`),
    environmentFailed: path.join(base, `.nexus-v2-${token}.env.failed`),
  };
}

function assertGeneratedPath(candidate, parent, transactionId) {
  if (path.dirname(candidate) !== parent
      || !path.basename(candidate).startsWith(
        `.nexus-v2-${transactionId}-`,
      )) {
    throw new Error('normalization generated path is outside its exact parent');
  }
}

function removeGenerated(candidate, parent, transactionId) {
  if (!pathEntryExists(candidate)) return;
  assertGeneratedPath(candidate, parent, transactionId);
  const stat = fs.lstatSync(candidate);
  const ownerUid = TEST_MODE ? process.getuid() : 0;
  if (stat.isSymbolicLink() || stat.uid !== ownerUid) {
    throw new Error(`unsafe generated normalization path: ${candidate}`);
  }
  const makeRemovable = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const child = fs.lstatSync(absolute);
      if (child.uid !== ownerUid) {
        throw new Error(`generated normalization child owner is invalid: ${absolute}`);
      }
      if (entry.isDirectory()) makeRemovable(absolute);
    }
    fs.chmodSync(directory, 0o700);
  };
  if (stat.isDirectory()) makeRemovable(candidate);
  fs.rmSync(candidate, { recursive: stat.isDirectory(), force: false });
  fsyncDirectory(parent);
}

function checkpointNormalization(journal, phase, additions = {}) {
  const next = {
    ...journal,
    ...additions,
    phase,
    updatedAt: new Date().toISOString(),
  };
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_NORMALIZATION_JOURNAL_BYTES) {
    throw new Error('normalization transaction journal exceeds its safety bound');
  }
  durablePrivateJson(NORMALIZATION_JOURNAL, next);
  const persisted = normalizationJournal();
  if (canonicalJson(persisted) !== canonicalJson(next)) {
    throw new Error('normalization transaction checkpoint verification failed');
  }
  if (TEST_MODE
      && process.env.NEXUS_V2_NORMALIZATION_TEST_CRASH_PHASE === phase) {
    process.kill(process.pid, 'SIGKILL');
  }
  return next;
}

function injectTestAdversarialReplacement(journal) {
  if (!TEST_MODE) return;
  const attack = process.env.NEXUS_V2_NORMALIZATION_TEST_ATTACK || '';
  if (!['rename_regular', 'rename_symlink'].includes(attack)) return;
  const original = path.join(journal.runtime.root, 'package.json');
  const displaced = path.join(
    journal.runtime.root,
    '.nexus-v2-test-displaced-package.json',
  );
  if (pathEntryExists(displaced)) {
    throw new Error('test adversarial displacement path already exists');
  }
  fs.renameSync(original, displaced);
  if (attack === 'rename_symlink') {
    fs.symlinkSync(path.join(journal.runtime.base, '.env'), original);
  } else {
    fs.writeFileSync(original, '{"version":"adversarial-replacement"}\n', {
      mode: 0o644,
      flag: 'wx',
    });
  }
  fsyncDirectory(journal.runtime.root);
}

function freezeSource(journal) {
  const ownerUid = TEST_MODE ? process.getuid() : 0;
  const guard = beginBoundMutationGuard(
    journal.metadata,
    journal.runtime.root,
    journal.runtime.base,
  );
  const desired = journal.metadata.map((record) => {
    let mode;
    if (record.scope === 'environment') {
      mode = 0o440;
    } else if (record.scope === 'base') {
      mode = 0o1770;
    } else if (record.scope === 'releases') {
      mode = 0o750;
    } else {
      mode = record.kind === 'directory'
        ? 0o550
        : ((record.mode & 0o111) ? 0o550 : 0o440);
    }
    return {
      ...record,
      uid: ownerUid,
      gid: journal.runtime.groupId,
      mode,
    };
  });
  const desiredBase = desired.find((record) => record.scope === 'base');
  if (!desiredBase) {
    closeBoundRecordChain(guard.chain);
    throw new Error('normalization freeze metadata has no base anchor');
  }
  const directories = desired
    .filter(
      (record) => record.kind === 'directory' && record.scope !== 'base',
    )
    .sort((left, right) => {
      const leftPath = recordPath(left, journal.runtime.root, journal.runtime.base);
      const rightPath = recordPath(right, journal.runtime.root, journal.runtime.base);
      return leftPath.split(path.sep).length - rightPath.split(path.sep).length;
    });
  const others = desired.filter(
    (record) => record.kind !== 'directory' && record.scope !== 'base',
  );
  try {
    for (const record of [...directories, ...others]) {
      const observed = guard.recordsByIdentity.get(
        normalizationRecordIdentity(record),
      );
      if (!observed) {
        throw new Error('normalization freeze inode map is incomplete');
      }
      mutateBoundGraphEntry(
        record,
        observed,
        guard,
      );
    }
    finishBoundMutationGuard(guard, desiredBase);
  } finally {
    closeBoundRecordChain(guard.chain);
  }
}

function copyBoundFile(source, record, destination, uid, gid, mode) {
  const input = boundDescriptor(source, record);
  let output;
  try {
    output = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const digest = createHash('sha256');
    let total = 0n;
    for (;;) {
      const count = fs.readSync(input, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
      total += BigInt(count);
      let offset = 0;
      while (offset < count) {
        offset += fs.writeSync(output, buffer, offset, count - offset);
      }
    }
    const after = fs.fstatSync(input, { bigint: true });
    if (!sameInode(after, record)
        || String(total) !== record.size
        || digest.digest('hex') !== record.contentSha256) {
      throw new Error(`normalization source changed while copying: ${source}`);
    }
    reproveEntry(source, record);
    fs.fchownSync(output, uid, gid);
    fs.fchmodSync(output, mode);
    fs.fsyncSync(output);
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

function rematerializeRuntime(journal) {
  const { stage } = journal.paths;
  const parent = path.join(journal.runtime.base, 'releases');
  assertGeneratedPath(stage, parent, journal.transaction.transactionId);
  if (pathEntryExists(stage)) {
    throw new Error('normalization stage already exists');
  }
  const ownerUid = TEST_MODE ? process.getuid() : 0;
  fs.mkdirSync(stage, { mode: 0o700 });
  fs.chownSync(stage, ownerUid, journal.runtime.groupId);
  fsyncDirectory(parent);
  const runtimeRecords = journal.metadata.filter(
    (record) => record.scope === 'runtime' && record.relative !== '.',
  );
  const directories = runtimeRecords
    .filter((record) => record.kind === 'directory')
    .sort(
      (left, right) =>
        left.relative.split('/').length - right.relative.split('/').length,
    );
  for (const record of directories) {
    const destination = path.join(stage, record.relative);
    fs.mkdirSync(destination, { mode: 0o700 });
    fs.chownSync(destination, ownerUid, journal.runtime.groupId);
  }
  for (const record of runtimeRecords.filter(
    (candidate) => candidate.kind !== 'directory',
  )) {
    const source = path.join(journal.runtime.root, record.relative);
    const destination = path.join(stage, record.relative);
    if (record.kind === 'symlink') {
      reproveEntry(source, record);
      const target = fs.readlinkSync(source);
      const targetBody = Buffer.from(target);
      if (String(targetBody.length) !== record.size
          || sha256(targetBody) !== record.contentSha256) {
        throw new Error(`normalization symlink changed while copying: ${source}`);
      }
      reproveEntry(source, record);
      fs.symlinkSync(target, destination);
      fs.lchownSync(destination, ownerUid, journal.runtime.groupId);
    } else {
      copyBoundFile(
        source,
        record,
        destination,
        ownerUid,
        journal.runtime.groupId,
        (record.mode & 0o111) ? 0o550 : 0o440,
      );
    }
  }
  for (const directory of [...directories].reverse()) {
    const destination = path.join(stage, directory.relative);
    fs.chmodSync(destination, 0o550);
    fsyncDirectory(destination);
  }
  fs.chmodSync(stage, 0o550);
  fsyncDirectory(stage);
  fsyncDirectory(parent);
  verifyRuntime({
    runtimeRoot: stage,
    base: journal.runtime.base,
    runtimeSha: journal.runtime.sha,
    artifactDigest: journal.runtime.artifactDigest,
    installedRuntimeDigest: journal.runtime.installedRuntimeDigest,
    groupId: journal.runtime.groupId,
    requireSealed: true,
    mode: journal.runtime.mode,
  });
  return runtimeSnapshot(stage, journal.runtime.base, false)
    .filter((record) => record.scope === 'runtime');
}

function rematerializeEnvironment(journal) {
  if (!journal.transitionEnvironment) return null;
  const original = journal.metadata.find(
    (record) => record.scope === 'environment',
  );
  if (!original) throw new Error('normalization environment metadata is missing');
  const destination = journal.paths.environmentStage;
  assertGeneratedPath(
    destination,
    journal.runtime.base,
    journal.transaction.transactionId,
  );
  const ownerUid = TEST_MODE ? process.getuid() : journal.environment.ownerUid;
  copyBoundFile(
    path.join(journal.runtime.base, '.env'),
    original,
    destination,
    ownerUid,
    journal.environment.groupId,
    Number.parseInt(journal.environment.mode, 8),
  );
  fsyncDirectory(journal.runtime.base);
  return snapshotEntry(destination, 'environment', '.');
}

function recordRoot(records) {
  return records.find(
    (record) => record.scope === 'runtime' && record.relative === '.',
  );
}

function pathMatchesRecord(absolute, record) {
  if (!record || !pathEntryExists(absolute)) return false;
  try {
    return sameInode(fs.lstatSync(absolute, { bigint: true }), record);
  } catch {
    return false;
  }
}

function verifyRecordedContent(absolute, inodeRecord, contentRecord = inodeRecord) {
  const stat = reproveEntry(absolute, inodeRecord);
  const content = stableEntryContent(absolute, stat, inodeRecord.kind);
  if (content.contentSha256 !== contentRecord.contentSha256
      || content.size !== contentRecord.size) {
    throw new Error(`normalization content binding changed: ${absolute}`);
  }
}

function applyRecordedMetadata(records, expectedRecords, runtimeRoot, base) {
  const desiredBase = records.find((record) => record.scope === 'base');
  if (!desiredBase) {
    throw new Error('normalization restore metadata has no base anchor');
  }
  const guard = beginBoundMutationGuard(
    expectedRecords,
    runtimeRoot,
    base,
  );
  const ordered = records.filter((record) => record.scope !== 'base')
    .sort((left, right) => {
    const leftPath = recordPath(left, runtimeRoot, base);
    const rightPath = recordPath(right, runtimeRoot, base);
    return rightPath.split(path.sep).length - leftPath.split(path.sep).length;
  });
  try {
    for (const desired of ordered) {
      const observed = guard.recordsByIdentity.get(
        normalizationRecordIdentity(desired),
      );
      if (!observed) {
        throw new Error('normalization restore inode map is incomplete');
      }
      mutateBoundGraphEntry(
        desired,
        observed,
        guard,
      );
    }
    finishBoundMutationGuard(guard, desiredBase);
  } finally {
    closeBoundRecordChain(guard.chain);
  }
}

const NORMALIZATION_PHASES = [
  'prepared',
  'frozen',
  'staged',
  'source_moved',
  'target_installed',
  'environment_moved',
  'environment_installed',
  'committed',
];

function validateNormalizationRecord(record, label) {
  exactKeys(
    record,
    [
      'scope',
      'relative',
      'kind',
      'dev',
      'ino',
      'nlink',
      'contentSha256',
      'size',
      'uid',
      'gid',
      'mode',
    ],
    label,
  );
  const relativeIsSafe = record.relative === '.' || safeRelative(record.relative);
  const decimal = /^(?:0|[1-9][0-9]*)$/u;
  if (!['base', 'releases', 'runtime', 'environment'].includes(record.scope)
      || !relativeIsSafe
      || (!['runtime'].includes(record.scope) && record.relative !== '.')
      || !['directory', 'file', 'symlink'].includes(record.kind)
      || !decimal.test(record.dev ?? '')
      || !/^[1-9][0-9]*$/u.test(record.ino ?? '')
      || !/^[1-9][0-9]*$/u.test(record.nlink ?? '')
      || (
        record.kind === 'directory'
          ? record.contentSha256 !== null || record.size !== null
          : !DIGEST.test(record.contentSha256 ?? '')
            || !decimal.test(record.size ?? '')
      )
      || !Number.isSafeInteger(record.uid) || record.uid < 0
      || !Number.isSafeInteger(record.gid) || record.gid < 0
      || !Number.isSafeInteger(record.mode)
      || record.mode < 0 || record.mode > 0o7777
      || (
        (record.kind === 'file' || record.kind === 'symlink')
        && record.nlink !== '1'
      )) {
    throw new Error(`${label} identity is invalid`);
  }
}

function validateNormalizationRecords(records, label, allowedScopes) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`${label} is empty or invalid`);
  }
  const identities = new Set();
  for (const [index, record] of records.entries()) {
    validateNormalizationRecord(record, `${label} entry ${index}`);
    if (!allowedScopes.includes(record.scope)) {
      throw new Error(`${label} contains an invalid scope`);
    }
    const identity = `${record.scope}:${record.relative}`;
    if (identities.has(identity)) {
      throw new Error(`${label} contains a duplicate path identity`);
    }
    identities.add(identity);
  }
  const byIdentity = new Map(
    records.map((record) => [
      `${record.scope}:${record.relative}`,
      record,
    ]),
  );
  for (const scope of ['base', 'releases']) {
    const root = byIdentity.get(`${scope}:.`);
    if (allowedScopes.includes(scope)
        && (!root || root.kind !== 'directory')) {
      throw new Error(`${label} ${scope} root is not a directory`);
    }
  }
  const runtimeRoot = byIdentity.get('runtime:.');
  if (allowedScopes.includes('runtime')
      && (!runtimeRoot || runtimeRoot.kind !== 'directory')) {
    throw new Error(`${label} runtime root is not a directory`);
  }
  const environment = byIdentity.get('environment:.');
  if (environment && environment.kind !== 'file') {
    throw new Error(`${label} environment is not a regular file`);
  }
  for (const record of records) {
    if (record.scope !== 'runtime' || record.relative === '.') continue;
    const parentRelative = path.posix.dirname(record.relative);
    const parent = byIdentity.get(
      `runtime:${parentRelative === '.' ? '.' : parentRelative}`,
    );
    if (!parent || parent.kind !== 'directory') {
      throw new Error(
        `${label} contains a descendant below a non-directory parent`,
      );
    }
  }
  return identities;
}

function normalizationJournal() {
  if (!pathEntryExists(NORMALIZATION_JOURNAL)) return null;
  const journal = stableJson(
    NORMALIZATION_JOURNAL,
    'normalization transaction journal',
    { modes: [0o600], maxBytes: MAX_NORMALIZATION_JOURNAL_BYTES },
  ).value;
  exactKeys(journal, [
    'schema',
    'status',
    'phase',
    'transaction',
    'runtime',
    'environment',
    'transitionEnvironment',
    'paths',
    'metadata',
    'stagedMetadata',
    'stagedEnvironment',
    'createdAt',
    'updatedAt',
  ], 'normalization transaction journal');
  exactKeys(
    journal.transaction,
    ['transactionId', 'requestSha256', 'requestEnvelopeSha256'],
    'normalization transaction tuple',
  );
  exactKeys(journal.runtime, [
    'root',
    'base',
    'sha',
    'artifactDigest',
    'installedRuntimeDigest',
    'groupId',
    'mode',
  ], 'normalization runtime tuple');
  exactKeys(
    journal.environment,
    ['ownerUid', 'groupId', 'mode'],
    'normalization environment tuple',
  );
  const phaseIndex = NORMALIZATION_PHASES.indexOf(journal.phase);
  if (journal.schema !== 'nexus.v2-normalization-filesystem-transaction.v1'
      || !['in_progress', 'committed'].includes(journal.status)
      || !TRANSACTION_ID.test(journal.transaction?.transactionId ?? '')
      || !DIGEST.test(journal.transaction?.requestSha256 ?? '')
      || !DIGEST.test(journal.transaction?.requestEnvelopeSha256 ?? '')
      || !SHA.test(journal.runtime?.sha ?? '')
      || !DIGEST.test(journal.runtime?.artifactDigest ?? '')
      || !DIGEST.test(journal.runtime?.installedRuntimeDigest ?? '')
      || !path.isAbsolute(journal.runtime?.root ?? '')
      || !path.isAbsolute(journal.runtime?.base ?? '')
      || path.dirname(journal.runtime.root)
        !== path.join(journal.runtime.base, 'releases')
      || !Number.isSafeInteger(journal.runtime.groupId)
      || journal.runtime.groupId < 0
      || !['legacy', 'strict'].includes(journal.runtime.mode)
      || !Number.isSafeInteger(journal.environment.ownerUid)
      || journal.environment.ownerUid < 0
      || !Number.isSafeInteger(journal.environment.groupId)
      || journal.environment.groupId < 0
      || journal.environment.mode !== '0440'
      || typeof journal.transitionEnvironment !== 'boolean'
      || phaseIndex < 0
      || (journal.status === 'committed') !== (journal.phase === 'committed')
      || !journal.paths || typeof journal.paths !== 'object'
      || Array.isArray(journal.paths)
      || !Number.isFinite(Date.parse(journal.createdAt ?? ''))
      || !Number.isFinite(Date.parse(journal.updatedAt ?? ''))) {
    throw new Error('normalization transaction journal is invalid');
  }
  exactKeys(journal.paths, [
    'stage',
    'quarantine',
    'failed',
    'environmentStage',
    'environmentQuarantine',
    'environmentFailed',
  ], 'normalization generated paths');
  const metadata = validateNormalizationRecords(
    journal.metadata,
    'normalization source metadata',
    ['base', 'releases', 'runtime', 'environment'],
  );
  for (const required of ['base:.', 'releases:.', 'runtime:.']) {
    if (!metadata.has(required)) {
      throw new Error('normalization source metadata is incomplete');
    }
  }
  if (metadata.has('environment:.') !== journal.transitionEnvironment) {
    throw new Error('normalization environment metadata is inconsistent');
  }
  const stagedRequired = phaseIndex >= NORMALIZATION_PHASES.indexOf('staged');
  if (stagedRequired !== Array.isArray(journal.stagedMetadata)) {
    throw new Error('normalization staged runtime metadata is inconsistent');
  }
  if (stagedRequired) {
    const staged = validateNormalizationRecords(
      journal.stagedMetadata,
      'normalization staged metadata',
      ['runtime'],
    );
    const sourceRuntime = [...metadata].filter(
      (identity) => identity.startsWith('runtime:'),
    );
    if (sourceRuntime.length !== staged.size
        || sourceRuntime.some((identity) => !staged.has(identity))) {
      throw new Error('normalization staged runtime metadata is incomplete');
    }
    const sourceByIdentity = new Map(
      journal.metadata
        .filter((record) => record.scope === 'runtime')
        .map((record) => [`${record.scope}:${record.relative}`, record]),
    );
    for (const record of journal.stagedMetadata) {
      const source = sourceByIdentity.get(
        `${record.scope}:${record.relative}`,
      );
      if (!source || source.kind !== record.kind
          || source.contentSha256 !== record.contentSha256
          || source.size !== record.size) {
        throw new Error('normalization staged content identity differs');
      }
    }
  }
  if (journal.transitionEnvironment) {
    if (stagedRequired) {
      validateNormalizationRecord(
        journal.stagedEnvironment,
        'normalization staged environment',
      );
      if (journal.stagedEnvironment.scope !== 'environment'
          || journal.stagedEnvironment.relative !== '.'
          || journal.stagedEnvironment.kind !== 'file'
          || journal.stagedEnvironment.contentSha256
            !== journal.metadata.find(
              (record) => record.scope === 'environment',
            ).contentSha256
          || journal.stagedEnvironment.size
            !== journal.metadata.find(
              (record) => record.scope === 'environment',
            ).size) {
        throw new Error('normalization staged environment identity is invalid');
      }
    } else if (journal.stagedEnvironment !== null) {
      throw new Error('normalization staged environment appeared too early');
    }
  } else if (journal.stagedEnvironment !== null) {
    throw new Error('normalization journal has an unexpected staged environment');
  }
  if (!journal.transitionEnvironment
      && ['environment_moved', 'environment_installed'].includes(journal.phase)) {
    throw new Error('normalization environment phase is impossible');
  }
  const expectedPaths = normalizationGeneratedPaths(
    journal.runtime.root,
    journal.runtime.base,
    journal.transaction.transactionId,
  );
  if (canonicalJson(journal.paths) !== canonicalJson(expectedPaths)) {
    throw new Error('normalization transaction generated paths are invalid');
  }
  return journal;
}

function assertNormalizationAuthority(journal) {
  const receipt = validateReceipt();
  const authorization = authorizationInputs({ allowExpired: true }).production;
  if (canonicalJson(receipt.transaction) !== canonicalJson(journal.transaction)
      || receipt.authorizations.productionSha256
        !== authorization.envelopeSha256
      || canonicalJson(receipt.transaction)
        !== canonicalJson(authorization.payload.transaction)) {
    throw new Error('normalization journal transaction authority is invalid');
  }
  const signedRuntime = journal.runtime.mode === 'strict'
    ? authorization.payload.runtime.target
    : authorization.payload.runtime.predecessor;
  if (journal.runtime.root !== signedRuntime.runtime
      || journal.runtime.base !== authorization.payload.runtime.base
      || journal.runtime.sha !== signedRuntime.sha
      || journal.runtime.artifactDigest !== signedRuntime.artifactDigest
      || journal.runtime.installedRuntimeDigest
        !== signedRuntime.installedRuntimeDigest
      || journal.runtime.groupId
        !== authorization.payload.environment.legacy.groupId
      || canonicalJson(journal.environment)
        !== canonicalJson(authorization.payload.environment.modern)
      || (
        journal.transitionEnvironment
        && journal.runtime.mode !== 'strict'
      )) {
    throw new Error('normalization journal runtime tuple is not owner-authorized');
  }
}

function cleanupNormalization(journal) {
  const runtimeParent = path.join(journal.runtime.base, 'releases');
  for (const candidate of [
    journal.paths.stage,
    journal.paths.quarantine,
    journal.paths.failed,
  ]) {
    removeGenerated(
      candidate,
      runtimeParent,
      journal.transaction.transactionId,
    );
  }
  for (const candidate of [
    journal.paths.environmentStage,
    journal.paths.environmentQuarantine,
    journal.paths.environmentFailed,
  ]) {
    removeGenerated(
      candidate,
      journal.runtime.base,
      journal.transaction.transactionId,
    );
  }
  durableRemove(NORMALIZATION_JOURNAL);
}

function rollbackNormalization(journal) {
  const runtimeParent = path.join(journal.runtime.base, 'releases');
  const stagedRoot = recordRoot(journal.stagedMetadata ?? []);
  const originalRoot = recordRoot(journal.metadata);
  let expectedRuntimeMetadata;
  if (stagedRoot) {
    let stagedLocation = null;
    for (const candidate of [journal.runtime.root, journal.paths.stage]) {
      if (pathMatchesRecord(candidate, stagedRoot)) stagedLocation = candidate;
    }
    if (!stagedLocation) {
      throw new Error('rematerialized rollback runtime cannot be located');
    }
    if (stagedLocation !== journal.runtime.root) {
      if (pathEntryExists(journal.runtime.root)) {
        reproveEntry(journal.runtime.root, originalRoot);
        if (pathEntryExists(journal.paths.quarantine)) {
          removeGenerated(
            journal.paths.quarantine,
            runtimeParent,
            journal.transaction.transactionId,
          );
        }
        fs.renameSync(journal.runtime.root, journal.paths.quarantine);
        fsyncDirectory(runtimeParent);
      }
      fs.renameSync(stagedLocation, journal.runtime.root);
      fsyncDirectory(runtimeParent);
    }
    expectedRuntimeMetadata = journal.stagedMetadata;
  } else {
    if (!pathMatchesRecord(journal.runtime.root, originalRoot)) {
      if (!pathMatchesRecord(journal.paths.quarantine, originalRoot)) {
        throw new Error('original normalization runtime cannot be restored');
      }
      if (pathEntryExists(journal.runtime.root)) {
        fs.renameSync(journal.runtime.root, journal.paths.failed);
        fsyncDirectory(runtimeParent);
      }
      fs.renameSync(journal.paths.quarantine, journal.runtime.root);
      fsyncDirectory(runtimeParent);
    }
    expectedRuntimeMetadata = journal.metadata.filter(
      (record) => record.scope === 'runtime',
    );
  }

  let expectedEnvironmentMetadata = [];
  let desiredEnvironment = null;
  if (journal.transitionEnvironment) {
    desiredEnvironment = journal.metadata.find(
      (record) => record.scope === 'environment',
    );
    const stagedEnvironment = journal.stagedEnvironment ?? null;
    if (stagedEnvironment) {
      let stagedLocation = null;
      for (const candidate of [
        path.join(journal.runtime.base, '.env'),
        journal.paths.environmentStage,
      ]) {
        if (pathMatchesRecord(candidate, stagedEnvironment)) {
          stagedLocation = candidate;
        }
      }
      if (!stagedLocation) {
        throw new Error('rematerialized rollback environment cannot be located');
      }
      if (stagedLocation !== path.join(journal.runtime.base, '.env')) {
        if (pathEntryExists(path.join(journal.runtime.base, '.env'))) {
          fs.renameSync(
            path.join(journal.runtime.base, '.env'),
            journal.paths.environmentQuarantine,
          );
          fsyncDirectory(journal.runtime.base);
        }
        fs.renameSync(stagedLocation, path.join(journal.runtime.base, '.env'));
        fsyncDirectory(journal.runtime.base);
      }
      expectedEnvironmentMetadata = [stagedEnvironment];
    } else {
      expectedEnvironmentMetadata = [desiredEnvironment];
    }
  }
  const expected = [
    ...journal.metadata.filter(
      (record) => ['base', 'releases'].includes(record.scope),
    ),
    ...expectedRuntimeMetadata,
    ...expectedEnvironmentMetadata,
  ];
  applyRecordedMetadata(
    journal.metadata,
    expected,
    journal.runtime.root,
    journal.runtime.base,
  );
  if (desiredEnvironment) {
    verifyRecordedContent(
      path.join(journal.runtime.base, '.env'),
      expectedEnvironmentMetadata[0],
      desiredEnvironment,
    );
  }
  verifyRuntime({
    runtimeRoot: journal.runtime.root,
    base: journal.runtime.base,
    runtimeSha: journal.runtime.sha,
    artifactDigest: journal.runtime.artifactDigest,
    installedRuntimeDigest: journal.runtime.installedRuntimeDigest,
    groupId: journal.runtime.groupId,
    requireSealed: false,
    mode: journal.runtime.mode,
  });
  if (journal.transitionEnvironment) {
    const desiredEnvironment = journal.metadata.find(
      (record) => record.scope === 'environment',
    );
    verifyRecordedContent(
      path.join(journal.runtime.base, '.env'),
      journal.stagedEnvironment ?? desiredEnvironment,
      desiredEnvironment,
    );
    verifyEnvironmentMode(
      journal.runtime.base,
      {
        ownerUid: desiredEnvironment.uid,
        groupId: desiredEnvironment.gid,
        mode: desiredEnvironment.mode.toString(8).padStart(4, '0'),
      },
      'legacy',
    );
  }
  cleanupNormalization(journal);
}

function finishCommittedNormalization(journal) {
  verifyRuntime({
    runtimeRoot: journal.runtime.root,
    base: journal.runtime.base,
    runtimeSha: journal.runtime.sha,
    artifactDigest: journal.runtime.artifactDigest,
    installedRuntimeDigest: journal.runtime.installedRuntimeDigest,
    groupId: journal.runtime.groupId,
    requireSealed: true,
    mode: journal.runtime.mode,
  });
  if (journal.transitionEnvironment) {
    verifyRecordedContent(
      path.join(journal.runtime.base, '.env'),
      journal.stagedEnvironment,
    );
    verifyEnvironmentMode(
      journal.runtime.base,
      journal.environment,
      'modern',
    );
  }
  cleanupNormalization(journal);
}

function recoverNormalization() {
  const journal = normalizationJournal();
  if (!journal) return { recovered: false };
  assertRootExclusiveParent(journal.runtime.base);
  assertNormalizationAuthority(journal);
  if (journal.status === 'committed' || journal.phase === 'committed') {
    finishCommittedNormalization(journal);
    return { recovered: true, disposition: 'finished' };
  }
  rollbackNormalization(journal);
  return { recovered: true, disposition: 'restored' };
}

function sealRuntime({
  runtimeRoot,
  base,
  runtimeSha,
  artifactDigest,
  installedRuntimeDigest,
  groupId,
  mode,
  environment,
  transitionEnvironment,
  transaction,
  postMutationVerify,
}) {
  assertRootExclusiveParent(base);
  verifyRuntime({
    runtimeRoot,
    base,
    runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
    groupId,
    requireSealed: false,
    mode,
  });
  if (pathEntryExists(NORMALIZATION_JOURNAL)) {
    throw new Error('a normalization transaction already requires recovery');
  }
  const paths = normalizationGeneratedPaths(
    runtimeRoot,
    base,
    transaction.transactionId,
  );
  for (const generated of Object.values(paths)) {
    if (pathEntryExists(generated)) {
      throw new Error('stale normalization generated path exists');
    }
  }
  let journal = {
    schema: 'nexus.v2-normalization-filesystem-transaction.v1',
    status: 'in_progress',
    phase: 'prepared',
    transaction,
    runtime: {
      root: runtimeRoot,
      base,
      sha: runtimeSha,
      artifactDigest,
      installedRuntimeDigest,
      groupId,
      mode,
    },
    environment,
    transitionEnvironment,
    paths,
    metadata: runtimeSnapshot(runtimeRoot, base, transitionEnvironment),
    stagedMetadata: null,
    stagedEnvironment: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  journal = checkpointNormalization(journal, 'prepared');
  try {
    injectTestAdversarialReplacement(journal);
    freezeSource(journal);
    verifyRuntime({
      runtimeRoot,
      base,
      runtimeSha,
      artifactDigest,
      installedRuntimeDigest,
      groupId,
      requireSealed: true,
      mode,
    });
    journal = checkpointNormalization(journal, 'frozen');
    const stagedMetadata = rematerializeRuntime(journal);
    const stagedEnvironment = rematerializeEnvironment(journal);
    journal = checkpointNormalization(journal, 'staged', {
      stagedMetadata,
      stagedEnvironment,
    });
    reproveEntry(runtimeRoot, recordRoot(journal.metadata));
    fs.renameSync(runtimeRoot, journal.paths.quarantine);
    fsyncDirectory(path.join(base, 'releases'));
    journal = checkpointNormalization(journal, 'source_moved');
    fs.renameSync(journal.paths.stage, runtimeRoot);
    fsyncDirectory(path.join(base, 'releases'));
    journal = checkpointNormalization(journal, 'target_installed');
    if (transitionEnvironment) {
      const sourceEnvironment = journal.metadata.find(
        (record) => record.scope === 'environment',
      );
      reproveEntry(path.join(base, '.env'), sourceEnvironment);
      fs.renameSync(
        path.join(base, '.env'),
        journal.paths.environmentQuarantine,
      );
      fsyncDirectory(base);
      journal = checkpointNormalization(journal, 'environment_moved');
      fs.renameSync(journal.paths.environmentStage, path.join(base, '.env'));
      fsyncDirectory(base);
      journal = checkpointNormalization(journal, 'environment_installed');
    }
    const verified = verifyRuntime({
      runtimeRoot,
      base,
      runtimeSha,
      artifactDigest,
      installedRuntimeDigest,
      groupId,
      requireSealed: true,
      mode,
    });
    if (transitionEnvironment) {
      verifyEnvironmentMode(base, environment, 'modern');
    }
    if (TEST_MODE
        && process.env.NEXUS_V2_NORMALIZATION_TEST_FAIL_AFTER_MUTATION === '1') {
      throw new Error('injected post-mutation seal failure');
    }
    postMutationVerify();
    journal = checkpointNormalization(
      { ...journal, status: 'committed' },
      'committed',
    );
    finishCommittedNormalization(journal);
    return verified;
  } catch (error) {
    try {
      const durable = normalizationJournal();
      if (durable) rollbackNormalization(durable);
    } catch (rollbackError) {
      throw new Error(
        `normalization failed and durable recovery is required: ${
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError)
        }; original failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    throw error;
  }
}

function environmentPhase(base, policy) {
  try {
    verifyEnvironmentMode(base, policy.legacy, 'legacy');
    return 'legacy';
  } catch (legacyError) {
    try {
      verifyEnvironmentMode(base, policy.modern, 'modern');
      return 'modern';
    } catch {
      throw legacyError;
    }
  }
}

function runtimeCommand() {
  recoverNormalization();
  if (pathEntryExists(MAINTENANCE_MARKER)) {
    stableRegularFile(
      MAINTENANCE_MARKER,
      'v2 normalization maintenance marker',
      { modes: [0o600] },
    );
    throw new Error('v2 normalization maintenance is in progress');
  }
  const runtimeRoot = path.resolve(value('--root'));
  const base = path.resolve(value('--base'));
  const runtimeSha = value('--runtime-sha');
  const artifactDigest = value('--artifact-digest');
  const installedRuntimeDigest = value('--installed-runtime-digest');
  const groupId = Number(value('--group-id'));
  if (!Number.isSafeInteger(groupId) || groupId < 0) {
    throw new Error('invalid application group id');
  }
  const receipt = validateReceipt();
  const installed = runtimeJson(runtimeRoot, '.nexus-installed-runtime.json');
  const identityKeys = Object.keys(installed?.identity ?? {}).sort().join(',');
  const strictKeys = [
    'artifactDigest',
    'inputs',
    'networkIndependentInstall',
    'packageVersion',
    'runtimeSha',
    'schema',
    'trees',
  ].sort().join(',');
  const legacyKeys = [
    'artifactDigest',
    'inputs',
    'packageVersion',
    'runtimeSha',
    'schema',
    'trees',
  ].sort().join(',');
  let mode;
  const authorization = acceptedAuthorization(receipt);
  const production = authorization.production;
  let phase;
  let transitionEnvironment = false;
  if (identityKeys === strictKeys) {
    mode = 'strict';
    const target = production.payload.runtime.target;
    if (base !== production.payload.runtime.base
        || runtimeRoot !== target.runtime
        || runtimeSha !== target.sha
        || artifactDigest !== target.artifactDigest
        || installedRuntimeDigest !== target.installedRuntimeDigest
        || groupId !== production.payload.environment.legacy.groupId) {
      throw new Error('strict identity is not the exact signed active target');
    }
    phase = environmentPhase(base, production.payload.environment);
    if (command === 'verify' && phase !== 'modern') {
      throw new Error('strict target verification requires root:worker 0440 environment');
    }
    transitionEnvironment = command === 'seal' && phase === 'legacy';
  } else if (identityKeys === legacyKeys) {
    mode = 'legacy';
    const predecessor = production.payload.runtime.predecessor;
    if (base !== production.payload.runtime.base
        || runtimeRoot !== predecessor.runtime
        || runtimeSha !== predecessor.sha
        || artifactDigest !== predecessor.artifactDigest
        || installedRuntimeDigest !== predecessor.installedRuntimeDigest
        || groupId !== production.payload.environment.legacy.groupId) {
      throw new Error('legacy identity is not the exact signed active predecessor');
    }
    phase = environmentPhase(base, production.payload.environment);
    const journal = authorization.authority.journal;
    const recovering = command === 'verify'
      && journal !== null
      && (
        journal.status === 'recovery_required'
        || (journal.status === 'running' && journal.phase === 'recovering')
      );
    if (phase !== 'legacy' && !(phase === 'modern' && recovering)) {
      throw new Error(
        'legacy predecessor under modern environment is allowed only during exact recovery',
      );
    }
  } else {
    throw new Error('installed runtime identity cannot select a trusted verifier mode');
  }
  const call = command === 'seal' ? sealRuntime : verifyRuntime;
  const result = call({
    runtimeRoot,
    base,
    runtimeSha,
    artifactDigest,
    installedRuntimeDigest,
    groupId,
    requireSealed: command === 'verify',
    mode,
    environment: production.payload.environment.modern,
    transitionEnvironment,
    transaction: production.payload.transaction,
    postMutationVerify: () => acceptedAuthorization(receipt),
  });
  // Re-read every root authority surface after mutation. A transaction that
  // loses active nonterminal authority while sealing fails closed. Strict
  // target verification is still authorization-bound but never uses the
  // legacy installed-tree algorithm.
  if (command === 'verify') acceptedAuthorization(receipt);
  return { ...result, verifierMode: mode };
}

function inspectAuthorizations() {
  const productionPath = path.resolve(value('--production-authorization'));
  const publicKeyPath = path.resolve(value('--owner-public-key'));
  const machineIdPath = path.resolve(value('--machine-id-file'));
  const bridgeSha256 = value('--bridge-sha256');
  const replacedAttestorSha256 = value('--replaced-attestor-sha256');
  const controlSha256 = value('--control-sha256');
  for (const digestValue of [
    bridgeSha256,
    replacedAttestorSha256,
    controlSha256,
  ]) {
    if (!DIGEST.test(digestValue)) throw new Error('authorization inspection digest is invalid');
  }
  const result = authorizationInputs({
    productionPath,
    publicKeyPath,
    machineIdPath,
    bridgeSha256,
    replacedAttestorSha256,
    controlSha256,
    allowExpired: has('--allow-expired'),
  });
  return {
    transactionId: result.production.payload.transaction.transactionId,
    requestSha256: result.production.payload.transaction.requestSha256,
    requestEnvelopeSha256:
      result.production.payload.transaction.requestEnvelopeSha256,
    productionAuthorizationSha256: result.production.envelopeSha256,
    workerUid: result.production.payload.environment.legacy.ownerUid,
    workerGroupId: result.production.payload.environment.legacy.groupId,
    productionBase: result.production.payload.runtime.base,
    targetRuntime: result.production.payload.runtime.target.runtime,
    legacyEnvironmentMode: result.production.payload.environment.legacy.mode,
    modernEnvironmentMode: result.production.payload.environment.modern.mode,
    targetRuntimeSha: result.production.payload.runtime.target.sha,
    targetArtifactDigest:
      result.production.payload.runtime.target.artifactDigest,
    targetInstalledRuntimeDigest:
      result.production.payload.runtime.target.installedRuntimeDigest,
  };
}

try {
  let result;
  if (command === 'inspect-authorizations') {
    result = inspectAuthorizations();
  } else if (command === 'recover-normalization') {
    result = recoverNormalization();
  } else if (command === 'verify' || command === 'seal') {
    result = runtimeCommand();
  } else {
    throw new Error(
      'Usage: trusted-release-runtime-attestation-v2-bridge.mjs '
      + '<verify|seal> --root <release> --base <base> --runtime-sha <sha> '
      + '--artifact-digest <sha256> --installed-runtime-digest <sha256> '
      + '--group-id <gid>, or recover-normalization',
    );
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sealed: command === 'seal',
    ...result,
  })}\n`);
} catch (error) {
  process.stderr.write(
    `trusted_release_runtime_attestation_v2_bridge_failed:${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(1);
}
