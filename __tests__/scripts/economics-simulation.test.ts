// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ECONOMICS_ARTIFACT_SCHEMA,
  ECONOMICS_PRODUCER_MODULES,
  buildEconomicsArtifact,
  buildProfiles,
  computeEconomics,
  economicsSourceBindingSha256,
  safeEconomicsCliFailureMessage,
  validateRateCard,
} from '../../scripts/economics-simulation.mjs';
import {
  CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA,
  CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
  CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA,
  CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA,
  OPERATION_USAGE_CLASSIFICATION_VERSION,
  OPERATION_USAGE_EVIDENCE_SCHEMA,
  acceptanceSourceBindingSha256,
  buildImmutableToolSourceBinding,
} from '../../scripts/content-ten-script-evidence.mjs';
import {
  TEN_SCRIPT_ACCEPTANCE_REVISION,
  TEN_SCRIPT_ACCEPTANCE_SCENARIOS,
} from '../../scripts/content-ten-script-acceptance.mjs';
import { canonicalJson } from '../../scripts/lib/release-canonical.mjs';
import {
  buildEconomicsActivationAuthentication,
  validateEconomicsActivationAuthentication,
} from '../../scripts/lib/economics-activation-auth.mjs';
import {
  verifyEconomicsActivationArtifact,
} from '../../scripts/economics-activation-verifier.mjs';

const workloadSourceSha = 'a'.repeat(40);
const producerSourceSha = 'c'.repeat(40);
const digest = (value: string | Buffer) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const workloadBackendImageDigest = digest('workload-backend-image');
const authenticationSecret = 'test-economics-activation-secret-at-least-32-bytes';
const immutableToolSourceFixture = (entrypoint: string, modulePaths: readonly string[]) => (
  buildImmutableToolSourceBinding({
    producerSourceSha,
    entrypoint,
    modules: modulePaths.map((modulePath, index) => ({
      path: modulePath,
      gitMode: '100644',
      gitBlobObjectId: (index + 1).toString(16).padStart(40, '0'),
      sha256: digest(`module:${modulePath}`),
      byteLength: 100 + index,
    })),
  })
);
const acceptanceProducerToolSource = immutableToolSourceFixture(
  'scripts/content-ten-script-evidence.mjs',
  CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
);
const economicsProducerToolSource = immutableToolSourceFixture(
  'scripts/economics-simulation.mjs',
  ECONOMICS_PRODUCER_MODULES,
);
const producerToolBindings = () => ({
  acceptanceProducerToolSource,
  economicsProducerToolSource,
  authenticationSecret,
});

describe('economics CLI error privacy', () => {
  it('preserves controlled refusals and redacts unexpected exception details', () => {
    const controlled = Object.assign(new Error('controlled economics refusal'), { exitCode: 78 });
    expect(safeEconomicsCliFailureMessage(controlled)).toBe('controlled economics refusal');
    expect(safeEconomicsCliFailureMessage(new Error('PRIVATE-ECONOMICS-PATH-MARKER'))).toBe('Error');
    expect(safeEconomicsCliFailureMessage('PRIVATE-ECONOMICS-STRING-MARKER')).toBe('string');
  });
});

const fixtureJobId = (index: number) => (
  `script_job_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
);

function healthyRateCard() {
  return {
    version: 'test-1',
    capturedAt: '2026-08-23T03:15:00Z',
    providerRatesUsdPerMTok: {
      standardOp: { input: 0.10, output: 0.40 },
      deepOp: { input: 0.25, output: 1.00 },
      standardScript: { input: 0.50, output: 2.00 },
      scheduledScript: { input: 0.25, output: 1.00 },
      priorityScript: { input: 0.50, output: 2.00 },
    },
    stripeFeePct: 0.029,
    stripeFeeFixedUsd: 0.30,
    appleProceedsPct: 0.85,
    vpsAllocationUsdPerPaidUser: 0.35,
    refundsPct: 0.01,
    taxesPct: 0.0,
    projectedCohortCounts: {
      pro_script_heavy: { web: 100, apple: 20 },
      max_script_heavy: { web: 100, apple: 20 },
      chat_heavy: { web: 100, apple: 20 },
      reasoning_heavy: { web: 100, apple: 20 },
      priority_pack_buyer: { web: 10, apple: 20 },
    },
  };
}

function measuredScriptP95() {
  return {
    standard: {
      sampleCount: 4, inputTokens: 9000, outputTokens: 4200,
      modelCostUsd: 0.0129, toolCostUsd: 0.002,
    },
    scheduled: {
      sampleCount: 3, inputTokens: 9200, outputTokens: 4300,
      modelCostUsd: 0.0066, toolCostUsd: 0.003,
    },
    priority: {
      sampleCount: 3, inputTokens: 9400, outputTokens: 4400,
      modelCostUsd: 0.0135, toolCostUsd: 0.004,
    },
  };
}

function measuredOperationUsage() {
  return {
    schemaVersion: OPERATION_USAGE_EVIDENCE_SCHEMA,
    classificationVersion: OPERATION_USAGE_CLASSIFICATION_VERSION,
    capturedAt: '2026-08-23T02:45:00Z',
    windowStart: '2026-05-25T02:45:00Z',
    windowEnd: '2026-08-23T02:45:00Z',
    scopeSha256: digest('scope'),
    classes: {
      standardOp: {
        sampleCount: 30, inputTokens: 2000, outputTokens: 600,
        modelCostUsd: 0.00044, toolCostUsd: 0.0002,
        failedOnlyOperationCount: 0,
        failedOnlyInputTokensAllocated: 0,
        failedOnlyOutputTokensAllocated: 0,
        failedOnlyModelCostUsdAllocated: 0,
        failedOnlyToolCostUsdAllocated: 0,
      },
      deepOp: {
        sampleCount: 10, inputTokens: 6000, outputTokens: 2500,
        modelCostUsd: 0.004, toolCostUsd: 0.0002,
        failedOnlyOperationCount: 0,
        failedOnlyInputTokensAllocated: 0,
        failedOnlyOutputTokensAllocated: 0,
        failedOnlyModelCostUsdAllocated: 0,
        failedOnlyToolCostUsdAllocated: 0,
      },
    },
  };
}

function releaseBinding() {
  return {
    viewSchema: 'nexus.release-state-view.v2',
    capturedAt: '2026-08-23T02:00:00Z',
    releaseId: 'b'.repeat(32),
    sourceSha: producerSourceSha,
    stateStatus: 'completed',
    receiptSchema: 'nexus.release-receipt.v3',
    receiptOutcome: 'completed',
    receiptCompletedAt: '2026-08-23T00:30:00Z',
    releasePayloadDigest: digest('release-payload'),
  };
}

function releaseViewFixture() {
  const release = releaseBinding();
  return {
    schema: release.viewSchema,
    capturedAt: release.capturedAt,
    blocked: null,
    active: {
      releaseId: release.releaseId,
      sourceSha: producerSourceSha,
      status: 'completed',
      releasePayloadDigest: release.releasePayloadDigest,
    },
    effective: {
      source: 'receipt',
      status: 'completed',
      releaseId: release.releaseId,
      provable: true,
      stateStatus: 'completed',
      staleProjection: false,
      releasePayloadDigest: release.releasePayloadDigest,
    },
    activeReceipt: {
      schema: release.receiptSchema,
      releaseId: release.releaseId,
      sourceSha: producerSourceSha,
      outcome: 'completed',
      completedAt: release.receiptCompletedAt,
      releasePayloadDigest: release.releasePayloadDigest,
    },
  };
}

function workloadReleaseViewFixture() {
  const releaseId = '9'.repeat(32);
  const releasePayloadDigest = digest('workload-release-payload');
  return {
    schema: 'nexus.release-state-view.v2',
    capturedAt: '2026-08-22T23:45:00Z',
    blocked: null,
    active: {
      releaseId,
      sourceSha: workloadSourceSha,
      status: 'completed',
      releasePayloadDigest,
      images: { backend: { digest: workloadBackendImageDigest } },
    },
    effective: {
      source: 'receipt',
      status: 'completed',
      releaseId,
      provable: true,
      stateStatus: 'completed',
      staleProjection: false,
      releasePayloadDigest,
    },
    activeReceipt: {
      schema: 'nexus.release-receipt.v3',
      releaseId,
      sourceSha: workloadSourceSha,
      outcome: 'completed',
      completedAt: '2026-08-22T23:30:00Z',
      releasePayloadDigest,
    },
  };
}

function acceptanceEvidence(
  releaseViewBytes: Buffer,
  workloadReleaseViewBytes: Buffer,
  producerToolSource = acceptanceProducerToolSource,
) {
  const release = releaseBinding();
  const p95ByDeliveryMode = measuredScriptP95();
  const scripts = TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((scenario, index) => {
    const p95 = p95ByDeliveryMode[scenario.deliveryMode];
    return {
      id: scenario.id,
      phase: scenario.phase,
      deliveryMode: scenario.deliveryMode,
      language: scenario.language,
      topicSha256: digest(scenario.topic),
      jobId: fixtureJobId(index),
      scriptSha256: digest(`script-${index}`),
      wordCount: 2_100,
      sourceConsistent: true,
      route: 'cloud',
      modelDigest: null,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      createdAt: '2026-08-23T00:00:00Z',
      completedAt: '2026-08-23T00:01:00Z',
      inputTokens: p95.inputTokens,
      outputTokens: p95.outputTokens,
      modelCostUsd: p95.modelCostUsd,
      toolCostUsd: p95.toolCostUsd,
    };
  });
  return {
    schemaVersion: CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    generatedAt: '2026-08-23T03:00:00Z',
    workloadSourceSha,
    producerSourceSha,
    producerToolSource: structuredClone(producerToolSource),
    sourceBindingSha256: acceptanceSourceBindingSha256(
      workloadSourceSha,
      producerSourceSha,
      producerToolSource.bindingSha256,
    ),
    stateSha256: digest('state'),
    scopeSha256: digest('scope'),
    workloadRelease: {
      viewSchema: 'nexus.release-state-view.v2',
      capturedAt: '2026-08-22T23:45:00Z',
      releaseId: '9'.repeat(32),
      sourceSha: workloadSourceSha,
      stateStatus: 'completed',
      receiptSchema: 'nexus.release-receipt.v3',
      receiptOutcome: 'completed',
      receiptCompletedAt: '2026-08-22T23:30:00Z',
      releasePayloadDigest: digest('workload-release-payload'),
      backendImageDigest: workloadBackendImageDigest,
      boundAt: '2026-08-22T23:50:00Z',
      viewSha256: digest(workloadReleaseViewBytes),
    },
    productionSmokeRuntimeRelease: {
      schemaVersion: CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA,
      jobId: fixtureJobId(9),
      creation: {
        releaseId: '9'.repeat(32),
        sourceSha: workloadSourceSha,
        backendImageDigest: workloadBackendImageDigest,
      },
      completion: {
        releaseId: '9'.repeat(32),
        sourceSha: workloadSourceSha,
        backendImageDigest: workloadBackendImageDigest,
      },
    },
    qualityReview: {
      schemaVersion: CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA,
      sha256: digest('quality'),
      reviewedAt: '2026-08-23T02:30:00Z',
      reviewType: 'independent',
      attestation: 'no_critical_quality_regression',
    },
    release: { ...release, viewSha256: digest(releaseViewBytes) },
    acceptancePass: true,
    inventory: {
      count: 10,
      delivery: { standard: 4, scheduled: 3, priority: 3 },
      languages: { en: 5, 'pt-BR': 5 },
      preRelease: 9,
      productionSmoke: 1,
    },
    p95Tokens: { input: 9400, output: 4400 },
    p95ByDeliveryMode,
    operationUsage: measuredOperationUsage(),
    totalModelCostUsd: Number(scripts.reduce((sum, row) => sum + row.modelCostUsd, 0).toFixed(6)),
    totalToolCostUsd: Number(scripts.reduce((sum, row) => sum + row.toolCostUsd, 0).toFixed(6)),
    scripts,
  };
}

describe('economics simulation', () => {
  it('fails closed on missing, nonfinite, negative, and out-of-range rate-card values', () => {
    const missing = healthyRateCard() as any;
    missing.providerRatesUsdPerMTok.priorityScript.output = null;
    expect(() => validateRateCard(missing)).toThrow(/priorityScript\.output/);
    expect(() => computeEconomics({} as any, measuredScriptP95(), measuredOperationUsage())).toThrow(/incomplete/);

    const nonfinite = healthyRateCard();
    nonfinite.providerRatesUsdPerMTok.standardOp.input = Number.NaN;
    expect(() => validateRateCard(nonfinite)).toThrow(/finite/);

    const negative = healthyRateCard();
    negative.vpsAllocationUsdPerPaidUser = -0.01;
    expect(() => validateRateCard(negative)).toThrow(/between 0/);

    const percentage = healthyRateCard();
    percentage.refundsPct = 1.01;
    expect(() => validateRateCard(percentage)).toThrow(/between 0 and 1/);
  });

  it('fails closed when scheduled rates exceed standard rates', () => {
    const rates = healthyRateCard() as any;
    rates.providerRatesUsdPerMTok.scheduledScript = { input: 0.60, output: 2.50 };
    expect(() => validateRateCard(rates)).toThrow(/scheduledScript rates exceed/);
  });

  it('rejects the checked-in template outright', () => {
    const template = JSON.parse(
      readFileSync(join(process.cwd(), 'config/economics-rate-card.template.json'), 'utf8'),
    );
    expect(() => computeEconomics(template, measuredScriptP95(), measuredOperationUsage())).toThrow(/incomplete/);
  });

  it('requires a complete profile-by-channel projection matrix', () => {
    const missingChannel = healthyRateCard() as any;
    delete missingChannel.projectedCohortCounts.chat_heavy.apple;
    expect(() => validateRateCard(missingChannel)).toThrow(/chat_heavy\.apple/);

    const zeroApple = healthyRateCard();
    for (const profile of Object.values(zeroApple.projectedCohortCounts)) {
      profile.apple = 0;
    }
    const result = computeEconomics(zeroApple, measuredScriptP95(), measuredOperationUsage());
    expect(result.gates.appleHasPaidCohort).toBe(false);
    expect(result.gates.appleFloor).toBe(false);
    expect(result.launchEligible).toBe(false);
  });

  it('models all required profiles and includes measured script tool/search cost', () => {
    const profiles = buildProfiles(healthyRateCard(), measuredScriptP95(), measuredOperationUsage());
    expect(profiles.map((profile) => `${profile.id}:${profile.channel}`)).toEqual([
      'pro_script_heavy:web',
      'pro_script_heavy:apple',
      'max_script_heavy:web',
      'max_script_heavy:apple',
      'chat_heavy:web',
      'chat_heavy:apple',
      'reasoning_heavy:web',
      'reasoning_heavy:apple',
      'priority_pack_buyer:web',
      'priority_pack_buyer:apple',
    ]);
    const proScriptHeavy = profiles.find((profile) => (
      profile.id === 'pro_script_heavy' && profile.channel === 'web'
    ))!;
    // Script model p95 is 0.0129, measured script tool p95 is 0.002,
    // and a standard op totals 0.00064 including its search/tool cost.
    expect(proScriptHeavy.modelCostUsd).toBeCloseTo(30 * 0.0129 + 200 * 0.00044, 10);
    expect(proScriptHeavy.toolCostUsd).toBeCloseTo(30 * 0.002 + 200 * 0.0002, 10);
    expect(proScriptHeavy.providerCostUsd).toBeCloseTo(30 * 0.0149 + 200 * 0.00064, 10);
    expect(proScriptHeavy.revenueUsd).toBe(9.99);
  });

  it('charges separate web fixed fees for the subscription and pack transactions', () => {
    const rates = healthyRateCard();
    const result = computeEconomics(rates, measuredScriptP95(), measuredOperationUsage());
    const packBuyer = result.profiles.find((profile) => (
      profile.id === 'priority_pack_buyer' && profile.channel === 'web'
    ))!;
    const ordinarySubscriber = result.profiles.find((profile) => (
      profile.id === 'max_script_heavy' && profile.channel === 'web'
    ))!;

    expect(packBuyer.transactionCount).toBe(2);
    expect(packBuyer.channelFeeUsd).toBeCloseTo(
      packBuyer.revenueUsd * rates.stripeFeePct + 2 * rates.stripeFeeFixedUsd,
      10,
    );
    expect(ordinarySubscriber.transactionCount).toBe(1);
    expect(ordinarySubscriber.channelFeeUsd).toBeCloseTo(
      ordinarySubscriber.revenueUsd * rates.stripeFeePct + rates.stripeFeeFixedUsd,
      10,
    );
  });

  it('uses the costlier measured Standard or Scheduled path for ten-credit profiles', () => {
    const scriptP95 = measuredScriptP95();
    scriptP95.scheduled = {
      sampleCount: 3,
      inputTokens: 9_200,
      outputTokens: 4_300,
      modelCostUsd: 0.02,
      toolCostUsd: 0.01,
    };

    const proScriptHeavy = buildProfiles(
      healthyRateCard(),
      scriptP95,
      measuredOperationUsage(),
    ).find((profile) => profile.id === 'pro_script_heavy' && profile.channel === 'web')!;
    expect(proScriptHeavy.modelCostUsd).toBeCloseTo(30 * 0.02 + 200 * 0.00044, 10);
    expect(proScriptHeavy.toolCostUsd).toBeCloseTo(30 * 0.01 + 200 * 0.0002, 10);
    expect(proScriptHeavy.providerCostUsd).toBeCloseTo(30 * 0.03 + 200 * 0.00064, 10);
  });

  it('never prices below resolved measured provider-cost p95 when a rate is too cheap', () => {
    const cheapRates = healthyRateCard();
    for (const rate of Object.values(cheapRates.providerRatesUsdPerMTok)) {
      rate.input = 0;
      rate.output = 0;
    }
    const proScriptHeavy = buildProfiles(
      cheapRates,
      measuredScriptP95(),
      measuredOperationUsage(),
    ).find((profile) => profile.id === 'pro_script_heavy' && profile.channel === 'web')!;
    expect(proScriptHeavy.modelCostUsd).toBeCloseTo(30 * 0.0129 + 200 * 0.00044, 10);
    expect(proScriptHeavy.toolCostUsd).toBeCloseTo(30 * 0.002 + 200 * 0.0002, 10);
  });

  it('passes and fails the bounded channel gates without hiding the result', () => {
    const healthy = computeEconomics(healthyRateCard(), measuredScriptP95(), measuredOperationUsage());
    expect(healthy.gates).toEqual({
      blendedAtLeast80: true,
      webHasPaidCohort: true,
      webAtLeast80: true,
      appleHasPaidCohort: true,
      appleFloor: true,
    });
    expect(healthy.launchEligible).toBe(true);

    const expensive = healthyRateCard();
    expensive.providerRatesUsdPerMTok.standardScript = { input: 20, output: 80 };
    expensive.providerRatesUsdPerMTok.priorityScript = { input: 40, output: 160 };
    const failed = computeEconomics(expensive, measuredScriptP95(), measuredOperationUsage());
    expect(failed.launchEligible).toBe(false);
    expect(failed.gates.blendedAtLeast80).toBe(false);
  });

  it('blocks an Apple-heavy projected mix that a fixed one-of-each profile mix would hide', () => {
    const appleHeavy = healthyRateCard();
    appleHeavy.projectedCohortCounts = {
      pro_script_heavy: { web: 1, apple: 0 },
      max_script_heavy: { web: 1, apple: 0 },
      chat_heavy: { web: 1, apple: 0 },
      reasoning_heavy: { web: 1, apple: 0 },
      priority_pack_buyer: { web: 1, apple: 10_000 },
    };

    const result = computeEconomics(appleHeavy, measuredScriptP95(), measuredOperationUsage());

    expect(result.webMarginPct).toBeGreaterThanOrEqual(0.8);
    expect(result.appleMarginPct).toBeGreaterThanOrEqual(0.7);
    expect(result.blendedMarginPct).toBeLessThan(0.8);
    expect(result.gates.blendedAtLeast80).toBe(false);
    expect(result.launchEligible).toBe(false);
    expect(result.profiles.find((profile) => (
      profile.id === 'priority_pack_buyer' && profile.channel === 'apple'
    )))
      .toMatchObject({ projectedCount: 10_000 });
  });

  it('digests distinct workload and producer sources with state, quality, and release', () => {
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const evidence = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    const acceptanceEvidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
    const artifact = buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: evidence,
      acceptanceEvidenceBytes,
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    });

    expect(artifact).toMatchObject({
      schemaVersion: ECONOMICS_ARTIFACT_SCHEMA,
      digestAlgorithm: 'sha256-canonical-json-payload-v1',
      payloadSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      authentication: {
        schemaVersion: 'nexus.pre-release-economics-auth.v1',
        algorithm: 'hmac-sha256',
        signature: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      },
      payload: {
        workloadSourceSha,
        producerSourceSha,
        producerToolSource: economicsProducerToolSource,
        sourceBindingSha256: economicsSourceBindingSha256({
          workloadSourceSha,
          producerSourceSha,
          acceptanceSourceBindingSha256: evidence.sourceBindingSha256,
          economicsToolBindingSha256: economicsProducerToolSource.bindingSha256,
        }),
        bindings: {
          rateCard: {
            sha256: digest(rateCardBytes),
            projectedCohortCounts: healthyRateCard().projectedCohortCounts,
            projectedCohortCountsSha256: digest(
              Buffer.from(canonicalJson(healthyRateCard().projectedCohortCounts)),
            ),
            data: healthyRateCard(),
          },
          acceptance: {
            acceptancePass: true,
            workloadSourceSha,
            evidenceSha256: digest(acceptanceEvidenceBytes),
            stateSha256: evidence.stateSha256,
            producerToolSource: acceptanceProducerToolSource,
            qualityReviewSha256: evidence.qualityReview.sha256,
            scopeSha256: evidence.scopeSha256,
            workloadReleaseViewSha256: digest(workloadReleaseViewBytes),
            evidence,
          },
          operationUsage: {
            schemaVersion: OPERATION_USAGE_EVIDENCE_SCHEMA,
            classificationVersion: OPERATION_USAGE_CLASSIFICATION_VERSION,
          },
          release: {
            releaseId: releaseBinding().releaseId,
            producerSourceSha,
            viewSha256: digest(releaseViewBytes),
          },
          workloadRelease: {
            sourceSha: workloadSourceSha,
            backendImageDigest: workloadBackendImageDigest,
            viewSha256: digest(workloadReleaseViewBytes),
          },
        },
      },
    });
    expect(validateEconomicsActivationAuthentication(
      artifact.authentication,
      artifact.payloadSha256,
      authenticationSecret,
    )).toEqual(artifact.authentication);

    const redigested = structuredClone(artifact);
    redigested.payload.result.blendedMarginPct = 0.99;
    redigested.payloadSha256 = digest(Buffer.from(canonicalJson(redigested.payload)));
    expect(() => validateEconomicsActivationAuthentication(
      redigested.authentication,
      redigested.payloadSha256,
      authenticationSecret,
    )).toThrow(/signature is invalid/);
  });

  it('revalidates authenticated governed inputs against the packaged producer bytes', () => {
    const actualToolSource = (entrypoint: string, modulePaths: readonly string[]) => (
      buildImmutableToolSourceBinding({
        producerSourceSha,
        entrypoint,
        modules: modulePaths.map((modulePath) => {
          const filename = join(process.cwd(), modulePath);
          const bytes = readFileSync(filename);
          const stat = statSync(filename);
          const gitBlobObjectId = crypto.createHash('sha1')
            .update(Buffer.from(`blob ${bytes.length}\0`))
            .update(bytes)
            .digest('hex');
          return {
            path: modulePath,
            gitMode: (stat.mode & 0o111) === 0 ? '100644' : '100755',
            gitBlobObjectId,
            sha256: digest(bytes),
            byteLength: bytes.length,
          };
        }),
      })
    );
    const actualAcceptanceToolSource = actualToolSource(
      'scripts/content-ten-script-evidence.mjs',
      CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
    );
    const actualEconomicsToolSource = actualToolSource(
      'scripts/economics-simulation.mjs',
      ECONOMICS_PRODUCER_MODULES,
    );
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const evidence = acceptanceEvidence(
      releaseViewBytes,
      workloadReleaseViewBytes,
      actualAcceptanceToolSource,
    );
    const artifact = buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: evidence,
      acceptanceEvidenceBytes: Buffer.from(`${JSON.stringify(evidence)}\n`),
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      acceptanceProducerToolSource: actualAcceptanceToolSource,
      economicsProducerToolSource: actualEconomicsToolSource,
      authenticationSecret,
      generatedAt: '2026-08-23T04:00:00Z',
    });
    const previousSource = process.env.NEXUS_RELEASE_SOURCE_SHA;
    const previousLegacySource = process.env.NEXUS_RELEASE_SHA;
    process.env.NEXUS_RELEASE_SOURCE_SHA = producerSourceSha;
    delete process.env.NEXUS_RELEASE_SHA;
    try {
      expect(verifyEconomicsActivationArtifact(artifact, {
        sourceRoot: process.cwd(),
        authenticationSecret,
        now: new Date('2026-08-23T04:30:00Z'),
      })).toMatchObject({ producerSourceSha, workloadSourceSha });

      expect(() => verifyEconomicsActivationArtifact(artifact, {
        sourceRoot: process.cwd(),
        authenticationSecret,
        now: new Date('2026-08-24T04:00:00.001Z'),
      })).toThrow(/outside the 24-hour activation window/);

      const handAuthored = structuredClone(artifact);
      handAuthored.payload.bindings.rateCard.data.stripeFeeFixedUsd = 0;
      handAuthored.payloadSha256 = digest(Buffer.from(canonicalJson(handAuthored.payload)));
      handAuthored.authentication = buildEconomicsActivationAuthentication(
        handAuthored.payloadSha256,
        authenticationSecret,
      );
      expect(() => verifyEconomicsActivationArtifact(handAuthored, {
        sourceRoot: process.cwd(),
        authenticationSecret,
        now: new Date('2026-08-23T04:30:00Z'),
      })).toThrow(/economics result does not match/);
    } finally {
      if (previousSource === undefined) delete process.env.NEXUS_RELEASE_SOURCE_SHA;
      else process.env.NEXUS_RELEASE_SOURCE_SHA = previousSource;
      if (previousLegacySource === undefined) delete process.env.NEXUS_RELEASE_SHA;
      else process.env.NEXUS_RELEASE_SHA = previousLegacySource;
    }
  });

  it('rejects a stale rate card or one captured before completed acceptance evidence', () => {
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const evidence = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    const acceptanceEvidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
    const staleRates = healthyRateCard();
    staleRates.capturedAt = '2026-08-23T02:59:59Z';

    expect(() => buildEconomicsArtifact({
      rates: staleRates,
      rateCardBytes: Buffer.from(`${JSON.stringify(staleRates)}\n`),
      acceptanceEvidence: evidence,
      acceptanceEvidenceBytes,
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    })).toThrow(/rate card is stale or predates/);
  });

  it('rejects a producer receipt that does not postdate workload smoke evidence', () => {
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    releaseView.activeReceipt.completedAt = '2026-08-22T23:55:00Z';
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const evidence = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    evidence.release.receiptCompletedAt = releaseView.activeReceipt.completedAt;
    const acceptanceEvidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);

    expect(() => buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: evidence,
      acceptanceEvidenceBytes,
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    })).toThrow(/timestamps are not causally ordered/);
  });

  it('rejects a production smoke that predates its authoritative workload binding', () => {
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const evidence = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    const smoke = evidence.scripts.find((row) => row.phase === 'production-smoke')!;
    smoke.createdAt = '2026-08-22T23:49:59Z';
    const acceptanceEvidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);

    expect(() => buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: evidence,
      acceptanceEvidenceBytes,
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    })).toThrow(/production smoke predates/);
  });

  it('rejects a wrong acceptance revision or a p95 summary that differs from the ten rows', () => {
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const wrongRevision = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes) as any;
    wrongRevision.acceptanceRevision = '2026-08-24.v3';
    expect(() => buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: wrongRevision,
      acceptanceEvidenceBytes: Buffer.from(`${JSON.stringify(wrongRevision)}\n`),
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    })).toThrow(/governed workload\/producer source pair/);

    const lowered = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes) as any;
    lowered.p95ByDeliveryMode.standard.inputTokens -= 1;
    expect(() => buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: lowered,
      acceptanceEvidenceBytes: Buffer.from(`${JSON.stringify(lowered)}\n`),
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    })).toThrow(/recomputed script evidence/);
  });

  it('rejects substitution of either source identity after acceptance evidence is created', () => {
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const evidence = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    const acceptanceEvidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`);
    const build = (workload: string, producer: string) => buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: evidence,
      acceptanceEvidenceBytes,
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha: workload,
      producerSourceSha: producer,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    });

    expect(() => build('d'.repeat(40), producerSourceSha)).toThrow(/workload\/producer source pair/);
    expect(() => build(workloadSourceSha, 'd'.repeat(40))).toThrow(/workload\/producer source pair/);
    expect(() => build(producerSourceSha, producerSourceSha)).toThrow(/distinct commits/);

    const tampered = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    tampered.sourceBindingSha256 = digest('forged-source-pair');
    expect(() => buildEconomicsArtifact({
      rates: healthyRateCard(),
      rateCardBytes,
      acceptanceEvidence: tampered,
      acceptanceEvidenceBytes: Buffer.from(`${JSON.stringify(tampered)}\n`),
      workloadReleaseView,
      workloadReleaseViewBytes,
      releaseView,
      releaseViewBytes,
      workloadSourceSha,
      producerSourceSha,
      ...producerToolBindings(),
      generatedAt: '2026-08-23T04:00:00Z',
    })).toThrow(/source binding is invalid/);
  });

  it('rejects self-consistent acceptance substitution and economics tool-closure drift', () => {
    const rateCardBytes = Buffer.from(`${JSON.stringify(healthyRateCard())}\n`);
    const releaseView = releaseViewFixture();
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const workloadReleaseView = workloadReleaseViewFixture();
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const build = (evidence: ReturnType<typeof acceptanceEvidence>, economicsToolSource: any) => (
      buildEconomicsArtifact({
        rates: healthyRateCard(),
        rateCardBytes,
        acceptanceEvidence: evidence,
        acceptanceEvidenceBytes: Buffer.from(`${JSON.stringify(evidence)}\n`),
        workloadReleaseView,
        workloadReleaseViewBytes,
        releaseView,
        releaseViewBytes,
        workloadSourceSha,
        producerSourceSha,
        acceptanceProducerToolSource,
        economicsProducerToolSource: economicsToolSource,
        authenticationSecret,
        generatedAt: '2026-08-23T04:00:00Z',
      })
    );

    const forgedEvidence = acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes);
    const forgedModules = structuredClone(acceptanceProducerToolSource.modules);
    forgedModules[0].sha256 = digest('substituted acceptance module');
    forgedEvidence.producerToolSource = buildImmutableToolSourceBinding({
      producerSourceSha,
      entrypoint: 'scripts/content-ten-script-evidence.mjs',
      modules: forgedModules,
    });
    forgedEvidence.sourceBindingSha256 = acceptanceSourceBindingSha256(
      workloadSourceSha,
      producerSourceSha,
      forgedEvidence.producerToolSource.bindingSha256,
    );
    expect(() => build(forgedEvidence, economicsProducerToolSource))
      .toThrow(/receipt-bound module closure/);

    const driftedEconomicsToolSource = structuredClone(economicsProducerToolSource);
    driftedEconomicsToolSource.modules[0].sha256 = digest('drifted economics module');
    expect(() => build(
      acceptanceEvidence(releaseViewBytes, workloadReleaseViewBytes),
      driftedEconomicsToolSource,
    )).toThrow(/closure or digest is invalid/);
  });
});
