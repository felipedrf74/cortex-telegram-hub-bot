import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertMigrationInventoryShape,
} from './migration-cd-eligibility.mjs';
import {
  assertReleaseMigrationReconciliationShape,
} from './production-migration-lineage.mjs';
import {
  assertCanonicalTimestamp,
  assertFullSha,
  assertHexSha256,
  assertOciDigest,
  assertPositiveIntegerString,
  canonicalJson,
  exactKeys,
  fail,
  sha256,
} from './release-canonical.mjs';
import {
  RELEASE_CONTROL_PLANE_SCHEMA,
  assertReleaseControlPlaneShape,
} from './release-control-plane.mjs';

export const RELEASE_MANIFEST_SCHEMA = 'nexus.release-manifest.v3';
export const RELEASE_MANIFEST_PAYLOAD_SCHEMA = 'nexus.release-manifest-payload.v3';
export const RELEASE_MANIFEST_SCHEMA_VERSION = 3;
export const LEGACY_RELEASE_MANIFEST_SCHEMA = 'nexus.release-manifest.v2';
export const LEGACY_RELEASE_MANIFEST_PAYLOAD_SCHEMA = 'nexus.release-manifest-payload.v2';
export const LEGACY_RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const CONTINUOUS_DEPLOYMENT_POLICY_PATH = 'config/continuous-deployment.json';

const MAX_PUBLIC_KEY_BYTES = 4 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const CONTINUOUS_DEPLOYMENT_POLICY_SCHEMA = 'nexus.continuous-deployment-policy.v1';
const CONTINUOUS_DEPLOYMENT_POLICY_VERSION = '2026-08-09.2';
const GOVERNED_COMPOSE_FILE = 'docker-compose.release.yml';
const POLICY_IDENTITY = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const POLICY_ENVIRONMENT_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
const POLICY_AUDIT_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const POLICY_HEARTBEAT_SCHEDULE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:[01]\d|2[0-3]):[0-5]\d$/;
const POLICY_RUNNER_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const POLICY_NODE_VERSION = /^\d+\.\d+\.\d+$/;
const POLICY_HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const POLICY_RELEASE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const POLICY_GITHUB_REPOSITORY = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;

// These values eventually become process timeouts, loop deadlines, retry
// budgets, filesystem retention limits, or provider payload sizes. Keeping the
// bounds next to the policy loader makes the JSON a finite control surface
// rather than a way to create multi-day child processes, infinite observations,
// or unbounded disk/provider use.
const MAX_RUNTIME_SECONDS = 86_400;
const MAX_AUDIT_ATTEMPTS = 100;
const MAX_IMAGE_PAIRS = 100;
const MAX_WORK_DIRS = 10_000;
const MIN_NOTIFICATION_MESSAGE_CHARS = 200;
const MAX_NOTIFICATION_MESSAGE_CHARS = 4_096;
const MAX_BOOTSTRAP_DATABASE_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_COMPOSE_BYTES = 1024 * 1024;
const MAX_MANIFEST_AGE_SECONDS = 7 * 24 * 60 * 60;
const REQUIRED_PI_LABELS = ['self-hosted', 'linux', 'ARM64', 'nexus-pi'];
const REQUIRED_PI_FORBIDDEN_CAPABILITIES = [
  'docker-socket',
  'production-secrets',
  'deploy-key',
  'production-audit-access',
];

const REQUIRED_POLICY_PATHS = [
  'stateDir',
  'receiptDir',
  'bootstrapBaselineFile',
  'lockFile',
  'workDir',
  'maintenanceLockFile',
];
const REQUIRED_TRUST_STRINGS = [
  'repository',
  'protectedRef',
  'workflow',
  'signingKeyId',
];
const REQUIRED_ENVIRONMENT_STRINGS = ['composeProject'];
const REQUIRED_ENVIRONMENT_PATHS = [
  'backendEnvFile',
  'contentEngineEnvFile',
  'dataDir',
];
const REQUIRED_COMPOSE_IDENTITIES = [
  'backendService',
  'contentEngineService',
  'migratorService',
];
const REQUIRED_TIMING_SECONDS = [
  'pollIntervalSeconds',
  'observationSeconds',
  'rollbackObjectiveSeconds',
  'healthBudgetSeconds',
  'stagingHealthBudgetSeconds',
  'migratorTimeoutSeconds',
  'backupTimeoutSeconds',
  'protectedHeadTimeoutSeconds',
];

function requirePolicyObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requirePolicyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePolicyAbsolutePath(value, label) {
  if (typeof value !== 'string'
      || !path.isAbsolute(value)
      || value.includes('\0')
      || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`);
  }
  return value;
}

function requirePolicyBoundedInteger(value, label, { min = 1, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requirePolicyBoolean(value, label) {
  if (typeof value !== 'boolean') {
    fail(`${label} must be a boolean`);
  }
  return value;
}

function requirePolicyStringArray(value, label, {
  min = 1,
  max = 64,
  validate = () => true,
} = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label} must be a bounded non-empty string array`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || !validate(entry)) {
      fail(`${label} contains an unsafe value`);
    }
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} must not contain duplicates`);
  }
  return value;
}

function requirePolicyImageRepository(value, host, label) {
  requirePolicyString(value, label);
  if (value.length > 255 || !value.startsWith(`${host}/`)) {
    fail(`${label} must be a repository below the governed registry host`);
  }
  const components = value.slice(host.length + 1).split('/');
  if (components.length < 2 || components.some((component) => (
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(component)
  ))) {
    fail(`${label} must be a safe lowercase OCI repository`);
  }
  return value;
}

function requirePolicyRelativePrefix(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
      || value.startsWith('/') || value.startsWith('-') || value.includes('\\')
      || value.includes('\0')) {
    fail(`${label} must be a safe repository-relative path prefix`);
  }
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutTrailingSlash.length === 0
      || path.posix.normalize(withoutTrailingSlash) !== withoutTrailingSlash
      || withoutTrailingSlash === '..'
      || withoutTrailingSlash.startsWith('../')
      || withoutTrailingSlash.includes('/../')) {
    fail(`${label} must be a normalized repository-relative path prefix`);
  }
  return true;
}

function requirePolicyIdentity(value, label) {
  requirePolicyString(value, label);
  if (!POLICY_IDENTITY.test(value)) {
    fail(`${label} must be a bounded lowercase service identity`);
  }
  return value;
}

function requireDistinctPolicyValues(entries, label) {
  const values = entries.map(([, value]) => value);
  if (new Set(values).size !== values.length) {
    fail(`${label} must be distinct`);
  }
}

function policyPathsOverlap(left, right) {
  const relative = path.relative(left, right);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

function requireNonOverlappingPolicyPaths(entries, label) {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const [leftName, leftPath] = entries[leftIndex];
      const [rightName, rightPath] = entries[rightIndex];
      if (policyPathsOverlap(leftPath, rightPath)
          || policyPathsOverlap(rightPath, leftPath)) {
        fail(`${label} must not overlap (${leftName}, ${rightName})`);
      }
    }
  }
}

function requirePolicyPort(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    fail(`${label} must be a valid TCP port`);
  }
  return value;
}

/**
 * The host policy is a release control, not a best-effort configuration file.
 * Every field consumed to establish trust, filesystem containment, registry
 * identity, or environment isolation is therefore required at load time.
 */
function assertContinuousDeploymentPolicyShape(policy) {
  requirePolicyObject(policy, 'continuous deployment policy');
  if (policy.schema !== CONTINUOUS_DEPLOYMENT_POLICY_SCHEMA) {
    fail('continuous deployment policy schema is unsupported');
  }
  requirePolicyString(policy.version, 'continuous deployment policy version');
  if (policy.version !== CONTINUOUS_DEPLOYMENT_POLICY_VERSION) {
    fail(`continuous deployment policy version is unsupported; expected ${CONTINUOUS_DEPLOYMENT_POLICY_VERSION}`);
  }

  const backup = requirePolicyObject(policy.backup, 'continuous deployment policy backup');
  requirePolicyAbsolutePath(backup.root, 'continuous deployment policy backup.root');
  requirePolicyAbsolutePath(
    backup.receiptPath,
    'continuous deployment policy backup.receiptPath',
  );
  requirePolicyAbsolutePath(
    backup.expectedDatabase,
    'continuous deployment policy backup.expectedDatabase',
  );
  requirePolicyBoundedInteger(
    backup.maxReceiptAgeSeconds,
    'continuous deployment policy backup.maxReceiptAgeSeconds',
    { max: MAX_RUNTIME_SECONDS },
  );

  const paths = requirePolicyObject(policy.paths, 'continuous deployment policy paths');
  for (const field of REQUIRED_POLICY_PATHS) {
    requirePolicyAbsolutePath(paths[field], `continuous deployment policy paths.${field}`);
  }
  // A new path field cannot silently arrive as a relative path merely because
  // this loader predates it.
  for (const [field, value] of Object.entries(paths)) {
    requirePolicyAbsolutePath(value, `continuous deployment policy paths.${field}`);
  }

  const registry = requirePolicyObject(
    policy.registry,
    'continuous deployment policy registry',
  );
  requirePolicyString(registry.host, 'continuous deployment policy registry.host');
  if (!POLICY_HOSTNAME.test(registry.host)) {
    fail('continuous deployment policy registry.host must be a safe lowercase hostname');
  }
  for (const field of ['backendImage', 'contentEngineImage', 'releaseImage']) {
    requirePolicyImageRepository(
      registry[field],
      registry.host,
      `continuous deployment policy registry.${field}`,
    );
  }
  requirePolicyString(registry.releaseTag, 'continuous deployment policy registry.releaseTag');
  if (!POLICY_RELEASE_TAG.test(registry.releaseTag)) {
    fail('continuous deployment policy registry.releaseTag must be a safe OCI tag');
  }
  requirePolicyBoundedInteger(
    registry.retainedImagePairs,
    'continuous deployment policy registry.retainedImagePairs',
    { min: 2, max: MAX_IMAGE_PAIRS },
  );

  const trust = requirePolicyObject(policy.trust, 'continuous deployment policy trust');
  for (const field of REQUIRED_TRUST_STRINGS) {
    requirePolicyString(trust[field], `continuous deployment policy trust.${field}`);
  }
  if (!POLICY_GITHUB_REPOSITORY.test(trust.repository)) {
    fail('continuous deployment policy trust.repository must be a canonical lowercase GitHub repository');
  }
  if (trust.protectedRef !== 'refs/heads/main') {
    fail('continuous deployment policy trust.protectedRef must be refs/heads/main');
  }
  requirePolicyString(
    trust.protectedRepositoryUrl,
    'continuous deployment policy trust.protectedRepositoryUrl',
  );
  if (trust.protectedRepositoryUrl !== `https://github.com/${trust.repository}.git`) {
    fail('continuous deployment policy trust.protectedRepositoryUrl must be the credential-free canonical GitHub URL');
  }
  requirePolicyAbsolutePath(
    trust.publicKeyPath,
    'continuous deployment policy trust.publicKeyPath',
  );
  requirePolicyBoundedInteger(
    trust.maxManifestBytes,
    'continuous deployment policy trust.maxManifestBytes',
    { max: MAX_MANIFEST_BYTES },
  );
  requirePolicyBoundedInteger(
    trust.maxComposeBytes,
    'continuous deployment policy trust.maxComposeBytes',
    { max: MAX_COMPOSE_BYTES },
  );
  requirePolicyBoundedInteger(
    trust.maxManifestAgeSeconds,
    'continuous deployment policy trust.maxManifestAgeSeconds',
    { max: MAX_MANIFEST_AGE_SECONDS },
  );

  const environments = requirePolicyObject(
    policy.environments,
    'continuous deployment policy environments',
  );
  for (const environmentName of ['staging', 'production']) {
    const environment = requirePolicyObject(
      environments[environmentName],
      `continuous deployment policy environments.${environmentName}`,
    );
    for (const field of REQUIRED_ENVIRONMENT_STRINGS) {
      requirePolicyString(
        environment[field],
        `continuous deployment policy environments.${environmentName}.${field}`,
      );
    }
    for (const field of REQUIRED_ENVIRONMENT_PATHS) {
      requirePolicyAbsolutePath(
        environment[field],
        `continuous deployment policy environments.${environmentName}.${field}`,
      );
    }
    requirePolicyPort(
      environment.backendPort,
      `continuous deployment policy environments.${environmentName}.backendPort`,
    );
    requirePolicyPort(
      environment.contentEnginePort,
      `continuous deployment policy environments.${environmentName}.contentEnginePort`,
    );
  }

  const compose = requirePolicyObject(policy.compose, 'continuous deployment policy compose');
  requirePolicyString(compose.file, 'continuous deployment policy compose.file');
  if (compose.file !== GOVERNED_COMPOSE_FILE) {
    fail(`continuous deployment policy compose.file must be ${GOVERNED_COMPOSE_FILE}`);
  }
  for (const field of REQUIRED_COMPOSE_IDENTITIES) {
    requirePolicyIdentity(compose[field], `continuous deployment policy compose.${field}`);
  }
  requireDistinctPolicyValues(
    REQUIRED_COMPOSE_IDENTITIES.map((field) => [field, compose[field]]),
    'continuous deployment policy Compose service identities',
  );
  // composeRunMigrator extracts this fixed service from the signed v1 topology;
  // accepting a different policy identity would validate one service and run
  // another.
  if (compose.migratorService !== 'migrator') {
    fail('continuous deployment policy compose.migratorService must be migrator for schema v1');
  }

  const bootstrap = requirePolicyObject(
    policy.bootstrap,
    'continuous deployment policy bootstrap',
  );
  for (const field of ['legacyProductionDatabase', 'legacyStagingDatabase']) {
    requirePolicyAbsolutePath(
      bootstrap[field],
      `continuous deployment policy bootstrap.${field}`,
    );
  }
  requireDistinctPolicyValues(
    [
      ['legacyProductionDatabase', bootstrap.legacyProductionDatabase],
      ['legacyStagingDatabase', bootstrap.legacyStagingDatabase],
    ],
    'continuous deployment policy bootstrap legacy databases',
  );
  requirePolicyBoundedInteger(
    bootstrap.maxBaselineAgeSeconds,
    'continuous deployment policy bootstrap.maxBaselineAgeSeconds',
    { max: MAX_RUNTIME_SECONDS },
  );
  requirePolicyBoundedInteger(
    bootstrap.maxDatabaseBytes,
    'continuous deployment policy bootstrap.maxDatabaseBytes',
    { min: 4_096, max: MAX_BOOTSTRAP_DATABASE_BYTES },
  );

  const timing = requirePolicyObject(policy.timing, 'continuous deployment policy timing');
  for (const field of REQUIRED_TIMING_SECONDS) {
    requirePolicyBoundedInteger(
      timing[field],
      `continuous deployment policy timing.${field}`,
      { max: MAX_RUNTIME_SECONDS },
    );
  }
  if (timing.healthBudgetSeconds > timing.rollbackObjectiveSeconds) {
    fail('continuous deployment policy timing.healthBudgetSeconds must not exceed rollbackObjectiveSeconds');
  }

  const notifications = requirePolicyObject(
    policy.notifications,
    'continuous deployment policy notifications',
  );
  for (const field of ['failureEnabled', 'recoveryEnabled', 'heartbeatEnabled']) {
    requirePolicyBoolean(
      notifications[field],
      `continuous deployment policy notifications.${field}`,
    );
  }
  requirePolicyString(
    notifications.heartbeatSchedule,
    'continuous deployment policy notifications.heartbeatSchedule',
  );
  if (!POLICY_HEARTBEAT_SCHEDULE.test(notifications.heartbeatSchedule)) {
    fail('continuous deployment policy notifications.heartbeatSchedule must use Ddd HH:MM');
  }
  requirePolicyBoundedInteger(
    notifications.maxMessageChars,
    'continuous deployment policy notifications.maxMessageChars',
    { min: MIN_NOTIFICATION_MESSAGE_CHARS, max: MAX_NOTIFICATION_MESSAGE_CHARS },
  );

  const auditMirror = requirePolicyObject(
    policy.auditMirror,
    'continuous deployment policy auditMirror',
  );
  requirePolicyBoolean(
    auditMirror.enabled,
    'continuous deployment policy auditMirror.enabled',
  );
  requirePolicyString(auditMirror.user, 'continuous deployment policy auditMirror.user');
  if (!POLICY_AUDIT_USER.test(auditMirror.user)) {
    fail('continuous deployment policy auditMirror.user must be a bounded account name');
  }
  requirePolicyAbsolutePath(auditMirror.path, 'continuous deployment policy auditMirror.path');
  // The path is transmitted as a positional argument to a fixed remote shell
  // transaction. Constrain it to ordinary POSIX path characters so policy bytes
  // can never become remote shell syntax.
  if (!/^\/[a-z0-9._/-]+$/.test(auditMirror.path)
      || auditMirror.path.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail('continuous deployment policy auditMirror.path must be a safe remote absolute path');
  }
  requirePolicyString(
    auditMirror.hostEnvVar,
    'continuous deployment policy auditMirror.hostEnvVar',
  );
  if (!POLICY_ENVIRONMENT_VARIABLE.test(auditMirror.hostEnvVar)) {
    fail('continuous deployment policy auditMirror.hostEnvVar must be an environment variable name');
  }
  for (const field of ['identityFile', 'knownHostsFile', 'queueDir']) {
    requirePolicyAbsolutePath(
      auditMirror[field],
      `continuous deployment policy auditMirror.${field}`,
    );
  }
  requirePolicyBoundedInteger(
    auditMirror.timeoutSeconds,
    'continuous deployment policy auditMirror.timeoutSeconds',
    { max: MAX_RUNTIME_SECONDS },
  );
  requirePolicyBoundedInteger(
    auditMirror.maxAttempts,
    'continuous deployment policy auditMirror.maxAttempts',
    { max: MAX_AUDIT_ATTEMPTS },
  );

  const retention = requirePolicyObject(
    policy.retention,
    'continuous deployment policy retention',
  );
  requirePolicyBoundedInteger(
    retention.workDirs,
    'continuous deployment policy retention.workDirs',
    { min: 2, max: MAX_WORK_DIRS },
  );
  exactKeys(retention, ['workDirs'], 'continuous deployment policy retention');

  const staging = environments.staging;
  const production = environments.production;
  requireDistinctPolicyValues(
    [
      ['staging', staging.composeProject],
      ['production', production.composeProject],
    ],
    'continuous deployment policy environment compose projects',
  );
  for (const [environmentName, environment] of [
    ['staging', staging],
    ['production', production],
  ]) {
    requirePolicyIdentity(
      environment.composeProject,
      `continuous deployment policy environments.${environmentName}.composeProject`,
    );
  }
  requireDistinctPolicyValues(
    [
      ['staging.backendPort', staging.backendPort],
      ['staging.contentEnginePort', staging.contentEnginePort],
      ['production.backendPort', production.backendPort],
      ['production.contentEnginePort', production.contentEnginePort],
    ],
    'continuous deployment policy environment service ports',
  );
  for (const field of REQUIRED_ENVIRONMENT_PATHS) {
    requireDistinctPolicyValues(
      [
        [`staging.${field}`, staging[field]],
        [`production.${field}`, production[field]],
      ],
      `continuous deployment policy environment ${field} paths`,
    );
  }
  requireNonOverlappingPolicyPaths(
    REQUIRED_ENVIRONMENT_PATHS.flatMap((field) => ([
      [`staging.${field}`, staging[field]],
      [`production.${field}`, production[field]],
    ])),
    'continuous deployment policy environment filesystem identities',
  );
  const mirrorQueueRoots = [
    ['queue', auditMirror.queueDir],
    ['quarantine', path.join(auditMirror.queueDir, 'quarantine')],
    ['exhausted', path.join(auditMirror.queueDir, 'failed')],
    ['delivered', path.join(auditMirror.queueDir, 'delivered')],
  ];
  for (const [name, mirrorPath] of mirrorQueueRoots) {
    if (policyPathsOverlap(paths.receiptDir, mirrorPath)
        || policyPathsOverlap(mirrorPath, paths.receiptDir)) {
      fail(`continuous deployment policy authoritative receipt and audit ${name} roots must not overlap`);
    }
  }
  const expectedProductionDatabase = path.join(production.dataDir, 'bot.db');
  if (backup.expectedDatabase !== expectedProductionDatabase) {
    fail('continuous deployment policy backup.expectedDatabase must equal environments.production.dataDir/bot.db');
  }
  requireDistinctPolicyValues(
    [
      ['legacyProductionDatabase', bootstrap.legacyProductionDatabase],
      ['legacyStagingDatabase', bootstrap.legacyStagingDatabase],
      ['targetProductionDatabase', expectedProductionDatabase],
      ['targetStagingDatabase', path.join(staging.dataDir, 'bot.db')],
    ],
    'continuous deployment policy bootstrap database paths',
  );

  const piRunner = requirePolicyObject(
    policy.piRunner,
    'continuous deployment policy piRunner',
  );
  const labels = requirePolicyStringArray(
    piRunner.labels,
    'continuous deployment policy piRunner.labels',
    { max: 16, validate: (value) => POLICY_RUNNER_LABEL.test(value) },
  );
  if (canonicalJson([...labels].sort()) !== canonicalJson([...REQUIRED_PI_LABELS].sort())) {
    fail('continuous deployment policy piRunner.labels must preserve the governed test-only runner identity');
  }
  for (const field of ['requiredArch', 'requiredOs']) {
    requirePolicyIdentity(
      piRunner[field],
      `continuous deployment policy piRunner.${field}`,
    );
  }
  requirePolicyBoundedInteger(
    piRunner.minUsableMemoryGiB,
    'continuous deployment policy piRunner.minUsableMemoryGiB',
    { max: 1_024 },
  );
  requirePolicyBoundedInteger(
    piRunner.minFreeStorageGiB,
    'continuous deployment policy piRunner.minFreeStorageGiB',
    { max: 100_000 },
  );
  requirePolicyString(piRunner.nodeVersion, 'continuous deployment policy piRunner.nodeVersion');
  if (!POLICY_NODE_VERSION.test(piRunner.nodeVersion)) {
    fail('continuous deployment policy piRunner.nodeVersion must be an exact semver triplet');
  }
  requirePolicyBoundedInteger(
    piRunner.focusedSuiteBudgetSeconds,
    'continuous deployment policy piRunner.focusedSuiteBudgetSeconds',
    { max: 3_600 },
  );
  requirePolicyStringArray(
    piRunner.requiredEgressHosts,
    'continuous deployment policy piRunner.requiredEgressHosts',
    { max: 32, validate: (value) => POLICY_HOSTNAME.test(value) },
  );
  const forbiddenCapabilities = requirePolicyStringArray(
    piRunner.forbiddenCapabilities,
    'continuous deployment policy piRunner.forbiddenCapabilities',
    { max: 16, validate: (value) => POLICY_IDENTITY.test(value) },
  );
  if (canonicalJson([...forbiddenCapabilities].sort())
      !== canonicalJson([...REQUIRED_PI_FORBIDDEN_CAPABILITIES].sort())) {
    fail('continuous deployment policy piRunner.forbiddenCapabilities must preserve every test-only isolation check');
  }
  requirePolicyStringArray(
    piRunner.budgetSuite,
    'continuous deployment policy piRunner.budgetSuite',
    {
      max: 32,
      validate: (value) => value.startsWith('__tests__/')
        && value.endsWith('.test.ts')
        && requirePolicyRelativePrefix(value, 'continuous deployment policy piRunner.budgetSuite entry'),
    },
  );

  requirePolicyStringArray(
    policy.iosContractPaths,
    'continuous deployment policy iosContractPaths',
    {
      max: 64,
      validate: (value) => requirePolicyRelativePrefix(
        value,
        'continuous deployment policy iosContractPaths entry',
      ),
    },
  );

  // Policy v1 is closed everywhere except `paths`. The path map is deliberately
  // additive so a newer operator path cannot bypass validation: every extra
  // entry is still required to be normalized and absolute by the catch-all loop
  // above. All other additions require a supported policy-version change.
  exactKeys(policy, [
    'schema', 'version', 'trust', 'registry', 'compose', 'bootstrap',
    'environments', 'paths', 'timing', 'auditMirror', 'notifications',
    'piRunner', 'iosContractPaths', 'backup', 'retention',
  ], 'continuous deployment policy');
  exactKeys(backup, [
    'root', 'receiptPath', 'maxReceiptAgeSeconds', 'expectedDatabase',
  ], 'continuous deployment policy backup');
  exactKeys(registry, [
    'host', 'backendImage', 'contentEngineImage', 'releaseImage', 'releaseTag',
    'retainedImagePairs',
  ], 'continuous deployment policy registry');
  exactKeys(trust, [
    ...REQUIRED_TRUST_STRINGS,
    'protectedRepositoryUrl', 'publicKeyPath', 'maxManifestBytes', 'maxComposeBytes',
    'maxManifestAgeSeconds',
  ], 'continuous deployment policy trust');
  exactKeys(environments, ['staging', 'production'], 'continuous deployment policy environments');
  for (const environmentName of ['staging', 'production']) {
    exactKeys(environments[environmentName], [
      ...REQUIRED_ENVIRONMENT_STRINGS,
      'backendPort', 'contentEnginePort',
      ...REQUIRED_ENVIRONMENT_PATHS,
    ], `continuous deployment policy environments.${environmentName}`);
  }
  exactKeys(compose, [
    'file', ...REQUIRED_COMPOSE_IDENTITIES,
  ], 'continuous deployment policy compose');
  exactKeys(bootstrap, [
    'legacyProductionDatabase', 'legacyStagingDatabase',
    'maxBaselineAgeSeconds', 'maxDatabaseBytes',
  ], 'continuous deployment policy bootstrap');
  exactKeys(timing, REQUIRED_TIMING_SECONDS, 'continuous deployment policy timing');
  exactKeys(notifications, [
    'failureEnabled', 'recoveryEnabled', 'heartbeatEnabled',
    'heartbeatSchedule', 'maxMessageChars',
  ], 'continuous deployment policy notifications');
  exactKeys(auditMirror, [
    'enabled', 'user', 'path', 'hostEnvVar', 'identityFile', 'timeoutSeconds',
    'knownHostsFile', 'maxAttempts', 'queueDir',
  ], 'continuous deployment policy auditMirror');
  exactKeys(piRunner, [
    'labels', 'requiredArch', 'requiredOs', 'minUsableMemoryGiB',
    'minFreeStorageGiB', 'nodeVersion', 'focusedSuiteBudgetSeconds',
    'requiredEgressHosts', 'forbiddenCapabilities', 'budgetSuite',
  ], 'continuous deployment policy piRunner');

  return policy;
}

/**
 * The signed release manifest is the only thing the VPS poller trusts. It binds
 * one protected-main commit to the exact pair of image digests, the exact
 * Compose topology, and the exact migration verdict, so a poller that verifies
 * the signature has verified the whole deployable release without needing a git
 * checkout, a build, or any CI credential.
 */

export function loadContinuousDeploymentPolicy(root = process.cwd()) {
  const policyPath = path.join(root, CONTINUOUS_DEPLOYMENT_POLICY_PATH);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  return assertContinuousDeploymentPolicyShape(policy);
}

function readEd25519PublicKey(publicKeyPath) {
  let stat;
  try {
    stat = fs.lstatSync(publicKeyPath);
  } catch {
    fail(`pinned release signing key is missing at ${publicKeyPath}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PUBLIC_KEY_BYTES) {
    fail('pinned release signing key is not a bounded regular file');
  }
  try {
    const key = createPublicKey(fs.readFileSync(publicKeyPath, 'utf8'));
    if (key.asymmetricKeyType !== 'ed25519') fail('pinned release signing key is not Ed25519');
    return key;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('pinned release signing key')) throw error;
    return fail('pinned release signing key is malformed');
  }
}

function assertImageReference(value, expectedRepository, label) {
  const image = exactKeys(value, ['repository', 'digest'], label);
  if (image.repository !== expectedRepository) {
    fail(`${label} repository is not the governed image repository`);
  }
  assertOciDigest(image.digest, `${label} digest`);
  return image;
}

function assertCdEligibility(value) {
  const eligibility = exactKeys(
    value,
    ['eligible', 'predecessorCompatible', 'reasons'],
    'release manifest migration cdEligibility',
  );
  if (typeof eligibility.eligible !== 'boolean'
      || typeof eligibility.predecessorCompatible !== 'boolean') {
    fail('release manifest migration cdEligibility flags must be booleans');
  }
  if (!Array.isArray(eligibility.reasons)
      || eligibility.reasons.some((reason) => typeof reason !== 'string' || reason.length === 0)
      || eligibility.reasons.length > 32) {
    fail('release manifest migration cdEligibility reasons must be a bounded string list');
  }
  return eligibility;
}

/**
 * Validate and normalize a payload before signing. Building and verifying share
 * this function so a manifest that CI can produce is always a manifest the
 * poller can accept.
 */
export function buildReleaseManifestPayload({
  createdAt,
  source,
  images,
  compose,
  migrations,
  controlPlane,
  policy,
}) {
  const payload = {
    schema: RELEASE_MANIFEST_PAYLOAD_SCHEMA,
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    createdAt,
    source: {
      repository: source?.repository,
      ref: source?.ref,
      sha: source?.sha,
      workflow: source?.workflow,
      runId: String(source?.runId ?? ''),
      runAttempt: String(source?.runAttempt ?? ''),
    },
    images: {
      backend: { repository: images?.backend?.repository, digest: images?.backend?.digest },
      contentEngine: {
        repository: images?.contentEngine?.repository,
        digest: images?.contentEngine?.digest,
      },
    },
    compose: { path: compose?.path, digest: compose?.digest },
    controlPlane: {
      schema: controlPlane?.schema,
      digest: controlPlane?.digest,
    },
    migrations: {
      digest: migrations?.digest,
      upFileCount: migrations?.upFileCount,
      downFileCount: migrations?.downFileCount,
      cdEligibility: migrations?.cdEligibility,
      inventory: migrations?.inventory,
      reconciliation: migrations?.reconciliation,
    },
  };
  assertReleaseManifestPayloadShape(payload, policy);
  return payload;
}

export function assertReleaseManifestPayloadShape(
  payload,
  policy,
  { allowLegacyControlPlane = false } = {},
) {
  const legacy = payload?.schema === LEGACY_RELEASE_MANIFEST_PAYLOAD_SCHEMA
    && payload?.schemaVersion === LEGACY_RELEASE_MANIFEST_SCHEMA_VERSION;
  if (legacy) {
    if (!allowLegacyControlPlane) {
      fail('legacy release manifest payload is not admissible as a new candidate');
    }
    exactKeys(payload, [
      'schema', 'schemaVersion', 'createdAt', 'source', 'images', 'compose', 'migrations',
    ], 'legacy release manifest payload');
  } else {
    exactKeys(payload, [
      'schema', 'schemaVersion', 'createdAt', 'source', 'images', 'compose',
      'controlPlane', 'migrations',
    ], 'release manifest payload');
    if (payload.schema !== RELEASE_MANIFEST_PAYLOAD_SCHEMA) {
      fail('release manifest payload schema is invalid');
    }
    if (payload.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
      fail('release manifest payload schema version is unsupported');
    }
    assertReleaseControlPlaneShape(payload.controlPlane, 'release manifest controlPlane');
  }
  assertCanonicalTimestamp(payload.createdAt, 'release manifest createdAt');

  const source = exactKeys(payload.source, [
    'repository', 'ref', 'sha', 'workflow', 'runId', 'runAttempt',
  ], 'release manifest source');
  if (source.repository !== policy.trust.repository) {
    fail('release manifest source repository is not the governed repository');
  }
  if (source.ref !== policy.trust.protectedRef) {
    fail('release manifest source ref is not the protected branch');
  }
  if (source.workflow !== policy.trust.workflow) {
    fail('release manifest source workflow is not the governed release workflow');
  }
  assertFullSha(source.sha, 'release manifest source sha');
  assertPositiveIntegerString(source.runId, 'release manifest source runId');
  assertPositiveIntegerString(source.runAttempt, 'release manifest source runAttempt');

  exactKeys(payload.images, ['backend', 'contentEngine'], 'release manifest images');
  assertImageReference(payload.images.backend, policy.registry.backendImage, 'release manifest backend image');
  assertImageReference(
    payload.images.contentEngine,
    policy.registry.contentEngineImage,
    'release manifest content engine image',
  );
  if (payload.images.backend.digest === payload.images.contentEngine.digest) {
    fail('release manifest backend and content engine digests must be distinct images');
  }

  const compose = exactKeys(payload.compose, ['path', 'digest'], 'release manifest compose');
  if (compose.path !== policy.compose.file) {
    fail('release manifest compose path is not the governed Compose file');
  }
  assertHexSha256(compose.digest, 'release manifest compose digest');

  const migrations = exactKeys(payload.migrations, [
    'digest', 'upFileCount', 'downFileCount', 'cdEligibility', 'inventory',
    'reconciliation',
  ], 'release manifest migrations');
  assertHexSha256(migrations.digest, 'release manifest migration digest');
  for (const field of ['upFileCount', 'downFileCount']) {
    if (!Number.isSafeInteger(migrations[field]) || migrations[field] < 0) {
      fail(`release manifest migration ${field} must be a non-negative integer`);
    }
  }
  const eligibility = assertCdEligibility(migrations.cdEligibility);
  // The summary verdict must not contradict itself. `eligible` is derived from
  // predecessor compatibility, so a manifest asserting both `eligible: true` and
  // `predecessorCompatible: false` is either tampered or computed by code that
  // disagrees with the reconciler — either way it must not deploy.
  if (eligibility.eligible && !eligibility.predecessorCompatible) {
    fail('release manifest claims CD eligibility for a predecessor-incompatible migration set');
  }
  if (!eligibility.predecessorCompatible && eligibility.reasons.length === 0) {
    fail('release manifest declares migrations incompatible without naming a reason');
  }
  assertMigrationInventoryShape(migrations.inventory);
  const reconciliation = assertReleaseMigrationReconciliationShape(
    migrations.reconciliation,
  );
  if (migrations.inventory.length !== migrations.upFileCount) {
    fail('release manifest migration inventory does not cover every up migration');
  }
  const inventoryByFile = new Map(
    migrations.inventory.map((entry) => [entry.file, entry]),
  );
  for (const environment of ['production', 'staging']) {
    for (const legacy of reconciliation.environments[environment].legacyRows) {
      const replacement = inventoryByFile.get(legacy.replacement.file);
      if (!replacement || replacement.sha256 !== legacy.replacement.sha256) {
        fail(
          `release manifest ${environment} legacy mapping replacement is absent or changed: `
          + legacy.replacement.file,
        );
      }
    }
  }
  for (const exemption of reconciliation.compatibilityExemptions) {
    const entry = inventoryByFile.get(exemption.file);
    if (!entry || entry.sha256 !== exemption.sha256
        || entry.kind !== exemption.effectiveKind
        || entry.predecessorCompatible !== true) {
      fail(`release manifest compatibility exemption is not reflected in inventory: ${exemption.file}`);
    }
  }
  // The digest commits to the whole migration decision the manifest carries —
  // the summary verdict *and* the ordered inventory with its byte digests and
  // classifications — so the deployment host recomputes it rather than trusting
  // it. Binding only the summary let a flipped per-file classification through.
  if (migrations.digest !== migrationVerdictDigest(
    migrations.cdEligibility,
    migrations.inventory,
    reconciliation,
  )) {
    fail('release manifest migration digest does not match its verdict and inventory');
  }
  return payload;
}

/**
 * Digest over the entire migration decision the manifest carries: the summary
 * verdict and the complete ordered inventory. CI and the deployment host compute
 * it identically, so it is an integrity check rather than an opaque identifier,
 * and a single altered per-file classification changes it.
 */
export function migrationVerdictDigest(cdEligibility, inventory, reconciliation) {
  return sha256(canonicalJson({
    eligible: cdEligibility.eligible,
    predecessorCompatible: cdEligibility.predecessorCompatible,
    reasons: cdEligibility.reasons,
    inventory: (inventory ?? []).map((entry) => ({
      file: entry.file,
      sha256: entry.sha256,
      kind: entry.kind,
      predecessorCompatible: entry.predecessorCompatible,
    })),
    reconciliation: assertReleaseMigrationReconciliationShape(reconciliation),
  }));
}

export function signReleaseManifest({ payload, privateKeyPem, keyId, policy }) {
  assertReleaseManifestPayloadShape(payload, policy);
  if (keyId !== policy.trust.signingKeyId) {
    fail('release manifest signing key id is not the governed key id');
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    return fail('release manifest signing key is malformed');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('release manifest signing key is not Ed25519');
  }
  const signature = cryptoSign(null, Buffer.from(canonicalJson(payload)), privateKey);
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    keyId,
    signatureAlgorithm: 'ed25519',
    payload,
    signature: signature.toString('base64'),
  };
}

/**
 * Verify a manifest envelope against the pinned key and the governed identity.
 * Every rejection is fail-closed: an unknown key id, a drifted repository or
 * workflow, a non-protected ref, a malformed digest, or a stale timestamp all
 * refuse the release rather than downgrading it to a warning.
 */
export function verifyReleaseManifest({
  envelope,
  policy,
  publicKeyPath = policy?.trust?.publicKeyPath,
  nowMs = Date.now(),
  allowLegacyControlPlane = false,
}) {
  if (!policy) fail('release manifest verification requires the deployment policy');
  exactKeys(envelope, [
    'schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature',
  ], 'release manifest envelope');
  const legacyEnvelope = envelope.schema === LEGACY_RELEASE_MANIFEST_SCHEMA;
  if (envelope.schema !== RELEASE_MANIFEST_SCHEMA
      && !(allowLegacyControlPlane && legacyEnvelope)) {
    fail('release manifest envelope schema is invalid');
  }
  if (envelope.keyId !== policy.trust.signingKeyId) {
    fail('release manifest key id is not the pinned signing key');
  }
  if (envelope.signatureAlgorithm !== 'ed25519'
      || typeof envelope.signature !== 'string'
      || !SIGNATURE_BASE64.test(envelope.signature)) {
    fail('release manifest signature envelope is malformed');
  }
  const signature = Buffer.from(envelope.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== envelope.signature) {
    fail('release manifest signature is malformed');
  }

  const payload = assertReleaseManifestPayloadShape(envelope.payload, policy, {
    allowLegacyControlPlane,
  });
  if ((legacyEnvelope && payload.schema !== LEGACY_RELEASE_MANIFEST_PAYLOAD_SCHEMA)
      || (!legacyEnvelope && payload.schema !== RELEASE_MANIFEST_PAYLOAD_SCHEMA)) {
    fail('release manifest envelope and payload schemas do not match');
  }

  const createdAtMs = Date.parse(payload.createdAt);
  const maxAgeMs = Number(policy.trust.maxManifestAgeSeconds ?? 0) * 1000;
  if (createdAtMs > nowMs + MAX_CLOCK_SKEW_MS) {
    fail('release manifest createdAt is in the future');
  }
  if (maxAgeMs > 0 && nowMs - createdAtMs > maxAgeMs) {
    fail('release manifest is older than the accepted freshness window');
  }

  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      readEd25519PublicKey(publicKeyPath),
      signature,
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('pinned release signing key')) throw error;
    signatureValid = false;
  }
  if (!signatureValid) fail('release manifest signature is invalid');

  return {
    payload,
    manifestDigest: sha256(canonicalJson(envelope)),
    payloadDigest: sha256(canonicalJson(payload)),
    releaseId: releaseIdFor(payload),
  };
}

/**
 * A release identity is derived only from signed, immutable content, so the same
 * manifest always resolves to the same release id. That is what makes a repeated
 * manifest idempotent rather than a second deployment.
 */
export function releaseIdFor(payload) {
  return sha256(canonicalJson({
    sha: payload.source.sha,
    backend: payload.images.backend.digest,
    contentEngine: payload.images.contentEngine.digest,
    compose: payload.compose.digest,
    migrations: payload.migrations.digest,
    ...(payload.controlPlane
      ? {
          controlPlane: {
            schema: payload.controlPlane.schema ?? RELEASE_CONTROL_PLANE_SCHEMA,
            digest: payload.controlPlane.digest,
          },
        }
      : {}),
  })).slice(0, 32);
}

export function verifyComposeBytes({ payload, bytes, policy }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail('release Compose file is empty');
  }
  const maxBytes = Number(policy.trust.maxComposeBytes ?? 0);
  if (maxBytes > 0 && bytes.length > maxBytes) {
    fail('release Compose file exceeds the accepted size bound');
  }
  const digest = sha256(bytes);
  if (digest !== payload.compose.digest) {
    fail('release Compose file digest does not match the signed manifest');
  }
  return digest;
}

export function parseReleaseManifestBytes({ bytes, policy }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail('release manifest bytes are empty');
  }
  const maxBytes = Number(policy.trust.maxManifestBytes ?? 0);
  if (maxBytes > 0 && bytes.length > maxBytes) {
    fail('release manifest exceeds the accepted size bound');
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return fail('release manifest is not valid JSON');
  }
}
