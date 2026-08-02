import { createHash, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const CHAT_CAPABILITY_FLAG_PLAN_SCHEMA = 'nexus.chat-capability-flag-plan.v1';
export const CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA = 'nexus.chat-capability-flag-evidence.v1';
export const CHAT_CAPABILITY_FLAG_RECEIPT_SCHEMA = 'nexus.chat-capability-flag-transaction.v1';
export const CHAT_CAPABILITY_STAGING_PREREQUISITE_SCHEMA =
  'nexus.chat-capability-staging-prerequisite.v1';
export const CHAT_CAPABILITY_STAGING_SMOKE_PROFILE =
  'nexus.staging-smoke.canonical.token-zero-locale.v2';
export const CHAT_CAPABILITY_OBSERVATION_PLAN_SCHEMA =
  'nexus.chat-capability-observation-plan.v1';
export const CHAT_CAPABILITY_OBSERVATION_RECEIPT_SCHEMA =
  'nexus.chat-capability-observation-receipt.v1';
export const CHAT_CAPABILITY_OBSERVED_STAGING_PREREQUISITE_SCHEMA =
  'nexus.chat-capability-observed-staging-prerequisite.v1';

const CAPABILITY_FLAGS = Object.freeze([
  'AI_ROUTING_MANIFEST_CLASSIFIER',
  'AI_ROUTING_MANIFEST_ORCHESTRATOR',
  'AI_ROUTING_MANIFEST_SHADOW',
  'AI_ROUTING_MANIFEST_REGISTRY',
  'AI_ROUTING_CLARIFY',
  'AI_CLASSIFY_MANIFEST_PROMPT',
  'AI_CROSS_SKILL_EXECUTION',
]);

const MASTER_KILL = 'AI_ROUTING_MANIFEST_KILL';

export const CHAT_CAPABILITY_FLAGS = Object.freeze([...CAPABILITY_FLAGS, MASTER_KILL]);
export const CHAT_CAPABILITY_EVIDENCE_KINDS = Object.freeze([
  'routing_divergence',
  'clarify_calibration',
  'clarify_budget',
  'action_skill_accuracy',
  'cross_skill_preflight',
  'cross_skill_smoke',
]);

const ROLE_VALUES = Object.freeze(['staging', 'production']);
const TRANSITION_REASONS = Object.freeze([
  'gate_pass',
  'operator_rollback',
  'quality_regression',
  'health_regression',
  'emergency_kill',
]);
const DISABLE_REASONS = new Set([
  'operator_rollback',
  'quality_regression',
  'health_regression',
]);
const ROUTING_SURFACES = Object.freeze({
  AI_ROUTING_MANIFEST_CLASSIFIER: 'classifierKeyword',
  AI_ROUTING_MANIFEST_ORCHESTRATOR: 'orchestratorPrimary',
  AI_ROUTING_MANIFEST_SHADOW: 'shadowRoute',
  AI_ROUTING_MANIFEST_REGISTRY: 'registrySubset',
});
function expectedEvidenceKind(binding) {
  if (Object.hasOwn(ROUTING_SURFACES, binding.flag)) return 'routing_divergence';
  if (binding.flag === 'AI_ROUTING_CLARIFY') {
    return binding.role === 'production' ? 'clarify_budget' : 'clarify_calibration';
  }
  if (binding.flag === 'AI_CLASSIFY_MANIFEST_PROMPT') return 'action_skill_accuracy';
  if (binding.flag === 'AI_CROSS_SKILL_EXECUTION') {
    return binding.role === 'production' ? 'cross_skill_smoke' : 'cross_skill_preflight';
  }
  fail('evidence target flag is not reviewed');
}

const PLAN_KEYS = Object.freeze([
  'schema',
  'role',
  'runtimeSha',
  'artifactDigest',
  'flag',
  'desiredValue',
  'previousPlanSequence',
  'planSequence',
  'transitionReason',
  'evidenceAttestation',
  'stagingPrerequisite',
  'generatedAt',
  'configuredBefore',
  'configuredAfter',
  'effectiveBefore',
  'effectiveAfter',
  'changedFlags',
  'planDigest',
]);

const BUILD_PLAN_INPUT_KEYS = Object.freeze([
  'role',
  'runtimeSha',
  'artifactDigest',
  'flag',
  'desiredValue',
  'configuredFlags',
  'previousPlanSequence',
  'transitionReason',
  'evidenceAttestation',
  'stagingPrerequisite',
  'generatedAt',
]);

const RECEIPT_KEYS = Object.freeze([
  'schema',
  'transactionId',
  'role',
  'runtimeSha',
  'artifactDigest',
  'planDigest',
  'previousPlanSequence',
  'planSequence',
  'flag',
  'desiredValue',
  'transitionReason',
  'evidenceAttestation',
  'stagingPrerequisite',
  'planGeneratedAt',
  'configuredBefore',
  'configuredAfter',
  'effectiveBefore',
  'effectiveAfter',
  'changedFlags',
  'startedAt',
  'completedAt',
  'status',
  'health',
  'rollback',
]);

const BUILD_RECEIPT_INPUT_KEYS = Object.freeze([
  'plan',
  'transactionId',
  'status',
  'startedAt',
  'completedAt',
  'health',
  'rollback',
]);

function fail(message) {
  throw new Error(`chat capability flag transaction: ${message}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
  return value;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label);
  const observed = Object.keys(value).sort(compareCodeUnits);
  const wanted = [...expected].sort(compareCodeUnits);
  if (observed.length !== wanted.length
      || observed.some((key, index) => key !== wanted[index])) {
    const unknown = observed.filter((key) => !wanted.includes(key));
    const missing = wanted.filter((key) => !observed.includes(key));
    fail(`${label} schema fields are invalid (unknown: ${unknown.join(',') || 'none'}; missing: ${missing.join(',') || 'none'})`);
  }
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON refuses non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isPlainObject(value)) fail('canonical JSON refuses non-plain objects');
  return `{${Object.keys(value).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertString(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
  return value;
}

function assertInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function assertRate(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite rate from 0 through 1`);
  }
  return value;
}

function assertOneOf(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function assertRuntimeSha(value, label = 'runtimeSha') {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    fail(`${label} must be a full lowercase 40-hex Git SHA`);
  }
  return value;
}

function assertArtifactDigest(value, label = 'artifactDigest') {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    fail(`${label} must be a full lowercase 64-hex SHA-256 digest`);
  }
  return value;
}

function assertSha256(value, label, { prefixed = false } = {}) {
  const pattern = prefixed ? /^sha256:[0-9a-f]{64}$/u : /^[0-9a-f]{64}$/u;
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(`${label} must be ${prefixed ? 'sha256: followed by ' : ''}64 lowercase hex characters`);
  }
  return value;
}

function assertCanonicalTimestamp(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a canonical ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function normalizeFlagState(value, label) {
  assertExactKeys(value, CHAT_CAPABILITY_FLAGS, label);
  return Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [
    flag,
    assertBoolean(value[flag], `${label}.${flag}`),
  ]));
}

function effectiveFlagState(configured) {
  const effective = Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [flag, configured[flag]]));
  if (configured[MASTER_KILL]) {
    for (const flag of CAPABILITY_FLAGS) effective[flag] = false;
  }
  return effective;
}

function equalCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertEvidenceCommon(evidence, binding, { targetEnabled }) {
  if (evidence.schema !== CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA) {
    fail('evidence schema is unsupported');
  }
  assertOneOf(evidence.kind, CHAT_CAPABILITY_EVIDENCE_KINDS, 'evidence.kind');
  if (evidence.status !== 'passed') fail('evidence status must be passed');
  if (evidence.environment !== 'staging') fail('gate evidence must come from staging');
  assertRuntimeSha(evidence.runtimeSha, 'evidence.runtimeSha');
  assertArtifactDigest(evidence.artifactDigest, 'evidence.artifactDigest');
  assertOneOf(evidence.flag, CAPABILITY_FLAGS, 'evidence.flag');
  if (evidence.collectedWithTargetEnabled !== targetEnabled) {
    fail(`evidence must be collected with the target capability flag ${targetEnabled ? 'enabled' : 'disabled'}`);
  }
  assertSha256(evidence.evidenceSha256, 'evidence.evidenceSha256');
  assertCanonicalTimestamp(evidence.generatedAt, 'evidence.generatedAt');
  if (evidence.runtimeSha !== binding.runtimeSha
      || evidence.artifactDigest !== binding.artifactDigest
      || evidence.flag !== binding.flag) {
    fail('evidence release identity or target flag does not match the plan');
  }
  if (Date.parse(evidence.generatedAt) > Date.parse(binding.generatedAt)) {
    fail('evidence cannot be generated after its plan');
  }
  const expectedKind = expectedEvidenceKind(binding);
  if (evidence.kind !== expectedKind) {
    fail(`evidence kind for ${binding.flag} must be ${expectedKind}`);
  }
}

function validateRoutingEvidence(evidence, binding) {
  assertExactKeys(evidence, [
    'schema',
    'kind',
    'status',
    'environment',
    'runtimeSha',
    'artifactDigest',
    'flag',
    'collectedWithTargetEnabled',
    'evidenceSha256',
    'generatedAt',
    'selectedSurface',
    'comparisonCount',
    'minimumComparisons',
    'agreementRate',
  ], 'routing divergence evidence');
  assertEvidenceCommon(evidence, binding, { targetEnabled: false });
  const expectedSurface = ROUTING_SURFACES[binding.flag];
  if (evidence.selectedSurface !== expectedSurface) {
    fail(`routing divergence surface must be ${expectedSurface}`);
  }
  assertInteger(evidence.comparisonCount, 'evidence.comparisonCount', { minimum: 200 });
  if (evidence.minimumComparisons !== 200) {
    fail('evidence.minimumComparisons must preserve the owner-selected minimum of 200');
  }
  assertRate(evidence.agreementRate, 'evidence.agreementRate');
  if (evidence.agreementRate < 0.99) {
    fail('routing divergence agreement rate must be at least 0.99');
  }
  return evidence;
}

function validateClarifyCalibrationEvidence(evidence, binding) {
  assertExactKeys(evidence, [
    'schema',
    'kind',
    'status',
    'environment',
    'runtimeSha',
    'artifactDigest',
    'flag',
    'collectedWithTargetEnabled',
    'evidenceSha256',
    'generatedAt',
    'calibrationSha256',
    'calibrationGeneratedAt',
    'corpusSize',
    'baselineDashboardSha256',
    'baselineGeneratedAt',
    'baselineEvaluatedTurns',
    'baselineClarifiedTurns',
    'baselineGlobalRate',
    'budgetLimit',
    'liveHealthSha256',
    'liveHealthCheckedAt',
  ], 'clarify calibration evidence');
  assertEvidenceCommon(evidence, binding, { targetEnabled: false });
  assertSha256(evidence.calibrationSha256, 'evidence.calibrationSha256');
  assertCanonicalTimestamp(
    evidence.calibrationGeneratedAt,
    'evidence.calibrationGeneratedAt',
  );
  if (evidence.corpusSize !== 300) fail('clarify calibration requires the 300-row corpus');
  assertSha256(evidence.baselineDashboardSha256, 'evidence.baselineDashboardSha256');
  assertCanonicalTimestamp(evidence.baselineGeneratedAt, 'evidence.baselineGeneratedAt');
  assertInteger(evidence.baselineEvaluatedTurns, 'evidence.baselineEvaluatedTurns');
  assertInteger(evidence.baselineClarifiedTurns, 'evidence.baselineClarifiedTurns');
  if (evidence.baselineClarifiedTurns > evidence.baselineEvaluatedTurns) {
    fail('clarify baseline clarified turns exceed evaluated turns');
  }
  if (evidence.baselineGlobalRate !== null) {
    assertRate(evidence.baselineGlobalRate, 'evidence.baselineGlobalRate');
  }
  if (evidence.budgetLimit !== 0.1) fail('clarify calibration must bind the 10% budget');
  assertSha256(evidence.liveHealthSha256, 'evidence.liveHealthSha256');
  assertCanonicalTimestamp(evidence.liveHealthCheckedAt, 'evidence.liveHealthCheckedAt');
  return evidence;
}

function validateClarifyEvidence(evidence, binding) {
  assertExactKeys(evidence, [
    'schema',
    'kind',
    'status',
    'environment',
    'runtimeSha',
    'artifactDigest',
    'flag',
    'collectedWithTargetEnabled',
    'evidenceSha256',
    'generatedAt',
    'evaluatedTurns',
    'clarifiedTurns',
    'clarifyRate',
    'budgetLimit',
    'withinBudget',
    'baselineDashboardSha256',
    'baselineGeneratedAt',
    'currentDashboardSha256',
    'candidateEvaluatedTurns',
    'candidateClarifiedTurns',
    'candidateClarifyRate',
    'outcomesReviewRequired',
    'liveHealthSha256',
    'liveHealthCheckedAt',
  ], 'clarify budget evidence');
  assertEvidenceCommon(evidence, binding, { targetEnabled: true });
  assertInteger(evidence.evaluatedTurns, 'evidence.evaluatedTurns', { minimum: 1 });
  assertInteger(evidence.clarifiedTurns, 'evidence.clarifiedTurns');
  if (evidence.clarifiedTurns > evidence.evaluatedTurns) {
    fail('evidence.clarifiedTurns cannot exceed evaluatedTurns');
  }
  assertRate(evidence.clarifyRate, 'evidence.clarifyRate');
  if (evidence.budgetLimit !== 0.1 || evidence.clarifyRate > evidence.budgetLimit
      || evidence.withinBudget !== true) {
    fail('clarify evidence must pass the fixed 10% budget');
  }
  assertSha256(evidence.baselineDashboardSha256, 'evidence.baselineDashboardSha256');
  assertCanonicalTimestamp(evidence.baselineGeneratedAt, 'evidence.baselineGeneratedAt');
  assertSha256(evidence.currentDashboardSha256, 'evidence.currentDashboardSha256');
  assertInteger(evidence.candidateEvaluatedTurns, 'evidence.candidateEvaluatedTurns', {
    minimum: 1,
  });
  assertInteger(evidence.candidateClarifiedTurns, 'evidence.candidateClarifiedTurns');
  if (evidence.candidateClarifiedTurns > evidence.candidateEvaluatedTurns) {
    fail('candidate clarify turns exceed candidate evaluated turns');
  }
  assertRate(evidence.candidateClarifyRate, 'evidence.candidateClarifyRate');
  if (evidence.candidateClarifyRate > 0.1) {
    fail('candidate clarify rate exceeds the fixed 10% budget');
  }
  if (evidence.outcomesReviewRequired !== 'owner_plan_digest_ack') {
    fail('clarify outcomes review must be bound to owner plan-digest authorization');
  }
  assertSha256(evidence.liveHealthSha256, 'evidence.liveHealthSha256');
  assertCanonicalTimestamp(evidence.liveHealthCheckedAt, 'evidence.liveHealthCheckedAt');
  return evidence;
}

function validateActionSkillEvidence(evidence, binding) {
  assertExactKeys(evidence, [
    'schema',
    'kind',
    'status',
    'environment',
    'runtimeSha',
    'artifactDigest',
    'flag',
    'collectedWithTargetEnabled',
    'evidenceSha256',
    'generatedAt',
    'labeledRows',
    'cacheRows',
    'agreementRate',
    'executionMode',
    'gatePassed',
    'corpusIdentityDigest',
    'promptSha256',
    'refreshPlanDigest',
    'hardBudgetUsd',
    'liveHealthSha256',
    'liveHealthCheckedAt',
  ], 'action-skill accuracy evidence');
  assertEvidenceCommon(evidence, binding, { targetEnabled: binding.role === 'production' });
  if (evidence.labeledRows !== 300 || evidence.cacheRows !== 300) {
    fail('action-skill evidence requires exactly 300 labeled and cache-bound rows');
  }
  assertRate(evidence.agreementRate, 'evidence.agreementRate');
  if (evidence.agreementRate < 0.95) fail('action-skill agreement rate must be at least 0.95');
  if (evidence.executionMode !== 'cache_only') {
    fail('action-skill gate evidence must be produced by the cache-only evaluator');
  }
  if (evidence.gatePassed !== true) fail('action-skill evidence gate must pass');
  assertSha256(evidence.corpusIdentityDigest, 'evidence.corpusIdentityDigest', {
    prefixed: true,
  });
  assertSha256(evidence.promptSha256, 'evidence.promptSha256');
  assertSha256(evidence.refreshPlanDigest, 'evidence.refreshPlanDigest', {
    prefixed: true,
  });
  if (typeof evidence.hardBudgetUsd !== 'number' || !Number.isFinite(evidence.hardBudgetUsd)
      || evidence.hardBudgetUsd <= 0) {
    fail('action-skill evidence requires the approved hard provider budget');
  }
  assertSha256(evidence.liveHealthSha256, 'evidence.liveHealthSha256');
  assertCanonicalTimestamp(evidence.liveHealthCheckedAt, 'evidence.liveHealthCheckedAt');
  return evidence;
}

function validateCrossSkillPreflightEvidence(evidence, binding) {
  assertExactKeys(evidence, [
    'schema',
    'kind',
    'status',
    'environment',
    'runtimeSha',
    'artifactDigest',
    'flag',
    'collectedWithTargetEnabled',
    'evidenceSha256',
    'generatedAt',
    'executorCoveragePassed',
    'legacyTailCoveragePassed',
    'outputRefsDecision',
    'liveHealthSha256',
    'liveHealthCheckedAt',
  ], 'cross-skill preflight evidence');
  assertEvidenceCommon(evidence, binding, { targetEnabled: false });
  if (evidence.executorCoveragePassed !== true || evidence.legacyTailCoveragePassed !== true) {
    fail('cross-skill preflight executor and legacy-tail coverage must pass');
  }
  if (evidence.outputRefsDecision !== 'absent') {
    fail('training_plan_create outputRefs must remain absent during rollout');
  }
  assertSha256(evidence.liveHealthSha256, 'evidence.liveHealthSha256');
  assertCanonicalTimestamp(evidence.liveHealthCheckedAt, 'evidence.liveHealthCheckedAt');
  return evidence;
}

function validateCrossSkillEvidence(evidence, binding) {
  assertExactKeys(evidence, [
    'schema',
    'kind',
    'status',
    'environment',
    'runtimeSha',
    'artifactDigest',
    'flag',
    'collectedWithTargetEnabled',
    'evidenceSha256',
    'generatedAt',
    'smokeStatus',
    'releaseIdentityVerified',
    'dedicatedStagingIdentity',
    'dedicatedIdentitySource',
    'outputRefsDecision',
    'runId',
    'operationCount',
    'liveHealthSha256',
    'liveHealthCheckedAt',
  ], 'cross-skill smoke evidence');
  assertEvidenceCommon(evidence, binding, { targetEnabled: true });
  if (evidence.smokeStatus !== 'passed') fail('cross-skill staging smoke must pass');
  if (evidence.releaseIdentityVerified !== true) fail('cross-skill evidence must verify release identity');
  if (evidence.dedicatedStagingIdentity !== true) fail('cross-skill evidence requires a dedicated staging identity');
  if (evidence.dedicatedIdentitySource !== 'chat_eval_dedicated_tenant_db_attested') {
    fail('cross-skill evidence requires a native dedicated-tenant DB attestation');
  }
  if (evidence.outputRefsDecision !== 'absent') {
    fail('training_plan_create outputRefs must remain absent during rollout');
  }
  if (typeof evidence.runId !== 'string' || !/^[A-Za-z0-9._:-]{8,160}$/u.test(evidence.runId)) {
    fail('cross-skill smoke runId is invalid');
  }
  assertInteger(evidence.operationCount, 'evidence.operationCount', { minimum: 1 });
  assertSha256(evidence.liveHealthSha256, 'evidence.liveHealthSha256');
  assertCanonicalTimestamp(evidence.liveHealthCheckedAt, 'evidence.liveHealthCheckedAt');
  return evidence;
}

function validateEvidence(evidence, binding) {
  assertPlainObject(evidence, 'evidenceAttestation');
  switch (evidence.kind) {
    case 'routing_divergence': return validateRoutingEvidence(evidence, binding);
    case 'clarify_calibration': return validateClarifyCalibrationEvidence(evidence, binding);
    case 'clarify_budget': return validateClarifyEvidence(evidence, binding);
    case 'action_skill_accuracy': return validateActionSkillEvidence(evidence, binding);
    case 'cross_skill_preflight': return validateCrossSkillPreflightEvidence(evidence, binding);
    case 'cross_skill_smoke': return validateCrossSkillEvidence(evidence, binding);
    default: fail('evidence kind is not reviewed');
  }
}

export function buildCapabilityEvidenceAttestation(input) {
  assertExactKeys(
    input,
    ['rawEvidence', 'flag', 'runtimeSha', 'artifactDigest', 'configuredFlags'],
    'raw capability evidence input',
  );
  const rawEvidence = assertString(input.rawEvidence, 'rawEvidence');
  if (!rawEvidence) fail('rawEvidence must not be empty');
  const flag = assertOneOf(input.flag, CAPABILITY_FLAGS, 'raw evidence flag');
  const runtimeSha = assertRuntimeSha(input.runtimeSha, 'raw evidence runtimeSha');
  const artifactDigest = assertArtifactDigest(
    input.artifactDigest,
    'raw evidence artifactDigest',
  );
  const configuredFlags = normalizeFlagState(
    input.configuredFlags,
    'raw evidence configuredFlags',
  );
  if (configuredFlags[flag] || configuredFlags[MASTER_KILL]) {
    fail('raw routing evidence requires the target and master kill configured off');
  }
  const selectedSurface = ROUTING_SURFACES[flag];
  if (!selectedSurface) {
    fail(`native evidence normalization is not implemented for ${flag}`);
  }
  let report;
  try {
    report = JSON.parse(rawEvidence);
  } catch {
    fail('raw routing gate evidence is not valid JSON');
  }
  assertPlainObject(report, 'raw routing gate report');
  const generatedAt = assertCanonicalTimestamp(
    report.generatedAt,
    'raw routing gate generatedAt',
  );
  const window = report.evidence?.window;
  assertPlainObject(window, 'raw routing gate evidence window');
  const sinceInclusive = assertCanonicalTimestamp(
    window.sinceInclusive,
    'raw routing gate sinceInclusive',
  );
  const throughInclusive = assertCanonicalTimestamp(
    window.throughInclusive,
    'raw routing gate throughInclusive',
  );
  const untilInclusive = assertCanonicalTimestamp(
    window.untilInclusive,
    'raw routing gate untilInclusive',
  );
  if (window.upperBoundSource !== 'until_flag'
      || throughInclusive !== untilInclusive
      || Date.parse(untilInclusive) < Date.parse(sinceInclusive)
      || Date.parse(generatedAt) < Date.parse(untilInclusive)) {
    fail('raw routing gate must use one immutable explicit evidence window');
  }
  const identity = report.evidence?.identity;
  const releaseIdentity = identity?.releaseIdentity;
  if (identity?.enforced !== true || releaseIdentity?.runtimeSha !== runtimeSha
      || releaseIdentity?.artifactDigest !== artifactDigest
      || releaseIdentity?.role !== 'staging') {
    fail('raw routing gate release identity is not exact staging evidence');
  }
  const binding = report.evidence?.capabilityFlagBinding;
  const counts = binding?.counts;
  if (binding?.enforced !== true || binding.selectedSurface !== selectedSurface
      || binding.selectedSurfaceFlag !== flag
      || counts?.unknownFlagStateBundles !== 0
      || counts?.selectedSurfaceFlagOnBundles !== 0
      || counts?.masterKillEngagedBundles !== 0) {
    fail('raw routing gate capability-flag binding is unsafe or incomplete');
  }
  const surfaceFlagPairs = [
    ['classifierKeyword', 'AI_ROUTING_MANIFEST_CLASSIFIER'],
    ['orchestratorPrimary', 'AI_ROUTING_MANIFEST_ORCHESTRATOR'],
    ['registrySubset', 'AI_ROUTING_MANIFEST_REGISTRY'],
    ['shadowRoute', 'AI_ROUTING_MANIFEST_SHADOW'],
  ];
  const expectedObserved = Object.fromEntries([
    ...surfaceFlagPairs.map(([surface, capability]) => [
      surface,
      configuredFlags[capability] ? 'on' : 'off',
    ]),
    ['masterKill', 'off'],
  ]);
  const observedStates = binding.observedStates;
  if (!Array.isArray(observedStates) || observedStates.length < 1) {
    fail('raw routing gate has no eligible observed capability state');
  }
  let observedBundles = 0;
  for (const observed of observedStates) {
    assertExactKeys(observed, ['state', 'bundles'], 'raw routing observed state');
    const state = assertString(observed.state, 'raw routing observed state value');
    const parsed = Object.fromEntries(state.split(',').map((entry) => entry.split('=')));
    if (!equalCanonical(parsed, expectedObserved)) {
      fail('raw routing gate was not collected with the exact rollout prefix');
    }
    observedBundles += assertInteger(observed.bundles, 'raw routing observed bundles', {
      minimum: 1,
    });
  }
  if (observedBundles !== counts.flagEligibleBundles) {
    fail('raw routing observed-state bundles do not match eligible comparisons');
  }
  const gate = report.gate;
  if (gate?.enabled !== true || gate.selectedSurface !== selectedSurface
      || gate.capabilityFlag !== flag || gate.minimumComparisons !== 200
      || gate.minimumAgreementRate !== 0.99 || gate.passed !== true
      || !Array.isArray(gate.failures) || gate.failures.length !== 0) {
    fail('raw routing gate did not pass the immutable owner-selected threshold');
  }
  const total = report.surfaceTotals?.[selectedSurface];
  const comparisonCount = assertInteger(
    total?.compared,
    'raw routing gate comparison count',
    { minimum: 200 },
  );
  const agreed = assertInteger(total?.agreed, 'raw routing gate agreed count');
  const agreementRate = assertRate(
    total?.agreementRate,
    'raw routing gate agreement rate',
  );
  if (agreed > comparisonCount || agreementRate < 0.99
      || Number((agreed / comparisonCount).toFixed(4)) !== agreementRate) {
    fail('raw routing gate surface agreement is inconsistent or below 0.99');
  }
  const attestation = {
    schema: CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA,
    kind: 'routing_divergence',
    status: 'passed',
    environment: 'staging',
    runtimeSha,
    artifactDigest,
    flag,
    collectedWithTargetEnabled: false,
    evidenceSha256: sha256(rawEvidence),
    generatedAt,
    selectedSurface,
    comparisonCount,
    minimumComparisons: 200,
    agreementRate,
  };
  return validateRoutingEvidence(attestation, {
    runtimeSha,
    artifactDigest,
    flag,
    generatedAt,
  });
}

function normalizeHealthCapabilityState(value, masterKill, label) {
  assertExactKeys(value, CAPABILITY_FLAGS, label);
  const normalized = Object.fromEntries(CAPABILITY_FLAGS.map((flag) => [
    flag,
    assertBoolean(value[flag], `${label}.${flag}`),
  ]));
  return { ...normalized, [MASTER_KILL]: masterKill };
}

function parseRawJson(raw, label) {
  const source = assertString(raw, label);
  if (!source) fail(`${label} must not be empty`);
  try {
    return { source, value: JSON.parse(source) };
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

function validateLiveStagingHealth({
  healthRaw,
  runtimeSha,
  artifactDigest,
  configuredFlags,
  checkedAt,
  flag,
  targetEnabled,
}) {
  const parsed = parseRawJson(healthRaw, 'live staging healthRaw');
  const health = assertPlainObject(parsed.value, 'live staging health');
  const exactRuntimeSha = assertRuntimeSha(runtimeSha, 'live staging runtimeSha');
  const exactArtifactDigest = assertArtifactDigest(
    artifactDigest,
    'live staging artifactDigest',
  );
  const exactFlag = assertOneOf(flag, CAPABILITY_FLAGS, 'live staging flag');
  const expectedConfigured = normalizeFlagState(
    configuredFlags,
    'live staging expected configured flags',
  );
  const exactCheckedAt = assertCanonicalTimestamp(checkedAt, 'live staging checkedAt');
  const healthTimestamp = assertCanonicalTimestamp(
    health.timestamp,
    'live staging health timestamp',
  );
  const databaseCheckedAt = assertCanonicalTimestamp(
    health.databaseProbe?.checkedAt,
    'live staging databaseProbe.checkedAt',
  );
  if (health.status !== 'healthy' || health.database !== 'connected'
      || health.databaseProbe?.status !== 'connected'
      || Date.parse(databaseCheckedAt) > Date.parse(healthTimestamp)
      || Date.parse(healthTimestamp) - Date.parse(databaseCheckedAt) > 30_000
      || Date.parse(healthTimestamp) > Date.parse(exactCheckedAt)
      || Date.parse(exactCheckedAt) - Date.parse(healthTimestamp) > 30_000) {
    fail('live staging health is degraded, stale, or database-disconnected');
  }
  const attestation = health.releaseAttestation;
  const masterKill = attestation?.capabilityFlags?.masterKill;
  if (attestation?.schema !== 'nexus.chat-capability-release-attestation.v1'
      || attestation.role !== 'staging' || attestation.runtimeSha !== exactRuntimeSha
      || attestation.artifactDigest !== exactArtifactDigest
      || !Number.isSafeInteger(attestation.processId) || attestation.processId < 1
      || masterKill !== false) {
    fail('live staging health does not attest the exact release with master kill off');
  }
  const configured = normalizeHealthCapabilityState(
    attestation.capabilityFlags.configured,
    masterKill,
    'live staging configured flags',
  );
  const effective = normalizeHealthCapabilityState(
    attestation.capabilityFlags.effective,
    masterKill,
    'live staging effective flags',
  );
  if (!equalCanonical(configured, expectedConfigured)
      || !equalCanonical(effective, expectedConfigured)
      || configured[exactFlag] !== targetEnabled || effective[exactFlag] !== targetEnabled) {
    fail('live staging health capability state does not match the exact evidence prefix');
  }
  if (configured.AI_CLASSIFY_MANIFEST_PROMPT
      && attestation.classifierPromptRuntimeForceDisabled !== false) {
    fail('live staging health reports the manifest prompt runtime guard as disabled');
  }
  return {
    health,
    healthSha256: sha256(parsed.source),
    healthTimestamp,
    checkedAt: exactCheckedAt,
    configured,
    effective,
  };
}

function parseClarifyDashboard(raw, label) {
  const parsed = parseRawJson(raw, label);
  const wrapper = assertPlainObject(parsed.value, label);
  const dashboard = assertPlainObject(wrapper.dashboard, `${label}.dashboard`);
  if (wrapper.ok !== true || dashboard.version !== 'chat-quality-dashboard@1.2.0') {
    fail(`${label} schema is unsupported`);
  }
  const generatedAt = assertCanonicalTimestamp(
    dashboard.generatedAt,
    `${label}.dashboard.generatedAt`,
  );
  const budget = dashboard.routingClarifyBudget;
  assertExactKeys(budget, [
    'windowDays',
    'evaluatedTurns',
    'clarifiedTurns',
    'rate',
    'budgetLimit',
    'withinBudget',
  ], `${label}.dashboard.routingClarifyBudget`);
  const windowDays = assertInteger(budget.windowDays, `${label}.windowDays`, { minimum: 1 });
  const evaluatedTurns = assertInteger(budget.evaluatedTurns, `${label}.evaluatedTurns`);
  const clarifiedTurns = assertInteger(budget.clarifiedTurns, `${label}.clarifiedTurns`);
  if (clarifiedTurns > evaluatedTurns) fail(`${label} clarified turns exceed evaluated turns`);
  const expectedRate = evaluatedTurns > 0 ? round4(clarifiedTurns / evaluatedTurns) : null;
  if (budget.rate !== expectedRate || budget.budgetLimit !== 0.1
      || budget.withinBudget !== (expectedRate === null ? null : expectedRate <= 0.1)) {
    fail(`${label} clarify budget counters are inconsistent`);
  }
  return {
    raw: parsed.source,
    sha256: sha256(parsed.source),
    generatedAt,
    windowDays,
    evaluatedTurns,
    clarifiedTurns,
    rate: expectedRate,
    withinBudget: budget.withinBudget,
  };
}

const STAGING_PREREQUISITE_KEYS = Object.freeze([
  'schema',
  'flag',
  'runtimeSha',
  'artifactDigest',
  'enableTransactionId',
  'enableReceiptSha256',
  'enableCompletedAt',
  'normalSmokeSha256',
  'normalSmokeProfile',
  'normalSmokeStartedAt',
  'normalSmokeCompletedAt',
  'normalSmokeCheckCount',
  'qualityDashboardSha256',
  'qualityDashboardGeneratedAt',
  'qualityMonitorSha256',
  'qualityMonitorStartedAt',
  'qualityMonitorCompletedAt',
  'qualityMonitorVerdict',
  'durableAlertWindowStartedAt',
  'durableAlertActivityRowCount',
  'scheduledMonitorLastRunAt',
  'scheduledMonitorLastResult',
  'observationMinimumMs',
  'observationElapsedMs',
  'backendUptimeSeconds',
  'liveHealthSha256',
  'liveHealthTimestamp',
  'liveHealthCheckedAt',
  'stagingConfigured',
  'stagingEffective',
  'masterKill',
]);

function validateStagingCapabilityPrerequisite(value, binding) {
  assertExactKeys(value, STAGING_PREREQUISITE_KEYS, 'staging prerequisite');
  if (value.schema !== CHAT_CAPABILITY_STAGING_PREREQUISITE_SCHEMA) {
    fail('staging prerequisite schema is unsupported');
  }
  const flag = assertOneOf(value.flag, CAPABILITY_FLAGS, 'staging prerequisite.flag');
  const runtimeSha = assertRuntimeSha(
    value.runtimeSha,
    'staging prerequisite.runtimeSha',
  );
  const artifactDigest = assertArtifactDigest(
    value.artifactDigest,
    'staging prerequisite.artifactDigest',
  );
  if (typeof value.enableTransactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-z]{12,64}$/u.test(value.enableTransactionId)) {
    fail('staging prerequisite enableTransactionId has an invalid shape');
  }
  assertSha256(value.enableReceiptSha256, 'staging prerequisite.enableReceiptSha256');
  assertSha256(value.normalSmokeSha256, 'staging prerequisite.normalSmokeSha256');
  assertSha256(value.qualityDashboardSha256, 'staging prerequisite.qualityDashboardSha256');
  assertSha256(value.qualityMonitorSha256, 'staging prerequisite.qualityMonitorSha256');
  assertSha256(value.liveHealthSha256, 'staging prerequisite.liveHealthSha256');
  const enableCompletedAt = assertCanonicalTimestamp(
    value.enableCompletedAt,
    'staging prerequisite.enableCompletedAt',
  );
  const liveHealthTimestamp = assertCanonicalTimestamp(
    value.liveHealthTimestamp,
    'staging prerequisite.liveHealthTimestamp',
  );
  const liveHealthCheckedAt = assertCanonicalTimestamp(
    value.liveHealthCheckedAt,
    'staging prerequisite.liveHealthCheckedAt',
  );
  const normalSmokeStartedAt = assertCanonicalTimestamp(
    value.normalSmokeStartedAt,
    'staging prerequisite.normalSmokeStartedAt',
  );
  const normalSmokeCompletedAt = assertCanonicalTimestamp(
    value.normalSmokeCompletedAt,
    'staging prerequisite.normalSmokeCompletedAt',
  );
  const normalSmokeProfile = assertString(
    value.normalSmokeProfile,
    'staging prerequisite.normalSmokeProfile',
  );
  const qualityDashboardGeneratedAt = assertCanonicalTimestamp(
    value.qualityDashboardGeneratedAt,
    'staging prerequisite.qualityDashboardGeneratedAt',
  );
  const qualityMonitorStartedAt = assertCanonicalTimestamp(
    value.qualityMonitorStartedAt,
    'staging prerequisite.qualityMonitorStartedAt',
  );
  const qualityMonitorCompletedAt = assertCanonicalTimestamp(
    value.qualityMonitorCompletedAt,
    'staging prerequisite.qualityMonitorCompletedAt',
  );
  const durableAlertWindowStartedAt = assertCanonicalTimestamp(
    value.durableAlertWindowStartedAt,
    'staging prerequisite.durableAlertWindowStartedAt',
  );
  const durableAlertActivityRowCount = assertInteger(
    value.durableAlertActivityRowCount,
    'staging prerequisite.durableAlertActivityRowCount',
  );
  const scheduledMonitorLastRunAt = assertCanonicalTimestamp(
    value.scheduledMonitorLastRunAt,
    'staging prerequisite.scheduledMonitorLastRunAt',
  );
  const observationMinimumMs = assertInteger(
    value.observationMinimumMs,
    'staging prerequisite.observationMinimumMs',
  );
  const observationElapsedMs = assertInteger(
    value.observationElapsedMs,
    'staging prerequisite.observationElapsedMs',
  );
  const backendUptimeSeconds = assertInteger(
    value.backendUptimeSeconds,
    'staging prerequisite.backendUptimeSeconds',
  );
  const normalSmokeCheckCount = assertInteger(
    value.normalSmokeCheckCount,
    'staging prerequisite.normalSmokeCheckCount',
    { minimum: 1 },
  );
  const enableMs = Date.parse(enableCompletedAt);
  const minimumObservationEnd = enableMs + 300_000;
  if (value.qualityMonitorVerdict !== 'passed'
      || normalSmokeProfile !== CHAT_CAPABILITY_STAGING_SMOKE_PROFILE
      || durableAlertWindowStartedAt !== enableCompletedAt
      || durableAlertActivityRowCount !== 0
      || observationMinimumMs !== 300_000
      || observationElapsedMs !== Date.parse(liveHealthCheckedAt) - enableMs
      || observationElapsedMs < observationMinimumMs
      || backendUptimeSeconds < 300
      || Date.parse(normalSmokeStartedAt) < minimumObservationEnd
      || Date.parse(normalSmokeStartedAt) > Date.parse(normalSmokeCompletedAt)
      || Date.parse(normalSmokeCompletedAt) > Date.parse(qualityDashboardGeneratedAt)
      || Date.parse(qualityMonitorStartedAt) < minimumObservationEnd
      || Date.parse(qualityMonitorStartedAt) > Date.parse(qualityMonitorCompletedAt)
      || Date.parse(qualityMonitorCompletedAt) > Date.parse(liveHealthTimestamp)
      || value.scheduledMonitorLastResult !== 'success'
      || Date.parse(scheduledMonitorLastRunAt) < minimumObservationEnd
      || Date.parse(scheduledMonitorLastRunAt) > Date.parse(liveHealthTimestamp)
      || Date.parse(qualityDashboardGeneratedAt) < minimumObservationEnd
      || Date.parse(qualityDashboardGeneratedAt) > Date.parse(liveHealthCheckedAt)
      || Date.parse(liveHealthCheckedAt) - Date.parse(qualityDashboardGeneratedAt) > 30_000
      || Date.parse(enableCompletedAt) > Date.parse(liveHealthTimestamp)
      || Date.parse(liveHealthTimestamp) > Date.parse(liveHealthCheckedAt)
      || Date.parse(liveHealthCheckedAt) - Date.parse(liveHealthTimestamp) > 30_000) {
    fail('staging prerequisite smoke, quality monitor, observation, or live health is stale or incomplete');
  }
  const masterKill = assertBoolean(value.masterKill, 'staging prerequisite.masterKill');
  if (masterKill) fail('staging prerequisite requires the master kill off');
  const stagingConfigured = normalizeFlagState(
    value.stagingConfigured,
    'staging prerequisite.stagingConfigured',
  );
  const stagingEffective = normalizeFlagState(
    value.stagingEffective,
    'staging prerequisite.stagingEffective',
  );
  if (!stagingConfigured[flag] || !stagingEffective[flag]
      || !equalCanonical(stagingConfigured, stagingEffective)) {
    fail('staging prerequisite target is not configured and effective in one exact state');
  }
  if (binding) {
    if (binding.role !== 'production' || binding.desiredValue !== true
        || binding.flag === MASTER_KILL || flag !== binding.flag
        || runtimeSha !== binding.runtimeSha || artifactDigest !== binding.artifactDigest
        || !equalCanonical(stagingConfigured, binding.configuredAfter)
        || !equalCanonical(stagingEffective, binding.effectiveAfter)
        || Date.parse(liveHealthCheckedAt) > Date.parse(binding.generatedAt)
        || Date.parse(binding.generatedAt) - Date.parse(liveHealthCheckedAt) > 60_000) {
      fail('staging prerequisite does not match the exact production enable plan');
    }
  }
  return {
    ...value,
    stagingConfigured,
    stagingEffective,
  };
}

export function buildStagingCapabilityPrerequisite(input) {
  assertExactKeys(input, [
    'receiptRaw',
    'healthRaw',
    'dashboardRaw',
    'smokeRaw',
    'monitorRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'checkedAt',
  ], 'staging prerequisite input');
  const receiptRaw = assertString(input.receiptRaw, 'staging receiptRaw');
  const healthRaw = assertString(input.healthRaw, 'staging healthRaw');
  const dashboardRaw = assertString(input.dashboardRaw, 'staging dashboardRaw');
  const smokeRaw = assertString(input.smokeRaw, 'staging smokeRaw');
  const monitorRaw = assertString(input.monitorRaw, 'staging monitorRaw');
  const flag = assertOneOf(input.flag, CAPABILITY_FLAGS, 'staging prerequisite flag');
  const runtimeSha = assertRuntimeSha(input.runtimeSha, 'staging prerequisite runtimeSha');
  const artifactDigest = assertArtifactDigest(
    input.artifactDigest,
    'staging prerequisite artifactDigest',
  );
  const checkedAt = assertCanonicalTimestamp(
    input.checkedAt,
    'staging prerequisite checkedAt',
  );
  let receipt;
  let health;
  let dashboardWrapper;
  let smoke;
  let monitor;
  try {
    receipt = JSON.parse(receiptRaw);
    health = JSON.parse(healthRaw);
    dashboardWrapper = JSON.parse(dashboardRaw);
    smoke = JSON.parse(smokeRaw);
    monitor = JSON.parse(monitorRaw);
  } catch {
    fail('staging prerequisite receipt, health, dashboard, smoke, and monitor must be valid JSON');
  }
  const validatedReceipt = validateCapabilityFlagReceipt(receipt);
  if (validatedReceipt.status !== 'passed' || validatedReceipt.role !== 'staging'
      || validatedReceipt.runtimeSha !== runtimeSha
      || validatedReceipt.artifactDigest !== artifactDigest
      || validatedReceipt.flag !== flag || validatedReceipt.desiredValue !== true
      || validatedReceipt.configuredAfter[flag] !== true
      || validatedReceipt.effectiveAfter[flag] !== true
      || Date.parse(validatedReceipt.completedAt) > Date.parse(checkedAt)) {
    fail('staging enable receipt does not prove this exact capability release');
  }
  const attestation = health?.releaseAttestation;
  const healthTimestamp = assertCanonicalTimestamp(
    health?.timestamp,
    'staging health timestamp',
  );
  const databaseCheckedAt = assertCanonicalTimestamp(
    health?.databaseProbe?.checkedAt,
    'staging health databaseProbe.checkedAt',
  );
  if (!Number.isSafeInteger(health?.uptime) || health.uptime < 300) {
    fail('live staging backend has not served the enabled capability continuously for five minutes');
  }
  if (health?.status !== 'healthy' || health?.database !== 'connected'
      || health?.databaseProbe?.status !== 'connected'
      || Date.parse(databaseCheckedAt) > Date.parse(healthTimestamp)
      || Date.parse(healthTimestamp) - Date.parse(databaseCheckedAt) > 30_000
      || Date.parse(healthTimestamp) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(healthTimestamp) > 30_000) {
    fail('live staging health is degraded, stale, or database-disconnected');
  }
  const masterKill = attestation?.capabilityFlags?.masterKill;
  if (attestation?.schema !== 'nexus.chat-capability-release-attestation.v1'
      || attestation.role !== 'staging' || attestation.runtimeSha !== runtimeSha
      || attestation.artifactDigest !== artifactDigest
      || !Number.isSafeInteger(attestation.processId) || attestation.processId < 1
      || typeof masterKill !== 'boolean' || masterKill) {
    fail('live staging health does not attest the exact release with master kill off');
  }
  const stagingConfigured = normalizeHealthCapabilityState(
    attestation.capabilityFlags.configured,
    masterKill,
    'staging health configured flags',
  );
  const stagingEffective = normalizeHealthCapabilityState(
    attestation.capabilityFlags.effective,
    masterKill,
    'staging health effective flags',
  );
  if (stagingConfigured[flag] !== true || stagingEffective[flag] !== true) {
    fail('live staging health does not show the target capability configured and effective');
  }
  if (!equalCanonical(stagingConfigured, validatedReceipt.configuredAfter)
      || !equalCanonical(stagingEffective, validatedReceipt.effectiveAfter)) {
    fail('live staging capability state drifted from the enable receipt');
  }
  if (flag === 'AI_CLASSIFY_MANIFEST_PROMPT'
      && attestation.classifierPromptRuntimeForceDisabled !== false) {
    fail('live staging health reports the manifest prompt runtime guard as disabled');
  }
  const dashboard = assertPlainObject(
    dashboardWrapper?.dashboard,
    'staging prerequisite chat-quality dashboard',
  );
  if (dashboardWrapper?.ok !== true
      || dashboard.version !== 'chat-quality-dashboard@1.2.0') {
    fail('staging prerequisite chat-quality dashboard schema is unsupported');
  }
  const qualityDashboardGeneratedAt = assertCanonicalTimestamp(
    dashboard.generatedAt,
    'staging prerequisite chat-quality dashboard.generatedAt',
  );
  if (Date.parse(qualityDashboardGeneratedAt) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(qualityDashboardGeneratedAt) > 30_000) {
    fail('staging prerequisite chat-quality dashboard is stale or future-dated');
  }

  const smokeObject = assertPlainObject(smoke, 'staging prerequisite normal smoke');
  assertExactKeys(smokeObject, [
    'version',
    'profile',
    'runStartedAt',
    'runCompletedAt',
    'branch',
    'sha',
    'runtimeSha',
    'artifactDigest',
    'host',
    'verdict',
    'totals',
    'checks',
  ], 'staging prerequisite normal smoke');
  const normalSmokeStartedAt = assertCanonicalTimestamp(
    smokeObject.runStartedAt,
    'staging prerequisite normal smoke.runStartedAt',
  );
  const normalSmokeCompletedAt = assertCanonicalTimestamp(
    smokeObject.runCompletedAt,
    'staging prerequisite normal smoke.runCompletedAt',
  );
  const totals = assertPlainObject(smokeObject.totals, 'staging prerequisite normal smoke.totals');
  assertExactKeys(totals, ['passed', 'failed', 'total'], 'staging prerequisite normal smoke.totals');
  const passed = assertInteger(totals.passed, 'staging prerequisite normal smoke.totals.passed');
  const failed = assertInteger(totals.failed, 'staging prerequisite normal smoke.totals.failed');
  const total = assertInteger(totals.total, 'staging prerequisite normal smoke.totals.total', {
    minimum: 1,
  });
  const requiredNormalSmokeChecks = [
    'content-engine /health',
    'nexus-hub /api/snapshot',
    'snapshot.uptime',
    'snapshot.bot',
    'snapshot.integrations',
    'snapshot.apiUsage',
    'cost-by-domain.totalCost',
    'cost-by-domain.detailed',
    'cost-by-domain.providerSplit',
    'cost-by-domain.dailySeries',
    'provider-stats.providers',
    'iOS /api/v1/dashboard',
    'iOS /api/v1/tasks/lists',
    'iOS /api/v1/training/today',
    'iOS /api/v1/plan/today',
    'iOS chat-message route boundary',
    'pm2 nexus-hub online',
    'pm2 content-engine online',
    'pm2 nexus-hub restarts == 0',
    'training plan preview e2e',
    'locale fidelity chat smoke',
    'Staging DB integrity',
    'Ollama release policy',
    'immutable staging selector',
  ];
  if (!Array.isArray(smokeObject.checks) || smokeObject.checks.length !== total) {
    fail('staging prerequisite normal smoke check count is inconsistent');
  }
  for (const [index, check] of smokeObject.checks.entries()) {
    const item = assertPlainObject(check, `staging prerequisite normal smoke.checks[${index}]`);
    assertExactKeys(item, ['name', 'status', 'detail'], `staging prerequisite normal smoke.checks[${index}]`);
    if (typeof item.name !== 'string' || item.name.trim().length === 0
        || item.status !== 'passed'
        || (item.detail !== null && typeof item.detail !== 'string')) {
      fail('staging prerequisite normal smoke contains an invalid or failed check');
    }
  }
  const checkNames = smokeObject.checks.map((check) => check.name);
  if (requiredNormalSmokeChecks.some((name) => checkNames.filter((item) => item === name).length !== 1)) {
    fail('staging prerequisite normal smoke is missing or duplicates a canonical required check');
  }
  const trainingCheck = smokeObject.checks.find((check) => check.name === 'training plan preview e2e');
  let trainingDetail;
  try {
    trainingDetail = JSON.parse(trainingCheck.detail);
  } catch {
    fail('staging prerequisite training smoke detail must be one strict JSON document');
  }
  assertExactKeys(trainingDetail, [
    'ok',
    'httpStatus',
    'responseOk',
    'planStatus',
    'userId',
    'blockerIds',
    'warningCodes',
    'totalSessions',
    'calendarFetchDegraded',
  ], 'staging prerequisite training smoke detail');
  const trainingUserId = assertInteger(
    trainingDetail.userId,
    'staging prerequisite training smoke userId',
  );
  const totalTrainingSessions = assertInteger(
    trainingDetail.totalSessions,
    'staging prerequisite training smoke totalSessions',
    { minimum: 1 },
  );
  if (trainingDetail.ok !== true || trainingDetail.httpStatus !== 200
      || trainingDetail.responseOk !== true || trainingDetail.planStatus !== 'preview'
      || trainingUserId !== 1_000_014 || totalTrainingSessions < 1
      || !Array.isArray(trainingDetail.blockerIds) || trainingDetail.blockerIds.length !== 0
      || !Array.isArray(trainingDetail.warningCodes)
      || trainingDetail.warningCodes.some((value) => typeof value !== 'string')
      || typeof trainingDetail.calendarFetchDegraded !== 'boolean') {
    fail('staging prerequisite training smoke violated the exact dedicated preview contract');
  }
  const localeCheck = smokeObject.checks.find((check) => check.name === 'locale fidelity chat smoke');
  let localeDetail;
  try {
    localeDetail = JSON.parse(localeCheck.detail);
  } catch {
    fail('staging prerequisite locale smoke detail must be one strict JSON document');
  }
  assertExactKeys(localeDetail, [
    'ok',
    'userId',
    'providerUsageBefore',
    'providerUsageAfter',
    'providerUsageDelta',
    'turns',
  ], 'staging prerequisite locale smoke detail');
  const localeUserId = assertInteger(
    localeDetail.userId,
    'staging prerequisite locale smoke userId',
  );
  const providerUsageBefore = assertInteger(
    localeDetail.providerUsageBefore,
    'staging prerequisite locale smoke providerUsageBefore',
  );
  const providerUsageAfter = assertInteger(
    localeDetail.providerUsageAfter,
    'staging prerequisite locale smoke providerUsageAfter',
  );
  const providerUsageDelta = assertInteger(
    localeDetail.providerUsageDelta,
    'staging prerequisite locale smoke providerUsageDelta',
  );
  const expectedLocaleTurns = [
    { requestedLocale: 'es-419', expectedLocale: 'en-US', expected: 'en', detected: 'en' },
    { requestedLocale: 'en-US', expectedLocale: 'en-US', expected: 'en', detected: 'en' },
    { requestedLocale: 'pt-BR', expectedLocale: 'pt-BR', expected: 'pt', detected: 'pt' },
  ];
  if (localeDetail.ok !== true || localeUserId !== 1_000_016
      || providerUsageAfter !== providerUsageBefore || providerUsageDelta !== 0
      || !Array.isArray(localeDetail.turns)
      || localeDetail.turns.length !== expectedLocaleTurns.length) {
    fail('staging prerequisite locale smoke did not prove the exact token-zero fixture contract');
  }
  for (const [index, expectedTurn] of expectedLocaleTurns.entries()) {
    const turn = assertPlainObject(
      localeDetail.turns[index],
      `staging prerequisite locale smoke turns[${index}]`,
    );
    assertExactKeys(turn, [
      'requestedLocale',
      'expectedLocale',
      'storedLanguage',
      'httpStatus',
      'ok',
      'routeMethod',
      'responseType',
      'authenticatedUserId',
      'hasDisplayName',
      'expected',
      'detected',
      'confidence',
      'replyPreview',
    ], `staging prerequisite locale smoke turns[${index}]`);
    assertRate(turn.confidence, `staging prerequisite locale smoke turns[${index}].confidence`);
    if (turn.requestedLocale !== expectedTurn.requestedLocale
        || turn.expectedLocale !== expectedTurn.expectedLocale
        || turn.storedLanguage !== 'es-ES'
        || turn.httpStatus !== 200 || turn.ok !== true
        || turn.routeMethod !== 'authenticated-identity'
        || turn.responseType !== 'authenticated_identity'
        || turn.authenticatedUserId !== localeUserId
        || turn.hasDisplayName !== true
        || turn.expected !== expectedTurn.expected
        || turn.detected !== expectedTurn.detected
        || typeof turn.replyPreview !== 'string' || turn.replyPreview.trim().length === 0) {
      fail('staging prerequisite locale smoke turn violated the exact identity and language contract');
    }
  }
  if (smokeObject.version !== '2'
      || smokeObject.profile !== CHAT_CAPABILITY_STAGING_SMOKE_PROFILE
      || smokeObject.host !== 'staging'
      || smokeObject.verdict !== 'passed' || smokeObject.sha !== runtimeSha
      || smokeObject.runtimeSha !== runtimeSha || smokeObject.artifactDigest !== artifactDigest
      || passed !== total || failed !== 0
      || Date.parse(normalSmokeStartedAt) < Date.parse(validatedReceipt.completedAt) + 300_000
      || Date.parse(normalSmokeStartedAt) > Date.parse(normalSmokeCompletedAt)
      || Date.parse(normalSmokeCompletedAt) > Date.parse(qualityDashboardGeneratedAt)) {
    fail('staging prerequisite normal smoke did not pass after the five-minute observation');
  }

  const monitorObject = assertPlainObject(monitor, 'staging prerequisite quality monitor');
  assertExactKeys(monitorObject, [
    'schema',
    'runtimeSha',
    'artifactDigest',
    'startedAt',
    'completedAt',
    'readinessAvailable',
    'readinessArtifactHealthy',
    'readinessUnavailableReason',
    'readinessHealthAlertCount',
    'readinessRegressionAlertCount',
    'behaviorRegressionAlertCount',
    'fallbackRegressionAlertCount',
    'recordedAlertCount',
    'monitoredAlertSources',
    'alertWindowStartedAt',
    'durableAlertActivityRowCount',
    'verdict',
  ], 'staging prerequisite quality monitor');
  const qualityMonitorStartedAt = assertCanonicalTimestamp(
    monitorObject.startedAt,
    'staging prerequisite quality monitor.startedAt',
  );
  const qualityMonitorCompletedAt = assertCanonicalTimestamp(
    monitorObject.completedAt,
    'staging prerequisite quality monitor.completedAt',
  );
  const alertWindowStartedAt = assertCanonicalTimestamp(
    monitorObject.alertWindowStartedAt,
    'staging prerequisite quality monitor.alertWindowStartedAt',
  );
  const durableAlertActivityRowCount = assertInteger(
    monitorObject.durableAlertActivityRowCount,
    'staging prerequisite quality monitor.durableAlertActivityRowCount',
  );
  const requiredAlertSources = [
    'chat_quality_regression_monitor',
    'chat_v2_retirement_monitor',
  ];
  const alertCountKeys = [
    'readinessHealthAlertCount',
    'readinessRegressionAlertCount',
    'behaviorRegressionAlertCount',
    'fallbackRegressionAlertCount',
    'recordedAlertCount',
  ];
  const alertCounts = alertCountKeys.map((key) => assertInteger(
    monitorObject[key],
    `staging prerequisite quality monitor.${key}`,
  ));
  if (monitorObject.schema !== 'nexus.chat-capability-quality-monitor.v1'
      || monitorObject.runtimeSha !== runtimeSha || monitorObject.artifactDigest !== artifactDigest
      || monitorObject.readinessAvailable !== true
      || monitorObject.readinessArtifactHealthy !== true
      || monitorObject.readinessUnavailableReason !== null
      || alertCounts.some((count) => count !== 0)
      || !Array.isArray(monitorObject.monitoredAlertSources)
      || !equalCanonical(monitorObject.monitoredAlertSources, requiredAlertSources)
      || alertWindowStartedAt !== validatedReceipt.completedAt
      || durableAlertActivityRowCount !== 0
      || monitorObject.verdict !== 'passed'
      || Date.parse(qualityMonitorStartedAt) < Date.parse(validatedReceipt.completedAt) + 300_000
      || Date.parse(qualityMonitorStartedAt) > Date.parse(qualityMonitorCompletedAt)
      || Date.parse(qualityMonitorCompletedAt) > Date.parse(healthTimestamp)) {
    fail('staging prerequisite five-minute quality monitor reported a regression or invalid identity');
  }
  const scheduledMonitorRows = Array.isArray(health?.jobs)
    ? health.jobs.filter((row) => row?.name === 'chat_quality_regression_monitor')
    : [];
  if (scheduledMonitorRows.length !== 1) {
    fail('staging prerequisite requires exactly one scheduled chat-quality monitor status');
  }
  const scheduledMonitor = scheduledMonitorRows[0];
  const scheduledMonitorLastRunAt = assertCanonicalTimestamp(
    scheduledMonitor.lastRunAt,
    'staging prerequisite scheduled quality monitor.lastRunAt',
  );
  if (scheduledMonitor.lastResult !== 'success' || scheduledMonitor.lastError !== null
      || Date.parse(scheduledMonitorLastRunAt) < Date.parse(validatedReceipt.completedAt) + 300_000
      || Date.parse(scheduledMonitorLastRunAt) > Date.parse(healthTimestamp)) {
    fail('staging prerequisite scheduled five-minute quality monitor did not complete cleanly after enable');
  }
  const observationElapsedMs = Date.parse(checkedAt) - Date.parse(validatedReceipt.completedAt);
  return validateStagingCapabilityPrerequisite({
    schema: CHAT_CAPABILITY_STAGING_PREREQUISITE_SCHEMA,
    flag,
    runtimeSha,
    artifactDigest,
    enableTransactionId: validatedReceipt.transactionId,
    enableReceiptSha256: sha256(receiptRaw),
    enableCompletedAt: validatedReceipt.completedAt,
    normalSmokeSha256: sha256(smokeRaw),
    normalSmokeProfile: smokeObject.profile,
    normalSmokeStartedAt,
    normalSmokeCompletedAt,
    normalSmokeCheckCount: total,
    qualityDashboardSha256: sha256(dashboardRaw),
    qualityDashboardGeneratedAt,
    qualityMonitorSha256: sha256(monitorRaw),
    qualityMonitorStartedAt,
    qualityMonitorCompletedAt,
    qualityMonitorVerdict: 'passed',
    durableAlertWindowStartedAt: alertWindowStartedAt,
    durableAlertActivityRowCount,
    scheduledMonitorLastRunAt,
    scheduledMonitorLastResult: 'success',
    observationMinimumMs: 300_000,
    observationElapsedMs,
    backendUptimeSeconds: health.uptime,
    liveHealthSha256: sha256(healthRaw),
    liveHealthTimestamp: healthTimestamp,
    liveHealthCheckedAt: checkedAt,
    stagingConfigured,
    stagingEffective,
    masterKill,
  });
}

const OBSERVATION_SHADOW_PLANNER_KEYS = Object.freeze([
  'global',
  'user1000014',
  'tenant1000014',
  'user1000016',
  'tenant1000016',
]);

const OBSERVATION_PLAN_KEYS = Object.freeze([
  'schema',
  'role',
  'runtimeSha',
  'artifactDigest',
  'flag',
  'previousObservationSequence',
  'observationSequence',
  'enableTransactionId',
  'enableReceiptSha256',
  'enablePlanSequence',
  'enableCompletedAt',
  'smokeNotBefore',
  'smokeScriptSha256',
  'smokeProfile',
  'configured',
  'effective',
  'masterKill',
  'shadowPlannerEffective',
  'expectedProductionPlanSequence',
  'generatedAt',
  'expiresAt',
  'planDigest',
]);

const BUILD_OBSERVATION_PLAN_INPUT_KEYS = Object.freeze([
  'role',
  'runtimeSha',
  'artifactDigest',
  'flag',
  'previousObservationSequence',
  'receiptRaw',
  'liveConfigured',
  'liveEffective',
  'liveMasterKill',
  'shadowPlannerEffective',
  'smokeScriptSha256',
  'expectedProductionPlanSequence',
  'generatedAt',
]);

const OBSERVATION_RECEIPT_KEYS = Object.freeze([
  'schema',
  'status',
  'role',
  'runtimeSha',
  'artifactDigest',
  'flag',
  'transactionId',
  'observationSequence',
  'planDigest',
  'plan',
  'enableTransactionId',
  'enableReceiptSha256',
  'enablePlanSequence',
  'enableCompletedAt',
  'smokeProfile',
  'smokeScriptSha256',
  'smokeSha256',
  'smokeStartedAt',
  'smokeCompletedAt',
  'smokeCheckCount',
  'observationStartedAt',
  'observationCompletedAt',
  'configuredBefore',
  'effectiveBefore',
  'masterKillBefore',
  'configuredAfter',
  'effectiveAfter',
  'masterKillAfter',
  'stagingPrerequisite',
  'flagSpecificEvidence',
  'providerLedger',
  'expectedProductionPlanSequence',
  'expiresAt',
]);

const BUILD_OBSERVATION_RECEIPT_INPUT_KEYS = Object.freeze([
  'plan',
  'transactionId',
  'stagingPrerequisite',
  'smokeRaw',
  'observationStartedAt',
  'observationCompletedAt',
  'configuredBefore',
  'effectiveBefore',
  'masterKillBefore',
  'configuredAfter',
  'effectiveAfter',
  'masterKillAfter',
  'flagSpecificEvidence',
  'providerLedger',
]);

const OBSERVATION_LEDGER_KEYS = Object.freeze([
  'scope',
  'expectedFixtureUserIds',
  'apiUsageBefore',
  'apiUsageAfter',
  'apiUsageRowDelta',
  'apiUsageCostDeltaUsd',
  'hardCeilingReservationsBefore',
  'hardCeilingReservationsAfter',
  'hardCeilingReservationRowDelta',
  'hardCeilingReservedCostDeltaUsd',
]);

function validateObservationShadowPlannerState(value, label) {
  assertExactKeys(value, OBSERVATION_SHADOW_PLANNER_KEYS, label);
  for (const key of OBSERVATION_SHADOW_PLANNER_KEYS) {
    if (assertBoolean(value[key], `${label}.${key}`)) {
      fail(`${label}.${key} must be effectively off for the token-zero fixtures`);
    }
  }
  return { ...value };
}

function assertContiguousCapabilityPrefix(state, flag, label) {
  let disabledSeen = false;
  for (const capability of CAPABILITY_FLAGS) {
    if (state[capability]) {
      if (disabledSeen) fail(`${label} must be one contiguous rollout prefix`);
    } else {
      disabledSeen = true;
    }
  }
  if (!state[flag] || state[MASTER_KILL]) {
    fail(`${label} must have the observed target on and master kill off`);
  }
}

function observationPlanWithoutDigest(plan) {
  return Object.fromEntries(OBSERVATION_PLAN_KEYS
    .filter((key) => key !== 'planDigest')
    .map((key) => [key, plan[key]]));
}

function computeObservationPlanDigest(plan) {
  return `sha256:${sha256(canonicalJson(observationPlanWithoutDigest(plan)))}`;
}

export function validateCapabilityObservationPlan(plan) {
  assertExactKeys(plan, OBSERVATION_PLAN_KEYS, 'observation plan');
  if (plan.schema !== CHAT_CAPABILITY_OBSERVATION_PLAN_SCHEMA || plan.role !== 'staging') {
    fail('observation plan schema or role is unsupported');
  }
  assertRuntimeSha(plan.runtimeSha, 'observation plan.runtimeSha');
  assertArtifactDigest(plan.artifactDigest, 'observation plan.artifactDigest');
  const flag = assertOneOf(plan.flag, CAPABILITY_FLAGS, 'observation plan.flag');
  const previousObservationSequence = assertInteger(
    plan.previousObservationSequence,
    'observation plan.previousObservationSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  if (plan.observationSequence !== previousObservationSequence + 1) {
    fail('observation plan sequence must advance exactly once');
  }
  if (typeof plan.enableTransactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-f]{12}$/u.test(plan.enableTransactionId)) {
    fail('observation plan enable transaction ID is invalid');
  }
  assertSha256(plan.enableReceiptSha256, 'observation plan.enableReceiptSha256');
  assertInteger(plan.enablePlanSequence, 'observation plan.enablePlanSequence', { minimum: 1 });
  const enableCompletedAt = assertCanonicalTimestamp(
    plan.enableCompletedAt,
    'observation plan.enableCompletedAt',
  );
  const smokeNotBefore = assertCanonicalTimestamp(
    plan.smokeNotBefore,
    'observation plan.smokeNotBefore',
  );
  if (Date.parse(smokeNotBefore) !== Date.parse(enableCompletedAt) + 300_000) {
    fail('observation plan smokeNotBefore must be exactly five minutes after enable');
  }
  assertSha256(plan.smokeScriptSha256, 'observation plan.smokeScriptSha256');
  if (plan.smokeProfile !== CHAT_CAPABILITY_STAGING_SMOKE_PROFILE) {
    fail('observation plan smoke profile is unsupported');
  }
  const configured = normalizeFlagState(plan.configured, 'observation plan.configured');
  const effective = normalizeFlagState(plan.effective, 'observation plan.effective');
  const masterKill = assertBoolean(plan.masterKill, 'observation plan.masterKill');
  if (masterKill || configured[MASTER_KILL] || effective[MASTER_KILL]
      || !equalCanonical(configured, effective)) {
    fail('observation plan requires one exact effective prefix with master kill off');
  }
  assertContiguousCapabilityPrefix(configured, flag, 'observation plan configured state');
  const shadowPlannerEffective = validateObservationShadowPlannerState(
    plan.shadowPlannerEffective,
    'observation plan.shadowPlannerEffective',
  );
  assertInteger(
    plan.expectedProductionPlanSequence,
    'observation plan.expectedProductionPlanSequence',
    { minimum: 1 },
  );
  const generatedAt = assertCanonicalTimestamp(plan.generatedAt, 'observation plan.generatedAt');
  const expiresAt = assertCanonicalTimestamp(plan.expiresAt, 'observation plan.expiresAt');
  if (Date.parse(generatedAt) < Date.parse(smokeNotBefore)
      || Date.parse(expiresAt) !== Date.parse(generatedAt) + 3_600_000) {
    fail('observation plan must be generated after maturity and expire exactly one hour later');
  }
  assertSha256(plan.planDigest, 'observation plan.planDigest', { prefixed: true });
  if (!safeEqualDigest(plan.planDigest, computeObservationPlanDigest(plan))) {
    fail('observation plan digest does not match its canonical bytes');
  }
  return {
    ...plan,
    configured,
    effective,
    shadowPlannerEffective,
  };
}

export function buildCapabilityObservationPlan(input) {
  assertExactKeys(input, BUILD_OBSERVATION_PLAN_INPUT_KEYS, 'observation plan input');
  if (input.role !== 'staging') fail('observation is staging-only');
  const runtimeSha = assertRuntimeSha(input.runtimeSha, 'observation runtimeSha');
  const artifactDigest = assertArtifactDigest(input.artifactDigest, 'observation artifactDigest');
  const flag = assertOneOf(input.flag, CAPABILITY_FLAGS, 'observation flag');
  const receiptRaw = assertString(input.receiptRaw, 'observation receiptRaw');
  let receipt;
  try { receipt = validateCapabilityFlagReceipt(JSON.parse(receiptRaw)); }
  catch { fail('observation requires one valid staging enable receipt'); }
  if (receipt.status !== 'passed' || receipt.role !== 'staging'
      || receipt.runtimeSha !== runtimeSha || receipt.artifactDigest !== artifactDigest
      || receipt.flag !== flag || receipt.desiredValue !== true) {
    fail('observation enable receipt does not match the exact target');
  }
  const liveConfigured = normalizeFlagState(input.liveConfigured, 'observation liveConfigured');
  const liveEffective = normalizeFlagState(input.liveEffective, 'observation liveEffective');
  const liveMasterKill = assertBoolean(input.liveMasterKill, 'observation liveMasterKill');
  if (liveMasterKill || !equalCanonical(liveConfigured, receipt.configuredAfter)
      || !equalCanonical(liveEffective, receipt.effectiveAfter)
      || !equalCanonical(liveConfigured, liveEffective)) {
    fail('observation live prefix does not match the exact enable receipt');
  }
  assertContiguousCapabilityPrefix(liveConfigured, flag, 'observation live configured state');
  const generatedAt = assertCanonicalTimestamp(input.generatedAt, 'observation generatedAt');
  const plan = {
    schema: CHAT_CAPABILITY_OBSERVATION_PLAN_SCHEMA,
    role: 'staging',
    runtimeSha,
    artifactDigest,
    flag,
    previousObservationSequence: assertInteger(
      input.previousObservationSequence,
      'observation previousObservationSequence',
      { maximum: Number.MAX_SAFE_INTEGER - 1 },
    ),
    observationSequence: input.previousObservationSequence + 1,
    enableTransactionId: receipt.transactionId,
    enableReceiptSha256: sha256(receiptRaw),
    enablePlanSequence: receipt.planSequence,
    enableCompletedAt: receipt.completedAt,
    smokeNotBefore: new Date(Date.parse(receipt.completedAt) + 300_000).toISOString(),
    smokeScriptSha256: assertSha256(input.smokeScriptSha256, 'observation smokeScriptSha256'),
    smokeProfile: CHAT_CAPABILITY_STAGING_SMOKE_PROFILE,
    configured: liveConfigured,
    effective: liveEffective,
    masterKill: false,
    shadowPlannerEffective: validateObservationShadowPlannerState(
      input.shadowPlannerEffective,
      'observation shadowPlannerEffective',
    ),
    expectedProductionPlanSequence: assertInteger(
      input.expectedProductionPlanSequence,
      'observation expectedProductionPlanSequence',
      { minimum: 1 },
    ),
    generatedAt,
    expiresAt: new Date(Date.parse(generatedAt) + 3_600_000).toISOString(),
  };
  return validateCapabilityObservationPlan({
    ...plan,
    planDigest: computeObservationPlanDigest(plan),
  });
}

function validateObservationLedgerSnapshot(value, label, costKey) {
  assertExactKeys(value, ['tablePresent', 'rowCount', 'maxId', costKey], label);
  const tablePresent = assertBoolean(value.tablePresent, `${label}.tablePresent`);
  const rowCount = assertInteger(value.rowCount, `${label}.rowCount`);
  const maxId = value.maxId === null
    ? null
    : assertInteger(value.maxId, `${label}.maxId`, { minimum: 1 });
  const cost = value[costKey];
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    fail(`${label}.${costKey} must be one finite non-negative number`);
  }
  if ((!tablePresent && (rowCount !== 0 || maxId !== null || cost !== 0))
      || (rowCount === 0) !== (maxId === null)) {
    fail(`${label} table, row count, max ID, and cost are inconsistent`);
  }
  return { tablePresent, rowCount, maxId, [costKey]: cost };
}

function validateObservationProviderLedger(value) {
  assertExactKeys(value, OBSERVATION_LEDGER_KEYS, 'observation providerLedger');
  if (value.scope !== 'global'
      || !Array.isArray(value.expectedFixtureUserIds)
      || !equalCanonical(value.expectedFixtureUserIds, [1_000_014, 1_000_016])) {
    fail('observation providerLedger global scope or expected fixture users are invalid');
  }
  const apiBefore = validateObservationLedgerSnapshot(
    value.apiUsageBefore,
    'observation providerLedger.apiUsageBefore',
    'totalCostUsd',
  );
  const apiAfter = validateObservationLedgerSnapshot(
    value.apiUsageAfter,
    'observation providerLedger.apiUsageAfter',
    'totalCostUsd',
  );
  const hardCeilingBefore = validateObservationLedgerSnapshot(
    value.hardCeilingReservationsBefore,
    'observation providerLedger.hardCeilingReservationsBefore',
    'totalReservedCostUsd',
  );
  const hardCeilingAfter = validateObservationLedgerSnapshot(
    value.hardCeilingReservationsAfter,
    'observation providerLedger.hardCeilingReservationsAfter',
    'totalReservedCostUsd',
  );
  if (!apiBefore.tablePresent || !apiAfter.tablePresent
      || !hardCeilingBefore.tablePresent || !hardCeilingAfter.tablePresent
      || value.apiUsageRowDelta !== 0 || value.apiUsageCostDeltaUsd !== 0
      || value.hardCeilingReservationRowDelta !== 0
      || value.hardCeilingReservedCostDeltaUsd !== 0
      || !equalCanonical(apiBefore, apiAfter)
      || !equalCanonical(hardCeilingBefore, hardCeilingAfter)) {
    fail('observation provider ledger must prove zero durable usage and hard-ceiling reservation deltas');
  }
  return {
    ...value,
    apiUsageBefore: apiBefore,
    apiUsageAfter: apiAfter,
    hardCeilingReservationsBefore: hardCeilingBefore,
    hardCeilingReservationsAfter: hardCeilingAfter,
  };
}

export function validateCapabilityObservationReceipt(receipt) {
  assertExactKeys(receipt, OBSERVATION_RECEIPT_KEYS, 'observation receipt');
  if (receipt.schema !== CHAT_CAPABILITY_OBSERVATION_RECEIPT_SCHEMA
      || receipt.status !== 'passed' || receipt.role !== 'staging') {
    fail('observation receipt schema, status, or role is unsupported');
  }
  const plan = validateCapabilityObservationPlan(receipt.plan);
  if (receipt.runtimeSha !== plan.runtimeSha || receipt.artifactDigest !== plan.artifactDigest
      || receipt.flag !== plan.flag || receipt.observationSequence !== plan.observationSequence
      || receipt.planDigest !== plan.planDigest
      || receipt.enableTransactionId !== plan.enableTransactionId
      || receipt.enableReceiptSha256 !== plan.enableReceiptSha256
      || receipt.enablePlanSequence !== plan.enablePlanSequence
      || receipt.enableCompletedAt !== plan.enableCompletedAt
      || receipt.smokeProfile !== plan.smokeProfile
      || receipt.smokeScriptSha256 !== plan.smokeScriptSha256
      || receipt.expectedProductionPlanSequence !== plan.expectedProductionPlanSequence
      || receipt.expiresAt !== plan.expiresAt) {
    fail('observation receipt does not match its exact inspected plan');
  }
  if (typeof receipt.transactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-f]{12}$/u.test(receipt.transactionId)) {
    fail('observation receipt transaction ID is invalid');
  }
  assertSha256(receipt.smokeSha256, 'observation receipt.smokeSha256');
  const smokeStartedAt = assertCanonicalTimestamp(
    receipt.smokeStartedAt,
    'observation receipt.smokeStartedAt',
  );
  const smokeCompletedAt = assertCanonicalTimestamp(
    receipt.smokeCompletedAt,
    'observation receipt.smokeCompletedAt',
  );
  const observationStartedAt = assertCanonicalTimestamp(
    receipt.observationStartedAt,
    'observation receipt.observationStartedAt',
  );
  const observationCompletedAt = assertCanonicalTimestamp(
    receipt.observationCompletedAt,
    'observation receipt.observationCompletedAt',
  );
  assertInteger(receipt.smokeCheckCount, 'observation receipt.smokeCheckCount', { minimum: 1 });
  if (Date.parse(observationStartedAt) < Date.parse(plan.generatedAt)
      || Date.parse(smokeStartedAt) < Date.parse(plan.smokeNotBefore)
      || Date.parse(smokeStartedAt) < Date.parse(observationStartedAt)
      || Date.parse(smokeCompletedAt) < Date.parse(smokeStartedAt)
      || Date.parse(observationCompletedAt) < Date.parse(smokeCompletedAt)
      || Date.parse(observationCompletedAt) > Date.parse(plan.expiresAt)) {
    fail('observation receipt timestamps violate the inspected observation window');
  }
  const configuredBefore = normalizeFlagState(
    receipt.configuredBefore,
    'observation receipt.configuredBefore',
  );
  const effectiveBefore = normalizeFlagState(
    receipt.effectiveBefore,
    'observation receipt.effectiveBefore',
  );
  const configuredAfter = normalizeFlagState(
    receipt.configuredAfter,
    'observation receipt.configuredAfter',
  );
  const effectiveAfter = normalizeFlagState(
    receipt.effectiveAfter,
    'observation receipt.effectiveAfter',
  );
  const masterKillBefore = assertBoolean(
    receipt.masterKillBefore,
    'observation receipt.masterKillBefore',
  );
  const masterKillAfter = assertBoolean(
    receipt.masterKillAfter,
    'observation receipt.masterKillAfter',
  );
  if (masterKillBefore || masterKillAfter
      || !equalCanonical(configuredBefore, plan.configured)
      || !equalCanonical(effectiveBefore, plan.effective)
      || !equalCanonical(configuredAfter, plan.configured)
      || !equalCanonical(effectiveAfter, plan.effective)) {
    fail('observation receipt capability prefix changed before or after smoke');
  }
  const stagingPrerequisite = validateStagingCapabilityPrerequisite(
    receipt.stagingPrerequisite,
  );
  if (stagingPrerequisite.flag !== plan.flag
      || stagingPrerequisite.runtimeSha !== plan.runtimeSha
      || stagingPrerequisite.artifactDigest !== plan.artifactDigest
      || stagingPrerequisite.enableTransactionId !== plan.enableTransactionId
      || stagingPrerequisite.enableReceiptSha256 !== plan.enableReceiptSha256
      || stagingPrerequisite.normalSmokeSha256 !== receipt.smokeSha256
      || stagingPrerequisite.normalSmokeProfile !== plan.smokeProfile
      || stagingPrerequisite.normalSmokeStartedAt !== smokeStartedAt
      || stagingPrerequisite.normalSmokeCompletedAt !== smokeCompletedAt
      || stagingPrerequisite.normalSmokeCheckCount !== receipt.smokeCheckCount
      || !equalCanonical(stagingPrerequisite.stagingConfigured, plan.configured)
      || !equalCanonical(stagingPrerequisite.stagingEffective, plan.effective)
      || stagingPrerequisite.masterKill !== false
      || stagingPrerequisite.durableAlertActivityRowCount !== 0) {
    fail('observation receipt staging prerequisite does not match its plan and smoke');
  }
  let flagSpecificEvidence = null;
  if (plan.flag === 'AI_ROUTING_CLARIFY') {
    if (receipt.flagSpecificEvidence === null) {
      fail('clarify observation receipt requires current budget evidence');
    }
    flagSpecificEvidence = validateClarifyEvidence(receipt.flagSpecificEvidence, {
      role: 'production',
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      flag: plan.flag,
      generatedAt: observationCompletedAt,
    });
  } else if (plan.flag === 'AI_CLASSIFY_MANIFEST_PROMPT') {
    if (receipt.flagSpecificEvidence === null) {
      fail('action-skill observation receipt requires current cache evidence');
    }
    flagSpecificEvidence = validateActionSkillEvidence(receipt.flagSpecificEvidence, {
      role: 'production',
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      flag: plan.flag,
      generatedAt: observationCompletedAt,
    });
  } else if (plan.flag === 'AI_CROSS_SKILL_EXECUTION') {
    if (receipt.flagSpecificEvidence === null) {
      fail('cross-skill observation receipt requires dedicated staging smoke evidence');
    }
    flagSpecificEvidence = validateCrossSkillEvidence(receipt.flagSpecificEvidence, {
      role: 'production',
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      flag: plan.flag,
      generatedAt: observationCompletedAt,
    });
  } else if (receipt.flagSpecificEvidence !== null) {
    fail('routing observation receipt does not accept target-on flag evidence');
  }
  const providerLedger = validateObservationProviderLedger(receipt.providerLedger);
  return {
    ...receipt,
    plan,
    configuredBefore,
    effectiveBefore,
    configuredAfter,
    effectiveAfter,
    stagingPrerequisite,
    flagSpecificEvidence,
    providerLedger,
  };
}

export function buildCapabilityObservationReceipt(input) {
  assertExactKeys(input, BUILD_OBSERVATION_RECEIPT_INPUT_KEYS, 'observation receipt input');
  const plan = validateCapabilityObservationPlan(input.plan);
  const stagingPrerequisite = validateStagingCapabilityPrerequisite(
    input.stagingPrerequisite,
  );
  const smokeRaw = assertString(input.smokeRaw, 'observation receipt smokeRaw');
  const receipt = {
    schema: CHAT_CAPABILITY_OBSERVATION_RECEIPT_SCHEMA,
    status: 'passed',
    role: 'staging',
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    flag: plan.flag,
    transactionId: input.transactionId,
    observationSequence: plan.observationSequence,
    planDigest: plan.planDigest,
    plan,
    enableTransactionId: plan.enableTransactionId,
    enableReceiptSha256: plan.enableReceiptSha256,
    enablePlanSequence: plan.enablePlanSequence,
    enableCompletedAt: plan.enableCompletedAt,
    smokeProfile: plan.smokeProfile,
    smokeScriptSha256: plan.smokeScriptSha256,
    smokeSha256: sha256(smokeRaw),
    smokeStartedAt: stagingPrerequisite.normalSmokeStartedAt,
    smokeCompletedAt: stagingPrerequisite.normalSmokeCompletedAt,
    smokeCheckCount: stagingPrerequisite.normalSmokeCheckCount,
    observationStartedAt: input.observationStartedAt,
    observationCompletedAt: input.observationCompletedAt,
    configuredBefore: input.configuredBefore,
    effectiveBefore: input.effectiveBefore,
    masterKillBefore: input.masterKillBefore,
    configuredAfter: input.configuredAfter,
    effectiveAfter: input.effectiveAfter,
    masterKillAfter: input.masterKillAfter,
    stagingPrerequisite,
    flagSpecificEvidence: input.flagSpecificEvidence,
    providerLedger: input.providerLedger,
    expectedProductionPlanSequence: plan.expectedProductionPlanSequence,
    expiresAt: plan.expiresAt,
  };
  return validateCapabilityObservationReceipt(receipt);
}

const OBSERVED_STAGING_PREREQUISITE_KEYS = Object.freeze([
  'schema',
  'observationReceiptSha256',
  'observationTransactionId',
  'observationSequence',
  'observationCompletedAt',
  'observationExpiresAt',
  'expectedProductionPlanSequence',
  'basePrerequisite',
]);

export function validateProductionStagingCapabilityPrerequisite(value, binding) {
  assertExactKeys(
    value,
    OBSERVED_STAGING_PREREQUISITE_KEYS,
    'observed staging prerequisite',
  );
  if (value.schema !== CHAT_CAPABILITY_OBSERVED_STAGING_PREREQUISITE_SCHEMA) {
    fail('observed staging prerequisite schema is unsupported');
  }
  assertSha256(
    value.observationReceiptSha256,
    'observed staging prerequisite.observationReceiptSha256',
  );
  if (typeof value.observationTransactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-f]{12}$/u.test(value.observationTransactionId)) {
    fail('observed staging prerequisite observation transaction ID is invalid');
  }
  assertInteger(
    value.observationSequence,
    'observed staging prerequisite.observationSequence',
    { minimum: 1 },
  );
  const observationCompletedAt = assertCanonicalTimestamp(
    value.observationCompletedAt,
    'observed staging prerequisite.observationCompletedAt',
  );
  const observationExpiresAt = assertCanonicalTimestamp(
    value.observationExpiresAt,
    'observed staging prerequisite.observationExpiresAt',
  );
  const expectedProductionPlanSequence = assertInteger(
    value.expectedProductionPlanSequence,
    'observed staging prerequisite.expectedProductionPlanSequence',
    { minimum: 1 },
  );
  if (Date.parse(observationCompletedAt) > Date.parse(observationExpiresAt)) {
    fail('observed staging prerequisite expires before observation completion');
  }
  const basePrerequisite = validateStagingCapabilityPrerequisite(
    value.basePrerequisite,
  );
  if (binding) {
    if (binding.role !== 'production' || binding.desiredValue !== true
        || binding.flag === MASTER_KILL
        || basePrerequisite.flag !== binding.flag
        || basePrerequisite.runtimeSha !== binding.runtimeSha
        || basePrerequisite.artifactDigest !== binding.artifactDigest
        || !equalCanonical(basePrerequisite.stagingConfigured, binding.configuredAfter)
        || !equalCanonical(basePrerequisite.stagingEffective, binding.effectiveAfter)
        || expectedProductionPlanSequence !== binding.planSequence
        || Date.parse(observationCompletedAt) > Date.parse(binding.generatedAt)
        || Date.parse(binding.generatedAt) > Date.parse(observationExpiresAt)) {
      fail('observed staging prerequisite does not bind the exact production enable plan');
    }
  }
  return { ...value, basePrerequisite };
}

export function buildProductionStagingCapabilityPrerequisite(input) {
  assertExactKeys(input, [
    'receiptRaw',
    'healthRaw',
    'dashboardRaw',
    'smokeRaw',
    'monitorRaw',
    'observationRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'checkedAt',
  ], 'observed staging prerequisite input');
  const observationRaw = assertString(
    input.observationRaw,
    'observed staging prerequisite observationRaw',
  );
  let observation;
  try {
    observation = validateCapabilityObservationReceipt(JSON.parse(observationRaw));
  } catch {
    fail('observed staging prerequisite requires one valid observation receipt');
  }
  const basePrerequisite = buildStagingCapabilityPrerequisite({
    receiptRaw: input.receiptRaw,
    healthRaw: input.healthRaw,
    dashboardRaw: input.dashboardRaw,
    smokeRaw: input.smokeRaw,
    monitorRaw: input.monitorRaw,
    flag: input.flag,
    runtimeSha: input.runtimeSha,
    artifactDigest: input.artifactDigest,
    checkedAt: input.checkedAt,
  });
  if (observation.flag !== input.flag
      || observation.runtimeSha !== input.runtimeSha
      || observation.artifactDigest !== input.artifactDigest
      || observation.enableTransactionId !== basePrerequisite.enableTransactionId
      || observation.enableReceiptSha256 !== basePrerequisite.enableReceiptSha256
      || observation.smokeSha256 !== basePrerequisite.normalSmokeSha256
      || observation.smokeProfile !== basePrerequisite.normalSmokeProfile
      || !equalCanonical(observation.configuredAfter, basePrerequisite.stagingConfigured)
      || !equalCanonical(observation.effectiveAfter, basePrerequisite.stagingEffective)
      || Date.parse(input.checkedAt) > Date.parse(observation.expiresAt)) {
    fail('observation receipt does not bind the current exact staging prerequisite');
  }
  return validateProductionStagingCapabilityPrerequisite({
    schema: CHAT_CAPABILITY_OBSERVED_STAGING_PREREQUISITE_SCHEMA,
    observationReceiptSha256: sha256(observationRaw),
    observationTransactionId: observation.transactionId,
    observationSequence: observation.observationSequence,
    observationCompletedAt: observation.observationCompletedAt,
    observationExpiresAt: observation.expiresAt,
    expectedProductionPlanSequence: observation.expectedProductionPlanSequence,
    basePrerequisite,
  });
}

export function buildProductionStagingCapabilityPrerequisiteFromObservation(input) {
  assertExactKeys(input, [
    'observationRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'checkedAt',
  ], 'observed staging selector input');
  const observationRaw = assertString(
    input.observationRaw,
    'observed staging selector observationRaw',
  );
  let observation;
  try {
    observation = validateCapabilityObservationReceipt(JSON.parse(observationRaw));
  } catch {
    fail('observed staging selector requires one valid observation receipt');
  }
  const checkedAt = assertCanonicalTimestamp(input.checkedAt, 'observed staging selector checkedAt');
  if (observation.flag !== input.flag
      || observation.runtimeSha !== input.runtimeSha
      || observation.artifactDigest !== input.artifactDigest
      || Date.parse(checkedAt) < Date.parse(observation.observationCompletedAt)
      || Date.parse(checkedAt) > Date.parse(observation.expiresAt)) {
    fail('observation receipt is stale or does not bind the exact production selector');
  }
  return validateProductionStagingCapabilityPrerequisite({
    schema: CHAT_CAPABILITY_OBSERVED_STAGING_PREREQUISITE_SCHEMA,
    observationReceiptSha256: sha256(observationRaw),
    observationTransactionId: observation.transactionId,
    observationSequence: observation.observationSequence,
    observationCompletedAt: observation.observationCompletedAt,
    observationExpiresAt: observation.expiresAt,
    expectedProductionPlanSequence: observation.expectedProductionPlanSequence,
    basePrerequisite: observation.stagingPrerequisite,
  });
}

export function buildClarifyCalibrationEvidenceAttestation(input) {
  assertExactKeys(input, [
    'calibrationRaw',
    'dashboardRaw',
    'healthRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'configuredFlags',
    'checkedAt',
  ], 'clarify calibration evidence input');
  if (input.flag !== 'AI_ROUTING_CLARIFY') fail('clarify calibration flag is invalid');
  const runtimeSha = assertRuntimeSha(input.runtimeSha);
  const artifactDigest = assertArtifactDigest(input.artifactDigest);
  const configuredFlags = normalizeFlagState(input.configuredFlags, 'configuredFlags');
  if (configuredFlags[input.flag] || configuredFlags[MASTER_KILL]) {
    fail('clarify calibration requires the target and master kill configured off');
  }
  const checkedAt = assertCanonicalTimestamp(input.checkedAt, 'checkedAt');
  const live = validateLiveStagingHealth({
    healthRaw: input.healthRaw,
    runtimeSha,
    artifactDigest,
    configuredFlags,
    checkedAt,
    flag: input.flag,
    targetEnabled: false,
  });
  const calibrationParsed = parseRawJson(input.calibrationRaw, 'routing calibration');
  const calibration = assertPlainObject(calibrationParsed.value, 'routing calibration');
  const provenance = assertPlainObject(calibration.provenance, 'routing calibration provenance');
  const clarify = assertPlainObject(calibration.clarify, 'routing calibration clarify policy');
  if (calibration.version !== 'routing-calibration@1.0.0'
      || provenance.source !== 'corpus' || provenance.corpusSize !== 300) {
    fail('clarify rollout requires the 300-row corpus calibration');
  }
  const calibrationGeneratedAt = assertCanonicalTimestamp(
    provenance.generatedAt,
    'routing calibration generatedAt',
  );
  assertRate(clarify.epsilon, 'routing calibration clarify.epsilon');
  assertRate(clarify.actionableFloor, 'routing calibration clarify.actionableFloor');
  if (Date.parse(calibrationGeneratedAt) > Date.parse(checkedAt)) {
    fail('routing calibration cannot postdate evidence collection');
  }
  const dashboard = parseClarifyDashboard(input.dashboardRaw, 'clarify baseline dashboard');
  if (Date.parse(dashboard.generatedAt) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(dashboard.generatedAt) > 30_000) {
    fail('clarify baseline dashboard is stale or future-dated');
  }
  const evidence = {
    schema: CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA,
    kind: 'clarify_calibration',
    status: 'passed',
    environment: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    collectedWithTargetEnabled: false,
    evidenceSha256: sha256(`${calibrationParsed.source}\0${dashboard.raw}\0${input.healthRaw}`),
    generatedAt: checkedAt,
    calibrationSha256: sha256(calibrationParsed.source),
    calibrationGeneratedAt,
    corpusSize: provenance.corpusSize,
    baselineDashboardSha256: dashboard.sha256,
    baselineGeneratedAt: dashboard.generatedAt,
    baselineEvaluatedTurns: dashboard.evaluatedTurns,
    baselineClarifiedTurns: dashboard.clarifiedTurns,
    baselineGlobalRate: dashboard.rate,
    budgetLimit: 0.1,
    liveHealthSha256: live.healthSha256,
    liveHealthCheckedAt: live.checkedAt,
  };
  return validateClarifyCalibrationEvidence(evidence, {
    role: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    generatedAt: checkedAt,
  });
}

export function buildClarifyBudgetEvidenceAttestation(input) {
  assertExactKeys(input, [
    'receiptRaw',
    'dashboardRaw',
    'healthRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'checkedAt',
  ], 'clarify budget evidence input');
  if (input.flag !== 'AI_ROUTING_CLARIFY') fail('clarify budget flag is invalid');
  const runtimeSha = assertRuntimeSha(input.runtimeSha);
  const artifactDigest = assertArtifactDigest(input.artifactDigest);
  const checkedAt = assertCanonicalTimestamp(input.checkedAt, 'checkedAt');
  const receiptParsed = parseRawJson(input.receiptRaw, 'clarify staging receiptRaw');
  const receipt = validateCapabilityFlagReceipt(receiptParsed.value);
  if (receipt.status !== 'passed' || receipt.role !== 'staging'
      || receipt.runtimeSha !== runtimeSha || receipt.artifactDigest !== artifactDigest
      || receipt.flag !== input.flag || receipt.desiredValue !== true
      || receipt.evidenceAttestation?.kind !== 'clarify_calibration') {
    fail('clarify budget requires the exact staging calibration enable receipt');
  }
  const live = validateLiveStagingHealth({
    healthRaw: input.healthRaw,
    runtimeSha,
    artifactDigest,
    configuredFlags: receipt.configuredAfter,
    checkedAt,
    flag: input.flag,
    targetEnabled: true,
  });
  const current = parseClarifyDashboard(input.dashboardRaw, 'current clarify dashboard');
  const baseline = receipt.evidenceAttestation;
  if (Date.parse(receipt.completedAt) > Date.parse(current.generatedAt)
      || Date.parse(current.generatedAt) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(current.generatedAt) > 30_000
      || current.windowDays !== 30
      || current.evaluatedTurns < baseline.baselineEvaluatedTurns
      || current.clarifiedTurns < baseline.baselineClarifiedTurns) {
    fail('clarify dashboard window or counters are stale, non-monotonic, or pre-enable');
  }
  const candidateEvaluatedTurns = current.evaluatedTurns - baseline.baselineEvaluatedTurns;
  const candidateClarifiedTurns = current.clarifiedTurns - baseline.baselineClarifiedTurns;
  if (candidateEvaluatedTurns < 1 || candidateClarifiedTurns > candidateEvaluatedTurns) {
    fail('clarify candidate window requires positive evaluated-turn evidence');
  }
  const candidateClarifyRate = round4(candidateClarifiedTurns / candidateEvaluatedTurns);
  if (current.rate === null || current.rate > 0.1 || current.withinBudget !== true
      || candidateClarifyRate > 0.1) {
    fail('clarify global or candidate rate exceeds the fixed 10% budget');
  }
  const evidence = {
    schema: CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA,
    kind: 'clarify_budget',
    status: 'passed',
    environment: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    collectedWithTargetEnabled: true,
    evidenceSha256: sha256(`${receiptParsed.source}\0${current.raw}\0${input.healthRaw}`),
    generatedAt: checkedAt,
    evaluatedTurns: current.evaluatedTurns,
    clarifiedTurns: current.clarifiedTurns,
    clarifyRate: current.rate,
    budgetLimit: 0.1,
    withinBudget: true,
    baselineDashboardSha256: baseline.baselineDashboardSha256,
    baselineGeneratedAt: baseline.baselineGeneratedAt,
    currentDashboardSha256: current.sha256,
    candidateEvaluatedTurns,
    candidateClarifiedTurns,
    candidateClarifyRate,
    outcomesReviewRequired: 'owner_plan_digest_ack',
    liveHealthSha256: live.healthSha256,
    liveHealthCheckedAt: live.checkedAt,
  };
  return validateClarifyEvidence(evidence, {
    role: 'production',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    generatedAt: checkedAt,
  });
}

export function buildActionSkillEvidenceAttestation(input) {
  assertExactKeys(input, [
    'rawEvidence',
    'healthRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'configuredFlags',
    'checkedAt',
  ], 'action-skill evidence input');
  if (input.flag !== 'AI_CLASSIFY_MANIFEST_PROMPT') fail('action-skill flag is invalid');
  const runtimeSha = assertRuntimeSha(input.runtimeSha);
  const artifactDigest = assertArtifactDigest(input.artifactDigest);
  const configuredFlags = normalizeFlagState(input.configuredFlags, 'configuredFlags');
  if (configuredFlags[MASTER_KILL]) fail('action-skill evidence requires master kill configured off');
  const targetEnabled = configuredFlags[input.flag];
  const checkedAt = assertCanonicalTimestamp(input.checkedAt, 'checkedAt');
  const live = validateLiveStagingHealth({
    healthRaw: input.healthRaw,
    runtimeSha,
    artifactDigest,
    configuredFlags,
    checkedAt,
    flag: input.flag,
    targetEnabled,
  });
  const parsed = parseRawJson(input.rawEvidence, 'action-skill gate report');
  const wrapper = assertPlainObject(parsed.value, 'action-skill gate report');
  const report = assertPlainObject(wrapper.report, 'action-skill gate report.report');
  const source = assertPlainObject(report.sourceIdentity, 'action-skill sourceIdentity');
  const release = assertPlainObject(report.releaseEvidence, 'action-skill releaseEvidence');
  const gate = assertPlainObject(report.gate, 'action-skill gate');
  if (wrapper.schemaVersion !== 'routing_action_skill_accuracy_report.v1'
      || report.version !== 'routing-action-skill-accuracy@1.0.0') {
    fail('action-skill gate report schema is unsupported');
  }
  const generatedAt = assertCanonicalTimestamp(report.generatedAt, 'action-skill generatedAt');
  if (Date.parse(generatedAt) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(generatedAt) > 300_000
      || source.runtimeSha !== runtimeSha || source.artifactDigest !== artifactDigest
      || source.requestBuilderVersion !== 'manifest-classifier-request@1.0.0'
      || source.provider !== 'gemini' || !/flash-lite/iu.test(source.model ?? '')
      || source.usageCategory !== 'gemini_classify' || source.requestSource !== 'system'
      || source.baseCategory !== 'routing_action_skill_cache_refresh'
      || source.jobName !== 'routing_action_skill_cache_refresh'
      || source.userId !== 0 || source.tenantId !== 0) {
    fail('action-skill gate source identity is not the exact approved release evaluator');
  }
  assertSha256(source.promptSha256, 'action-skill promptSha256');
  assertSha256(report.corpusIdentityDigest, 'action-skill corpusIdentityDigest', {
    prefixed: true,
  });
  assertSha256(release.terminalPlanDigest, 'action-skill terminalPlanDigest', {
    prefixed: true,
  });
  if (!Array.isArray(release.completedPlanDigests)
      || !release.completedPlanDigests.includes(release.terminalPlanDigest)
      || release.terminalPlanStatus !== 'completed'
      || !Number.isSafeInteger(release.terminalPlanSequence)
      || release.terminalPlanSequence < 1
      || typeof release.hardBudgetUsd !== 'number'
      || !Number.isFinite(release.hardBudgetUsd) || release.hardBudgetUsd <= 0
      || report.itemCount !== 300 || report.covered !== 300 || report.uncovered !== 0
      || report.coverage !== 1 || typeof report.agreement !== 'number'
      || report.agreement < 0.95 || gate.passed !== true
      || gate.requiredItemCount !== 300 || gate.requiredCovered !== 300
      || gate.minimumAgreement !== 0.95 || !Array.isArray(gate.reasons)
      || gate.reasons.length !== 0) {
    fail('action-skill cache coverage, agreement, refresh receipt, or gate did not pass');
  }
  const evidence = {
    schema: CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA,
    kind: 'action_skill_accuracy',
    status: 'passed',
    environment: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    collectedWithTargetEnabled: targetEnabled,
    evidenceSha256: sha256(parsed.source),
    generatedAt,
    labeledRows: report.itemCount,
    cacheRows: report.covered,
    agreementRate: report.agreement,
    executionMode: 'cache_only',
    gatePassed: true,
    corpusIdentityDigest: report.corpusIdentityDigest,
    promptSha256: source.promptSha256,
    refreshPlanDigest: release.terminalPlanDigest,
    hardBudgetUsd: release.hardBudgetUsd,
    liveHealthSha256: live.healthSha256,
    liveHealthCheckedAt: live.checkedAt,
  };
  return validateActionSkillEvidence(evidence, {
    role: targetEnabled ? 'production' : 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    generatedAt: checkedAt,
  });
}

export function buildCrossSkillPreflightEvidenceAttestation(input) {
  assertExactKeys(input, [
    'rawEvidence',
    'healthRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'configuredFlags',
    'checkedAt',
  ], 'cross-skill preflight evidence input');
  if (input.flag !== 'AI_CROSS_SKILL_EXECUTION') fail('cross-skill preflight flag is invalid');
  const runtimeSha = assertRuntimeSha(input.runtimeSha);
  const artifactDigest = assertArtifactDigest(input.artifactDigest);
  const configuredFlags = normalizeFlagState(input.configuredFlags, 'configuredFlags');
  if (configuredFlags[input.flag] || configuredFlags[MASTER_KILL]) {
    fail('cross-skill preflight requires the target and master kill configured off');
  }
  const checkedAt = assertCanonicalTimestamp(input.checkedAt, 'checkedAt');
  const live = validateLiveStagingHealth({
    healthRaw: input.healthRaw,
    runtimeSha,
    artifactDigest,
    configuredFlags,
    checkedAt,
    flag: input.flag,
    targetEnabled: false,
  });
  const parsed = parseRawJson(input.rawEvidence, 'cross-skill preflight report');
  const report = assertPlainObject(parsed.value, 'cross-skill preflight report');
  assertExactKeys(report, [
    'schema',
    'generatedAt',
    'runtimeSha',
    'artifactDigest',
    'executorCoverage',
    'legacyTailCoverage',
    'trainingPlanCreateOutputRefs',
    'passed',
  ], 'cross-skill preflight report');
  const generatedAt = assertCanonicalTimestamp(report.generatedAt, 'cross-skill preflight generatedAt');
  assertExactKeys(report.executorCoverage, [
    'draft_email',
    'send_email',
    'connections_retry_sync',
  ], 'cross-skill executor coverage');
  assertExactKeys(report.legacyTailCoverage, [
    'connections',
    'notifications',
    'decision_center',
  ], 'cross-skill legacy-tail coverage');
  const executorCoveragePassed = Object.values(report.executorCoverage)
    .every((value) => value === true);
  const legacyTailCoveragePassed = Object.values(report.legacyTailCoverage)
    .every((value) => value === true);
  if (report.schema !== 'nexus.chat-capability-cross-skill-preflight.v1'
      || report.runtimeSha !== runtimeSha || report.artifactDigest !== artifactDigest
      || Date.parse(generatedAt) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(generatedAt) > 300_000
      || !executorCoveragePassed || !legacyTailCoveragePassed
      || report.trainingPlanCreateOutputRefs !== 'absent' || report.passed !== true) {
    fail('cross-skill preflight did not pass the exact executor, legacy-tail, and outputRefs contract');
  }
  const evidence = {
    schema: CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA,
    kind: 'cross_skill_preflight',
    status: 'passed',
    environment: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    collectedWithTargetEnabled: false,
    evidenceSha256: sha256(parsed.source),
    generatedAt,
    executorCoveragePassed,
    legacyTailCoveragePassed,
    outputRefsDecision: 'absent',
    liveHealthSha256: live.healthSha256,
    liveHealthCheckedAt: live.checkedAt,
  };
  return validateCrossSkillPreflightEvidence(evidence, {
    role: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    generatedAt: checkedAt,
  });
}

export function buildCrossSkillSmokeEvidenceAttestation(input) {
  assertExactKeys(input, [
    'rawEvidence',
    'healthRaw',
    'flag',
    'runtimeSha',
    'artifactDigest',
    'configuredFlags',
    'checkedAt',
  ], 'cross-skill smoke evidence input');
  if (input.flag !== 'AI_CROSS_SKILL_EXECUTION') fail('cross-skill smoke flag is invalid');
  const runtimeSha = assertRuntimeSha(input.runtimeSha);
  const artifactDigest = assertArtifactDigest(input.artifactDigest);
  const configuredFlags = normalizeFlagState(input.configuredFlags, 'configuredFlags');
  if (!configuredFlags[input.flag] || configuredFlags[MASTER_KILL]) {
    fail('cross-skill smoke requires the target configured on and master kill off');
  }
  const checkedAt = assertCanonicalTimestamp(input.checkedAt, 'checkedAt');
  const live = validateLiveStagingHealth({
    healthRaw: input.healthRaw,
    runtimeSha,
    artifactDigest,
    configuredFlags,
    checkedAt,
    flag: input.flag,
    targetEnabled: true,
  });
  const parsed = parseRawJson(input.rawEvidence, 'cross-skill smoke report');
  const report = assertPlainObject(parsed.value, 'cross-skill smoke report');
  const release = assertPlainObject(report.releaseIdentity, 'cross-skill smoke releaseIdentity');
  const statuses = assertPlainObject(report.operationStatuses, 'cross-skill smoke operationStatuses');
  const expectedFlows = [
    'local_fixture_contracts',
    'phase7_cross_skill_flag_contract',
    'secretary_conflict',
    'cooking_fueling_gap',
    'finance_budget_constraint',
    'content_workload',
    'training_content_milestone',
    'shared_context_scope',
  ];
  assertExactKeys(statuses, expectedFlows, 'cross-skill smoke operationStatuses');
  const startedAt = assertCanonicalTimestamp(report.startedAt, 'cross-skill smoke startedAt');
  const finishedAt = assertCanonicalTimestamp(report.finishedAt, 'cross-skill smoke finishedAt');
  if (report.schema !== 'nexus.training-cross-skill-staging-smoke.v1'
      || report.dryRun !== false || report.dedicatedStagingIdentity !== true
      || report.dedicatedIdentitySource !== 'chat_eval_dedicated_tenant_db_attested'
      || release.environment !== 'staging' || release.runtimeSha !== runtimeSha
      || release.artifactDigest !== artifactDigest || report.prerequisitesPassed !== true
      || Object.values(statuses).some((status) => status !== 'pass')
      || report.crossSkillExecutionEffective !== true || report.masterKill !== false
      || report.trainingPlanCreateOutputRefs !== 'absent' || report.verdict !== 'passed'
      || Date.parse(finishedAt) < Date.parse(startedAt)
      || Date.parse(finishedAt) > Date.parse(checkedAt)
      || Date.parse(checkedAt) - Date.parse(finishedAt) > 300_000) {
    fail('cross-skill staging smoke did not pass its exact target-on release contract');
  }
  const evidence = {
    schema: CHAT_CAPABILITY_FLAG_EVIDENCE_SCHEMA,
    kind: 'cross_skill_smoke',
    status: 'passed',
    environment: 'staging',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    collectedWithTargetEnabled: true,
    evidenceSha256: sha256(parsed.source),
    generatedAt: finishedAt,
    smokeStatus: 'passed',
    releaseIdentityVerified: true,
    dedicatedStagingIdentity: true,
    dedicatedIdentitySource: 'chat_eval_dedicated_tenant_db_attested',
    outputRefsDecision: 'absent',
    runId: assertString(report.runId, 'cross-skill smoke runId'),
    operationCount: expectedFlows.length,
    liveHealthSha256: live.healthSha256,
    liveHealthCheckedAt: live.checkedAt,
  };
  return validateCrossSkillEvidence(evidence, {
    role: 'production',
    runtimeSha,
    artifactDigest,
    flag: input.flag,
    generatedAt: checkedAt,
  });
}

function assertCapabilityRolloutOrder(before, flag, desiredValue) {
  const targetIndex = CAPABILITY_FLAGS.indexOf(flag);
  if (desiredValue) {
    let observedDisabled = false;
    for (const capability of CAPABILITY_FLAGS) {
      if (!before[capability]) observedDisabled = true;
      else if (observedDisabled) {
        fail('configured capability flags must form one contiguous rollout prefix');
      }
    }
    if (CAPABILITY_FLAGS.slice(0, targetIndex).some((capability) => !before[capability])) {
      fail(`cannot enable ${flag} before every earlier rollout capability`);
    }
    if (CAPABILITY_FLAGS.slice(targetIndex + 1).some((capability) => before[capability])) {
      fail(`cannot enable ${flag} while a later rollout capability is configured`);
    }
  } else if (CAPABILITY_FLAGS.slice(targetIndex + 1).some((capability) => before[capability])) {
    fail(`capability rollback must disable later rollout capabilities first`);
  }
}

function validateTransition({ flag, desiredValue, before, transitionReason, evidenceAttestation, binding }) {
  assertOneOf(transitionReason, TRANSITION_REASONS, 'transitionReason');
  if (before[flag] === desiredValue) fail(`flag ${flag} already has the requested configured value`);

  if (flag === MASTER_KILL) {
    if (evidenceAttestation !== null) fail('master kill transitions do not accept gate evidence');
    if (desiredValue) {
      if (transitionReason !== 'emergency_kill') {
        fail('enabling the master kill requires transitionReason emergency_kill');
      }
      return null;
    }
    if (!DISABLE_REASONS.has(transitionReason)) {
      fail('clearing the master kill requires an approved rollback reason');
    }
    for (const capability of CAPABILITY_FLAGS) {
      if (before[capability]) {
        fail('master kill cannot be cleared while a capability remains configured on');
      }
    }
    return null;
  }

  if (desiredValue) {
    if (before[MASTER_KILL]) {
      fail('cannot configure a hidden capability enable while the master kill is engaged');
    }
    assertCapabilityRolloutOrder(before, flag, desiredValue);
    if (transitionReason !== 'gate_pass') {
      fail('enabling a capability requires transitionReason gate_pass');
    }
    if (evidenceAttestation === null) fail('enabling a capability requires structured gate evidence');
    return validateEvidence(evidenceAttestation, binding);
  }

  assertCapabilityRolloutOrder(before, flag, desiredValue);

  if (!DISABLE_REASONS.has(transitionReason)) {
    fail('disabling a capability requires an approved rollback reason');
  }
  if (evidenceAttestation !== null) fail('rollback transitions do not accept gate evidence');
  return null;
}

function validatePlanStagingPrerequisite(plan) {
  const required = plan.role === 'production'
    && plan.desiredValue === true
    && plan.flag !== MASTER_KILL;
  if (!required) {
    if (plan.stagingPrerequisite !== null) {
      fail('staging prerequisite is accepted only for production capability enables');
    }
    return null;
  }
  if (plan.stagingPrerequisite === null) {
    fail('production capability enable requires exact live staging prerequisite proof');
  }
  return validateProductionStagingCapabilityPrerequisite(plan.stagingPrerequisite, plan);
}

function planWithoutDigest(plan) {
  return Object.fromEntries(PLAN_KEYS
    .filter((key) => key !== 'planDigest')
    .map((key) => [key, plan[key]]));
}

function computePlanDigest(plan) {
  return `sha256:${sha256(canonicalJson(planWithoutDigest(plan)))}`;
}

function safeEqualDigest(left, right) {
  assertSha256(left, 'left digest', { prefixed: true });
  assertSha256(right, 'right digest', { prefixed: true });
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function validatePlan(plan) {
  assertExactKeys(plan, PLAN_KEYS, 'plan');
  if (plan.schema !== CHAT_CAPABILITY_FLAG_PLAN_SCHEMA) fail('plan schema is unsupported');
  assertOneOf(plan.role, ROLE_VALUES, 'plan.role');
  assertRuntimeSha(plan.runtimeSha, 'plan.runtimeSha');
  assertArtifactDigest(plan.artifactDigest, 'plan.artifactDigest');
  assertOneOf(plan.flag, CHAT_CAPABILITY_FLAGS, 'plan.flag');
  assertBoolean(plan.desiredValue, 'plan.desiredValue');
  assertInteger(plan.previousPlanSequence, 'plan.previousPlanSequence', {
    maximum: Number.MAX_SAFE_INTEGER - 1,
  });
  if (plan.planSequence !== plan.previousPlanSequence + 1) {
    fail('planSequence must monotonically increment previousPlanSequence by one');
  }
  assertCanonicalTimestamp(plan.generatedAt, 'plan.generatedAt');
  const configuredBefore = normalizeFlagState(plan.configuredBefore, 'plan.configuredBefore');
  const configuredAfter = normalizeFlagState(plan.configuredAfter, 'plan.configuredAfter');
  const expectedAfter = { ...configuredBefore, [plan.flag]: plan.desiredValue };
  if (!equalCanonical(configuredAfter, expectedAfter)) fail('plan configuredAfter changes more than its target flag');
  if (!Array.isArray(plan.changedFlags)
      || plan.changedFlags.length !== 1
      || plan.changedFlags[0] !== plan.flag) {
    fail('plan changedFlags must contain exactly the target flag');
  }
  const expectedEffectiveBefore = effectiveFlagState(configuredBefore);
  const expectedEffectiveAfter = effectiveFlagState(configuredAfter);
  if (!equalCanonical(plan.effectiveBefore, expectedEffectiveBefore)
      || !equalCanonical(plan.effectiveAfter, expectedEffectiveAfter)) {
    fail('plan effective flag states do not honor the master kill');
  }
  validateTransition({
    flag: plan.flag,
    desiredValue: plan.desiredValue,
    before: configuredBefore,
    transitionReason: plan.transitionReason,
    evidenceAttestation: plan.evidenceAttestation,
    binding: plan,
  });
  validatePlanStagingPrerequisite(plan);
  assertSha256(plan.planDigest, 'plan.planDigest', { prefixed: true });
  const expectedDigest = computePlanDigest(plan);
  if (!safeEqualDigest(plan.planDigest, expectedDigest)) fail('plan digest does not match canonical plan bytes');
  return plan;
}

export function buildCapabilityFlagPlan(input) {
  assertExactKeys(input, BUILD_PLAN_INPUT_KEYS, 'plan input');
  const role = assertOneOf(input.role, ROLE_VALUES, 'role');
  const runtimeSha = assertRuntimeSha(input.runtimeSha);
  const artifactDigest = assertArtifactDigest(input.artifactDigest);
  const flag = assertOneOf(input.flag, CHAT_CAPABILITY_FLAGS, 'flag');
  const desiredValue = assertBoolean(input.desiredValue, 'desiredValue');
  const configuredBefore = normalizeFlagState(input.configuredFlags, 'configuredFlags');
  const previousPlanSequence = assertInteger(
    input.previousPlanSequence,
    'previousPlanSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  const generatedAt = assertCanonicalTimestamp(input.generatedAt, 'generatedAt');
  const binding = { role, runtimeSha, artifactDigest, flag, generatedAt };
  const evidenceAttestation = validateTransition({
    flag,
    desiredValue,
    before: configuredBefore,
    transitionReason: input.transitionReason,
    evidenceAttestation: input.evidenceAttestation,
    binding,
  });
  const configuredAfter = { ...configuredBefore, [flag]: desiredValue };
  const plan = {
    schema: CHAT_CAPABILITY_FLAG_PLAN_SCHEMA,
    role,
    runtimeSha,
    artifactDigest,
    flag,
    desiredValue,
    previousPlanSequence,
    planSequence: previousPlanSequence + 1,
    transitionReason: input.transitionReason,
    evidenceAttestation,
    stagingPrerequisite: input.stagingPrerequisite,
    generatedAt,
    configuredBefore,
    configuredAfter,
    effectiveBefore: effectiveFlagState(configuredBefore),
    effectiveAfter: effectiveFlagState(configuredAfter),
    changedFlags: [flag],
  };
  return validatePlan({ ...plan, planDigest: computePlanDigest(plan) });
}

export function assertCapabilityFlagApplyAuthorization({ ownerAuthorized, ackPlan, planDigest } = {}) {
  if (ownerAuthorized !== '1') fail('explicit owner authorization is required for apply');
  assertSha256(ackPlan, 'acknowledged plan digest', { prefixed: true });
  assertSha256(planDigest, 'plan digest', { prefixed: true });
  if (!safeEqualDigest(ackPlan, planDigest)) fail('acknowledged plan digest does not match the inspected plan');
  return true;
}

function splitPreservingLineEndings(source) {
  if (source.length === 0) return [];
  const segments = source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu) ?? [];
  return segments.filter((segment, index) => segment.length > 0 || index < segments.length - 1);
}

function lineParts(segment) {
  if (segment.endsWith('\r\n')) return { body: segment.slice(0, -2), ending: '\r\n' };
  if (segment.endsWith('\n') || segment.endsWith('\r')) {
    return { body: segment.slice(0, -1), ending: segment.slice(-1) };
  }
  return { body: segment, ending: '' };
}

function parseGovernedAssignment(body) {
  const governed = CHAT_CAPABILITY_FLAGS.map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
  const candidate = body.match(new RegExp(`^\\s*(?:export[ \\t]+)?(${governed})[ \\t]*=`, 'u'));
  if (!candidate) return null;
  const canonical = body.match(new RegExp(`^\\s*(?:export[ \\t]+)?(${governed})[ \\t]*=[ \\t]*(true|false)[ \\t]*$`, 'u'));
  if (!canonical) fail(`governed assignment for ${candidate[1]} must use canonical boolean true or false`);
  return { flag: canonical[1], value: canonical[2] === 'true' };
}

export function rewriteCapabilityFlagDotenv({ source, plan } = {}) {
  assertString(source, 'dotenv source');
  validatePlan(plan);
  const segments = splitPreservingLineEndings(source);
  const seen = new Map();
  let newline = '\n';
  const parsed = segments.map((segment) => {
    const parts = lineParts(segment);
    if (parts.ending && newline === '\n') newline = parts.ending;
    const assignment = parseGovernedAssignment(parts.body);
    if (assignment) {
      if (seen.has(assignment.flag)) fail(`duplicate governed assignment for ${assignment.flag}`);
      seen.set(assignment.flag, assignment.value);
    }
    return { ...parts, assignment };
  });
  const configuredBefore = Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [
    flag,
    seen.get(flag) ?? false,
  ]));
  if (!equalCanonical(configuredBefore, plan.configuredBefore)) {
    fail('dotenv configured state drifted from the inspected plan');
  }

  let contents = parsed.map(({ body, ending, assignment }) => (
    assignment ? `${assignment.flag}=${plan.configuredAfter[assignment.flag]}${ending}` : `${body}${ending}`
  )).join('');
  const missing = CHAT_CAPABILITY_FLAGS.filter((flag) => !seen.has(flag));
  if (missing.length > 0) {
    if (contents.length > 0 && !/(?:\r\n|\n|\r)$/u.test(contents)) contents += newline;
    contents += missing.map((flag) => `${flag}=${plan.configuredAfter[flag]}${newline}`).join('');
  }
  return {
    contents,
    configuredBefore,
    configuredAfter: { ...plan.configuredAfter },
    changedFlags: [...plan.changedFlags],
  };
}

export function readCapabilityFlagState(source) {
  assertString(source, 'dotenv source');
  const seen = new Map();
  for (const segment of splitPreservingLineEndings(source)) {
    const assignment = parseGovernedAssignment(lineParts(segment).body);
    if (!assignment) continue;
    if (seen.has(assignment.flag)) fail(`duplicate governed assignment for ${assignment.flag}`);
    seen.set(assignment.flag, assignment.value);
  }
  return Object.fromEntries(CHAT_CAPABILITY_FLAGS.map((flag) => [
    flag,
    seen.get(flag) ?? false,
  ]));
}

const PENDING_PLAN_SCHEMA = 'nexus.chat-capability-pending-plan.v1';

function validatePrivateProcessPrecondition(value, label) {
  assertExactKeys(value, ['name', 'pid', 'pmUptimeMs'], label);
  const name = assertString(value.name, `${label}.name`);
  if (!name) fail(`${label}.name must not be empty`);
  return {
    name,
    pid: assertInteger(value.pid, `${label}.pid`, { minimum: 1 }),
    pmUptimeMs: assertInteger(value.pmUptimeMs, `${label}.pmUptimeMs`),
  };
}

function validatePrivatePreconditions(value, plan) {
  assertExactKeys(
    value,
    ['envSha256', 'releaseDir', 'backendProcess', 'contentProcess'],
    'privatePreconditions',
  );
  const envSha256 = assertSha256(value.envSha256, 'privatePreconditions.envSha256');
  const releaseDir = assertString(value.releaseDir, 'privatePreconditions.releaseDir');
  const expectedBase = plan.role === 'staging'
    ? '/home/dominguez/telegram-hub-bot-staging/releases/'
    : '/home/dominguez/telegram-hub-bot/releases/';
  const expectedName = `${plan.runtimeSha}-${plan.artifactDigest.slice(0, 12)}`;
  if (releaseDir !== `${expectedBase}${expectedName}`) {
    fail('privatePreconditions.releaseDir does not match the exact release identity');
  }
  return {
    envSha256,
    releaseDir,
    backendProcess: validatePrivateProcessPrecondition(
      value.backendProcess,
      'privatePreconditions.backendProcess',
    ),
    contentProcess: validatePrivateProcessPrecondition(
      value.contentProcess,
      'privatePreconditions.contentProcess',
    ),
  };
}

function validatePendingPlanBinding(plan) {
  assertPlainObject(plan, 'pending plan');
  if (plan.schema !== CHAT_CAPABILITY_FLAG_PLAN_SCHEMA) fail('pending plan schema is unsupported');
  const role = assertOneOf(plan.role, ROLE_VALUES, 'pending plan.role');
  const runtimeSha = assertRuntimeSha(plan.runtimeSha, 'pending plan.runtimeSha');
  const artifactDigest = assertArtifactDigest(plan.artifactDigest, 'pending plan.artifactDigest');
  const previousPlanSequence = assertInteger(
    plan.previousPlanSequence,
    'pending plan.previousPlanSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  const planSequence = assertInteger(plan.planSequence, 'pending plan.planSequence', { minimum: 1 });
  if (planSequence !== previousPlanSequence + 1) {
    fail('pending plan sequence must advance exactly once');
  }
  const planDigest = assertSha256(plan.planDigest, 'pending plan.planDigest', { prefixed: true });
  return { role, runtimeSha, artifactDigest, previousPlanSequence, planSequence, planDigest };
}

function validatePendingRecord(record) {
  assertPlainObject(record, 'pending plan record');
  if (record.schema !== PENDING_PLAN_SCHEMA) fail('pending plan record schema is unsupported');
  if (record.state !== 'pending') fail('pending plan record was already claimed or consumed');
  const binding = validatePendingPlanBinding(record.plan);
  if (record.role !== binding.role
      || record.runtimeSha !== binding.runtimeSha
      || record.artifactDigest !== binding.artifactDigest
      || record.planSequence !== binding.planSequence
      || record.planDigest !== binding.planDigest) {
    fail('pending plan record binding is inconsistent');
  }
  const privatePreconditions = validatePrivatePreconditions({
    envSha256: record.envSha256,
    releaseDir: record.releaseDir,
    backendProcess: record.backendProcess,
    contentProcess: record.contentProcess,
  }, binding);
  assertCanonicalTimestamp(record.createdAt, 'pending plan record.createdAt');
  return { binding, privatePreconditions };
}

export function createPendingCapabilityPlanRecord(input) {
  assertExactKeys(
    input,
    ['latestPlanSequence', 'existingPending', 'plan', 'privatePreconditions', 'createdAt'],
    'pending plan record input',
  );
  const latestPlanSequence = assertInteger(
    input.latestPlanSequence,
    'latestPlanSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  const binding = validatePendingPlanBinding(input.plan);
  if (binding.previousPlanSequence !== latestPlanSequence
      || binding.planSequence !== latestPlanSequence + 1) {
    fail('pending plan sequence does not monotonically follow the latest sequence');
  }
  const privatePreconditions = validatePrivatePreconditions(input.privatePreconditions, binding);
  const createdAt = assertCanonicalTimestamp(input.createdAt, 'pending plan createdAt');

  if (input.existingPending !== null) {
    const existing = validatePendingRecord(input.existingPending);
    if (existing.binding.planDigest !== binding.planDigest
        || existing.binding.planSequence !== binding.planSequence
        || !equalCanonical(existing.privatePreconditions, privatePreconditions)) {
      fail('a different pending plan cannot replace the unconsumed pending plan');
    }
    return input.existingPending;
  }

  return {
    schema: PENDING_PLAN_SCHEMA,
    state: 'pending',
    role: binding.role,
    runtimeSha: binding.runtimeSha,
    artifactDigest: binding.artifactDigest,
    planSequence: binding.planSequence,
    planDigest: binding.planDigest,
    envSha256: privatePreconditions.envSha256,
    releaseDir: privatePreconditions.releaseDir,
    backendProcess: privatePreconditions.backendProcess,
    contentProcess: privatePreconditions.contentProcess,
    createdAt,
    plan: input.plan,
  };
}

export function claimPendingCapabilityPlanRecord(input) {
  assertExactKeys(input, [
    'record',
    'ackPlan',
    'expectedRole',
    'expectedRuntimeSha',
    'expectedArtifactDigest',
    'expectedPlanSequence',
    'transactionId',
    'claimedAt',
  ], 'pending plan claim input');
  const { binding } = validatePendingRecord(input.record);
  const ackPlan = assertSha256(input.ackPlan, 'acknowledged plan digest', { prefixed: true });
  const expectedRole = assertOneOf(input.expectedRole, ROLE_VALUES, 'expectedRole');
  const expectedRuntimeSha = assertRuntimeSha(input.expectedRuntimeSha, 'expectedRuntimeSha');
  const expectedArtifactDigest = assertArtifactDigest(
    input.expectedArtifactDigest,
    'expectedArtifactDigest',
  );
  const expectedPlanSequence = assertInteger(
    input.expectedPlanSequence,
    'expectedPlanSequence',
    { minimum: 1 },
  );
  if (!safeEqualDigest(ackPlan, binding.planDigest)
      || expectedRole !== binding.role
      || expectedRuntimeSha !== binding.runtimeSha
      || expectedArtifactDigest !== binding.artifactDigest
      || expectedPlanSequence !== binding.planSequence) {
    fail('pending plan claim digest, sequence, or release identity does not match');
  }
  if (typeof input.transactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-z]{12,64}$/u.test(input.transactionId)) {
    fail('pending plan claim transactionId has an invalid shape');
  }
  const claimedAt = assertCanonicalTimestamp(input.claimedAt, 'pending plan claimedAt');
  return {
    ...input.record,
    state: 'claimed',
    transactionId: input.transactionId,
    claimedAt,
  };
}

function validateFileIdentity(value, label) {
  assertExactKeys(value, ['device', 'inode', 'size', 'mtimeMs'], label);
  const mtimeMs = value.mtimeMs;
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) {
    fail(`${label}.mtimeMs must be a non-negative finite number`);
  }
  return {
    device: assertInteger(value.device, `${label}.device`),
    inode: assertInteger(value.inode, `${label}.inode`, { minimum: 1 }),
    size: assertInteger(value.size, `${label}.size`),
    mtimeMs,
  };
}

export function assertDotenvCasPrecondition(input) {
  assertExactKeys(input, [
    'expectedSha256',
    'expectedFileIdentity',
    'observedContents',
    'observedFileIdentity',
  ], 'dotenv CAS input');
  const expectedSha256 = assertSha256(input.expectedSha256, 'expected dotenv SHA-256');
  const expectedFileIdentity = validateFileIdentity(
    input.expectedFileIdentity,
    'expected dotenv file identity',
  );
  const observedContents = assertString(input.observedContents, 'observed dotenv contents');
  const observedFileIdentity = validateFileIdentity(
    input.observedFileIdentity,
    'observed dotenv file identity',
  );
  const observedSha256 = sha256(observedContents);
  const hashMatches = timingSafeEqual(
    Buffer.from(expectedSha256, 'hex'),
    Buffer.from(observedSha256, 'hex'),
  );
  if (!hashMatches
      || observedFileIdentity.size !== Buffer.byteLength(observedContents, 'utf8')
      || !equalCanonical(expectedFileIdentity, observedFileIdentity)) {
    fail('dotenv environment CAS precondition changed before mutation');
  }
  return true;
}

function selectExactPm2Process(rows, name, phase) {
  if (!Array.isArray(rows)) fail(`${phase} PM2 snapshot must be an array`);
  const matches = rows.filter((row) => row?.name === name);
  if (matches.length !== 1) fail(`${phase} PM2 snapshot must contain exactly one ${name} process`);
  return matches[0];
}

function validatePm2Identity(row, expected, label) {
  assertPlainObject(row, `${label} PM2 process`);
  const pid = assertInteger(row.pid, `${label} PID`, { minimum: 1 });
  const environment = assertPlainObject(row.pm2_env, `${label} PM2 environment`);
  const pmUptime = assertInteger(environment.pm_uptime, `${label} PM2 uptime`, { minimum: 1 });
  if (environment.status !== 'online'
      || environment.pm_cwd !== expected.cwd
      || environment.pm_exec_path !== expected.execPath
      || environment.NEXUS_RELEASE_ROLE !== expected.role
      || environment.NEXUS_RELEASE_SHA !== expected.runtimeSha
      || environment.NEXUS_RELEASE_ARTIFACT_SHA256 !== expected.artifactDigest) {
    fail(`${label} PM2 process identity is invalid`);
  }
  return { pid, pmUptime };
}

export function assertBackendOnlyPm2Transition(input) {
  assertExactKeys(input, [
    'before',
    'after',
    'role',
    'releaseDir',
    'runtimeSha',
    'artifactDigest',
    'backendName',
    'contentName',
  ], 'PM2 transition input');
  const role = assertOneOf(input.role, ROLE_VALUES, 'PM2 transition role');
  const releaseDir = assertString(input.releaseDir, 'PM2 transition releaseDir');
  const runtimeSha = assertRuntimeSha(input.runtimeSha, 'PM2 transition runtimeSha');
  const artifactDigest = assertArtifactDigest(input.artifactDigest, 'PM2 transition artifactDigest');
  const backendName = assertString(input.backendName, 'PM2 transition backendName');
  const contentName = assertString(input.contentName, 'PM2 transition contentName');
  const shared = { role, runtimeSha, artifactDigest };
  const backendExpected = {
    ...shared,
    cwd: releaseDir,
    execPath: `${releaseDir}/dist/index.js`,
  };
  const contentExpected = {
    ...shared,
    cwd: `${releaseDir}/content-engine`,
    execPath: '/usr/bin/python3.12',
  };
  const backendBefore = validatePm2Identity(
    selectExactPm2Process(input.before, backendName, 'before'),
    backendExpected,
    'before backend',
  );
  const backendAfter = validatePm2Identity(
    selectExactPm2Process(input.after, backendName, 'after'),
    backendExpected,
    'after backend',
  );
  const contentBefore = validatePm2Identity(
    selectExactPm2Process(input.before, contentName, 'before'),
    contentExpected,
    'before content',
  );
  const contentAfter = validatePm2Identity(
    selectExactPm2Process(input.after, contentName, 'after'),
    contentExpected,
    'after content',
  );
  if (backendAfter.pid === backendBefore.pid || backendAfter.pmUptime <= backendBefore.pmUptime) {
    fail('backend process was not recreated with a new PID and uptime');
  }
  if (contentAfter.pid !== contentBefore.pid || contentAfter.pmUptime !== contentBefore.pmUptime) {
    fail('content process changed during the backend-only transaction');
  }
  return {
    backendPidBefore: backendBefore.pid,
    backendPidAfter: backendAfter.pid,
    contentPidBefore: contentBefore.pid,
    contentPidAfter: contentAfter.pid,
  };
}

export function prepareDotenvRollbackRestoration(input) {
  assertExactKeys(input, [
    'currentContents',
    'expectedMutatedSha256',
    'preimageContents',
    'expectedPreimageSha256',
  ], 'dotenv rollback input');
  const currentContents = assertString(input.currentContents, 'rollback candidate contents');
  const preimageContents = assertString(input.preimageContents, 'rollback preimage contents');
  const expectedMutatedSha256 = assertSha256(
    input.expectedMutatedSha256,
    'expected mutated dotenv SHA-256',
  );
  const expectedPreimageSha256 = assertSha256(
    input.expectedPreimageSha256,
    'expected rollback preimage SHA-256',
  );
  const candidateMatches = timingSafeEqual(
    Buffer.from(sha256(currentContents), 'hex'),
    Buffer.from(expectedMutatedSha256, 'hex'),
  );
  const preimageMatches = timingSafeEqual(
    Buffer.from(sha256(preimageContents), 'hex'),
    Buffer.from(expectedPreimageSha256, 'hex'),
  );
  if (!candidateMatches) fail('rollback candidate changed after failed activation');
  if (!preimageMatches) fail('rollback preimage failed private integrity validation');
  return { restored: true, contents: preimageContents };
}

function validateHealth(health) {
  assertExactKeys(health, ['backend', 'content', 'identity'], 'receipt health');
  return Object.fromEntries(['backend', 'content', 'identity'].map((key) => [
    key,
    assertOneOf(health[key], ['passed', 'failed'], `receipt health.${key}`),
  ]));
}

function validateRollback(rollback) {
  assertExactKeys(rollback, ['status'], 'receipt rollback');
  return { status: assertOneOf(
    rollback.status,
    ['not_required', 'rolled_back', 'rollback_failed'],
    'receipt rollback.status',
  ) };
}

function receiptPlan(receipt) {
  return {
    schema: CHAT_CAPABILITY_FLAG_PLAN_SCHEMA,
    role: receipt.role,
    runtimeSha: receipt.runtimeSha,
    artifactDigest: receipt.artifactDigest,
    flag: receipt.flag,
    desiredValue: receipt.desiredValue,
    previousPlanSequence: receipt.previousPlanSequence,
    planSequence: receipt.planSequence,
    transitionReason: receipt.transitionReason,
    evidenceAttestation: receipt.evidenceAttestation,
    stagingPrerequisite: receipt.stagingPrerequisite,
    generatedAt: receipt.planGeneratedAt,
    configuredBefore: receipt.configuredBefore,
    configuredAfter: receipt.configuredAfter,
    effectiveBefore: receipt.effectiveBefore,
    effectiveAfter: receipt.effectiveAfter,
    changedFlags: receipt.changedFlags,
    planDigest: receipt.planDigest,
  };
}

export function validateCapabilityFlagReceipt(receipt) {
  assertExactKeys(receipt, RECEIPT_KEYS, 'receipt');
  if (receipt.schema !== CHAT_CAPABILITY_FLAG_RECEIPT_SCHEMA) fail('receipt schema is unsupported');
  if (typeof receipt.transactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-z]{12,64}$/u.test(receipt.transactionId)) {
    fail('receipt transactionId has an invalid shape');
  }
  validatePlan(receiptPlan(receipt));
  const startedAt = assertCanonicalTimestamp(receipt.startedAt, 'receipt.startedAt');
  const completedAt = assertCanonicalTimestamp(receipt.completedAt, 'receipt.completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) fail('receipt completedAt precedes startedAt');
  const status = assertOneOf(
    receipt.status,
    ['passed', 'failed', 'rolled_back', 'rollback_failed'],
    'receipt.status',
  );
  const health = validateHealth(receipt.health);
  const rollback = validateRollback(receipt.rollback);
  if (status === 'passed') {
    if (Object.values(health).some((value) => value !== 'passed') || rollback.status !== 'not_required') {
      fail('passed receipt requires all health checks passed and no rollback');
    }
  } else if (status === 'rolled_back' && rollback.status !== 'rolled_back') {
    fail('rolled_back receipt requires rolled_back rollback status');
  } else if (status === 'rollback_failed' && rollback.status !== 'rollback_failed') {
    fail('rollback_failed receipt requires rollback_failed rollback status');
  }
  return {
    ...receipt,
    configuredBefore: normalizeFlagState(receipt.configuredBefore, 'receipt.configuredBefore'),
    configuredAfter: normalizeFlagState(receipt.configuredAfter, 'receipt.configuredAfter'),
    effectiveBefore: normalizeFlagState(receipt.effectiveBefore, 'receipt.effectiveBefore'),
    effectiveAfter: normalizeFlagState(receipt.effectiveAfter, 'receipt.effectiveAfter'),
    changedFlags: [...receipt.changedFlags],
    health,
    rollback,
  };
}

export function buildCapabilityFlagReceipt(input) {
  assertExactKeys(input, BUILD_RECEIPT_INPUT_KEYS, 'receipt input');
  const plan = validatePlan(input.plan);
  const receipt = {
    schema: CHAT_CAPABILITY_FLAG_RECEIPT_SCHEMA,
    transactionId: input.transactionId,
    role: plan.role,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    planDigest: plan.planDigest,
    previousPlanSequence: plan.previousPlanSequence,
    planSequence: plan.planSequence,
    flag: plan.flag,
    desiredValue: plan.desiredValue,
    transitionReason: plan.transitionReason,
    evidenceAttestation: plan.evidenceAttestation,
    stagingPrerequisite: plan.stagingPrerequisite,
    planGeneratedAt: plan.generatedAt,
    configuredBefore: plan.configuredBefore,
    configuredAfter: plan.configuredAfter,
    effectiveBefore: plan.effectiveBefore,
    effectiveAfter: plan.effectiveAfter,
    changedFlags: plan.changedFlags,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    health: input.health,
    rollback: input.rollback,
  };
  return validateCapabilityFlagReceipt(receipt);
}

export const CHAT_CAPABILITY_SECRET_PLAN_SCHEMA = 'nexus.chat-capability-secret-plan.v1';
export const CHAT_CAPABILITY_SECRET_RECEIPT_SCHEMA = 'nexus.chat-capability-secret-transaction.v1';
export const CHAT_CAPABILITY_HMAC_NAMES = Object.freeze([
  'CLASSIFY_SHADOW_HASH_SECRET',
  'CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET',
]);

const CLASSIFIER_HMAC = CHAT_CAPABILITY_HMAC_NAMES[0];
const CHAT_V2_HMAC = CHAT_CAPABILITY_HMAC_NAMES[1];
const SECRET_PLAN_KEYS = Object.freeze([
  'schema',
  'role',
  'runtimeSha',
  'artifactDigest',
  'previousPlanSequence',
  'planSequence',
  'generatedAt',
  'policy',
  'presentBefore',
  'actions',
  'planDigest',
]);
const BUILD_SECRET_PLAN_INPUT_KEYS = Object.freeze([
  'role',
  'runtimeSha',
  'artifactDigest',
  'secretPresence',
  'previousPlanSequence',
  'generatedAt',
]);
const SECRET_RECEIPT_KEYS = Object.freeze([
  'schema',
  'transactionId',
  'role',
  'runtimeSha',
  'artifactDigest',
  'planDigest',
  'previousPlanSequence',
  'planSequence',
  'policy',
  'presentBefore',
  'actions',
  'planGeneratedAt',
  'startedAt',
  'completedAt',
  'status',
  'health',
  'rollback',
]);
const BUILD_SECRET_RECEIPT_INPUT_KEYS = Object.freeze([
  'plan',
  'transactionId',
  'status',
  'startedAt',
  'completedAt',
  'health',
  'rollback',
]);

function normalizeSecretPresence(value, label) {
  assertExactKeys(value, CHAT_CAPABILITY_HMAC_NAMES, label);
  return Object.fromEntries(CHAT_CAPABILITY_HMAC_NAMES.map((name) => [
    name,
    assertBoolean(value[name], `${label}.${name}`),
  ]));
}

function secretPolicy(role) {
  return {
    [CLASSIFIER_HMAC]: role === 'production' ? 'require_existing' : 'generate_if_missing',
    [CHAT_V2_HMAC]: 'generate_if_missing',
  };
}

function normalizeSecretPolicy(value, role, label) {
  assertExactKeys(value, CHAT_CAPABILITY_HMAC_NAMES, label);
  const expected = secretPolicy(role);
  for (const name of CHAT_CAPABILITY_HMAC_NAMES) {
    if (value[name] !== expected[name]) fail(`${label}.${name} does not match the role policy`);
  }
  return expected;
}

function secretActions(presentBefore) {
  return Object.fromEntries(CHAT_CAPABILITY_HMAC_NAMES.map((name) => [
    name,
    presentBefore[name] ? 'preserve' : 'generate',
  ]));
}

function normalizeSecretActions(value, presentBefore, label) {
  assertExactKeys(value, CHAT_CAPABILITY_HMAC_NAMES, label);
  const expected = secretActions(presentBefore);
  for (const name of CHAT_CAPABILITY_HMAC_NAMES) {
    if (value[name] !== expected[name]) fail(`${label}.${name} does not match inspected presence`);
  }
  return expected;
}

function secretPlanWithoutDigest(plan) {
  return Object.fromEntries(SECRET_PLAN_KEYS
    .filter((key) => key !== 'planDigest')
    .map((key) => [key, plan[key]]));
}

function computeSecretPlanDigest(plan) {
  return `sha256:${sha256(canonicalJson(secretPlanWithoutDigest(plan)))}`;
}

function validateSecretPlan(plan) {
  assertExactKeys(plan, SECRET_PLAN_KEYS, 'secret plan');
  if (plan.schema !== CHAT_CAPABILITY_SECRET_PLAN_SCHEMA) fail('secret plan schema is unsupported');
  const role = assertOneOf(plan.role, ROLE_VALUES, 'secret plan.role');
  assertRuntimeSha(plan.runtimeSha, 'secret plan.runtimeSha');
  assertArtifactDigest(plan.artifactDigest, 'secret plan.artifactDigest');
  const previousPlanSequence = assertInteger(
    plan.previousPlanSequence,
    'secret plan.previousPlanSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  if (plan.planSequence !== previousPlanSequence + 1) {
    fail('secret plan sequence must advance exactly once');
  }
  assertCanonicalTimestamp(plan.generatedAt, 'secret plan.generatedAt');
  const presentBefore = normalizeSecretPresence(plan.presentBefore, 'secret plan.presentBefore');
  if (role === 'production' && !presentBefore[CLASSIFIER_HMAC]) {
    fail(`production requires an existing ${CLASSIFIER_HMAC}`);
  }
  normalizeSecretPolicy(plan.policy, role, 'secret plan.policy');
  normalizeSecretActions(plan.actions, presentBefore, 'secret plan.actions');
  assertSha256(plan.planDigest, 'secret plan.planDigest', { prefixed: true });
  const expectedDigest = computeSecretPlanDigest(plan);
  if (!safeEqualDigest(plan.planDigest, expectedDigest)) {
    fail('secret plan digest does not match canonical plan bytes');
  }
  return plan;
}

export function buildCapabilitySecretPlan(input) {
  assertExactKeys(input, BUILD_SECRET_PLAN_INPUT_KEYS, 'secret plan input');
  const role = assertOneOf(input.role, ROLE_VALUES, 'secret plan role');
  const runtimeSha = assertRuntimeSha(input.runtimeSha, 'secret plan runtimeSha');
  const artifactDigest = assertArtifactDigest(
    input.artifactDigest,
    'secret plan artifactDigest',
  );
  const previousPlanSequence = assertInteger(
    input.previousPlanSequence,
    'secret plan previousPlanSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  const generatedAt = assertCanonicalTimestamp(input.generatedAt, 'secret plan generatedAt');
  const presentBefore = normalizeSecretPresence(input.secretPresence, 'secretPresence');
  if (role === 'production' && !presentBefore[CLASSIFIER_HMAC]) {
    fail(`production requires an existing ${CLASSIFIER_HMAC}`);
  }
  const plan = {
    schema: CHAT_CAPABILITY_SECRET_PLAN_SCHEMA,
    role,
    runtimeSha,
    artifactDigest,
    previousPlanSequence,
    planSequence: previousPlanSequence + 1,
    generatedAt,
    policy: secretPolicy(role),
    presentBefore,
    actions: secretActions(presentBefore),
  };
  return validateSecretPlan({ ...plan, planDigest: computeSecretPlanDigest(plan) });
}

function parseSecretAssignment(body) {
  const governed = CHAT_CAPABILITY_HMAC_NAMES
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('|');
  const assignment = body.match(
    new RegExp(`^\\s*(?:export[ \\t]+)?(${governed})[ \\t]*=(.*)$`, 'u'),
  );
  if (!assignment) return null;
  const value = assignment[2].trim();
  if (!/^[A-Za-z0-9+/_=-]{32,512}$/u.test(value)) {
    fail(`HMAC assignment for ${assignment[1]} must use a strong canonical literal`);
  }
  return {
    name: assignment[1],
    present: true,
  };
}

function readSecretAssignments(source) {
  const seen = new Map();
  let newline = '\n';
  const parsed = splitPreservingLineEndings(source).map((segment) => {
    const parts = lineParts(segment);
    if (parts.ending && newline === '\n') newline = parts.ending;
    const assignment = parseSecretAssignment(parts.body);
    if (assignment) {
      if (seen.has(assignment.name)) fail(`duplicate HMAC assignment for ${assignment.name}`);
      seen.set(assignment.name, assignment);
    }
    return { ...parts, assignment };
  });
  return { seen, parsed, newline };
}

export function readCapabilitySecretPresence(source) {
  assertString(source, 'dotenv source');
  const { seen } = readSecretAssignments(source);
  return Object.fromEntries(CHAT_CAPABILITY_HMAC_NAMES.map((name) => [
    name,
    seen.get(name)?.present ?? false,
  ]));
}

function validateGeneratedSecret(value, name) {
  assertString(value, `generated ${name}`);
  if (Buffer.byteLength(value, 'utf8') < 32 || /[\0\r\n]/u.test(value)) {
    fail(`generated ${name} does not satisfy the private HMAC policy`);
  }
  return value;
}

export function rewriteCapabilitySecretDotenv({ source, plan, generateSecret } = {}) {
  assertString(source, 'dotenv source');
  validateSecretPlan(plan);
  if (typeof generateSecret !== 'function') fail('generateSecret must be a function');
  const { seen, parsed, newline } = readSecretAssignments(source);
  const observedPresence = Object.fromEntries(CHAT_CAPABILITY_HMAC_NAMES.map((name) => [
    name,
    seen.get(name)?.present ?? false,
  ]));
  if (!equalCanonical(observedPresence, plan.presentBefore)) {
    fail('HMAC presence changed after the secret plan was inspected');
  }

  const generated = new Map();
  for (const name of CHAT_CAPABILITY_HMAC_NAMES) {
    if (plan.actions[name] === 'generate') {
      generated.set(name, validateGeneratedSecret(generateSecret(name), name));
    }
  }
  let contents = parsed.map(({ body, ending, assignment }) => {
    if (!assignment || plan.actions[assignment.name] === 'preserve') return `${body}${ending}`;
    return `${assignment.name}=${generated.get(assignment.name)}${ending}`;
  }).join('');
  const missingAssignments = CHAT_CAPABILITY_HMAC_NAMES.filter((name) => !seen.has(name));
  if (missingAssignments.length > 0) {
    if (contents.length > 0 && !/(?:\r\n|\n|\r)$/u.test(contents)) contents += newline;
    contents += missingAssignments
      .map((name) => `${name}=${generated.get(name)}${newline}`)
      .join('');
  }
  return { contents, actions: { ...plan.actions } };
}

function normalizeSecretHealth(value) {
  assertExactKeys(value, ['backend', 'identity'], 'secret receipt health');
  return Object.fromEntries(['backend', 'identity'].map((key) => [
    key,
    assertOneOf(value[key], ['passed', 'failed'], `secret receipt health.${key}`),
  ]));
}

function normalizeSecretRollback(value) {
  assertExactKeys(value, ['status'], 'secret receipt rollback');
  return {
    status: assertOneOf(
      value.status,
      ['not_required', 'rolled_back', 'rollback_failed'],
      'secret receipt rollback.status',
    ),
  };
}

export function validateCapabilitySecretReceipt(receipt) {
  assertExactKeys(receipt, SECRET_RECEIPT_KEYS, 'secret receipt');
  if (receipt.schema !== CHAT_CAPABILITY_SECRET_RECEIPT_SCHEMA) {
    fail('secret receipt schema is unsupported');
  }
  if (typeof receipt.transactionId !== 'string'
      || !/^\d{8}T\d{6}Z-[0-9a-z]{12,64}$/u.test(receipt.transactionId)) {
    fail('secret receipt transactionId has an invalid shape');
  }
  const role = assertOneOf(receipt.role, ROLE_VALUES, 'secret receipt.role');
  assertRuntimeSha(receipt.runtimeSha, 'secret receipt.runtimeSha');
  assertArtifactDigest(receipt.artifactDigest, 'secret receipt.artifactDigest');
  assertSha256(receipt.planDigest, 'secret receipt.planDigest', { prefixed: true });
  const previousPlanSequence = assertInteger(
    receipt.previousPlanSequence,
    'secret receipt.previousPlanSequence',
    { maximum: Number.MAX_SAFE_INTEGER - 1 },
  );
  if (receipt.planSequence !== previousPlanSequence + 1) {
    fail('secret receipt plan sequence must advance exactly once');
  }
  assertCanonicalTimestamp(receipt.planGeneratedAt, 'secret receipt.planGeneratedAt');
  const startedAt = assertCanonicalTimestamp(receipt.startedAt, 'secret receipt.startedAt');
  const completedAt = assertCanonicalTimestamp(receipt.completedAt, 'secret receipt.completedAt');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    fail('secret receipt completedAt precedes startedAt');
  }
  const policy = normalizeSecretPolicy(receipt.policy, role, 'secret receipt.policy');
  const presentBefore = normalizeSecretPresence(
    receipt.presentBefore,
    'secret receipt.presentBefore',
  );
  const actions = normalizeSecretActions(
    receipt.actions,
    presentBefore,
    'secret receipt.actions',
  );
  validateSecretPlan({
    schema: CHAT_CAPABILITY_SECRET_PLAN_SCHEMA,
    role,
    runtimeSha: receipt.runtimeSha,
    artifactDigest: receipt.artifactDigest,
    previousPlanSequence,
    planSequence: receipt.planSequence,
    generatedAt: receipt.planGeneratedAt,
    policy,
    presentBefore,
    actions,
    planDigest: receipt.planDigest,
  });
  if (role === 'production' && actions[CLASSIFIER_HMAC] !== 'preserve') {
    fail(`production secret receipt must preserve ${CLASSIFIER_HMAC}`);
  }
  const status = assertOneOf(
    receipt.status,
    ['passed', 'failed', 'rolled_back', 'rollback_failed'],
    'secret receipt.status',
  );
  const health = normalizeSecretHealth(receipt.health);
  const rollback = normalizeSecretRollback(receipt.rollback);
  if (status === 'passed') {
    if (Object.values(health).some((value) => value !== 'passed')
        || rollback.status !== 'not_required') {
      fail('passed secret receipt requires passed health and no rollback');
    }
  } else if (status === 'rolled_back' && rollback.status !== 'rolled_back') {
    fail('rolled_back secret receipt requires rolled_back rollback status');
  } else if (status === 'rollback_failed' && rollback.status !== 'rollback_failed') {
    fail('rollback_failed secret receipt requires rollback_failed rollback status');
  }
  return { ...receipt, policy, presentBefore, actions, health, rollback };
}

export function buildCapabilitySecretReceipt(input) {
  assertExactKeys(input, BUILD_SECRET_RECEIPT_INPUT_KEYS, 'secret receipt input');
  const plan = validateSecretPlan(input.plan);
  return validateCapabilitySecretReceipt({
    schema: CHAT_CAPABILITY_SECRET_RECEIPT_SCHEMA,
    transactionId: input.transactionId,
    role: plan.role,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    planDigest: plan.planDigest,
    previousPlanSequence: plan.previousPlanSequence,
    planSequence: plan.planSequence,
    policy: plan.policy,
    presentBefore: plan.presentBefore,
    actions: plan.actions,
    planGeneratedAt: plan.generatedAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    health: input.health,
    rollback: input.rollback,
  });
}

function readPrivateRegularFile(filePath, label) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symbolic file`);
  return {
    contents: readFileSync(filePath, 'utf8'),
    identity: {
      device: stat.dev,
      inode: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    },
  };
}

function sameFileIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function writePrivateFileExclusive(filePath, contents) {
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(filePath, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (created) unlinkIfPresent(filePath);
    throw error;
  }
}

function fsyncParentDirectory(filePath) {
  const descriptor = openSync(dirname(filePath), 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function unlinkIfPresent(filePath) {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function assertFileStillMatches(filePath, expectedContents, expectedIdentity, label) {
  const observed = readPrivateRegularFile(filePath, label);
  if (observed.contents !== expectedContents
      || !sameFileIdentity(observed.identity, expectedIdentity)) {
    fail(`${label} changed during compare-and-swap`);
  }
}

export function replaceCapabilitySecretDotenvFile({
  filePath,
  backupPath,
  expectedContents,
  nextContents,
  temporarySuffix = String(process.pid),
} = {}) {
  assertString(filePath, 'dotenv filePath');
  assertString(backupPath, 'dotenv backupPath');
  assertString(expectedContents, 'dotenv expectedContents');
  assertString(nextContents, 'dotenv nextContents');
  if (typeof temporarySuffix !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/u.test(temporarySuffix)) {
    fail('dotenv temporarySuffix has an invalid shape');
  }
  const before = readPrivateRegularFile(filePath, 'dotenv candidate');
  if (before.contents !== expectedContents) fail('dotenv compare-and-swap precondition is stale');
  const temporaryPath = `${filePath}.next-${temporarySuffix}`;
  writePrivateFileExclusive(backupPath, before.contents);
  fsyncParentDirectory(backupPath);
  let temporaryCreated = false;
  let replaced = false;
  try {
    writePrivateFileExclusive(temporaryPath, nextContents);
    temporaryCreated = true;
    assertFileStillMatches(filePath, expectedContents, before.identity, 'dotenv candidate');
    renameSync(temporaryPath, filePath);
    temporaryCreated = false;
    replaced = true;
    chmodSync(filePath, 0o600);
    fsyncParentDirectory(filePath);
  } catch (error) {
    if (temporaryCreated) unlinkIfPresent(temporaryPath);
    if (!replaced) unlinkIfPresent(backupPath);
    throw error;
  }
  const installed = readPrivateRegularFile(filePath, 'installed dotenv');
  if (installed.contents !== nextContents) fail('installed dotenv failed atomic postcondition');
  return { replaced: true };
}

export function restoreCapabilitySecretDotenvFile({
  filePath,
  backupPath,
  expectedContents,
} = {}) {
  assertString(filePath, 'dotenv filePath');
  assertString(backupPath, 'dotenv backupPath');
  assertString(expectedContents, 'dotenv expectedContents');
  const candidate = readPrivateRegularFile(filePath, 'dotenv rollback candidate');
  if (candidate.contents !== expectedContents) fail('dotenv restore compare-and-swap is stale');
  const backup = readPrivateRegularFile(backupPath, 'dotenv rollback backup');
  const temporaryPath = `${filePath}.next-${process.pid}`;
  let temporaryCreated = false;
  try {
    writePrivateFileExclusive(temporaryPath, backup.contents);
    temporaryCreated = true;
    assertFileStillMatches(filePath, expectedContents, candidate.identity, 'dotenv rollback candidate');
    renameSync(temporaryPath, filePath);
    temporaryCreated = false;
    chmodSync(filePath, 0o600);
    fsyncParentDirectory(filePath);
  } catch (error) {
    if (temporaryCreated) unlinkIfPresent(temporaryPath);
    throw error;
  }
  const restored = readPrivateRegularFile(filePath, 'restored dotenv');
  if (restored.contents !== backup.contents) fail('restored dotenv failed atomic postcondition');
  return { restored: true };
}
