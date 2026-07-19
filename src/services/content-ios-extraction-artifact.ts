// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import {
  contentEvalHmacSha256,
  contentEvalSha256,
  contentLiveEvalAttestationKeyFingerprint,
} from './content-live-evaluation-artifact';

export const CONTENT_IOS_EXTRACTION_SCHEMA_VERSION = 'nexus.content-ios-extraction.v1' as const;
export const CONTENT_IOS_EXTRACTION_SOURCE = 'xcodebuild-content-ui-tests' as const;
export const CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS = 'content-workspace-critical-user' as const;
export const CONTENT_IOS_EXTRACTION_FIXTURE_VERSION = '2026-07-19.v2' as const;
export const CONTENT_IOS_TEST_EVIDENCE_SCHEMA_VERSION = 'nexus.content-ios-test-evidence.v2' as const;
export const CONTENT_IOS_TEST_EVIDENCE_ATTACHMENT_NAME = 'nexus-content-eval-v2.json' as const;
export const CONTENT_IOS_EXTRACTION_SCHEME = 'Nexus Hub Debug UI Smoke' as const;
export const CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION = 'Debug' as const;
export const CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE = 'behavioral_not_archive_equivalence' as const;
export const CONTENT_IOS_EXTRACTION_SUMMARY_TITLE = `Test - ${CONTENT_IOS_EXTRACTION_SCHEME}` as const;
export const CONTENT_IOS_EXTRACTION_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS = Object.freeze([
  'ContentCreationLiveWorkflowUITests/test_contentAgencyFixtureOutputIsActionableCleanAndExtractable',
  'ContentCreationLiveWorkflowUITests/test_contentScriptFixtureOutputIsActionableCleanAndExtractable',
  'ContentStudioQuickCaptureUITests/test_offlineSubmitParksDraftInVisibleOutbox',
  'ContentStudioQuickCaptureUITests/test_cancelWithTextKeepsVisibleDraft',
  'ContentStudioPipelineUITests/test_workspaceStatusAndNextActionRenderBackendTruth',
] as const);

export const CONTENT_IOS_EXTRACTION_METRIC_CONTRACT = Object.freeze({
  expectedVisibleSignals: 29,
  forbiddenSignalsChecked: 13,
  actionableControlsExpected: 7,
  recoveryAssertionsExpected: 7,
});

export type ContentIosEvidenceCheckKind =
  | 'required_visible_signal'
  | 'forbidden_absent'
  | 'actionable_control'
  | 'recovery';

interface ContentIosExpectedEvidenceCheck {
  id: string;
  kind: ContentIosEvidenceCheckKind;
}

function expectedChecks(
  kind: ContentIosEvidenceCheckKind,
  ids: readonly string[],
): ContentIosExpectedEvidenceCheck[] {
  return ids.map((id) => ({ id, kind }));
}

export const CONTENT_IOS_TEST_EVIDENCE_CONTRACT: Readonly<Record<string, readonly ContentIosExpectedEvidenceCheck[]>> = Object.freeze({
  [CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS[0]]: Object.freeze([
    ...expectedChecks('required_visible_signal', [
      'agency.visible.summary',
      'agency.visible.audience-positioning',
      'agency.visible.competitor-study',
      'agency.visible.transcript-study',
      'agency.visible.hook-bank',
      'agency.visible.script-studio',
      'agency.visible.creative-direction',
      'agency.visible.compliance-review',
      'agency.visible.experiment-plan',
      'agency.visible.performance-diagnosis',
      'agency.visible.pipeline-handoff',
      'agency.visible.retention-diagnosis',
      'agency.visible.proof-first-opener',
      'agency.visible.hold-rate-and-shares',
      'agency.visible.recommended-test',
      'agency.visible.metrics-to-watch',
      'agency.visible.originality-constraints',
    ]),
    ...expectedChecks('forbidden_absent', [
      'agency.forbidden.system-prompt',
      'agency.forbidden.json-fence',
      'agency.forbidden.coach-recs-marker',
      'agency.forbidden.internal-id',
      'agency.forbidden.viral-guarantee',
      'agency.forbidden.prompt-injection',
      'agency.forbidden.raw-item-cast',
    ]),
    ...expectedChecks('actionable_control', [
      'agency.action.approve-enabled',
      'agency.action.move-to-pipeline-visible',
    ]),
  ]),
  [CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS[1]]: Object.freeze([
    ...expectedChecks('required_visible_signal', [
      'script.visible.quality',
      'script.visible.overall-score',
      'script.visible.film-edit-guidance',
      'script.visible.first-frame',
      'script.visible.proof-object',
      'script.visible.draft-pack',
      'script.visible.first-three-seconds',
      'script.visible.timing-marker',
      'script.visible.visual-direction',
      'script.visible.save-and-test-cta',
    ]),
    ...expectedChecks('forbidden_absent', [
      'script.forbidden.system-prompt',
      'script.forbidden.json-fence',
      'script.forbidden.raw-provider-output',
      'script.forbidden.internal-id',
      'script.forbidden.viral-guarantee',
      'script.forbidden.copy-this-exact',
    ]),
    ...expectedChecks('actionable_control', ['script.action.save-library-visible']),
  ]),
  [CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS[2]]: Object.freeze([
    ...expectedChecks('actionable_control', [
      'capture.action.submit',
      'capture.action.retry',
    ]),
    ...expectedChecks('recovery', [
      'capture.recovery.failure-visible',
      'capture.recovery.outbox-durable-after-relaunch',
      'capture.recovery.retry-reuses-idempotency-key',
      'capture.recovery.retry-creates-one-authoritative-item',
    ]),
  ]),
  [CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS[3]]: Object.freeze([
    ...expectedChecks('actionable_control', ['capture.action.cancel']),
    ...expectedChecks('recovery', ['capture.recovery.cancel-preserves-visible-draft']),
  ]),
  [CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS[4]]: Object.freeze([
    ...expectedChecks('required_visible_signal', [
      'workspace.visible.status',
      'workspace.visible.next-action',
    ]),
    ...expectedChecks('actionable_control', ['workspace.action.next-action-control']),
    ...expectedChecks('recovery', [
      'workspace.recovery.status-matches-backend',
      'workspace.recovery.next-action-matches-backend',
    ]),
  ]),
});

export type ContentIosExtractionTestStatus = 'passed' | 'failed' | 'skipped';

export interface ContentIosExtractionBuildIdentity {
  gitCommit: string;
  sourceTreeDigest: string;
  scheme: typeof CONTENT_IOS_EXTRACTION_SCHEME;
  buildConfiguration: typeof CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION;
  evidenceScope: typeof CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE;
}

export interface ContentIosExtractionArtifact {
  schemaVersion: typeof CONTENT_IOS_EXTRACTION_SCHEMA_VERSION;
  runId: string;
  source: typeof CONTENT_IOS_EXTRACTION_SOURCE;
  generatedAt: string;
  iosSource: ContentIosExtractionBuildIdentity;
  resultBundle: {
    xcresultDigest: string;
    testsDigest: string;
    summaryDigest: string;
    attachmentsDigest: string;
  };
  fixture: {
    corpus: typeof CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS;
    version: typeof CONTENT_IOS_EXTRACTION_FIXTURE_VERSION;
  };
  tests: Array<{
    identifier: string;
    status: ContentIosExtractionTestStatus;
    durationMs: number;
  }>;
  summary: {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    skippedCount: number;
  };
  metrics: {
    expectedVisibleSignals: number;
    matchedVisibleSignals: number;
    forbiddenSignalsChecked: number;
    forbiddenSignalsFound: number;
    actionableControlsExpected: number;
    actionableControlsFound: number;
    recoveryAssertionsExpected: number;
    recoveryAssertionsPassed: number;
    rawInternalLeaks: number;
  };
  score: number;
  bindingDigest: string;
  attestation: {
    algorithm: 'HMAC-SHA256';
    keyFingerprint: string;
    mac: string;
  };
}

export interface ContentIosExtractionValidationOptions {
  attestationKey: Buffer;
  trustedAttestationKeyFingerprint: string;
  expectedIosGitCommit: string;
  expectedIosSourceTreeDigest: string;
  now?: Date;
}

export interface ContentIosExtractionValidation {
  valid: boolean;
  releaseQualified?: boolean;
  artifact?: ContentIosExtractionArtifact;
  reason?: string;
}

const releaseQualifiedArtifacts = new WeakMap<object, string>();

interface XcresultTestNode {
  nodeIdentifier?: unknown;
  nodeType?: unknown;
  name?: unknown;
  result?: unknown;
  durationInSeconds?: unknown;
  children?: unknown;
}

interface DerivedXcresultEvidence {
  generatedAt: string;
  tests: ContentIosExtractionArtifact['tests'];
  metrics: ContentIosExtractionArtifact['metrics'];
}

interface ContentIosTestEvidenceAttachment {
  schemaVersion: typeof CONTENT_IOS_TEST_EVIDENCE_SCHEMA_VERSION;
  corpus: typeof CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS;
  fixtureVersion: typeof CONTENT_IOS_EXTRACTION_FIXTURE_VERSION;
  testIdentifier: string;
  buildIdentity: ContentIosExtractionBuildIdentity;
  checks: Array<{
    id: string;
    kind: ContentIosEvidenceCheckKind;
    passed: boolean;
  }>;
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === [...expected].sort()[index]);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function expectedSummary(tests: ContentIosExtractionArtifact['tests']): ContentIosExtractionArtifact['summary'] {
  return {
    totalCount: tests.length,
    passedCount: tests.filter((test) => test.status === 'passed').length,
    failedCount: tests.filter((test) => test.status === 'failed').length,
    skippedCount: tests.filter((test) => test.status === 'skipped').length,
  };
}

export function normalizeContentIosTestIdentifier(value: string): string {
  return value
    .replace(/^test:\/\//, '')
    .replace(/\(\)$/, '')
    .replace(/^.*?Nexus(?:%20| )HubUITests\//, '')
    .replace(/^Nexus(?:%20| )HubUITests\//, '');
}

function testIdentifierMatches(
  requiredIdentifier: string,
  node: XcresultTestNode,
  suiteNames: readonly string[],
): boolean {
  const required = normalizeContentIosTestIdentifier(requiredIdentifier);
  const nodeIdentifier = typeof node.nodeIdentifier === 'string'
    ? normalizeContentIosTestIdentifier(node.nodeIdentifier)
    : '';
  if (nodeIdentifier === required || nodeIdentifier.endsWith(`/${required}`)) return true;

  const [requiredSuite, requiredTest] = required.split('/');
  const nodeName = typeof node.name === 'string' ? normalizeContentIosTestIdentifier(node.name) : '';
  return nodeName === requiredTest
    && suiteNames.some((suiteName) => normalizeContentIosTestIdentifier(suiteName) === requiredSuite);
}

function mapXcresultStatus(value: unknown): ContentIosExtractionTestStatus {
  if (value === 'Passed') return 'passed';
  if (value === 'Skipped') return 'skipped';
  return 'failed';
}

function parseEvidenceAttachments(
  value: unknown,
  expectedBuildIdentity: ContentIosExtractionArtifact['iosSource'],
): ContentIosTestEvidenceAttachment[] {
  if (!Array.isArray(value) || value.length !== CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.length) {
    throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_SET_INCOMPLETE');
  }
  return CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.map((requiredIdentifier, index) => {
    const attachment = value[index] as ContentIosTestEvidenceAttachment;
    if (!exactKeys(attachment, ['schemaVersion', 'corpus', 'fixtureVersion', 'testIdentifier', 'buildIdentity', 'checks'])) {
      throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_SHAPE_INVALID');
    }
    if (
      attachment.schemaVersion !== CONTENT_IOS_TEST_EVIDENCE_SCHEMA_VERSION
      || attachment.corpus !== CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS
      || attachment.fixtureVersion !== CONTENT_IOS_EXTRACTION_FIXTURE_VERSION
      || attachment.testIdentifier !== requiredIdentifier
    ) throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_CONTRACT_MISMATCH');
    if (
      !exactKeys(attachment.buildIdentity, [
        'gitCommit', 'sourceTreeDigest', 'scheme', 'buildConfiguration', 'evidenceScope',
      ])
      || !/^[a-f0-9]{40}$/.test(attachment.buildIdentity.gitCommit)
      || !validDigest(attachment.buildIdentity.sourceTreeDigest)
      || attachment.buildIdentity.gitCommit !== expectedBuildIdentity.gitCommit
      || attachment.buildIdentity.sourceTreeDigest !== expectedBuildIdentity.sourceTreeDigest
      || attachment.buildIdentity.scheme !== CONTENT_IOS_EXTRACTION_SCHEME
      || attachment.buildIdentity.buildConfiguration !== CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION
      || attachment.buildIdentity.evidenceScope !== CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE
    ) throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_BUILD_IDENTITY_MISMATCH');
    const expected = CONTENT_IOS_TEST_EVIDENCE_CONTRACT[requiredIdentifier];
    if (!Array.isArray(attachment.checks) || attachment.checks.length !== expected.length) {
      throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_CHECK_SET_INCOMPLETE');
    }
    for (let checkIndex = 0; checkIndex < expected.length; checkIndex += 1) {
      const check = attachment.checks[checkIndex];
      const expectedCheck = expected[checkIndex];
      if (!exactKeys(check, ['id', 'kind', 'passed'])) {
        throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_CHECK_SHAPE_INVALID');
      }
      if (check.id !== expectedCheck.id || check.kind !== expectedCheck.kind) {
        throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_CHECK_CONTRACT_MISMATCH');
      }
      if (check.passed !== true) throw new Error('CONTENT_IOS_EXTRACTION_ATTACHMENT_CHECK_FAILED');
    }
    return attachment;
  });
}

function deriveMetrics(attachments: readonly ContentIosTestEvidenceAttachment[]): ContentIosExtractionArtifact['metrics'] {
  const checks = attachments.flatMap((attachment) => attachment.checks);
  const countPassed = (kind: ContentIosEvidenceCheckKind) => checks.filter((check) => check.kind === kind && check.passed).length;
  return {
    ...CONTENT_IOS_EXTRACTION_METRIC_CONTRACT,
    matchedVisibleSignals: countPassed('required_visible_signal'),
    forbiddenSignalsFound: checks.filter((check) => check.kind === 'forbidden_absent' && !check.passed).length,
    actionableControlsFound: countPassed('actionable_control'),
    recoveryAssertionsPassed: countPassed('recovery'),
    rawInternalLeaks: checks.filter((check) => check.kind === 'forbidden_absent' && !check.passed).length,
  };
}

/**
 * Parse Apple `xcresulttool get test-results` documents and derive the fixed
 * Content UI evidence contract. Production callers must use the executable
 * producer, which obtains these documents directly from the `.xcresult`.
 */
export function deriveContentIosExtractionEvidenceFromXcresult(
  testsDocument: unknown,
  summaryDocument: unknown,
  attachmentsDocument: unknown,
  expectedBuildIdentity: ContentIosExtractionArtifact['iosSource'],
): DerivedXcresultEvidence {
  if (!testsDocument || typeof testsDocument !== 'object' || Array.isArray(testsDocument)) {
    throw new Error('CONTENT_IOS_EXTRACTION_TESTS_DOCUMENT_INVALID');
  }
  if (!summaryDocument || typeof summaryDocument !== 'object' || Array.isArray(summaryDocument)) {
    throw new Error('CONTENT_IOS_EXTRACTION_SUMMARY_DOCUMENT_INVALID');
  }
  const summary = summaryDocument as Record<string, unknown>;
  const expectedCount = CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.length;
  if (summary.title !== CONTENT_IOS_EXTRACTION_SUMMARY_TITLE) {
    throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_EXECUTION_CONTEXT_MISMATCH');
  }
  if (
    summary.result !== 'Passed'
    || summary.totalTestCount !== expectedCount
    || summary.passedTests !== expectedCount
    || summary.failedTests !== 0
    || summary.skippedTests !== 0
    || summary.expectedFailures !== 0
  ) {
    throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_NOT_CLEAN');
  }
  if (typeof summary.finishTime !== 'number' || !Number.isFinite(summary.finishTime) || summary.finishTime <= 0) {
    throw new Error('CONTENT_IOS_EXTRACTION_FINISH_TIME_MISSING');
  }

  const rootNodes = (testsDocument as Record<string, unknown>).testNodes;
  if (!Array.isArray(rootNodes)) throw new Error('CONTENT_IOS_EXTRACTION_TEST_NODES_MISSING');
  const matches = new Map<string, ContentIosExtractionArtifact['tests'][number]>();

  const visit = (value: unknown, suiteNames: readonly string[]): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as XcresultTestNode;
    const name = typeof node.name === 'string' ? node.name : '';
    const nextSuiteNames = node.nodeType === 'Test Suite' && name
      ? [...suiteNames, name]
      : suiteNames;
    if (node.nodeType === 'Test Case') {
      for (const requiredIdentifier of CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS) {
        if (!testIdentifierMatches(requiredIdentifier, node, nextSuiteNames)) continue;
        if (matches.has(requiredIdentifier)) throw new Error('CONTENT_IOS_EXTRACTION_DUPLICATE_TEST');
        const durationSeconds = node.durationInSeconds;
        if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
          throw new Error('CONTENT_IOS_EXTRACTION_TEST_DURATION_INVALID');
        }
        matches.set(requiredIdentifier, {
          identifier: requiredIdentifier,
          status: mapXcresultStatus(node.result),
          durationMs: Math.round(durationSeconds * 1_000),
        });
      }
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child, nextSuiteNames);
    }
  };
  for (const node of rootNodes) visit(node, []);

  const tests = CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.map((identifier) => matches.get(identifier));
  if (tests.some((test) => !test)) throw new Error('CONTENT_IOS_EXTRACTION_REQUIRED_TEST_MISSING');
  const completeTests = tests as ContentIosExtractionArtifact['tests'];
  if (completeTests.some((test) => test.status !== 'passed')) {
    throw new Error('CONTENT_IOS_EXTRACTION_REQUIRED_TEST_FAILED');
  }
  const attachments = parseEvidenceAttachments(attachmentsDocument, expectedBuildIdentity);
  return {
    generatedAt: new Date(summary.finishTime * 1_000).toISOString(),
    tests: completeTests,
    metrics: deriveMetrics(attachments),
  };
}

export function deriveContentIosExtractionScore(
  metrics: ContentIosExtractionArtifact['metrics'],
): number {
  if (metrics.forbiddenSignalsFound > 0 || metrics.rawInternalLeaks > 0) return 0;
  const visible = metrics.matchedVisibleSignals / Math.max(metrics.expectedVisibleSignals, 1);
  const actions = metrics.actionableControlsFound / Math.max(metrics.actionableControlsExpected, 1);
  const recovery = metrics.recoveryAssertionsPassed / Math.max(metrics.recoveryAssertionsExpected, 1);
  return Math.max(0, Math.min(100, Math.round(100 * (0.4 * visible + 0.3 * actions + 0.3 * recovery))));
}

export function createContentIosExtractionArtifactFromXcresultDocuments(input: {
  testsJson: string;
  summaryJson: string;
  attachmentsJson: string;
  iosGitCommit: string;
  iosSourceTreeDigest: string;
  xcresultDigest: string;
  attestationKey: Buffer;
}): ContentIosExtractionArtifact {
  let testsDocument: unknown;
  let summaryDocument: unknown;
  let attachmentsDocument: unknown;
  try {
    testsDocument = JSON.parse(input.testsJson) as unknown;
    summaryDocument = JSON.parse(input.summaryJson) as unknown;
    attachmentsDocument = JSON.parse(input.attachmentsJson) as unknown;
  } catch {
    throw new Error('CONTENT_IOS_EXTRACTION_XCRESULT_JSON_INVALID');
  }
  const expectedBuildIdentity = {
    gitCommit: input.iosGitCommit,
    sourceTreeDigest: input.iosSourceTreeDigest,
    scheme: CONTENT_IOS_EXTRACTION_SCHEME,
    buildConfiguration: CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION,
    evidenceScope: CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE,
  } satisfies ContentIosExtractionBuildIdentity;
  const evidence = deriveContentIosExtractionEvidenceFromXcresult(
    testsDocument,
    summaryDocument,
    attachmentsDocument,
    expectedBuildIdentity,
  );
  const testsDigest = crypto.createHash('sha256').update(input.testsJson).digest('hex');
  const summaryDigest = crypto.createHash('sha256').update(input.summaryJson).digest('hex');
  const attachmentsDigest = crypto.createHash('sha256').update(input.attachmentsJson).digest('hex');
  const runIdSeed = contentEvalSha256({
    schemaVersion: CONTENT_IOS_EXTRACTION_SCHEMA_VERSION,
    fixtureCorpus: CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS,
    fixtureVersion: CONTENT_IOS_EXTRACTION_FIXTURE_VERSION,
    generatedAt: evidence.generatedAt,
    iosSource: expectedBuildIdentity,
    xcresultDigest: input.xcresultDigest,
    testsDigest,
    summaryDigest,
    attachmentsDigest,
    tests: evidence.tests,
    metrics: evidence.metrics,
  });
  const runId = `content-ios-extraction-${runIdSeed.slice(0, 24)}`;
  const withoutBinding = {
    schemaVersion: CONTENT_IOS_EXTRACTION_SCHEMA_VERSION,
    runId,
    source: CONTENT_IOS_EXTRACTION_SOURCE,
    generatedAt: evidence.generatedAt,
    iosSource: structuredClone(expectedBuildIdentity),
    resultBundle: {
      xcresultDigest: input.xcresultDigest,
      testsDigest,
      summaryDigest,
      attachmentsDigest,
    },
    fixture: {
      corpus: CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS,
      version: CONTENT_IOS_EXTRACTION_FIXTURE_VERSION,
    },
    tests: structuredClone(evidence.tests),
    summary: expectedSummary(evidence.tests),
    metrics: structuredClone(evidence.metrics),
    score: deriveContentIosExtractionScore(evidence.metrics),
  };
  const bindingDigest = contentEvalSha256(withoutBinding);
  const signed = {
    ...withoutBinding,
    bindingDigest,
    attestation: {
      algorithm: 'HMAC-SHA256' as const,
      keyFingerprint: contentLiveEvalAttestationKeyFingerprint(input.attestationKey),
      mac: '',
    },
  };
  const { attestation: _attestation, ...signedPayload } = signed;
  signed.attestation.mac = contentEvalHmacSha256(input.attestationKey, signedPayload);
  return signed;
}

export function validateContentIosExtractionArtifact(
  value: unknown,
  options: ContentIosExtractionValidationOptions,
): ContentIosExtractionValidation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false, reason: 'invalid_artifact' };
  const artifact = value as ContentIosExtractionArtifact;
  if (!exactKeys(artifact, [
    'schemaVersion', 'runId', 'source', 'generatedAt', 'iosSource', 'resultBundle',
    'fixture', 'tests', 'summary', 'metrics', 'score', 'bindingDigest', 'attestation',
  ])) return { valid: false, reason: 'unknown_artifact_field' };
  if (artifact.schemaVersion !== CONTENT_IOS_EXTRACTION_SCHEMA_VERSION || artifact.source !== CONTENT_IOS_EXTRACTION_SOURCE) return { valid: false, reason: 'invalid_contract' };
  if (typeof artifact.runId !== 'string' || !/^content-ios-extraction-[a-z0-9._:-]{8,120}$/i.test(artifact.runId)) return { valid: false, reason: 'invalid_run_id' };
  const generatedAt = Date.parse(artifact.generatedAt);
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(generatedAt) || generatedAt > now + 120_000 || now - generatedAt > CONTENT_IOS_EXTRACTION_MAX_AGE_MS) return { valid: false, reason: 'stale_or_future_artifact' };
  if (!exactKeys(artifact.iosSource, [
    'gitCommit', 'sourceTreeDigest', 'scheme', 'buildConfiguration', 'evidenceScope',
  ])) return { valid: false, reason: 'invalid_source_shape' };
  if (
    artifact.iosSource.scheme !== CONTENT_IOS_EXTRACTION_SCHEME
    || artifact.iosSource.buildConfiguration !== CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION
    || artifact.iosSource.evidenceScope !== CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE
  ) return { valid: false, reason: 'unsupported_test_execution_context' };
  if (!/^[a-f0-9]{40}$/.test(artifact.iosSource.gitCommit) || artifact.iosSource.gitCommit !== options.expectedIosGitCommit) return { valid: false, reason: 'ios_source_commit_mismatch' };
  if (!validDigest(artifact.iosSource.sourceTreeDigest) || artifact.iosSource.sourceTreeDigest !== options.expectedIosSourceTreeDigest) return { valid: false, reason: 'ios_source_tree_mismatch' };
  if (!exactKeys(artifact.resultBundle, ['xcresultDigest', 'testsDigest', 'summaryDigest', 'attachmentsDigest']) || !validDigest(artifact.resultBundle.xcresultDigest) || !validDigest(artifact.resultBundle.testsDigest) || !validDigest(artifact.resultBundle.summaryDigest) || !validDigest(artifact.resultBundle.attachmentsDigest)) return { valid: false, reason: 'invalid_result_digest' };
  if (!exactKeys(artifact.fixture, ['corpus', 'version']) || artifact.fixture.corpus !== CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS || artifact.fixture.version !== CONTENT_IOS_EXTRACTION_FIXTURE_VERSION) return { valid: false, reason: 'fixture_contract_mismatch' };
  if (!Array.isArray(artifact.tests) || artifact.tests.length !== CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.length) return { valid: false, reason: 'partial_test_set' };
  for (let index = 0; index < artifact.tests.length; index++) {
    const test = artifact.tests[index];
    if (!exactKeys(test, ['identifier', 'status', 'durationMs'])) return { valid: false, reason: 'invalid_test_shape' };
    if (test.identifier !== CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS[index]) return { valid: false, reason: 'test_identifier_mismatch' };
    if (!['passed', 'failed', 'skipped'].includes(test.status) || !Number.isFinite(test.durationMs) || test.durationMs < 0) return { valid: false, reason: 'invalid_test_result' };
  }
  if (!exactKeys(artifact.summary, ['totalCount', 'passedCount', 'failedCount', 'skippedCount']) || contentEvalSha256(artifact.summary) !== contentEvalSha256(expectedSummary(artifact.tests))) return { valid: false, reason: 'summary_mismatch' };
  if (artifact.summary.failedCount !== 0 || artifact.summary.skippedCount !== 0 || artifact.summary.passedCount !== CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.length) return { valid: false, reason: 'tests_not_clean' };
  if (!exactKeys(artifact.metrics, [
    'expectedVisibleSignals', 'matchedVisibleSignals', 'forbiddenSignalsChecked',
    'forbiddenSignalsFound', 'actionableControlsExpected', 'actionableControlsFound',
    'recoveryAssertionsExpected', 'recoveryAssertionsPassed', 'rawInternalLeaks',
  ])) return { valid: false, reason: 'invalid_metrics_shape' };
  const metricValues = Object.values(artifact.metrics);
  if (metricValues.some((metric) => !Number.isSafeInteger(metric) || metric < 0)) return { valid: false, reason: 'invalid_metric' };
  if (
    artifact.metrics.expectedVisibleSignals !== CONTENT_IOS_EXTRACTION_METRIC_CONTRACT.expectedVisibleSignals
    || artifact.metrics.forbiddenSignalsChecked !== CONTENT_IOS_EXTRACTION_METRIC_CONTRACT.forbiddenSignalsChecked
    || artifact.metrics.actionableControlsExpected !== CONTENT_IOS_EXTRACTION_METRIC_CONTRACT.actionableControlsExpected
    || artifact.metrics.recoveryAssertionsExpected !== CONTENT_IOS_EXTRACTION_METRIC_CONTRACT.recoveryAssertionsExpected
    || artifact.metrics.matchedVisibleSignals > artifact.metrics.expectedVisibleSignals
    || artifact.metrics.actionableControlsFound > artifact.metrics.actionableControlsExpected
    || artifact.metrics.recoveryAssertionsPassed > artifact.metrics.recoveryAssertionsExpected
  ) return { valid: false, reason: 'metric_contract_mismatch' };
  if (artifact.score !== deriveContentIosExtractionScore(artifact.metrics)) return { valid: false, reason: 'score_mismatch' };
  const { bindingDigest, attestation, ...withoutBinding } = artifact;
  if (!validDigest(bindingDigest) || bindingDigest !== contentEvalSha256(withoutBinding)) return { valid: false, reason: 'binding_digest_mismatch' };
  if (!exactKeys(attestation, ['algorithm', 'keyFingerprint', 'mac']) || attestation.algorithm !== 'HMAC-SHA256') return { valid: false, reason: 'invalid_attestation' };
  const actualFingerprint = contentLiveEvalAttestationKeyFingerprint(options.attestationKey);
  if (!validDigest(options.trustedAttestationKeyFingerprint) || actualFingerprint !== options.trustedAttestationKeyFingerprint || attestation.keyFingerprint !== actualFingerprint) return { valid: false, reason: 'untrusted_attestation_key' };
  const { attestation: _discarded, ...signedPayload } = artifact;
  const expectedMac = contentEvalHmacSha256(options.attestationKey, signedPayload);
  if (
    !validDigest(attestation.mac)
    || !crypto.timingSafeEqual(Buffer.from(attestation.mac, 'hex'), Buffer.from(expectedMac, 'hex'))
  ) return { valid: false, reason: 'attestation_mismatch' };
  const releaseQualified = artifact.score >= 95
    && artifact.metrics.forbiddenSignalsFound === 0
    && artifact.metrics.rawInternalLeaks === 0;
  if (releaseQualified) releaseQualifiedArtifacts.set(artifact, contentEvalSha256(artifact));
  return { valid: true, releaseQualified, artifact };
}

export function isReleaseQualifiedContentIosExtractionArtifact(
  value: unknown,
): value is ContentIosExtractionArtifact {
  if (!value || typeof value !== 'object') return false;
  const digest = releaseQualifiedArtifacts.get(value as object);
  if (!digest) return false;
  try {
    return contentEvalSha256(value) === digest;
  } catch {
    return false;
  }
}
