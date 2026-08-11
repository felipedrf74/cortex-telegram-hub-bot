import fs from 'node:fs';
import path from 'node:path';

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
import { releaseIdFor } from './release-manifest.mjs';
import { assertReleaseControlPlaneShape } from './release-control-plane.mjs';

/**
 * Authoritative release state and immutable receipts on the deployment host.
 *
 * Two properties matter more than anything else here.
 *
 * 1. **Write-ahead.** State that says "a mutation may have begun" is durably
 *    written and fsynced *before* the mutation is attempted. Every recovery
 *    decision depends on that ordering: if the poller dies mid-deploy, the state
 *    on disk must already admit the possibility.
 * 2. **Atomicity.** A receipt is written to a per-writer temp path, fsynced,
 *    renamed into place, and the parent directory fsynced. A reader therefore
 *    sees either no receipt or a complete one — never a truncated one, and never
 *    an empty file created by a redirect that ran before the work did.
 *
 * Readers fail closed. An unparseable state file or receipt is an error, never
 * treated as absent, because "absent" is what authorizes a fresh deployment.
 */

export const RELEASE_STATE_SCHEMA = 'nexus.release-host-state.v1';
export const LEGACY_RELEASE_RECEIPT_SCHEMA = 'nexus.release-receipt.v2';
export const RELEASE_RECEIPT_SCHEMA = 'nexus.release-receipt.v3';

export const RELEASE_STATUSES = Object.freeze({
  ELIGIBLE: 'eligible',
  STAGING_HEALTHY: 'staging_healthy',
  SUPERSEDED: 'superseded',
  PRODUCTION_OBSERVING: 'production_observing',
  COMPLETED: 'completed',
  ROLLED_BACK: 'rolled_back',
  ROLLBACK_FAILED: 'rollback_failed',
});

const STATUS_VALUES = Object.freeze(Object.values(RELEASE_STATUSES));

export const RELEASE_RECEIPT_OUTCOMES = Object.freeze({
  COMPLETED: 'completed',
  ROLLED_BACK: 'rolled_back',
  ROLLBACK_FAILED: 'rollback_failed',
  BLOCKED: 'blocked',
  STAGING_FAILED: 'staging_failed',
});

const RECEIPT_OUTCOME_VALUES = Object.freeze(Object.values(RELEASE_RECEIPT_OUTCOMES));

// A receipt can outrank only the write-ahead states from which that exact
// outcome can legitimately settle. Rollback recovery publishes its receipt
// before projecting the recovered terminal status, so either rollback outcome
// may briefly accompany any mutation-admitting state. `blocked` and
// `staging_failed` retain their non-terminal active status, but must never make
// an unrelated or already-completed active projection provable.
export const RELEASE_RECEIPT_STATUS_COMPATIBILITY = Object.freeze({
  [RELEASE_RECEIPT_OUTCOMES.COMPLETED]: Object.freeze([
    RELEASE_STATUSES.PRODUCTION_OBSERVING,
    RELEASE_STATUSES.COMPLETED,
  ]),
  [RELEASE_RECEIPT_OUTCOMES.ROLLED_BACK]: Object.freeze([
    RELEASE_STATUSES.PRODUCTION_OBSERVING,
    RELEASE_STATUSES.COMPLETED,
    RELEASE_STATUSES.ROLLED_BACK,
    RELEASE_STATUSES.ROLLBACK_FAILED,
  ]),
  [RELEASE_RECEIPT_OUTCOMES.ROLLBACK_FAILED]: Object.freeze([
    RELEASE_STATUSES.PRODUCTION_OBSERVING,
    RELEASE_STATUSES.COMPLETED,
    RELEASE_STATUSES.ROLLED_BACK,
    RELEASE_STATUSES.ROLLBACK_FAILED,
  ]),
  [RELEASE_RECEIPT_OUTCOMES.BLOCKED]: Object.freeze([
    RELEASE_STATUSES.ELIGIBLE,
    RELEASE_STATUSES.STAGING_HEALTHY,
    RELEASE_STATUSES.PRODUCTION_OBSERVING,
  ]),
  [RELEASE_RECEIPT_OUTCOMES.STAGING_FAILED]: Object.freeze([
    RELEASE_STATUSES.ELIGIBLE,
  ]),
});

const RECEIPT_TERMINAL_STATUS = Object.freeze({
  [RELEASE_RECEIPT_OUTCOMES.COMPLETED]: RELEASE_STATUSES.COMPLETED,
  [RELEASE_RECEIPT_OUTCOMES.ROLLED_BACK]: RELEASE_STATUSES.ROLLED_BACK,
  [RELEASE_RECEIPT_OUTCOMES.ROLLBACK_FAILED]: RELEASE_STATUSES.ROLLBACK_FAILED,
});

export const BLOCK_REASONS = Object.freeze({
  ROLLBACK_FIRED: 'rollback_fired',
  ROLLBACK_FAILED: 'rollback_failed',
  UNPROVABLE_ACTIVE_RELEASE: 'unprovable_active_release',
  MIGRATION_NOT_CD_ELIGIBLE: 'migration_not_cd_eligible',
  DATABASE_INTEGRITY: 'database_integrity_failed',
  RECEIPT_UNWRITABLE: 'receipt_unwritable',
  PREPRODUCTION_TEARDOWN_FAILED: 'preproduction_teardown_failed',
  BOOTSTRAP_TARGET_ABANDONED: 'bootstrap_target_abandoned',
});

const MAX_HISTORY = 50;
const MAX_REJECTED = 50;
const MAX_DETAIL_CHARS = 200;
const MAX_RECEIPT_TEXT_CHARS = 512;
const REDACTED = '[redacted]';
const RELEASE_ID = /^[0-9a-f]{32}$/;

/**
 * Redaction is allowlist-first, not denylist-first.
 *
 * The previous implementation stripped punctuation and matched a list of secret
 * shapes. That fails in both directions: `Authorization: Custom abc123` merely
 * lost its colon, and `https://user:pass@host/path` lost its `@` while keeping
 * `pass`. A denylist can only remove the secrets somebody thought of.
 *
 * So instead: anything that is not positively recognised as safe is removed.
 * Three rules, in order.
 *
 * 1. A credential *context* poisons the whole string. If the text mentions auth,
 *    a token, a password, a key and so on, the value beside it is a secret by
 *    definition and no per-token rule can be trusted to find it.
 * 2. A URL carrying userinfo is redacted whole, because the credential sits in
 *    the structure rather than next to a keyword.
 * 3. Otherwise every token must match a known-safe shape — a lowercase word, a
 *    small integer, a version, a governed absolute path, a prefixed SHA-256
 *    digest, or an explicitly enumerated release code. Everything else becomes
 *    the marker.
 *
 * Exact release identifiers and source SHAs belong in structured receipt and
 * notification fields. Free text never treats bare opaque hex as public merely
 * because its length resembles a digest.
 */
const CREDENTIAL_HINT =
  /(?:auth|token|secret|password|passphrase|credential|bearer|cookie|session|signature|api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|secret[_\s-]?key)/i;

const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@/i;

const GOVERNED_DETAIL_TOKENS = new Set([
  ...STATUS_VALUES,
  ...Object.values(BLOCK_REASONS),
  'already_completed',
  'already_completed_payload',
  'api_smoke',
  'audit_mirror',
  'backend_health',
  'backend_public_status',
  'backup_evidence_invalid',
  'backup_liveness',
  'backup_policy_invalid',
  'backup_receipt_stale',
  'bootstrap_production_revalidation',
  'bootstrap_revalidation',
  'compose_invalid',
  'container_health',
  'content_engine_health',
  'controller_only_transition',
  'crash_recovery',
  'crash_recovery_detected',
  'crash_recovery_write_ahead',
  'database_integrity',
  'discovery_verification',
  'first_container_bootstrap_authorization_required',
  'first_container_bootstrap_baseline_changed',
  'first_container_bootstrap_baseline_invalid',
  'foreign_key_check',
  'host_not_configured',
  'heartbeat_failed',
  'inspect_backup_evidence',
  'inspect_local_backup_unit',
  'inspect_restore_verification_unit',
  'integrity_check',
  'known_hosts_not_configured',
  'ledger_reconciliation',
  'local_backup',
  'local_backup_failed',
  'mirror_exhausted',
  'mirror_failed',
  'non_monotonic_source_order',
  'not_applicable',
  'not_attempted',
  'not_configured',
  'not_required',
  'notification_failed',
  'owner_bootstrap_baseline',
  'pointer_refresh_failed',
  'protected_head_unavailable',
  'protected_head_mismatch',
  'preproduction_teardown_failed',
  'bootstrap_target_abandoned',
  'poll_failed',
  'previously_failed_digests',
  'production_identity',
  'production_ledger_read',
  'production_ledger_reconciliation',
  'production_migrator',
  'provider_rejected',
  'reconciled_crash_recovery_receipt',
  'rollback_compose_start',
  'rollback_identity',
  'rollback_predecessor_topology',
  'restore_verification',
  'restore_verification_failed',
  'restore_verification_stale',
  'staging_migrator',
  'systemd_unit_failed',
  'transport_failed',
  'unreadable_candidate_receipt',
]);

// Deliberately narrow, and alphabetic-only per segment.
//
// An earlier, looser version allowed any lowercase alphanumeric token, which
// still passed detector-shaped Slack bearer values and `age1qqq...` — both are
// "lowercase words" by that definition. Requiring purely alphabetic segments
// means a token carrying entropy (digits mixed into letters) is never safe.
// Snake/kebab release codes are not admitted by shape: only the exact governed
// values above survive, so an underscore-delimited passphrase cannot impersonate
// operational evidence.
//
// Everything else that must survive is enumerated explicitly, because a
// governed identifier is safe by construction rather than by shape.
const SAFE_TOKEN = new RegExp([
  '^(?:',
  '[A-Za-z][a-z]{0,23}',                        // ordinary word
  '|\\d{1,5}',                                  // bounded integer: exit codes, counts, ports
  '|\\d+(?:\\.\\d+){1,3}',                       // version
  // NOTE: absolute paths are NOT matched here. The obvious character class for a
  // path is also the character class for base64url, so `/xoxb-…`, `/AKIA…` and
  // `/tmp/eyJhbGci…` all passed through verbatim. Paths are validated
  // segment-by-segment in `isSafePath` instead.
  '|nexus-db-\\d{8}T\\d{6}Z\\.sqlite\\.age',       // governed backup artifact name
  '|sha256:[0-9a-f]{64}',
  ')$',
].join(''));

// Segmented path components are otherwise indistinguishable from passphrases.
// Keep the exception closed over the exact hyphenated components used by the
// governed release, backup, audit, and one-time legacy paths; a new component
// must be reviewed here instead of inheriting a broad "looks like a path" pass.
const GOVERNED_SEGMENTED_PATH_COMPONENTS = new Set([
  'nexus-backups',
  'nexus-hub',
  'nexus-local-backup',
  'nexus-release',
  'nexus-release-audit',
  'pre-promotion',
  'telegram-hub-bot',
  'telegram-hub-bot-staging',
]);

/**
 * A path is safe only if every segment is safe.
 *
 * Segments must be lowercase, and a long segment mixing letters and digits is
 * refused outright: that is what a leaked token looks like, and no legitimate
 * path component in this system does.
 */
function isSafePath(token) {
  if (!token.startsWith('/') || token.length > 120) return false;
  const segments = token.slice(1).split('/');
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (segment.length === 0) return false;
    if (GOVERNED_ARTIFACT.test(segment)) return true;
    // A leading slash must not turn a residual secret into a "path". These are
    // the same fail-closed shapes rejected for ordinary tokens below; checking
    // each segment closes the path-prefix bypass without weakening legitimate
    // governed paths such as `/var/lib/nexus-release/state`.
    if (/^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/.test(segment)
        || (looksLikeResidualSecret(segment)
          && !GOVERNED_SEGMENTED_PATH_COMPONENTS.has(segment))) {
      return false;
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(segment)) return false;
    const mixed = /[a-z]/.test(segment) && /[0-9]/.test(segment);
    return !(mixed && segment.length >= 20);
  });
}

const GOVERNED_ARTIFACT = /^nexus-db-\d{8}T\d{6}Z\.sqlite\.age$/;

/**
 * Residual secret shapes that are syntactically word-like.
 *
 * Lowercase passphrases and segmented tokens have no prefix or credential
 * marker to distinguish them from prose. Redact conservatively once the run is
 * long enough to carry credential material. Six-or-more-digit bare values are
 * rejected before any identifier rule, and segmented values survive only when
 * they are exact members of `GOVERNED_DETAIL_TOKENS`.
 */
function looksLikeResidualSecret(token) {
  if (/^\d{6,}$/.test(token)) return true;
  if (/^[a-z]{12,}$/.test(token)) return true;
  if (/^[a-z]+(?:[_-][a-z]+)+$/.test(token)) {
    return token.replaceAll('-', '').replaceAll('_', '').length >= 12;
  }
  return false;
}

export function sanitizeDetail(value) {
  if (value === null || value === undefined) return null;
  let text = String(value);

  // One line only. A collapsed multi-line log is still a log.
  const firstBreak = text.search(/[\r\n]/);
  if (firstBreak !== -1) text = text.slice(0, firstBreak);

  if (CREDENTIAL_HINT.test(text) || URL_USERINFO.test(text)) return REDACTED;

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const kept = [];
  let previousWasMarker = false;
  for (const rawToken of tokens) {
    // Sentence punctuation is not evidence. Removing it before matching keeps
    // ordinary details such as "failed; will retry" readable and idempotent.
    const token = rawToken.replace(/[;,.]+$/, '');
    const safe = token.length > 0
      && (GOVERNED_DETAIL_TOKENS.has(token)
        || (!looksLikeResidualSecret(token)
          && (SAFE_TOKEN.test(token) || isSafePath(token))));
    if (safe) {
      kept.push(token);
      previousWasMarker = false;
      continue;
    }
    // Collapse runs of removed tokens so the marker stays readable.
    if (!previousWasMarker) kept.push(REDACTED);
    previousWasMarker = true;
  }

  // Truncate on token boundaries. Slicing mid-token could cut a digest in half,
  // and the fragment would not be recognised on a second pass — making
  // sanitizeDetail non-idempotent. The receipt validator asserts idempotence, so
  // a non-idempotent result is rejected at write time and halts the pipeline.
  const bounded = [];
  let length = 0;
  for (const token of kept) {
    const added = bounded.length === 0 ? token.length : token.length + 1;
    if (length + added > MAX_DETAIL_CHARS) break;
    bounded.push(token);
    length += added;
  }
  const cleaned = bounded.join(' ').trim();
  if (!cleaned || cleaned === REDACTED) return cleaned ? REDACTED : null;
  return cleaned;
}

/**
 * The payload identity of a release: the digest of the OCI payload image that
 * carried its signed manifest and Compose file, plus that Compose file's own
 * digest.
 *
 * Rollback needs this. Restoring the predecessor means running the predecessor's
 * *topology*, not the failed candidate's topology with older image digests
 * substituted in — those can differ in services, ports, mounts or the migrator
 * command. Recording the payload digest is what makes the real predecessor
 * topology retrievable and verifiable later.
 */
function assertPayloadIdentity(value, label) {
  const identity = exactKeys(value, ['digest', 'composeDigest'], label);
  assertOciDigest(identity.digest, `${label} digest`);
  if (typeof identity.composeDigest !== 'string' || !/^[0-9a-f]{64}$/.test(identity.composeDigest)) {
    fail(`${label} composeDigest is not a lowercase hex SHA-256`);
  }
  return identity;
}

function assertReleaseId(value, label) {
  if (typeof value !== 'string' || !RELEASE_ID.test(value)) {
    fail(`${label} is not a release id`);
  }
  return value;
}

function assertBoundedText(value, label, { max = MAX_RECEIPT_TEXT_CHARS } = {}) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > max
      || value.trim() !== value
      || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be bounded, non-empty text without control characters`);
  }
  return value;
}

function assertBoundedIdentifier(value, label, options = {}) {
  assertBoundedText(value, label, options);
  if (/\s/.test(value)) fail(`${label} must not contain whitespace`);
  return value;
}

function assertPositiveIntegerText(value, label) {
  if (typeof value !== 'string' || value.length > 32) {
    fail(`${label} must be a bounded positive integer string`);
  }
  return assertPositiveIntegerString(value, label);
}

function assertNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertAbsoluteEvidencePath(value, label) {
  assertBoundedText(value, label, { max: 512 });
  if (!path.isAbsolute(value) || path.normalize(value) !== value) {
    fail(`${label} must be a normalized absolute path`);
  }
  return value;
}

/**
 * Complete identity of the encrypted pre-migration backup that was verified
 * before production mutation. Keeping only the basename is insufficient for
 * crash recovery: it cannot bind the receipt, bytes, database, or producer
 * interval that the original verifier accepted.
 */
export function assertBackupEvidenceShape(value, label = 'backup evidence') {
  const evidence = exactKeys(value, [
    'artifact', 'artifactPath', 'encryptedSha256', 'encryptedSizeBytes',
    'database', 'startedAt', 'completedAt',
  ], label);
  if (typeof evidence.artifact !== 'string' || !GOVERNED_ARTIFACT.test(evidence.artifact)) {
    fail(`${label} artifact must be a governed backup artifact name`);
  }
  assertAbsoluteEvidencePath(evidence.artifactPath, `${label} artifactPath`);
  if (path.basename(evidence.artifactPath) !== evidence.artifact) {
    fail(`${label} artifactPath must end in the governed artifact name`);
  }
  assertHexSha256(evidence.encryptedSha256, `${label} encryptedSha256`);
  assertPositiveInteger(evidence.encryptedSizeBytes, `${label} encryptedSizeBytes`);
  assertAbsoluteEvidencePath(evidence.database, `${label} database`);
  assertCanonicalTimestamp(evidence.startedAt, `${label} startedAt`);
  assertCanonicalTimestamp(evidence.completedAt, `${label} completedAt`);
  if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
    fail(`${label} completedAt must not predate startedAt`);
  }
  return evidence;
}

function backupEvidenceMatches(left, right) {
  return Boolean(left && right) && canonicalJson(left) === canonicalJson(right);
}

function assertRelativeArtifactPath(value, label) {
  assertBoundedIdentifier(value, label, { max: 256 });
  if (value.includes('\\')
      || path.posix.isAbsolute(value)
      || path.posix.normalize(value) !== value
      || value.split('/').some((segment) => segment === '.' || segment === '..')) {
    fail(`${label} must be a normalized relative artifact path`);
  }
  return value;
}

function atomicWriteJson(filePath, value, { exclusive = false } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.next-${process.pid}`;
  // A crash plus PID reuse can leave a same-PID temp behind. Clearing it first
  // keeps the exclusive open from throwing EEXIST at the worst possible moment:
  // after the mutation, before the receipt is recorded.
  fs.rmSync(temporary, { force: true });
  if (exclusive && fs.existsSync(filePath)) {
    fail(`refusing to overwrite the immutable file at ${filePath}`);
  }
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, body);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  // Only a non-empty temp file is promoted. A zero-byte "receipt" reads as an
  // unprovable release and would block the pipeline for a reason nobody can see.
  if (fs.statSync(temporary).size === 0) {
    fs.rmSync(temporary, { force: true });
    fail(`refusing to publish an empty file at ${filePath}`);
  }
  if (exclusive && fs.existsSync(filePath)) {
    fs.rmSync(temporary, { force: true });
    fail(`refusing to overwrite the immutable file at ${filePath}`);
  }
  fs.renameSync(temporary, filePath);
  const parent = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
  return filePath;
}

function readJsonFailClosed(filePath, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (bytes.trim().length === 0) {
    fail(`${label} exists but is empty; refusing to treat it as absent`);
  }
  try {
    return JSON.parse(bytes);
  } catch {
    return fail(`${label} is not valid JSON; refusing to treat it as absent`);
  }
}

export function emptyReleaseState() {
  return {
    schema: RELEASE_STATE_SCHEMA,
    updatedAt: null,
    active: null,
    predecessor: null,
    blocked: null,
    // Survives block acknowledgement on purpose: acknowledging an incident must
    // not erase the fact that an incompatible migration is still pending.
    unresolvedContractMigrations: null,
    // Monotonic source ordering. GitHub run ids increase per repository, so a
    // manifest whose run id is not greater than the last accepted one is either a
    // replay or an out-of-order publish, and both must be refused.
    lastAcceptedRunId: null,
    history: [],
    rejected: [],
  };
}

function assertImagePair(value, label) {
  const pair = exactKeys(value, ['backend', 'contentEngine'], label);
  for (const key of ['backend', 'contentEngine']) {
    const image = exactKeys(pair[key], ['repository', 'digest'], `${label} ${key}`);
    assertBoundedIdentifier(image.repository, `${label} ${key} repository`);
    assertOciDigest(image.digest, `${label} ${key} digest`);
  }
  return pair;
}

function imagePairMatches(left, right) {
  return Boolean(left && right)
    && left.backend?.repository === right.backend?.repository
    && left.backend?.digest === right.backend?.digest
    && left.contentEngine?.repository === right.contentEngine?.repository
    && left.contentEngine?.digest === right.contentEngine?.digest;
}

/**
 * Digest every claim that came from the verified signed manifest, plus the
 * content-addressed OCI artifact that carried it. `releaseId` intentionally
 * remains the deployable-content identity, so a later CI run may republish the
 * same content without becoming a second deployment. This separate digest
 * binds the immutable receipt to the exact authorizing run, key, manifest, and
 * migration verdict without changing that idempotency contract.
 */
export function releaseEvidenceDigest({
  manifestPayload,
  manifestDigest,
  keyId,
  releasePayloadDigest,
}) {
  assertHexSha256(manifestDigest, 'release evidence manifestDigest');
  assertBoundedIdentifier(keyId, 'release evidence keyId', { max: 128 });
  assertOciDigest(releasePayloadDigest, 'release evidence releasePayloadDigest');
  const reconciliationDigest = manifestPayload.migrations.reconciliationDigest
    ?? sha256(canonicalJson(manifestPayload.migrations.reconciliation));
  assertHexSha256(
    reconciliationDigest,
    'release evidence migration reconciliation digest',
  );
  const controlPlane = manifestPayload.controlPlane
    ? assertReleaseControlPlaneShape(
        manifestPayload.controlPlane,
        'release evidence controlPlane',
      )
    : null;
  return sha256(canonicalJson({
    source: {
      repository: manifestPayload.source.repository,
      ref: manifestPayload.source.ref,
      sha: manifestPayload.source.sha,
      workflow: manifestPayload.source.workflow,
      runId: manifestPayload.source.runId,
      runAttempt: manifestPayload.source.runAttempt,
    },
    identity: { manifestDigest, keyId, releasePayloadDigest },
    images: {
      backend: { ...manifestPayload.images.backend },
      contentEngine: { ...manifestPayload.images.contentEngine },
    },
    compose: { ...manifestPayload.compose },
    ...(controlPlane ? { controlPlane: { ...controlPlane } } : {}),
    migrations: {
      digest: manifestPayload.migrations.digest,
      reconciliationDigest,
      upFileCount: manifestPayload.migrations.upFileCount,
      downFileCount: manifestPayload.migrations.downFileCount,
      eligible: manifestPayload.migrations.cdEligibility.eligible,
      predecessorCompatible:
        manifestPayload.migrations.cdEligibility.predecessorCompatible,
      reasons: [...manifestPayload.migrations.cdEligibility.reasons],
    },
  }));
}

function assertRollbackIdentity(value, label) {
  const identity = exactKeys(value, [
    'releaseId', 'sourceSha', 'images', 'payload',
  ], label);
  assertPayloadIdentity(identity.payload, `${label} payload`);
  assertReleaseId(identity.releaseId, `${label} releaseId`);
  assertFullSha(identity.sourceSha, `${label} sourceSha`);
  assertImagePair(identity.images, `${label} images`);
  return identity;
}

function assertRecoveryTiming(value, label, { requireWithinObjective = false } = {}) {
  const timing = exactKeys(value, [
    'incidentRecoveryDurationMs',
    'predecessorSwitchDurationMs',
    'predecessorSwitchObjectiveSeconds',
  ], label);
  assertNonNegativeInteger(
    timing.incidentRecoveryDurationMs,
    `${label} incidentRecoveryDurationMs`,
  );
  assertNonNegativeInteger(
    timing.predecessorSwitchDurationMs,
    `${label} predecessorSwitchDurationMs`,
  );
  assertPositiveInteger(
    timing.predecessorSwitchObjectiveSeconds,
    `${label} predecessorSwitchObjectiveSeconds`,
  );
  if (timing.predecessorSwitchDurationMs > timing.incidentRecoveryDurationMs) {
    fail(`${label} predecessor switch cannot outlast the full incident recovery`);
  }
  if (requireWithinObjective
      && BigInt(timing.predecessorSwitchDurationMs)
        > BigInt(timing.predecessorSwitchObjectiveSeconds) * 1000n) {
    fail(`${label} restored predecessor switch exceeds its objective`);
  }
  return timing;
}

export function assertReleaseStateShape(state) {
  exactKeys(state, [
    'schema', 'updatedAt', 'active', 'predecessor', 'blocked',
    'unresolvedContractMigrations', 'lastAcceptedRunId', 'history', 'rejected',
  ], 'release host state');
  if (state.schema !== RELEASE_STATE_SCHEMA) fail('release host state schema is unsupported');
  if (state.updatedAt !== null) assertCanonicalTimestamp(state.updatedAt, 'release host state updatedAt');

  if (state.active !== null) {
    const active = exactKeys(state.active, [
      'releaseId', 'sourceSha', 'status', 'images', 'payload', 'evidenceDigest',
      'startedAt', 'updatedAt',
      'attempts', 'lastEvidence', 'backupArtifact', 'backupEvidence', 'rollbackTarget',
    ], 'release host state active');
    assertPayloadIdentity(active.payload, 'active payload');
    assertReleaseId(active.releaseId, 'active releaseId');
    assertFullSha(active.sourceSha, 'active sourceSha');
    assertHexSha256(active.evidenceDigest, 'active evidenceDigest');
    if (!STATUS_VALUES.includes(active.status)) fail('active release status is not a governed status');
    assertImagePair(active.images, 'active images');
    assertCanonicalTimestamp(active.startedAt, 'active startedAt');
    assertCanonicalTimestamp(active.updatedAt, 'active updatedAt');
    if (!Number.isSafeInteger(active.attempts) || active.attempts < 1) {
      fail('active attempts must be a positive integer');
    }
    if (active.lastEvidence !== null && typeof active.lastEvidence !== 'string') {
      fail('active lastEvidence must be a string or null');
    }
    if (active.backupEvidence !== null) {
      assertBackupEvidenceShape(active.backupEvidence, 'active backupEvidence');
      if (active.backupArtifact !== active.backupEvidence.artifact) {
        fail('active backupArtifact must match active backupEvidence');
      }
    } else if (active.backupArtifact !== null) {
      fail('active backupArtifact cannot exist without complete backupEvidence');
    }
    if ([
      RELEASE_STATUSES.PRODUCTION_OBSERVING,
      RELEASE_STATUSES.COMPLETED,
      RELEASE_STATUSES.ROLLED_BACK,
      RELEASE_STATUSES.ROLLBACK_FAILED,
    ].includes(active.status) && active.backupEvidence === null) {
      fail('mutation-admitting active state requires complete backupEvidence');
    }
    if (active.rollbackTarget !== null) {
      assertRollbackIdentity(active.rollbackTarget, 'active rollbackTarget');
    }
  }

  if (state.predecessor !== null) {
    assertRollbackIdentity(state.predecessor, 'release host state predecessor');
  }

  if (state.blocked !== null) {
    const blocked = exactKeys(state.blocked, ['releaseId', 'reason', 'since'], 'release host state blocked');
    assertReleaseId(blocked.releaseId, 'blocked releaseId');
    if (!Object.values(BLOCK_REASONS).includes(blocked.reason)) {
      fail('blocked reason is not a governed reason');
    }
    assertCanonicalTimestamp(blocked.since, 'blocked since');
  }

  if (state.unresolvedContractMigrations !== null) {
    const unresolved = exactKeys(
      state.unresolvedContractMigrations,
      ['releaseId', 'files', 'since'],
      'release host state unresolvedContractMigrations',
    );
    assertReleaseId(unresolved.releaseId, 'unresolvedContractMigrations releaseId');
    if (!Array.isArray(unresolved.files) || unresolved.files.length === 0
        || unresolved.files.length > 512
        || unresolved.files.some((file) => !/^\d{3}_.*\.sql$/.test(file))) {
      fail('unresolvedContractMigrations files must be a bounded migration list');
    }
    assertCanonicalTimestamp(unresolved.since, 'unresolvedContractMigrations since');
  }

  if (state.lastAcceptedRunId !== null
      && !/^[1-9][0-9]*$/.test(String(state.lastAcceptedRunId))) {
    fail('lastAcceptedRunId must be a positive integer string');
  }

  if (!Array.isArray(state.history) || state.history.length > MAX_HISTORY) {
    fail('release host state history must be a bounded array');
  }
  for (const entry of state.history) {
    // v1 state written before recovery timing was introduced has the original
    // three-key history entry. Accept it so an installed host upgrades safely;
    // every new entry carries the explicit nullable recoveryTiming field.
    const hasRecoveryTiming = Boolean(
      entry && typeof entry === 'object' && !Array.isArray(entry)
        && Object.prototype.hasOwnProperty.call(entry, 'recoveryTiming'),
    );
    const historyEntry = exactKeys(entry, hasRecoveryTiming
      ? ['releaseId', 'status', 'completedAt', 'recoveryTiming']
      : ['releaseId', 'status', 'completedAt'], 'release host state history entry');
    assertReleaseId(historyEntry.releaseId, 'release host state history releaseId');
    if (!STATUS_VALUES.includes(historyEntry.status)) {
      fail('release host state history status is not governed');
    }
    assertCanonicalTimestamp(
      historyEntry.completedAt,
      'release host state history completedAt',
    );
    if (hasRecoveryTiming && historyEntry.recoveryTiming !== null) {
      assertRecoveryTiming(
        historyEntry.recoveryTiming,
        'release host state history recoveryTiming',
        { requireWithinObjective: historyEntry.status === RELEASE_STATUSES.ROLLED_BACK },
      );
    }
  }
  if (!Array.isArray(state.rejected) || state.rejected.length > MAX_REJECTED) {
    fail('release host state rejected must be a bounded array');
  }
  return state;
}

export function createReleaseStateStore({ stateDir, receiptDir, now = () => new Date() }) {
  if (!stateDir || !receiptDir) fail('release state store requires stateDir and receiptDir');
  const stateFile = path.join(stateDir, 'release-state.json');

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function readState() {
    const raw = readJsonFailClosed(stateFile, 'release host state');
    if (raw === null) return emptyReleaseState();
    return assertReleaseStateShape(raw);
  }

  function writeState(next) {
    const candidate = { ...next, updatedAt: timestamp() };
    assertReleaseStateShape(candidate);
    atomicWriteJson(stateFile, candidate);
    return candidate;
  }

  /**
   * Write-ahead transition. The status is persisted before the caller performs
   * the mutation it describes, so an interrupted run is always recoverable from
   * state plus receipts rather than from guesswork.
   */
  function recordStatus({
    manifestPayload, releaseId, status, payloadDigest, evidence = null,
    manifestDigest, keyId, backupEvidence = undefined,
  }) {
    if (!STATUS_VALUES.includes(status)) fail('cannot record an ungoverned release status');
    const state = readState();
    const at = timestamp();
    const images = {
      backend: {
        repository: manifestPayload.images.backend.repository,
        digest: manifestPayload.images.backend.digest,
      },
      contentEngine: {
        repository: manifestPayload.images.contentEngine.repository,
        digest: manifestPayload.images.contentEngine.digest,
      },
    };
    const sameRelease = state.active?.releaseId === releaseId;
    const evidenceDigest = releaseEvidenceDigest({
      manifestPayload,
      manifestDigest,
      keyId,
      releasePayloadDigest: payloadDigest ?? state.active?.payload?.digest,
    });
    if (sameRelease && state.active.evidenceDigest !== evidenceDigest) {
      fail('cannot replace the accepted release evidence for an active release');
    }
    const priorBackupEvidence = sameRelease ? state.active.backupEvidence : null;
    const nextBackupEvidence = backupEvidence === undefined
      ? priorBackupEvidence
      : backupEvidence;
    if (nextBackupEvidence !== null) {
      assertBackupEvidenceShape(nextBackupEvidence, 'recorded backupEvidence');
    }
    if (priorBackupEvidence !== null
        && nextBackupEvidence !== null
        && !backupEvidenceMatches(priorBackupEvidence, nextBackupEvidence)
        && [
          RELEASE_STATUSES.PRODUCTION_OBSERVING,
          RELEASE_STATUSES.COMPLETED,
          RELEASE_STATUSES.ROLLED_BACK,
          RELEASE_STATUSES.ROLLBACK_FAILED,
        ].includes(state.active.status)) {
      fail('cannot replace the verified backup evidence for an active release');
    }
    const active = {
      releaseId,
      sourceSha: manifestPayload.source.sha,
      status,
      images,
      payload: {
        digest: payloadDigest ?? state.active?.payload?.digest,
        composeDigest: manifestPayload.compose.digest,
      },
      evidenceDigest,
      startedAt: sameRelease ? state.active.startedAt : at,
      updatedAt: at,
      attempts: sameRelease ? state.active.attempts : 1,
      lastEvidence: sanitizeDetail(evidence),
      // Keep the basename projection for compact operator views, but the full
      // descriptor-verified identity below is the recovery authority.
      backupArtifact: nextBackupEvidence?.artifact ?? null,
      backupEvidence: nextBackupEvidence,
      // Snapshot the outgoing predecessor before any production mutation. A
      // later `completed` state promotes the candidate into `state.predecessor`;
      // without this separate identity, a crash before the terminal receipt
      // would erase the only topology that can safely be restored.
      rollbackTarget: sameRelease
        ? state.active.rollbackTarget
        : asPredecessor(state.predecessor),
    };
    return writeState({ ...state, active });
  }

  function beginAttempt({
    manifestPayload, releaseId, payloadDigest, manifestDigest, keyId,
  }) {
    const state = readState();
    const at = timestamp();
    if (state.active?.releaseId === releaseId) {
      const evidenceDigest = releaseEvidenceDigest({
        manifestPayload,
        manifestDigest,
        keyId,
        releasePayloadDigest: payloadDigest,
      });
      if (state.active.evidenceDigest !== evidenceDigest) {
        fail('cannot retry an active release with different signed evidence');
      }
      const active = {
        ...state.active,
        status: RELEASE_STATUSES.ELIGIBLE,
        updatedAt: at,
        attempts: state.active.attempts + 1,
      };
      return writeState({ ...state, active });
    }
    return recordStatus({
      manifestPayload,
      releaseId,
      status: RELEASE_STATUSES.ELIGIBLE,
      payloadDigest,
      manifestDigest,
      keyId,
    });
  }

  function asPredecessor(active) {
    if (!active) return null;
    return {
      releaseId: active.releaseId,
      sourceSha: active.sourceSha,
      images: active.images,
      payload: active.payload,
    };
  }

  // The history entry carries no receipt digest on purpose: the status is written
  // ahead of the receipt, so any digest recorded here would necessarily be null.
  // A receipt is addressed by release id, which is enough to find it.
  function completeRelease({
    releaseId,
    status,
    restoredPredecessor = undefined,
    recoveryTiming = null,
  }) {
    const state = readState();
    if (!state.active || state.active.releaseId !== releaseId) {
      fail('cannot complete a release that is not the active release');
    }
    if (!STATUS_VALUES.includes(status)) fail('cannot complete with an ungoverned release status');
    if (recoveryTiming !== null) {
      assertRecoveryTiming(recoveryTiming, 'completed release recoveryTiming');
      if (![RELEASE_STATUSES.ROLLED_BACK, RELEASE_STATUSES.ROLLBACK_FAILED].includes(status)) {
        fail('recoveryTiming requires a rollback terminal status');
      }
    }
    const at = timestamp();
    const active = { ...state.active, status, updatedAt: at };
    const history = [
      { releaseId, status, completedAt: at, recoveryTiming },
      ...state.history,
    ].slice(0, MAX_HISTORY);
    // Only a completed release becomes the rollback target. A rolled-back or
    // failed candidate must never displace the predecessor it was restored to.
    if (restoredPredecessor !== undefined && restoredPredecessor !== null) {
      assertRollbackIdentity(restoredPredecessor, 'restored predecessor');
    }
    const predecessor = status === RELEASE_STATUSES.COMPLETED
      ? asPredecessor(active)
      : (restoredPredecessor !== undefined ? restoredPredecessor : state.predecessor);
    return writeState({ ...state, active, predecessor, history });
  }

  /**
   * Atomically retire a candidate that has not admitted production mutation.
   * The active pointer and its history entry move in one fsynced state write; a
   * bootstrap abandonment may bind its owner-action block in that same write.
   */
  function retirePreProduction({ releaseId, blockReason = null }) {
    const state = readState();
    if (!state.active || state.active.releaseId !== releaseId) {
      fail('cannot retire a release that is not the active release');
    }
    if (![RELEASE_STATUSES.ELIGIBLE, RELEASE_STATUSES.STAGING_HEALTHY]
      .includes(state.active.status)) {
      fail('cannot retire a mutation-admitting or terminal release');
    }
    // A verified backup does not mutate production. `production_observing` is
    // persisted before the migrator may run, so ELIGIBLE/STAGING_HEALTHY remains
    // safe to retire even when a crash left pre-migration backup evidence there.
    if (blockReason !== null && !Object.values(BLOCK_REASONS).includes(blockReason)) {
      fail('cannot retire a release with an ungoverned block reason');
    }
    const at = timestamp();
    const history = [{
      releaseId,
      status: RELEASE_STATUSES.SUPERSEDED,
      completedAt: at,
      recoveryTiming: null,
    }, ...state.history].slice(0, MAX_HISTORY);
    return writeState({
      ...state,
      active: null,
      history,
      blocked: blockReason === null
        ? state.blocked
        : { releaseId, reason: blockReason, since: at },
    });
  }

  function block({ releaseId, reason }) {
    const state = readState();
    if (state.blocked?.releaseId === releaseId && state.blocked.reason === reason) {
      return state;
    }
    return writeState({
      ...state,
      blocked: { releaseId, reason, since: timestamp() },
    });
  }

  /**
   * Clear the block only. `unresolvedContractMigrations` is deliberately left in
   * place: acknowledging an incident says "I have seen this", not "the pending
   * contract migration is now safe". Only observed evidence — the migration no
   * longer being pending — clears that.
   */
  function acknowledgeBlock() {
    const state = readState();
    if (!state.blocked) fail('there is no blocked release to acknowledge');
    // The reason projected in `blocked` is not proof that a terminal receipt was
    // written. A process can die after recording rollback_fired, rollback_failed,
    // database_integrity_failed, or receipt_unwritable but before publishing the
    // immutable outcome. Refuse acknowledgement for every such receiptless
    // mutation-admitting state, regardless of the older projected reason.
    const effective = resolveEffectiveRelease({ state, readReceipt });
    if (!effective.provable) {
      fail('an unprovable active release must be recovered before acknowledgement');
    }
    return writeState({ ...state, blocked: null });
  }

  function recordUnresolvedContractMigrations({ releaseId, files }) {
    const state = readState();
    const merged = [...new Set([
      ...(state.unresolvedContractMigrations?.files ?? []),
      ...files,
    ])].sort();
    return writeState({
      ...state,
      unresolvedContractMigrations: {
        releaseId,
        files: merged,
        since: state.unresolvedContractMigrations?.since ?? timestamp(),
      },
    });
  }

  /** Cleared only when the ledger proves nothing incompatible is pending. */
  function clearUnresolvedContractMigrations() {
    const state = readState();
    if (!state.unresolvedContractMigrations) return state;
    return writeState({ ...state, unresolvedContractMigrations: null });
  }

  /**
   * Durable monotonic source ordering. Recording the accepted run id is what makes
   * a replay of an older-but-still-fresh signed manifest refusable without having
   * to reason about receipts at all.
   */
  function recordAcceptedRunId(runId) {
    const state = readState();
    const current = state.lastAcceptedRunId ? BigInt(state.lastAcceptedRunId) : 0n;
    const candidate = BigInt(runId);
    if (candidate <= current) return state;
    return writeState({ ...state, lastAcceptedRunId: String(candidate) });
  }

  function isStaleRunId(runId) {
    const state = readState();
    if (!state.lastAcceptedRunId) return false;
    return BigInt(runId) <= BigInt(state.lastAcceptedRunId);
  }

  /**
   * A release identity that already failed stays refused. Retrying the same
   * digests unattended would re-run a known-bad deployment on a timer.
   */
  function reject({ releaseId, reason }) {
    const state = readState();
    const rejected = [
      { releaseId, reason: sanitizeDetail(reason) ?? 'unspecified', at: timestamp() },
      ...state.rejected.filter((entry) => entry.releaseId !== releaseId),
    ].slice(0, MAX_REJECTED);
    return writeState({ ...state, rejected });
  }

  function isRejected(releaseId) {
    return readState().rejected.some((entry) => entry.releaseId === releaseId);
  }

  function receiptPath(releaseId) {
    return path.join(receiptDir, `${releaseId}.json`);
  }

  function writeReceipt(receipt) {
    assertReleaseReceiptShape(receipt);
    const file = receiptPath(receipt.releaseId);
    atomicWriteJson(file, receipt, { exclusive: true });
    return { path: file, digest: sha256(canonicalJson(receipt)) };
  }

  function readReceipt(releaseId) {
    assertReleaseId(releaseId, 'receipt releaseId');
    const raw = readJsonFailClosed(receiptPath(releaseId), `release receipt ${releaseId}`);
    if (raw === null) return null;
    // Addressing is part of the evidence boundary. A valid receipt copied under
    // another release's filename must not be accepted as proof for the requested
    // release merely because its internal shape is otherwise well formed.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.releaseId !== releaseId) {
      fail(`release receipt embedded id does not match the requested release id ${releaseId}`);
    }
    return assertReleaseReceiptShape(raw);
  }

  function listReceiptIds() {
    let entries = [];
    try {
      entries = fs.readdirSync(receiptDir);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    return entries
      .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
      .map((name) => name.replace(/\.json$/, ''))
      .sort();
  }

  return {
    stateFile,
    receiptPath,
    readState,
    writeState,
    recordStatus,
    beginAttempt,
    completeRelease,
    retirePreProduction,
    block,
    acknowledgeBlock,
    recordUnresolvedContractMigrations,
    clearUnresolvedContractMigrations,
    recordAcceptedRunId,
    isStaleRunId,
    reject,
    isRejected,
    writeReceipt,
    readReceipt,
    listReceiptIds,
  };
}

export function assertReleaseReceiptShape(receipt) {
  // Deliberately no audit-mirror field: the mirror copies this exact file, so a
  // mirror outcome recorded inside it could never be accurate at write time, and
  // a receipt that gets rewritten after the fact is not immutable. Mirror
  // outcomes live in state evidence and in the failure notification instead.
  const hasControlPlane = Object.hasOwn(receipt ?? {}, 'controlPlane');
  const legacy = receipt?.schema === LEGACY_RELEASE_RECEIPT_SCHEMA;
  const current = receipt?.schema === RELEASE_RECEIPT_SCHEMA;
  if (!legacy && !current) fail('release receipt schema is unsupported');
  if ((legacy && hasControlPlane) || (current && !hasControlPlane)) {
    fail('release receipt schema and controlPlane presence do not match');
  }
  exactKeys(receipt, [
    'schema', 'releaseId', 'sourceSha', 'createdAt', 'completedAt', 'evidenceDigest',
    'identity', 'images',
    'compose', ...(hasControlPlane ? ['controlPlane'] : []),
    'migrations', 'staging', 'production', 'backup', 'rollback',
    'outcome', 'failureCode',
  ], 'release receipt');
  assertReleaseId(receipt.releaseId, 'release receipt releaseId');
  assertFullSha(receipt.sourceSha, 'release receipt sourceSha');
  assertCanonicalTimestamp(receipt.createdAt, 'release receipt createdAt');
  assertCanonicalTimestamp(receipt.completedAt, 'release receipt completedAt');
  assertHexSha256(receipt.evidenceDigest, 'release receipt evidenceDigest');

  const identity = exactKeys(receipt.identity, [
    'repository', 'ref', 'workflow', 'runId', 'runAttempt', 'manifestDigest', 'keyId',
    'releasePayloadDigest',
  ], 'release receipt identity');
  assertBoundedIdentifier(identity.repository, 'release receipt identity repository');
  assertBoundedIdentifier(identity.ref, 'release receipt identity ref');
  assertBoundedText(identity.workflow, 'release receipt identity workflow');
  assertPositiveIntegerText(identity.runId, 'release receipt identity runId');
  assertPositiveIntegerText(identity.runAttempt, 'release receipt identity runAttempt');
  assertHexSha256(identity.manifestDigest, 'release receipt identity manifestDigest');
  assertBoundedIdentifier(identity.keyId, 'release receipt identity keyId', { max: 128 });
  assertOciDigest(
    identity.releasePayloadDigest,
    'release receipt identity releasePayloadDigest',
  );

  assertImagePair(receipt.images, 'release receipt images');
  if (receipt.images.backend.digest === receipt.images.contentEngine.digest) {
    fail('release receipt image digests must identify distinct images');
  }

  const compose = exactKeys(receipt.compose, ['path', 'digest'], 'release receipt compose');
  assertRelativeArtifactPath(compose.path, 'release receipt compose path');
  assertHexSha256(compose.digest, 'release receipt compose digest');
  const controlPlane = hasControlPlane
    ? assertReleaseControlPlaneShape(receipt.controlPlane, 'release receipt controlPlane')
    : null;

  const migrations = exactKeys(receipt.migrations, [
    'digest', 'reconciliationDigest', 'upFileCount', 'downFileCount', 'eligible',
    'predecessorCompatible', 'reasons',
  ], 'release receipt migrations');
  assertHexSha256(migrations.digest, 'release receipt migrations digest');
  assertHexSha256(
    migrations.reconciliationDigest,
    'release receipt migrations reconciliationDigest',
  );
  assertNonNegativeInteger(migrations.upFileCount, 'release receipt migrations upFileCount');
  assertNonNegativeInteger(migrations.downFileCount, 'release receipt migrations downFileCount');
  if (typeof migrations.eligible !== 'boolean'
      || typeof migrations.predecessorCompatible !== 'boolean') {
    fail('release receipt migration verdict flags must be booleans');
  }
  if (!Array.isArray(migrations.reasons)
      || migrations.reasons.length > 32
      || migrations.reasons.some((reason) => {
        try {
          assertBoundedText(reason, 'release receipt migration reason');
          return false;
        } catch {
          return true;
        }
      })) {
    fail('release receipt migration reasons must be a bounded text list');
  }
  if (migrations.eligible && !migrations.predecessorCompatible) {
    fail('release receipt claims eligibility for predecessor-incompatible migrations');
  }
  if (!migrations.predecessorCompatible && migrations.reasons.length === 0) {
    fail('release receipt incompatible migrations must name a reason');
  }

  for (const phase of ['staging', 'production']) {
    const value = exactKeys(receipt[phase], [
      'result', 'checks', 'durationMs',
    ], `release receipt ${phase}`);
    if (!['passed', 'failed', 'skipped'].includes(value.result)) {
      fail(`release receipt ${phase} result is invalid`);
    }
    if (!Array.isArray(value.checks) || value.checks.length > 64) {
      fail(`release receipt ${phase} checks must be a bounded array`);
    }
    assertNonNegativeInteger(value.durationMs, `release receipt ${phase} durationMs`);
    for (const check of value.checks) {
      const entry = exactKeys(check, ['name', 'result', 'durationMs', 'detail'], `release receipt ${phase} check`);
      if (typeof entry.name !== 'string' || !/^[a-z][a-z0-9_-]{0,127}$/.test(entry.name)) {
        fail(`release receipt ${phase} check name is invalid`);
      }
      if (!['passed', 'failed', 'skipped'].includes(entry.result)) {
        fail(`release receipt ${phase} check result is invalid`);
      }
      assertNonNegativeInteger(
        entry.durationMs,
        `release receipt ${phase} check durationMs`,
      );
      if (entry.detail !== null
          && (typeof entry.detail !== 'string'
            || entry.detail !== sanitizeDetail(entry.detail))) {
        fail(`release receipt ${phase} check detail is not sanitized`);
      }
    }
  }

  const backup = exactKeys(receipt.backup, ['result', 'artifact'], 'release receipt backup');
  if (!['passed', 'failed', 'skipped'].includes(backup.result)) {
    fail('release receipt backup result is invalid');
  }
  if (backup.result === 'passed') {
    if (typeof backup.artifact !== 'string' || !GOVERNED_ARTIFACT.test(backup.artifact)) {
      fail('release receipt passed backup must name a governed artifact');
    }
  } else if (backup.artifact !== null) {
    fail('release receipt non-passing backup must not name an artifact');
  }

  const rollback = exactKeys(receipt.rollback, [
    'result', 'restored', 'incidentRecoveryDurationMs',
    'predecessorSwitchDurationMs', 'predecessorSwitchObjectiveSeconds',
  ], 'release receipt rollback');
  // `not_attempted` is distinct from `failed`: a corrupt database deliberately
  // stops before rollback, because swapping images cannot repair the data and
  // restoring an older database would discard valid writes.
  if (!['not_required', 'restored', 'failed', 'not_attempted'].includes(rollback.result)) {
    fail('release receipt rollback result is invalid');
  }
  assertRecoveryTiming({
    incidentRecoveryDurationMs: rollback.incidentRecoveryDurationMs,
    predecessorSwitchDurationMs: rollback.predecessorSwitchDurationMs,
    predecessorSwitchObjectiveSeconds: rollback.predecessorSwitchObjectiveSeconds,
  }, 'release receipt rollback timing', {
    requireWithinObjective: rollback.result === 'restored',
  });
  if (rollback.result === 'not_required'
      && (rollback.incidentRecoveryDurationMs !== 0
        || rollback.predecessorSwitchDurationMs !== 0)) {
    fail('release receipt not-required rollback cannot claim recovery time');
  }
  if (rollback.result === 'not_attempted' && rollback.predecessorSwitchDurationMs !== 0) {
    fail('release receipt not-attempted rollback cannot claim predecessor switch time');
  }
  if (rollback.result === 'restored') {
    assertImagePair(rollback.restored, 'release receipt rollback restored');
    if (rollback.restored.backend.digest === rollback.restored.contentEngine.digest) {
      fail('release receipt restored image digests must identify distinct images');
    }
  } else if (rollback.restored !== null) {
    fail('release receipt non-restored rollback must not claim restored images');
  }

  // `staging_failed` is kept distinct from `blocked`: one means the rehearsal
  // rejected the candidate; the other is a hard halt without a completed or
  // rollback terminal result and may follow staging or production mutation.
  // Collapsing them would erase whether rehearsal failed or an unresolved
  // safety condition stopped the control plane.
  if (!RECEIPT_OUTCOME_VALUES.includes(receipt.outcome)) {
    fail('release receipt outcome is invalid');
  }
  if (receipt.failureCode !== null && receipt.failureCode !== sanitizeDetail(receipt.failureCode)) {
    fail('release receipt failureCode is not sanitized');
  }
  if (receipt.outcome === 'completed') {
    if (receipt.failureCode !== null
        || receipt.staging.result !== 'passed'
        || receipt.production.result !== 'passed'
        || backup.result !== 'passed'
        || rollback.result !== 'not_required') {
      fail('completed release receipt carries contradictory terminal evidence');
    }
  } else if (receipt.failureCode === null) {
    fail('non-completed release receipt must carry a failureCode');
  }
  if (receipt.outcome === 'rolled_back'
      && (receipt.staging.result !== 'passed'
        || receipt.production.result !== 'failed'
        || backup.result !== 'passed'
        || rollback.result !== 'restored')) {
    fail('rolled-back receipt must prove failed production and restored images');
  }
  if (receipt.outcome === 'rollback_failed'
      && (receipt.staging.result !== 'passed'
        || receipt.production.result !== 'failed'
        || backup.result !== 'passed'
        || !['failed', 'not_attempted'].includes(rollback.result))) {
    fail('rollback-failed receipt carries a contradictory rollback result');
  }
  if (receipt.outcome === 'staging_failed'
      && (receipt.staging.result !== 'failed'
        || receipt.production.result !== 'skipped'
        || backup.result !== 'skipped'
        || rollback.result !== 'not_required')) {
    fail('staging-failed receipt carries contradictory phase evidence');
  }

  // The filename is only an address. Recompute the identity from the receipt's
  // load-bearing signed-content fields so altered source/image/Compose/migration
  // evidence cannot retain the old address and masquerade as the same release.
  const expectedReleaseId = releaseIdFor({
    source: { sha: receipt.sourceSha },
    images: receipt.images,
    compose: receipt.compose,
    ...(controlPlane ? { controlPlane } : {}),
    migrations: receipt.migrations,
  });
  if (receipt.releaseId !== expectedReleaseId) {
    fail('release receipt release id does not match its content');
  }
  const expectedEvidenceDigest = releaseEvidenceDigest({
    manifestPayload: {
      source: {
        repository: identity.repository,
        ref: identity.ref,
        sha: receipt.sourceSha,
        workflow: identity.workflow,
        runId: identity.runId,
        runAttempt: identity.runAttempt,
      },
      images: receipt.images,
      compose: receipt.compose,
      ...(controlPlane ? { controlPlane } : {}),
      migrations: {
        digest: migrations.digest,
        reconciliationDigest: migrations.reconciliationDigest,
        upFileCount: migrations.upFileCount,
        downFileCount: migrations.downFileCount,
        cdEligibility: {
          eligible: migrations.eligible,
          predecessorCompatible: migrations.predecessorCompatible,
          reasons: migrations.reasons,
        },
      },
    },
    manifestDigest: identity.manifestDigest,
    keyId: identity.keyId,
    releasePayloadDigest: identity.releasePayloadDigest,
  });
  if (receipt.evidenceDigest !== expectedEvidenceDigest) {
    fail('release receipt evidence digest does not match its signed claims');
  }
  return receipt;
}

/**
 * Evidence outranks a stale state projection.
 *
 * The state file is a projection written by a process that can die between two
 * writes; a receipt is only written once a phase has actually settled. So a
 * completed receipt for the active release is proof when the projection is a
 * compatible `production_observing` or `completed` state. Every receipt outcome
 * has the same explicit compatibility gate. An unreadable receipt is never
 * treated as absent — it escalates to `unprovable`, which blocks rather than
 * authorizing new work.
 */
export function resolveEffectiveRelease({ state, readReceipt }) {
  if (!state.active) {
    return { source: 'state', status: null, releaseId: null, provable: true };
  }
  const { releaseId, status } = state.active;
  let receipt = null;
  try {
    receipt = readReceipt(releaseId);
  } catch {
    return { source: 'receipt', status, releaseId, provable: false };
  }
  if (receipt) {
    const compatibleStatuses = RELEASE_RECEIPT_STATUS_COMPATIBILITY[receipt.outcome];
    const outcomeCompatible = Boolean(compatibleStatuses?.includes(status));
    // A terminal file is proof only for the exact write-ahead identity it settles.
    // In particular, its OCI payload digest must match state before callers may
    // use the receipt + moving pointer to skip manifest freshness verification.
    // This also prevents a valid receipt copied beside unrelated/corrupt state
    // from suppressing the crash-recovery branch.
    const activeMayHaveMutated = [
      RELEASE_STATUSES.PRODUCTION_OBSERVING,
      RELEASE_STATUSES.COMPLETED,
      RELEASE_STATUSES.ROLLED_BACK,
      RELEASE_STATUSES.ROLLBACK_FAILED,
    ].includes(status);
    const backupBound = !activeMayHaveMutated
      || (state.active.backupEvidence !== null
        && state.active.backupArtifact !== null
        && receipt.backup.result === 'passed'
        && receipt.backup.artifact === state.active.backupArtifact);
    const boundToActive = receipt.releaseId === releaseId
      && receipt.sourceSha === state.active.sourceSha
      && imagePairMatches(receipt.images, state.active.images)
      && receipt.compose.digest === state.active.payload.composeDigest
      && receipt.identity.releasePayloadDigest === state.active.payload.digest
      && receipt.evidenceDigest === state.active.evidenceDigest
      && outcomeCompatible
      && backupBound
      && (receipt.outcome !== 'rolled_back'
        || (receipt.rollback.result === 'restored'
          && state.active.rollbackTarget !== null
          && imagePairMatches(receipt.rollback.restored, state.active.rollbackTarget.images)));
    if (!boundToActive) {
      return {
        source: 'receipt',
        status,
        releaseId,
        provable: false,
        stateStatus: status,
        staleProjection: false,
      };
    }
    const receiptStatus = RECEIPT_TERMINAL_STATUS[receipt.outcome] ?? status;
    return {
      source: 'receipt',
      status: receiptStatus,
      releaseId,
      provable: true,
      stateStatus: status,
      staleProjection: receiptStatus !== status,
      releasePayloadDigest: receipt.identity.releasePayloadDigest,
    };
  }
  // Any status that admits production may have been mutated is unprovable
  // without a terminal receipt.
  //
  // `production_observing` is written *before* the migrator and the Compose
  // switch, so seeing it with no receipt means the poller died somewhere inside
  // the mutation window and nothing on disk says where. Treating that as
  // provable let a newer release start on top of a half-migrated or
  // half-switched production, which is the worst state this system can reach.
  //
  // The three settled statuses are unprovable for the same reason: the writer
  // died between the state write and the receipt write.
  const mutationAdmitting = [
    RELEASE_STATUSES.PRODUCTION_OBSERVING,
    RELEASE_STATUSES.COMPLETED,
    RELEASE_STATUSES.ROLLED_BACK,
    RELEASE_STATUSES.ROLLBACK_FAILED,
  ];
  return {
    source: 'state',
    status,
    releaseId,
    provable: !mutationAdmitting.includes(status),
    stateStatus: status,
    staleProjection: false,
  };
}
