import {
  CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS,
  CONTENT_IOS_EXTRACTION_FIXTURE_VERSION,
  CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION,
  CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE,
  CONTENT_IOS_EXTRACTION_SCHEME,
  CONTENT_IOS_EXTRACTION_SUMMARY_TITLE,
  CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS,
  CONTENT_IOS_TEST_EVIDENCE_CONTRACT,
  CONTENT_IOS_TEST_EVIDENCE_SCHEMA_VERSION,
  createContentIosExtractionArtifactFromXcresultDocuments,
  type ContentIosExtractionArtifact,
} from '../../src/services/content-ios-extraction-artifact';
import { contentLiveEvalAttestationKeyFingerprint } from '../../src/services/content-live-evaluation-artifact';

export const CONTENT_IOS_TEST_KEY = Buffer.alloc(32, 0x69);
export const CONTENT_IOS_TEST_FINGERPRINT = contentLiveEvalAttestationKeyFingerprint(CONTENT_IOS_TEST_KEY);
export const CONTENT_IOS_TEST_GIT_COMMIT = 'd'.repeat(40);
export const CONTENT_IOS_TEST_SOURCE_TREE_DIGEST = 'e'.repeat(64);
export const CONTENT_IOS_TEST_GENERATED_AT = '2026-07-19T10:00:00.000Z';

export function makeContentIosXcresultDocuments(input: {
  generatedAt?: string;
  resultByIndex?: Partial<Record<number, 'Passed' | 'Failed' | 'Skipped'>>;
  omitIndex?: number;
  duplicateIndex?: number;
  attachmentMutator?: (attachments: Array<Record<string, unknown>>) => void;
  summaryOverrides?: Record<string, unknown>;
} = {}): { testsJson: string; summaryJson: string; attachmentsJson: string } {
  const nodes = CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.flatMap((identifier, index) => {
    if (input.omitIndex === index) return [];
    const [suite, test] = identifier.split('/');
    const node = {
      nodeType: 'Test Suite',
      name: suite,
      children: [{
        nodeType: 'Test Case',
        nodeIdentifier: `Nexus HubUITests/${identifier}()`,
        name: `${test}()`,
        result: input.resultByIndex?.[index] ?? 'Passed',
        durationInSeconds: 1 + index / 1_000,
      }],
    };
    return input.duplicateIndex === index ? [node, structuredClone(node)] : [node];
  });
  const generatedAt = input.generatedAt ?? CONTENT_IOS_TEST_GENERATED_AT;
  const attachments: Array<Record<string, unknown>> = CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.map((testIdentifier) => ({
    schemaVersion: CONTENT_IOS_TEST_EVIDENCE_SCHEMA_VERSION,
    corpus: CONTENT_IOS_EXTRACTION_FIXTURE_CORPUS,
    fixtureVersion: CONTENT_IOS_EXTRACTION_FIXTURE_VERSION,
    testIdentifier,
    buildIdentity: {
      gitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
      sourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
      scheme: CONTENT_IOS_EXTRACTION_SCHEME,
      buildConfiguration: CONTENT_IOS_EXTRACTION_BUILD_CONFIGURATION,
      evidenceScope: CONTENT_IOS_EXTRACTION_EVIDENCE_SCOPE,
    },
    checks: CONTENT_IOS_TEST_EVIDENCE_CONTRACT[testIdentifier].map((check) => ({ ...check, passed: true })),
  }));
  input.attachmentMutator?.(attachments);
  return {
    testsJson: JSON.stringify({
      testPlanConfigurations: [],
      devices: [],
      testNodes: [{ nodeType: 'UI test bundle', name: 'Nexus HubUITests', children: nodes }],
    }),
    summaryJson: JSON.stringify({
      title: CONTENT_IOS_EXTRACTION_SUMMARY_TITLE,
      environmentDescription: 'Nexus Hub UI tests',
      topInsights: [],
      result: 'Passed',
      totalTestCount: CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.length,
      passedTests: CONTENT_IOS_EXTRACTION_TEST_IDENTIFIERS.length,
      failedTests: 0,
      skippedTests: 0,
      expectedFailures: 0,
      finishTime: Date.parse(generatedAt) / 1_000,
      statistics: [],
      devicesAndConfigurations: {},
      testFailures: [],
      ...input.summaryOverrides,
    }),
    attachmentsJson: JSON.stringify(attachments),
  };
}

export function makeContentIosExtractionTestArtifact(input: {
  generatedAt?: string;
} = {}): ContentIosExtractionArtifact {
  const documents = makeContentIosXcresultDocuments(input);
  return createContentIosExtractionArtifactFromXcresultDocuments({
    ...documents,
    iosGitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
    iosSourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
    xcresultDigest: 'a'.repeat(64),
    attestationKey: CONTENT_IOS_TEST_KEY,
  });
}
