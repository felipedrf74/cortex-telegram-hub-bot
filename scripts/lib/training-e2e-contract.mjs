import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TRAINING_E2E_REQUIRED_LIFECYCLE_STEP_IDS = Object.freeze([
  'first_run_profile_blocker',
  'no_plan_home',
  'plan_preview',
  'plan_generate_activate',
  'today_plan_progress_read_models',
  'feedback_variants_and_repeated_skips',
  'successful_fixture_reflow_swap',
  'stale_readiness_degraded',
  'calendar_sync_provider_safe',
  'cancel_cleanup_and_no_plan_recovery',
]);

const TRAINING_E2E_REQUIRED_PROFILE_TYPES = Object.freeze([
  'fitness',
  'triathlon-gym',
  'triathlon-running',
  'triathlon-cycling',
  'triathlon-swim',
]);

const TRAINING_E2E_STATEFUL_PERSONA_FIXTURES = Object.freeze({
  poor_adherence: { adherence: 'repeated_skips', minSkippedRows: 3 },
  fatigue_plateau: { readiness: 'low_apple_health', adherence: 'fatigue_overreach', minCompletionRows: 3 },
  stale_wearable: { readiness: 'stale_apple_health', requireStale: true },
  no_wearable: { readiness: 'none', source: 'estimated', maxHealthRows: 0 },
  calendar_conflicted: { calendar: 'busy_windows', minEventRows: 2 },
});

export function resolveTrainingE2EStatePolicy({ exists, resume }) {
  if (exists && !resume) {
    throw new Error('Training E2E state directory already exists; choose a fresh run id or set NEXUS_TRAINING_E2E_RESUME=1 for non-qualifying debug use.');
  }
  return exists
    ? { mode: 'resume', qualifying: false }
    : { mode: 'fresh', qualifying: true };
}

export function resolveTrainingE2EStatePath(trainingE2ERoot, runId) {
  const resolvedRoot = path.resolve(trainingE2ERoot);
  const resolvedState = path.resolve(resolvedRoot, String(runId || ''));
  if (resolvedState === resolvedRoot || !resolvedState.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Training E2E state path resolves outside ${resolvedRoot}: ${resolvedState}`);
  }
  return resolvedState;
}

export function assertResolvedTrainingE2EPath(trainingE2ERoot, candidate, label = 'path') {
  const resolvedRoot = path.resolve(trainingE2ERoot);
  const resolvedCandidate = path.resolve(String(candidate || ''));
  if (!resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing Training E2E ${label} outside ${resolvedRoot}: ${resolvedCandidate}`);
  }
  return resolvedCandidate;
}

export function buildRunScopedImageNames(runId) {
  const suffix = String(runId || '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(suffix)) {
    throw new Error(`Invalid Training E2E run id for image names: ${runId}`);
  }
  return {
    backend: `nexus-hub-node:training-e2e-${suffix}`,
    contentEngine: `nexus-hub-content-engine:training-e2e-${suffix}`,
  };
}

/**
 * Hash the complete Git-visible dirty source state without publishing patch
 * text or file contents. `git diff HEAD` covers staged and unstaged tracked
 * changes; the canonical untracked manifest adds every non-ignored file by
 * path, type/mode, and content digest.
 */
export function computeTrainingE2EDirtyTreeDigest({ repoRoot, gitDir }) {
  const resolvedRoot = path.resolve(String(repoRoot || ''));
  const resolvedGitDir = path.resolve(String(gitDir || ''));
  const git = (args) => execFileSync(
    'git',
    [`--git-dir=${resolvedGitDir}`, `--work-tree=${resolvedRoot}`, ...args],
    { encoding: null, maxBuffer: 256 * 1024 * 1024 },
  );
  const digest = crypto.createHash('sha256');
  digest.update('nexus-training-e2e-dirty-tree.v1\0');
  digest.update(git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']));

  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const relativePath of untracked) {
    const absolutePath = path.resolve(resolvedRoot, relativePath);
    if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Refusing to hash untracked source outside ${resolvedRoot}: ${absolutePath}`);
    }
    const stat = fs.lstatSync(absolutePath);
    const type = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other';
    const executable = stat.mode & 0o111 ? 'x' : '-';
    const content = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(absolutePath), 'utf8')
      : stat.isFile()
        ? fs.readFileSync(absolutePath)
        : Buffer.alloc(0);
    const contentDigest = crypto.createHash('sha256').update(content).digest('hex');
    digest.update('untracked\0');
    digest.update(relativePath);
    digest.update('\0');
    digest.update(type);
    digest.update('\0');
    digest.update(executable);
    digest.update('\0');
    digest.update(contentDigest);
    digest.update('\0');
  }
  return digest.digest('hex');
}

/**
 * Fail closed unless a run is bound to exact backend source and the two
 * run-scoped images actually used by its running containers. iOS source
 * provenance is a separate contract owned by the iOS runner.
 */
export function assertTrainingE2ERunProvenance(value) {
  const errors = [];
  const runId = typeof value?.runId === 'string' ? value.runId.trim() : '';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(runId)) errors.push('run id is missing or invalid');
  if (value?.git && value?.schemaVersion !== 'training_e2e_environment.v2') {
    errors.push('run metadata schema must be training_e2e_environment.v2');
  }

  const backendGit = value?.backendGit ?? value?.git;
  if (!/^[a-f0-9]{40}$/i.test(String(backendGit?.commit ?? ''))) {
    errors.push('exact backend commit must be a 40-character Git SHA');
  }
  if (!/^[a-f0-9]{40}$/i.test(String(backendGit?.baseCommit ?? ''))) {
    errors.push('exact backend base commit must be a 40-character Git SHA');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(backendGit?.dirtyTreeDiffSha256 ?? ''))) {
    errors.push('backend dirty-tree diff digest must be a SHA-256 hex value');
  }

  let expectedImageNames = null;
  try {
    expectedImageNames = buildRunScopedImageNames(runId);
  } catch {
    // The run-id error above is the useful diagnostic.
  }
  for (const [key, label] of [['backend', 'backend'], ['contentEngine', 'content-engine']]) {
    const image = value?.images?.[key];
    const expectedName = expectedImageNames?.[key];
    if (!image || typeof image !== 'object') {
      errors.push(`${label} image provenance is missing`);
      continue;
    }
    if (expectedName && image.name !== expectedName) {
      errors.push(`run-scoped ${label} image name must be ${expectedName}`);
    }
    const builtImageId = String(image.builtImageId ?? '');
    const actualImageId = String(image.actualContainerImageId ?? '');
    if (!/^sha256:[a-f0-9]{64}$/i.test(builtImageId)) {
      errors.push(`built ${label} image id must be an exact sha256 identity`);
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(actualImageId)) {
      errors.push(`running ${label} image id must be an exact sha256 identity`);
    } else if (builtImageId !== actualImageId) {
      errors.push(`running ${label} image does not match the run-scoped built image`);
    }
  }

  if (errors.length > 0) throw new Error(`Training E2E provenance failed:\n- ${errors.join('\n- ')}`);
  return value;
}

/**
 * Compare startup metadata with observations collected immediately before a
 * qualifying flow or quality artifact is written. Callers own the read-only
 * Git/Docker inspection; this helper owns the exact fail-closed comparison.
 */
export function assertTrainingE2ECurrentRuntimeProvenance(recorded, current) {
  assertTrainingE2ERunProvenance(recorded);
  const backendGit = recorded?.backendGit ?? recorded?.git;
  const errors = [];
  for (const [field, label] of [
    ['commit', 'backend commit'],
    ['baseCommit', 'backend base commit'],
    ['dirtyTreeDiffSha256', 'backend dirty-tree source digest'],
  ]) {
    if (typeof current?.[field] !== 'string' || current[field] !== backendGit?.[field]) {
      errors.push(`current ${label} does not match recorded provenance`);
    }
  }
  if (current?.backendActualImageId !== recorded?.images?.backend?.actualContainerImageId) {
    errors.push('current backend running image does not match recorded provenance');
  }
  if (current?.contentActualImageId !== recorded?.images?.contentEngine?.actualContainerImageId) {
    errors.push('current content-engine running image does not match recorded provenance');
  }
  if (errors.length > 0) {
    throw new Error(`Training E2E current runtime provenance failed:\n- ${errors.join('\n- ')}`);
  }
  return recorded;
}

export function normalizeLiveCalendarProviders(providers) {
  const normalized = [...new Set((Array.isArray(providers) ? providers : [])
    .map((provider) => String(provider).trim().toLowerCase())
    .filter(Boolean))];
  if (normalized.length === 0) {
    throw new Error('At least one live Training E2E calendar provider is required.');
  }
  const invalid = normalized.filter((provider) => provider !== 'google' && provider !== 'outlook');
  if (invalid.length > 0) {
    throw new Error(`Unsupported live Training E2E calendar provider(s): ${invalid.join(', ')}`);
  }
  return normalized;
}

export function buildLiveCalendarComposeOverride(providers) {
  const selected = normalizeLiveCalendarProviders(providers);
  const environment = [
    '      TRAINING_CALENDAR_WRITES_ENABLED: "true"',
    '      TRAINING_CALENDAR_SYNC_ENABLED: "true"',
  ];
  if (selected.includes('google')) {
    environment.push(
      '      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:?GOOGLE_CLIENT_ID required for live Training calendar E2E}',
      '      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:?GOOGLE_CLIENT_SECRET required for live Training calendar E2E}',
      '      GOOGLE_REFRESH_TOKEN: ""',
    );
  }
  if (selected.includes('outlook')) {
    environment.push(
      '      OUTLOOK_CLIENT_ID: ${OUTLOOK_CLIENT_ID:?OUTLOOK_CLIENT_ID required for live Training calendar E2E}',
      '      OUTLOOK_CLIENT_SECRET: ${OUTLOOK_CLIENT_SECRET:?OUTLOOK_CLIENT_SECRET required for live Training calendar E2E}',
      '      OUTLOOK_TENANT_ID: ${OUTLOOK_TENANT_ID:?OUTLOOK_TENANT_ID required for live Training calendar E2E}',
      '      OUTLOOK_REFRESH_TOKEN: ""',
    );
  }
  return ['services:', '  nexus-hub:', '    environment:', ...environment, ''].join('\n');
}

export function assertTrainingE2EEvidenceComplete(evidence, { personaIds } = {}) {
  const errors = [];
  const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  const isStringArray = (value) => Array.isArray(value) && value.every(isNonEmptyString);
  const isNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
  const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
  const generatedAtMs = Date.parse(String(evidence?.generatedAt ?? ''));

  if (!isRecord(evidence)) errors.push('evidence is missing');
  if (evidence?.schemaVersion !== 'training_e2e_contract.v3') {
    errors.push('evidence schema must be training_e2e_contract.v3');
  }
  if (evidence?.qualifying !== true) {
    errors.push('resume/non-qualifying Training E2E evidence cannot satisfy the release contract');
  }
  if (!Number.isFinite(generatedAtMs)) errors.push('evidence generatedAt must be a valid timestamp');
  if (!isIsolatedLoopbackUrl(evidence?.backendBaseUrl)) {
    errors.push('evidence backendBaseUrl must be an isolated non-default loopback URL');
  }
  try {
    assertTrainingE2ERunProvenance(evidence);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const lifecycle = evidence?.lifecycleEvidence;
  let lifecycleRows = [];
  if (!isRecord(lifecycle)) {
    errors.push('lifecycle evidence is missing');
  } else {
    if (lifecycle.schemaVersion !== 'training_e2e_flow.v2') {
      errors.push('lifecycle evidence schema must be training_e2e_flow.v2');
    }
    if (!isNonEmptyString(lifecycle.flowAttemptId)) errors.push('lifecycle flowAttemptId is missing');
    if (lifecycle.runId !== evidence.runId) errors.push('lifecycle run id does not match final evidence');
    if (lifecycle.baseUrl !== evidence.backendBaseUrl) {
      errors.push('lifecycle base URL does not match final evidence');
    }
    if (lifecycle.backendBaseUrl !== evidence.backendBaseUrl) {
      errors.push('lifecycle backend URL does not match final evidence');
    }
    const lifecycleProvenance = lifecycle.backendProvenance;
    if (!isRecord(lifecycleProvenance)) {
      errors.push('lifecycle backend provenance is missing');
    } else {
      if (lifecycleProvenance.schemaVersion !== 'training_e2e_backend_provenance.v1') {
        errors.push('lifecycle backend provenance schema must be training_e2e_backend_provenance.v1');
      }
      if (lifecycleProvenance.environmentSchemaVersion !== 'training_e2e_environment.v2') {
        errors.push('lifecycle environment schema must be training_e2e_environment.v2');
      }
      const verifiedAtMs = Date.parse(String(lifecycleProvenance.verifiedAt ?? ''));
      if (!Number.isFinite(verifiedAtMs)) {
        errors.push('lifecycle provenance verifiedAt must be a valid timestamp');
      } else if (Number.isFinite(generatedAtMs) && verifiedAtMs > generatedAtMs) {
        errors.push('lifecycle provenance cannot be verified after final evidence generation');
      }
      for (const field of ['commit', 'baseCommit', 'dirtyTreeDiffSha256']) {
        if (lifecycleProvenance.git?.[field] !== evidence?.backendGit?.[field]) {
          errors.push(`lifecycle source provenance ${field} does not match final evidence`);
        }
      }
      for (const key of ['backend', 'contentEngine']) {
        for (const field of ['name', 'builtImageId', 'actualContainerImageId']) {
          if (lifecycleProvenance.images?.[key]?.[field] !== evidence?.images?.[key]?.[field]) {
            errors.push(`lifecycle ${key} image provenance ${field} does not match final evidence`);
          }
        }
      }
    }
    lifecycleRows = Array.isArray(lifecycle.steps) ? lifecycle.steps : [];
  }
  const lifecycleIds = lifecycleRows.map((row) => row?.step);
  const lifecycleById = new Map(lifecycleRows.map((row) => [row?.step, row]));
  for (const stepId of TRAINING_E2E_REQUIRED_LIFECYCLE_STEP_IDS) {
    const row = lifecycleById.get(stepId);
    if (!row) errors.push(`missing lifecycle step ${stepId}`);
    else if (row.status !== 'pass') errors.push(`lifecycle step ${stepId} did not pass`);
    if (lifecycleIds.filter((value) => value === stepId).length > 1) {
      errors.push(`lifecycle step ${stepId} is duplicated`);
    }
  }

  const expectedPersonaIds = Array.isArray(personaIds) ? personaIds : [];
  if (expectedPersonaIds.length === 0 || !expectedPersonaIds.every(isNonEmptyString)) {
    errors.push('canonical persona ids were not supplied');
  }
  if (new Set(expectedPersonaIds).size !== expectedPersonaIds.length) {
    errors.push('canonical persona ids must be distinct');
  }
  const personaRows = Array.isArray(evidence?.personas) ? evidence.personas : [];
  const personaById = new Map(personaRows.map((row) => [row?.personaId, row]));
  const fixtureUserIds = [];
  const planIds = [];
  for (const personaId of expectedPersonaIds) {
    const row = personaById.get(personaId);
    if (!isRecord(row)) {
      errors.push(`missing persona ${personaId}`);
      continue;
    }
    if (row.status !== 'pass') errors.push(`persona ${personaId} did not pass`);
    if (row.previewStatus !== 'preview') errors.push(`persona ${personaId} preview did not pass`);
    if (row.createStatus !== 'created') errors.push(`persona ${personaId} create did not pass`);
    if (row.cleanupStatus !== 'cancelled') errors.push(`persona ${personaId} cleanup did not cancel its plan`);
    if (row.planReadModelMatch !== true) errors.push(`persona ${personaId} plan/read-model invariant failed`);
    if (row.providerFreeAgendaIsolation !== true) {
      errors.push(`persona ${personaId} provider-free Secretary agenda isolation failed`);
    }
    if (!isPositiveInteger(row.planId)) errors.push(`persona ${personaId} planId must be a positive integer`);
    else planIds.push(row.planId);

    for (const countField of ['providerOAuthRows', 'providerEventMappings', 'providerOwnershipRows']) {
      if (row[countField] !== 0) errors.push(`persona ${personaId} ${countField} must be numeric zero`);
    }
    if (!Array.isArray(row.blockers)) {
      errors.push(`persona ${personaId} blockers must be an explicit array`);
    } else if (row.blockers.length > 0) {
      errors.push(`persona ${personaId} blockers: ${row.blockers.join('; ')}`);
    }

    for (const countField of ['totalSessions', 'persistedPlanSessions', 'readModelSessions']) {
      if (!isPositiveInteger(row[countField])) {
        errors.push(`persona ${personaId} ${countField} must be a positive integer`);
      }
    }
    if (
      isPositiveInteger(row.totalSessions)
      && isPositiveInteger(row.persistedPlanSessions)
      && isPositiveInteger(row.readModelSessions)
      && (row.totalSessions !== row.persistedPlanSessions || row.persistedPlanSessions !== row.readModelSessions)
    ) {
      errors.push(`persona ${personaId} session counts must agree across output, persistence, and read model`);
    }
    if (row.secretaryAgendaRows !== 0) errors.push(`persona ${personaId} secretaryAgendaRows must be numeric zero`);
    if (!isNonNegativeInteger(row.preferredTimeUnavailableCount)) {
      errors.push(`persona ${personaId} preferredTimeUnavailableCount must be a non-negative integer`);
    } else if (isPositiveInteger(row.persistedPlanSessions) && row.preferredTimeUnavailableCount > row.persistedPlanSessions) {
      errors.push(`persona ${personaId} preferredTimeUnavailableCount exceeds persisted sessions`);
    }
    if (row.busyWindowOverlapCount !== 0) {
      errors.push(`persona ${personaId} busyWindowOverlapCount must be numeric zero`);
    }
    if (!Array.isArray(row.identityMismatches)) {
      errors.push(`persona ${personaId} identityMismatches must be an explicit array`);
    } else if (row.identityMismatches.length > 0) {
      errors.push(`persona ${personaId} identity mismatches: ${row.identityMismatches.join('; ')}`);
    }
    for (const field of ['weekNotes', 'scheduleReasonCodes', 'scheduleStatuses']) {
      if (!isStringArray(row[field])) errors.push(`persona ${personaId} ${field} must be a string array`);
    }
    if (
      Array.isArray(row.scheduleStatuses)
      && isPositiveInteger(row.persistedPlanSessions)
      && row.scheduleStatuses.length !== row.persistedPlanSessions
    ) {
      errors.push(`persona ${personaId} scheduleStatuses must cover every persisted session`);
    }

    if (typeof row.qualityScore !== 'number' || !Number.isFinite(row.qualityScore)
      || row.qualityScore < 0 || row.qualityScore > 100) {
      errors.push(`persona ${personaId} qualityScore must be a finite value from 0 to 100`);
    }
    if (row.qualityVerdict !== 'pass' && row.qualityVerdict !== 'warn') {
      errors.push(`persona ${personaId} qualityVerdict must be pass or warn`);
    }
    validatePersonaSignalEvidence(row, personaId, errors);

    const cleanupProof = row.cleanupProof;
    if (!isRecord(cleanupProof)) {
      errors.push(`persona ${personaId} cleanup proof is missing`);
    } else {
      if (cleanupProof.clean !== true) errors.push(`persona ${personaId} cleanup proof must have clean=true`);
      for (const countField of [
        'planRows',
        'weekRows',
        'sessionRows',
        'completionRows',
        'agendaRows',
        'ownershipRows',
      ]) {
        if (cleanupProof[countField] !== 0) {
          errors.push(`persona ${personaId} cleanup ${countField} must be numeric zero`);
        }
      }
    }

    const fixtureCleanupProof = row.fixtureCleanupProof;
    if (!isRecord(fixtureCleanupProof)) {
      errors.push(`persona ${personaId} fixture cleanup proof is missing`);
    } else {
      if (fixtureCleanupProof.clean !== true) {
        errors.push(`persona ${personaId} fixture cleanup proof must have clean=true`);
      }
      for (const countField of [
        'planRows',
        'weekRows',
        'sessionRows',
        'completionRows',
        'agendaRows',
        'ownershipRows',
        'profileRows',
        'healthRows',
        'calendarFixtureRows',
        'deviceRows',
        'subscriptionRows',
        'idempotencyRows',
        'oauthRows',
        'operationLockRows',
        'outboxRows',
        'apiCacheRows',
        'userRows',
      ]) {
        if (fixtureCleanupProof[countField] !== 0) {
          errors.push(`persona ${personaId} fixture cleanup ${countField} must be numeric zero`);
        }
      }
    }

    const fixture = row.fixtureEvidence;
    const fixtureUserId = fixture?.userId;
    if (!Number.isInteger(fixtureUserId) || fixtureUserId < 1_000_000 || fixtureUserId > 1_099_999) {
      errors.push(`persona ${personaId} fixture user must be a numeric id in the reserved staging range`);
    } else {
      fixtureUserIds.push(fixtureUserId);
    }
    validateAuthorizationScopeIsolation(row.authorizationScopeIsolation, personaId, fixtureUserId, errors);

    const profileTypes = Array.isArray(fixture?.profileTypes) ? fixture.profileTypes : [];
    for (const profileType of TRAINING_E2E_REQUIRED_PROFILE_TYPES) {
      if (!profileTypes.includes(profileType)) errors.push(`persona ${personaId} missing fixture profile ${profileType}`);
    }
    if (new Set(profileTypes).size !== profileTypes.length) {
      errors.push(`persona ${personaId} fixture profile types must be distinct`);
    }
    if (!isRecord(fixture?.readiness) || !isRecord(fixture?.adherence) || !isRecord(fixture?.calendar)) {
      errors.push(`persona ${personaId} is missing durable fixture state evidence`);
      continue;
    }
    const expectedFixture = TRAINING_E2E_STATEFUL_PERSONA_FIXTURES[personaId];
    if (expectedFixture?.readiness && fixture.readiness.fixture !== expectedFixture.readiness) {
      errors.push(`persona ${personaId} readiness fixture must be ${expectedFixture.readiness}`);
    }
    if (expectedFixture?.source && fixture.readiness.source !== expectedFixture.source) {
      errors.push(`persona ${personaId} readiness source must be ${expectedFixture.source}`);
    }
    if (typeof fixture.readiness.isStale !== 'boolean') {
      errors.push(`persona ${personaId} readiness isStale must be an explicit boolean`);
    }
    if (!isNonNegativeInteger(fixture.readiness.healthRows)) {
      errors.push(`persona ${personaId} readiness healthRows must be a non-negative integer`);
    }
    validateReadinessFreshness(fixture.readiness, personaId, generatedAtMs, errors);
    if (expectedFixture?.requireStale === true && fixture.readiness.isStale !== true) {
      errors.push(`persona ${personaId} must prove stale readiness data`);
    }
    if (Number.isFinite(expectedFixture?.maxHealthRows)
      && (!isNonNegativeInteger(fixture.readiness.healthRows)
        || fixture.readiness.healthRows > expectedFixture.maxHealthRows)) {
      errors.push(`persona ${personaId} must not seed wearable rows`);
    }
    for (const countField of ['historyRows', 'skippedRows', 'completionRows']) {
      if (!isNonNegativeInteger(fixture.adherence[countField])) {
        errors.push(`persona ${personaId} adherence ${countField} must be a non-negative integer`);
      }
    }
    if (expectedFixture?.adherence && fixture.adherence.fixture !== expectedFixture.adherence) {
      errors.push(`persona ${personaId} adherence fixture must be ${expectedFixture.adherence}`);
    }
    if (Number.isFinite(expectedFixture?.minSkippedRows)
      && fixture.adherence.skippedRows < expectedFixture.minSkippedRows) {
      errors.push(`persona ${personaId} requires at least ${expectedFixture.minSkippedRows} skipped rows`);
    }
    if (Number.isFinite(expectedFixture?.minCompletionRows)
      && fixture.adherence.completionRows < expectedFixture.minCompletionRows) {
      errors.push(`persona ${personaId} requires at least ${expectedFixture.minCompletionRows} completion rows`);
    }
    if (!isNonNegativeInteger(fixture.calendar.eventRows)) {
      errors.push(`persona ${personaId} calendar eventRows must be a non-negative integer`);
    }
    if (expectedFixture?.calendar && fixture.calendar.fixture !== expectedFixture.calendar) {
      errors.push(`persona ${personaId} calendar fixture must be ${expectedFixture.calendar}`);
    }
    if (Number.isFinite(expectedFixture?.minEventRows)
      && fixture.calendar.eventRows < expectedFixture.minEventRows) {
      errors.push(`persona ${personaId} requires at least ${expectedFixture.minEventRows} calendar events`);
    }
  }
  if (new Set(fixtureUserIds).size !== fixtureUserIds.length) {
    errors.push('persona fixture users must be distinct and isolated');
  }
  if (new Set(planIds).size !== planIds.length) {
    errors.push('persona plan ids must be distinct');
  }
  if (personaRows.length !== expectedPersonaIds.length) {
    errors.push(`persona evidence count ${personaRows.length} does not match canonical count ${expectedPersonaIds.length}`);
  }
  if (errors.length > 0) throw new Error(`Training E2E contract failed:\n- ${errors.join('\n- ')}`);
  return evidence;
}

function isIsolatedLoopbackUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && Boolean(parsed.port)
      && parsed.port !== '8200';
  } catch {
    return false;
  }
}

function validatePersonaSignalEvidence(row, personaId, errors) {
  const validList = (value) => Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length > 0)
    && new Set(value).size === value.length;
  if (!validList(row.expectedSignals)) {
    errors.push(`persona ${personaId} expectedSignals must be a distinct non-empty string array`);
  }
  if (!validList(row.forbiddenConditions)) {
    errors.push(`persona ${personaId} forbiddenConditions must be a distinct non-empty string array`);
  }
  if (!row.signalEvidence || typeof row.signalEvidence !== 'object' || Array.isArray(row.signalEvidence)) {
    errors.push(`persona ${personaId} signal evidence is missing`);
    return;
  }
  const expected = Array.isArray(row.expectedSignals) ? [...row.expectedSignals].sort() : [];
  const actual = Object.keys(row.signalEvidence).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    errors.push(`persona ${personaId} signal evidence must have exact expected-signal key coverage`);
  }
  for (const key of expected) {
    const facts = row.signalEvidence[key];
    if (!Array.isArray(facts) || facts.length === 0
      || facts.some((fact) => typeof fact !== 'string' || fact.trim().length === 0)) {
      errors.push(`persona ${personaId} signal evidence ${key} must contain non-empty concrete facts`);
    }
  }
}

function validateAuthorizationScopeIsolation(isolation, personaId, fixtureUserId, errors) {
  if (!isolation || typeof isolation !== 'object' || !Array.isArray(isolation.probes)) {
    errors.push(`persona ${personaId} authorization scope isolation proof is missing`);
    return;
  }
  const requiredBoundaries = ['foreign_user_same_tenant', 'same_user_foreign_tenant'];
  const requiredProbeFields = [
    'boundary',
    'expectedOwnerTenantId',
    'expectedOwnerUserId',
    'foreignPlanId',
    'remainedActive',
    'remainedOwnedByExpectedScope',
    'responseCancelled',
    'responseStatus',
  ];
  const boundaries = isolation.probes.map((probe) => probe?.boundary);
  if (isolation.probes.length !== requiredBoundaries.length
    || new Set(boundaries).size !== requiredBoundaries.length
    || requiredBoundaries.some((boundary) => !boundaries.includes(boundary))) {
    errors.push(`persona ${personaId} authorization scope isolation must cover exactly both user/tenant boundaries`);
  }
  const planIds = [];
  for (const probe of isolation.probes) {
    const label = requiredBoundaries.includes(probe?.boundary) ? probe.boundary : 'unknown_boundary';
    const actualProbeFields = probe && typeof probe === 'object' && !Array.isArray(probe)
      ? Object.keys(probe).sort()
      : [];
    if (actualProbeFields.length !== requiredProbeFields.length
      || requiredProbeFields.some((field, index) => actualProbeFields[index] !== field)) {
      errors.push(`persona ${personaId} isolation ${label} probe must use the exact authorization evidence shape`);
    }
    if (probe?.responseCancelled !== null && typeof probe?.responseCancelled !== 'boolean') {
      errors.push(`persona ${personaId} isolation ${label} responseCancelled must be boolean or null`);
    }
    const routeDenied = [403, 404].includes(probe?.responseStatus)
      || (probe?.responseStatus === 200 && probe?.responseCancelled === false);
    if (!routeDenied || probe?.responseCancelled === true) {
      errors.push(`persona ${personaId} isolation ${label} did not explicitly deny cancellation`);
    }
    if (!Number.isInteger(probe?.foreignPlanId) || probe.foreignPlanId <= 0) {
      errors.push(`persona ${personaId} isolation ${label} foreignPlanId must be a positive integer`);
    } else {
      planIds.push(probe.foreignPlanId);
    }
    if (!Number.isInteger(probe?.expectedOwnerUserId) || probe.expectedOwnerUserId <= 0
      || !Number.isInteger(probe?.expectedOwnerTenantId) || probe.expectedOwnerTenantId <= 0) {
      errors.push(`persona ${personaId} isolation ${label} expected owner scope is invalid`);
    }
    if (Number.isInteger(fixtureUserId)) {
      if (label === 'foreign_user_same_tenant'
        && (probe.expectedOwnerUserId === fixtureUserId || probe.expectedOwnerTenantId !== fixtureUserId)) {
        errors.push(`persona ${personaId} isolation foreign_user_same_tenant scope does not match its boundary`);
      }
      if (label === 'same_user_foreign_tenant'
        && (probe.expectedOwnerUserId !== fixtureUserId || probe.expectedOwnerTenantId === fixtureUserId)) {
        errors.push(`persona ${personaId} isolation same_user_foreign_tenant scope does not match its boundary`);
      }
    }
    if (probe?.remainedOwnedByExpectedScope !== true) {
      errors.push(`persona ${personaId} isolation ${label} did not preserve expected ownership`);
    }
    if (probe?.remainedActive !== true) {
      errors.push(`persona ${personaId} isolation ${label} did not preserve the active plan`);
    }
  }
  if (new Set(planIds).size !== planIds.length) {
    errors.push(`persona ${personaId} authorization scope isolation probe plan ids must be distinct`);
  }
}

function validateReadinessFreshness(readiness, personaId, generatedAtMs, errors) {
  if (readiness.dataAsOf == null) return;
  if (typeof readiness.dataAsOf !== 'string') {
    errors.push(`persona ${personaId} readiness dataAsOf must be a timestamp or null`);
    return;
  }
  const dataAsOfMs = Date.parse(readiness.dataAsOf);
  if (!Number.isFinite(dataAsOfMs)) {
    errors.push(`persona ${personaId} readiness dataAsOf is invalid`);
    return;
  }
  if (!Number.isFinite(generatedAtMs)) return;
  if (dataAsOfMs > generatedAtMs) {
    errors.push(`persona ${personaId} readiness dataAsOf cannot be after evidence generation`);
    return;
  }
  const recomputedStale = generatedAtMs - dataAsOfMs > 36 * 60 * 60 * 1000;
  if (readiness.isStale !== recomputedStale) {
    errors.push(`persona ${personaId} readiness stale freshness does not match dataAsOf`);
  }
}
