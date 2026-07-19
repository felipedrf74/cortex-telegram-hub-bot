import { describe, expect, it } from 'vitest';
import {
  CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION,
  CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE,
  CONTENT_IOS_EXTRACTION_SCHEME,
  CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS,
  createContentIosExtractionArtifactFromXcresultDocuments,
  deriveContentIosExtractionEvidenceFromXcresult,
  deriveContentIosExtractionScore,
  isReleaseQualifiedContentIosExtractionArtifact,
  validateContentIosExtractionArtifact,
} from '../../src/services/content-ios-extraction-artifact';
import {
  CONTENT_IOS_TEST_FINGERPRINT,
  CONTENT_IOS_TEST_GENERATED_AT,
  CONTENT_IOS_TEST_GIT_COMMIT,
  CONTENT_IOS_TEST_KEY,
  CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
  makeContentIosExtractionTestArtifact,
  makeContentIosXcresultDocuments,
} from '../fixtures/content-ios-extraction';

function validationOptions() {
  return {
    attestationKey: CONTENT_IOS_TEST_KEY,
    trustedAttestationKeyFingerprint: CONTENT_IOS_TEST_FINGERPRINT,
    expectedIosGitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
    expectedIosSourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
    now: new Date('2026-07-19T10:05:00.000Z'),
  };
}

function iosBuildIdentity() {
  return {
    gitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
    sourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
    scheme: CONTENT_IOS_EXTRACTION_SCHEME,
    buildConfiguration: CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION,
    evidenceScope: CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE,
  };
}

describe('Content iOS visible-text extraction artifact', () => {
  it('release-qualifies a complete, fresh, source-bound and score-derived fixture artifact', () => {
    const artifact = makeContentIosExtractionTestArtifact();
    expect(artifact.score).toBe(100);
    expect(artifact.iosSource).toMatchObject({
      scheme: 'Nexus Hub Debug UI Smoke',
      buildConfiguration: 'Debug',
      evidenceScope: 'behavioral_not_archive_equivalence',
    });
    expect(artifact.resultBundle.testsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.tests.map((test) => test.identifier)).toEqual(CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS);
    expect(validateContentIosExtractionArtifact(artifact, validationOptions()))
      .toMatchObject({ valid: true, releaseQualified: true });
    expect(isReleaseQualifiedContentIosExtractionArtifact(artifact)).toBe(true);
  });

  it('rejects score/metric tampering and invalidates a previously qualified object after mutation', () => {
    const artifact = makeContentIosExtractionTestArtifact();
    expect(validateContentIosExtractionArtifact(artifact, validationOptions()).releaseQualified).toBe(true);
    artifact.metrics.matchedVisibleSignals -= 1;
    expect(validateContentIosExtractionArtifact(artifact, validationOptions()).valid).toBe(false);
    expect(isReleaseQualifiedContentIosExtractionArtifact(artifact)).toBe(false);
  });

  it('rejects stale evidence and independently pinned source mismatches', () => {
    const stale = makeContentIosExtractionTestArtifact({ generatedAt: '2026-07-18T00:00:00.000Z' });
    expect(validateContentIosExtractionArtifact(stale, validationOptions()).reason).toBe('stale_or_future_artifact');

    const artifact = makeContentIosExtractionTestArtifact();
    expect(validateContentIosExtractionArtifact(artifact, {
      ...validationOptions(),
      expectedIosGitCommit: 'f'.repeat(40),
    }).reason).toBe('ios_source_commit_mismatch');
    expect(validateContentIosExtractionArtifact(artifact, {
      ...validationOptions(),
      expectedIosSourceTreeDigest: 'f'.repeat(64),
    }).reason).toBe('ios_source_tree_mismatch');

    for (const [field, value] of [
      ['scheme', 'Nexus Hub'],
      ['buildConfiguration', 'Release'],
      ['evidenceScope', 'app_store_archive_equivalence'],
    ] as const) {
      const forged = makeContentIosExtractionTestArtifact();
      (forged.iosSource as unknown as Record<string, unknown>)[field] = value;
      expect(validateContentIosExtractionArtifact(forged, validationOptions()).reason)
        .toBe('unsupported_test_execution_context');
    }
    const missingExecutionScope = makeContentIosExtractionTestArtifact();
    delete (missingExecutionScope.iosSource as unknown as Record<string, unknown>).evidenceScope;
    expect(validateContentIosExtractionArtifact(missingExecutionScope, validationOptions()).reason)
      .toBe('invalid_source_shape');
  });

  it('rejects partial, failed, and skipped test sets', () => {
    const failed = makeContentIosExtractionTestArtifact();
    failed.tests[0].status = 'failed';
    failed.summary.passedCount = 4;
    failed.summary.failedCount = 1;
    expect(validateContentIosExtractionArtifact(failed, validationOptions()).reason).toBe('tests_not_clean');
    const skipped = makeContentIosExtractionTestArtifact();
    skipped.tests[1].status = 'skipped';
    skipped.summary.passedCount = 4;
    skipped.summary.skippedCount = 1;
    expect(validateContentIosExtractionArtifact(skipped, validationOptions()).reason).toBe('tests_not_clean');
    const complete = makeContentIosExtractionTestArtifact();
    const partial = structuredClone(complete);
    partial.tests = partial.tests.slice(0, -1);
    expect(validateContentIosExtractionArtifact(partial, validationOptions()).reason).toBe('partial_test_set');
  });

  it('derives tests, counts, timestamp, and score from xcresulttool documents', () => {
    const documents = makeContentIosXcresultDocuments();
    const evidence = deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(documents.testsJson),
      JSON.parse(documents.summaryJson),
      JSON.parse(documents.attachmentsJson),
      iosBuildIdentity(),
    );
    expect(evidence.generatedAt).toBe(CONTENT_IOS_TEST_GENERATED_AT);
    expect(evidence.tests).toHaveLength(5);
    expect(evidence.tests.every((test) => test.status === 'passed')).toBe(true);
    expect(evidence.metrics).toMatchObject({
      expectedVisibleSignals: 29,
      matchedVisibleSignals: 29,
      forbiddenSignalsChecked: 13,
      forbiddenSignalsFound: 0,
      actionableControlsExpected: 7,
      actionableControlsFound: 7,
      recoveryAssertionsExpected: 7,
      recoveryAssertionsPassed: 7,
      rawInternalLeaks: 0,
    });
  });

  it('fails closed on failed, skipped, partial, duplicate, or inconsistent xcresult evidence', () => {
    for (const result of ['Failed', 'Skipped'] as const) {
      const documents = makeContentIosXcresultDocuments({
        resultByIndex: { 0: result },
        summaryOverrides: {
          result,
          passedTests: 4,
          failedTests: result === 'Failed' ? 1 : 0,
          skippedTests: result === 'Skipped' ? 1 : 0,
        },
      });
      expect(() => createContentIosExtractionArtifactFromXcresultDocuments({
        ...documents,
        iosGitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
        iosSourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
        xcresultDigest: 'a'.repeat(64),
        attestationKey: CONTENT_IOS_TEST_KEY,
      })).toThrow('CONTENT_IOS_EXTRACTION_XCRESULT_NOT_CLEAN');
    }

    const partial = makeContentIosXcresultDocuments({ omitIndex: 4 });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(partial.testsJson), JSON.parse(partial.summaryJson), JSON.parse(partial.attachmentsJson), iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_REQUIRED_TEST_MISSING');

    const duplicate = makeContentIosXcresultDocuments({ duplicateIndex: 0 });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(duplicate.testsJson), JSON.parse(duplicate.summaryJson), JSON.parse(duplicate.attachmentsJson), iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_DUPLICATE_TEST');

    const inconsistent = makeContentIosXcresultDocuments({
      summaryOverrides: { totalTestCount: 6, passedTests: 6 },
    });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(inconsistent.testsJson), JSON.parse(inconsistent.summaryJson), JSON.parse(inconsistent.attachmentsJson), iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_XCRESULT_NOT_CLEAN');

    for (const summaryTitle of [undefined, 'Test - Nexus Hub', 'Archive - Nexus Hub']) {
      const wrongExecutionContext = makeContentIosXcresultDocuments({
        summaryOverrides: { title: summaryTitle },
      });
      expect(() => deriveContentIosExtractionEvidenceFromXcresult(
        JSON.parse(wrongExecutionContext.testsJson),
        JSON.parse(wrongExecutionContext.summaryJson),
        JSON.parse(wrongExecutionContext.attachmentsJson),
        iosBuildIdentity(),
      )).toThrow('CONTENT_IOS_EXTRACTION_XCRESULT_EXECUTION_CONTEXT_MISMATCH');
    }

    const missingAttachment = makeContentIosXcresultDocuments({
      attachmentMutator: (attachments) => attachments.pop(),
    });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(missingAttachment.testsJson),
      JSON.parse(missingAttachment.summaryJson),
      JSON.parse(missingAttachment.attachmentsJson),
      iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_SET_INCOMPLETE');

    const forgedCheck = makeContentIosXcresultDocuments({
      attachmentMutator: (attachments) => {
        const checks = attachments[0].checks as Array<Record<string, unknown>>;
        checks[0].passed = false;
      },
    });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(forgedCheck.testsJson),
      JSON.parse(forgedCheck.summaryJson),
      JSON.parse(forgedCheck.attachmentsJson),
      iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_CHECK_FAILED');

    const unknownCheck = makeContentIosXcresultDocuments({
      attachmentMutator: (attachments) => {
        const checks = attachments[0].checks as Array<Record<string, unknown>>;
        checks[0].id = 'caller.supplied.pass';
      },
    });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(unknownCheck.testsJson),
      JSON.parse(unknownCheck.summaryJson),
      JSON.parse(unknownCheck.attachmentsJson),
      iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_CHECK_CONTRACT_MISMATCH');

    const wrongBuild = makeContentIosXcresultDocuments({
      attachmentMutator: (attachments) => {
        const buildIdentity = attachments[2].buildIdentity as Record<string, unknown>;
        buildIdentity.gitCommit = 'f'.repeat(40);
      },
    });
    expect(() => deriveContentIosExtractionEvidenceFromXcresult(
      JSON.parse(wrongBuild.testsJson),
      JSON.parse(wrongBuild.summaryJson),
      JSON.parse(wrongBuild.attachmentsJson),
      iosBuildIdentity(),
    )).toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_BUILD_IDENTITY_MISMATCH');

    for (const [field, value] of [
      ['scheme', undefined],
      ['scheme', 'Nexus Hub'],
      ['buildConfiguration', 'Release'],
      ['evidenceScope', 'app_store_archive_equivalence'],
    ] as const) {
      const forgedExecutionContext = makeContentIosXcresultDocuments({
        attachmentMutator: (attachments) => {
          const buildIdentity = attachments[0].buildIdentity as Record<string, unknown>;
          if (value === undefined) delete buildIdentity[field];
          else buildIdentity[field] = value;
        },
      });
      expect(() => deriveContentIosExtractionEvidenceFromXcresult(
        JSON.parse(forgedExecutionContext.testsJson),
        JSON.parse(forgedExecutionContext.summaryJson),
        JSON.parse(forgedExecutionContext.attachmentsJson),
        iosBuildIdentity(),
      )).toThrow('CONTENT_IOS_EXTRACTION_ATTACHMENT_BUILD_IDENTITY_MISMATCH');
    }
  });

  it('derives run identity from the full result/source binding, not summary alone', () => {
    const documents = makeContentIosXcresultDocuments();
    const first = createContentIosExtractionArtifactFromXcresultDocuments({
      ...documents,
      iosGitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
      iosSourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
      xcresultDigest: 'a'.repeat(64),
      attestationKey: CONTENT_IOS_TEST_KEY,
    });
    const second = createContentIosExtractionArtifactFromXcresultDocuments({
      ...documents,
      iosGitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
      iosSourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
      xcresultDigest: 'c'.repeat(64),
      attestationKey: CONTENT_IOS_TEST_KEY,
    });
    expect(first.resultBundle.summaryDigest).toBe(second.resultBundle.summaryDigest);
    expect(first.runId).not.toBe(second.runId);
  });

  it('derives lower scores from missing assertions and blocks forbidden/internal output', () => {
    const artifact = makeContentIosExtractionTestArtifact();
    expect(deriveContentIosExtractionScore({
      ...artifact.metrics,
      matchedVisibleSignals: artifact.metrics.expectedVisibleSignals - 4,
    })).toBeLessThan(100);
    expect(deriveContentIosExtractionScore({
      ...artifact.metrics,
      forbiddenSignalsFound: 1,
    })).toBe(0);
    expect(deriveContentIosExtractionScore({
      ...artifact.metrics,
      rawInternalLeaks: 1,
    })).toBe(0);
  });

  it('binds the exact generated timestamp used by the permanent fixture', () => {
    expect(makeContentIosExtractionTestArtifact().generatedAt).toBe(CONTENT_IOS_TEST_GENERATED_AT);
  });
});
