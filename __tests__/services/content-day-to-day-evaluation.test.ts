import { describe, expect, it } from 'vitest';
import {
  CONTENT_PERSONA_BANK,
  CONTENT_QUALITY_RUBRIC,
  CONTENT_SCENARIO_BANK,
  evaluateContentEvalTextQuality,
  formatContentEvalResultsMarkdown,
  runContentDayToDayEvaluation,
} from '../../src/services/content-day-to-day-evaluation';
import {
  type ContentLiveEvaluationArtifact,
} from '../../src/services/content-live-evaluation-artifact';
import { makeReleaseQualifiedContentLiveEvalArtifact } from '../fixtures/content-live-evaluation';
import {
  CONTENT_IOS_TEST_FINGERPRINT,
  CONTENT_IOS_TEST_GIT_COMMIT,
  CONTENT_IOS_TEST_KEY,
  CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
  makeContentIosExtractionTestArtifact,
} from '../fixtures/content-ios-extraction';
import {
  validateContentIosExtractionArtifact,
  type ContentIosExtractionArtifact,
} from '../../src/services/content-ios-extraction-artifact';

function liveArtifact(lowQuality = false): ContentLiveEvaluationArtifact {
  return makeReleaseQualifiedContentLiveEvalArtifact(lowQuality);
}

function liveEvidence(artifact: ContentLiveEvaluationArtifact) {
  return {
    runId: artifact.runId,
    source: artifact.source,
    sampleCount: artifact.summary.sampleCount,
    generatedAt: artifact.generatedAt,
    providerInvocations: artifact.invocations,
    artifact,
  };
}

function iosArtifact(): ContentIosExtractionArtifact {
  const artifact = makeContentIosExtractionTestArtifact();
  const validation = validateContentIosExtractionArtifact(artifact, {
    attestationKey: CONTENT_IOS_TEST_KEY,
    trustedAttestationKeyFingerprint: CONTENT_IOS_TEST_FINGERPRINT,
    expectedIosGitCommit: CONTENT_IOS_TEST_GIT_COMMIT,
    expectedIosSourceTreeDigest: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
    now: new Date('2026-07-19T10:05:00.000Z'),
  });
  if (!validation.releaseQualified) throw new Error(`Invalid iOS test artifact: ${validation.reason}`);
  return artifact;
}

function iosEvidence(artifact: ContentIosExtractionArtifact) {
  return {
    runId: artifact.runId,
    source: artifact.source,
    sampleCount: artifact.summary.totalCount,
    generatedAt: artifact.generatedAt,
    iosArtifact: artifact,
  };
}

describe('Content day-to-day evaluation harness', () => {
  it('defines the required persona bank for realistic Content Creation work', () => {
    const personaIds = new Set(CONTENT_PERSONA_BANK.map((persona) => persona.id));

    expect(personaIds).toEqual(new Set([
      'solo_creator',
      'creator_with_references',
      'strong_voice_creator',
      'weak_setup_creator',
      'training_milestone_creator',
      'tight_schedule_creator',
      'multi_tenant_brand_creator',
      'tenant_admin_reviewer',
      'voice_correction_user',
      'repeat_rejection_user',
    ]));
  });

  it('defines multi-turn workflow scenarios instead of one-shot snapshot prompts', () => {
    const scenarioIds = new Set(CONTENT_SCENARIO_BANK.map((scenario) => scenario.id));

    expect(scenarioIds).toEqual(new Set([
      'book_reference_to_script',
      'voice_refinement_to_short_form',
      'secretary_schedules_writing_block',
      'radar_dismiss_and_explain',
      'reject_repeated_topic',
      'training_milestone_to_content',
      'tenant_brand_switch_safety',
      'same_style_as_last_week',
      'remove_unsupported_claims',
      'weekly_content_plan',
      'competitor_transcripts_to_agency_package',
      'weak_script_rewrite',
      'analytics_bottleneck_diagnosis',
      'brand_positioning_calendar',
      'viral_competitor_pattern_originality',
      'branded_content_disclosure_gate',
      'prompt_injected_transcript_guard',
    ]));
    expect(CONTENT_SCENARIO_BANK.every((scenario) => scenario.turns.length >= 3)).toBe(true);
    expect(CONTENT_SCENARIO_BANK.every((scenario) => scenario.requiredWorkflow.length > 0)).toBe(true);
  });

  it('adds Creator Agency scenarios that test originality, compliance, analytics, and critical-user usefulness', () => {
    const scenarioById = new Map(CONTENT_SCENARIO_BANK.map((scenario) => [scenario.id, scenario]));
    const requiredAgencyScenarios = [
      'competitor_transcripts_to_agency_package',
      'weak_script_rewrite',
      'analytics_bottleneck_diagnosis',
      'brand_positioning_calendar',
      'viral_competitor_pattern_originality',
      'branded_content_disclosure_gate',
      'prompt_injected_transcript_guard',
    ];

    for (const id of requiredAgencyScenarios) {
      const scenario = scenarioById.get(id as any);
      expect(scenario, id).toBeDefined();
      expect(scenario?.requiredWorkflow).toContain('critical_user_review');
      expect(scenario?.requiredDimensions.length).toBeGreaterThanOrEqual(3);
      expect(scenario?.expectedFailureProtections.length).toBeGreaterThanOrEqual(3);
    }
    expect(scenarioById.get('competitor_transcripts_to_agency_package')?.requiredWorkflow).toEqual(expect.arrayContaining([
      'competitor_pattern_study',
      'transcript_pattern_study',
      'generate_hook_bank',
      'generate_script_variants',
      'creative_direction',
      'compliance_review',
      'experiment_plan',
    ]));
    expect(scenarioById.get('analytics_bottleneck_diagnosis')?.expectedFailureProtections).toContain('unsupported_analytics_claim');
    expect(scenarioById.get('branded_content_disclosure_gate')?.expectedFailureProtections).toContain('missing_disclosure');
    expect(scenarioById.get('prompt_injected_transcript_guard')?.expectedFailureProtections).toContain('raw_prompt_artifact');
  });

  it('scores content quality by rubric dimensions rather than exact wording', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T00:00:00.000Z',
    });
    const rubricIds = CONTENT_QUALITY_RUBRIC.map((dimension) => dimension.id).sort();

    expect(result.aggregate.caseCount).toBeGreaterThanOrEqual(10);
    expect(result.aggregate.caseCount).toBeGreaterThanOrEqual(20);
    expect(result.aggregate.overallScore).toBeGreaterThanOrEqual(95);
    expect(result.aggregate.minScore).toBeGreaterThanOrEqual(92);
    expect(result.aggregate.laneScores.fixtureScore).toBeGreaterThanOrEqual(95);
    expect(result.aggregate.laneScores.localEngineScore).toBeGreaterThanOrEqual(94);
    expect(result.aggregate.laneScores.scriptQualityScore).toBeGreaterThanOrEqual(94);
    expect(result.aggregate.laneScores.criticalUserScore).toBeGreaterThanOrEqual(92);
    expect(result.aggregate.releaseGate).toBe('PASS_WITH_CONDITIONS');
    expect(result.aggregate.criticalFailureCount).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.openConditions).toEqual(expect.arrayContaining([
      expect.stringContaining('not a release-passing generation gate'),
    ]));

    for (const testCase of result.cases) {
      expect(Object.keys(testCase.dimensionScores).sort()).toEqual(rubricIds);
      expect(testCase.penalties).toEqual([]);
      expect(testCase.output.transcript.length).toBeGreaterThanOrEqual(3);
      expect(testCase.output.providerTrace.productionDataUsed).toBe(false);
      expect(testCase.output.providerTrace.preservesLiveRouting).toBe(false);
      expect(testCase.output.providerTrace.realProviderCalls).toBe(false);
      expect(testCase.output.providerTrace.executionKind).toBe('contract_fixture');
      expect(testCase.output.unsupportedClaimsRemaining).toBeNull();
      expect(testCase.output.claimReviewStatus).toBe('not_executed');
      expect(testCase.output.userEditsPreserved).toBeNull();
      expect(testCase.output.editPreservationStatus).toBe('not_executed');
      expect(testCase.dimensionScores.claim_safety).toBeNull();
      expect(testCase.output.providerTrace.category).toBe('content_day_to_day_eval');
    }
  });

  it('can report PASS only with both typed iOS and live-provider artifacts', () => {
    const artifact = liveArtifact();
    const ios = iosArtifact();
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      iosExtractionScore: ios.score,
      iosExtractionEvidence: iosEvidence(ios),
      realProviderSampleScore: artifact.summary.score,
      realProviderSampleEvidence: liveEvidence(artifact),
    });

    expect(result.aggregate.releaseGate).toBe('PASS');
    expect(result.passed).toBe(true);
    expect(result.aggregate.laneScores).toMatchObject({
      iosExtractionScore: 100,
      realProviderSampleScore: artifact.summary.score,
    });
    expect(result.aggregate.laneEvidence.iosExtraction).toMatchObject({
      status: 'executed',
      invocationCount: 5,
      iosExecutionContext: {
        scheme: 'Nexus Hub Debug UI Smoke',
        buildConfiguration: 'Debug',
        evidenceScope: 'behavioral_not_archive_equivalence',
      },
    });
    const markdown = formatContentEvalResultsMarkdown(result);
    expect(markdown).toContain('Behavioral UI/recovery evidence only; not App Store archive equivalence');
    expect(markdown).toContain('Nexus Hub Debug UI Smoke — Debug');
  });

  it('rejects an operator score that does not exactly match the bound artifact', () => {
    const artifact = liveArtifact();
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      iosExtractionScore: 999,
      iosExtractionEvidence: {
        runId: 'ios-content-extraction-overflow',
        source: 'xcodebuild-content-ui-tests',
        sampleCount: 4,
      },
      realProviderSampleScore: 999,
      realProviderSampleEvidence: liveEvidence(artifact),
    });

    expect(result.aggregate.overallScore).toBeLessThanOrEqual(100);
    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
    expect(result.aggregate.laneEvidence.realProviderSample.failureCode).toBe('score_artifact_mismatch');
    expect(result.aggregate.releaseGate).toBe('FAIL');
  });

  it('does not allow fabricated external lane numbers to force a release PASS', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      iosExtractionScore: 100,
      realProviderSampleScore: 100,
    });

    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.passed).toBe(false);
    expect(result.openConditions).toEqual(expect.arrayContaining([
      expect.stringContaining('iOS visible-text extraction evidence was ignored'),
      expect.stringContaining('Real-provider sample score was ignored'),
    ]));
  });

  it('ignores forged iOS provenance metadata even when every field and score looks plausible', () => {
    const artifact = liveArtifact();
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      iosExtractionScore: 100,
      iosExtractionEvidence: {
        runId: 'ios-forged-perfect-run',
        source: 'xcodebuild-content-ui-tests',
        sampleCount: 999,
        generatedAt: '2026-07-19T10:00:00.000Z',
      },
      realProviderSampleScore: artifact.summary.score,
      realProviderSampleEvidence: liveEvidence(artifact),
    });

    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.laneEvidence.iosExtraction).toMatchObject({
      status: 'invalid_evidence',
      invocationCount: 0,
      failureCode: 'typed_artifact_required',
    });
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.passed).toBe(false);
  });

  it('fails when supplied external lane evidence is below the release quality floor', () => {
    const artifact = liveArtifact(true);
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      iosExtractionScore: 70,
      iosExtractionEvidence: {
        runId: 'ios-content-extraction-low',
        source: 'xcodebuild-content-ui-tests',
        sampleCount: 4,
      },
      realProviderSampleScore: artifact.summary.score,
      realProviderSampleEvidence: liveEvidence(artifact),
    });

    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.passed).toBe(false);
  });

  it('never treats a requested real-provider mode as captured provider execution', () => {
    const result = runContentDayToDayEvaluation({ mode: 'real_provider' });

    expect(result.cases.every((testCase) => testCase.output.providerTrace.mode === 'fixture')).toBe(true);
    expect(result.cases.every((testCase) => testCase.output.providerTrace.requestedMode === 'real_provider')).toBe(true);
    expect(result.cases.every((testCase) => testCase.output.providerTrace.realProviderCalls === false)).toBe(true);
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
    expect(result.aggregate.laneEvidence.realProviderSample).toMatchObject({
      status: 'not_executed',
      invocationCount: 0,
      failureCode: 'missing_bound_artifact',
    });
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.passed).toBe(false);
  });

  it('fails the release gate closed when local engine execution throws', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'local_engine',
      engine: {
        evaluateLocalPackage: () => {
          throw new Error('simulated engine failure');
        },
      },
    });

    expect(result.aggregate.laneScores.localEngineScore).toBe(0);
    expect(result.aggregate.laneScores.criticalUserScore).toBe(0);
    expect(result.aggregate.laneEvidence.localEngine).toMatchObject({
      status: 'failed',
      failureCode: 'engine_exception',
    });
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.passed).toBe(false);
  });

  it('fails the release gate when executable review finds an unsupported claim', () => {
    const result = runContentDayToDayEvaluation({
      simulationTransform: (output, { scenario }) => scenario.id === 'remove_unsupported_claims'
        ? { ...output, claimReviewStatus: 'executed', unsupportedClaimsRemaining: 1 }
        : output,
    });
    const unsafeCase = result.cases.find((testCase) => testCase.scenarioId === 'remove_unsupported_claims');

    expect(unsafeCase?.failures).toContain('unsupported_claim');
    expect(unsafeCase?.status).toBe('fail');
    expect(result.aggregate.releaseGate).toBe('FAIL');
  });

  it('fails the release gate when a revision simulation loses user edits', () => {
    const result = runContentDayToDayEvaluation({
      simulationTransform: (output, { scenario }) => scenario.id === 'weak_script_rewrite'
        ? { ...output, editPreservationStatus: 'executed', userEditsPreserved: false }
        : output,
    });
    const lostEditCase = result.cases.find((testCase) => testCase.scenarioId === 'weak_script_rewrite');

    expect(lostEditCase?.failures).toContain('lost_user_edits');
    expect(lostEditCase?.status).toBe('fail');
    expect(result.aggregate.releaseGate).toBe('FAIL');
  });

  it('fails the release gate when a simulation introduces a cross-tenant reference', () => {
    const result = runContentDayToDayEvaluation({
      simulationTransform: (output, { scenario }) => scenario.id === 'tenant_brand_switch_safety'
        ? {
            ...output,
            referencesUsed: [{
              id: 'leaked-reference',
              title: 'Other tenant draft',
              type: 'previous_content',
              tenantId: 'tenant-other',
              scope: 'tenant-shared',
              confidence: 1,
              freshness: 'fresh',
            }],
          }
        : output,
    });
    const leakedCase = result.cases.find((testCase) => testCase.scenarioId === 'tenant_brand_switch_safety');

    expect(leakedCase?.dimensionScores.tenant_safety).toBe(0);
    expect(leakedCase?.failures).toContain('wrong_tenant_reference');
    expect(leakedCase?.status).toBe('fail');
    expect(result.aggregate.releaseGate).toBe('FAIL');
  });

  it('penalizes low-value or unsafe output instead of letting averages hide it', () => {
    const penalties = evaluateContentEvalTextQuality({
      text: [
        'Post consistently.',
        'Copy this exact competitor script.',
        'This will get a 40% lift and guaranteed views.',
        '```json {"INTERNAL_ID":"raw"}',
      ].join('\n'),
      audienceFit: false,
      hookStrength: 'weak',
      referenceRequired: true,
      referencesUsed: 0,
      clarificationAsked: false,
      nextActionsProvided: false,
    });

    expect(penalties.map((penalty) => penalty.id)).toEqual(expect.arrayContaining([
      'generic_filler',
      'missing_audience',
      'weak_hook',
      'no_proof_or_example',
      'unclear_cta',
      'copied_structure_or_wording',
      'unsupported_metric_or_platform_claim',
      'raw_artifact',
    ]));
  });

  it('keeps tenant and brand context partitioned during tenant-switch scenarios', () => {
    const result = runContentDayToDayEvaluation({ mode: 'fixture' });
    const tenantSwitch = result.cases.find((testCase) => testCase.scenarioId === 'tenant_brand_switch_safety');

    expect(tenantSwitch).toBeDefined();
    expect(tenantSwitch?.dimensionScores.tenant_safety).toBe(100);
    expect(tenantSwitch?.failures).not.toContain('wrong_tenant_reference');
    expect(tenantSwitch?.output.referencesUsed.every((ref) => ref.tenantId === tenantSwitch.output.tenantId)).toBe(true);
  });

  it('treats repeated ideas as a novelty and workflow problem, not a text snapshot problem', () => {
    const result = runContentDayToDayEvaluation({ mode: 'fixture' });
    const repeatCase = result.cases.find((testCase) => testCase.scenarioId === 'reject_repeated_topic');

    expect(repeatCase).toBeDefined();
    expect(repeatCase?.output.noveltyStatus).toBe('duplicate_suppressed');
    expect(repeatCase?.dimensionScores.novelty).toBeGreaterThanOrEqual(90);
    expect(repeatCase?.failures).not.toContain('duplicate_idea');
  });

  it('simulates skeptical creator extraction from agency outputs, not only screen taps', () => {
    const result = runContentDayToDayEvaluation({ mode: 'fixture' });
    const competitorCase = result.cases.find((testCase) => testCase.scenarioId === 'competitor_transcripts_to_agency_package');
    const analyticsCase = result.cases.find((testCase) => testCase.scenarioId === 'analytics_bottleneck_diagnosis');
    const injectionCase = result.cases.find((testCase) => testCase.scenarioId === 'prompt_injected_transcript_guard');

    expect(competitorCase).toBeDefined();
    expect(competitorCase?.score).toBeGreaterThanOrEqual(85);
    expect(competitorCase?.failures).not.toContain('copied_competitor_wording');
    expect(competitorCase?.output.transcript.map((turn) => turn.assistantOutcome).join('\n')).toMatch(/pattern-level|original angles|without copying/i);
    expect(competitorCase?.output.transcript.flatMap((turn) => turn.safetyNotes)).toEqual(expect.arrayContaining([
      'competitor_or_transcript_text_marked_untrusted',
      'originality_required_different_angle_proof_story_execution',
      'disclosure_copyright_claim_review_required',
    ]));

    expect(analyticsCase?.output.transcript.map((turn) => turn.assistantOutcome).join('\n')).toMatch(/high CTR plus low retention/i);
    expect(analyticsCase?.failures).not.toContain('unsupported_analytics_claim');

    expect(injectionCase?.output.transcript.flatMap((turn) => turn.safetyNotes)).toContain('competitor_or_transcript_text_marked_untrusted');
    expect(injectionCase?.failures).not.toContain('raw_prompt_artifact');
  });

  it('renders a baseline report with failure taxonomy and release conditions', () => {
    const result = runContentDayToDayEvaluation({
      mode: 'fixture',
      generatedAt: '2026-04-29T00:00:00.000Z',
    });
    const markdown = formatContentEvalResultsMarkdown(result);

    expect(markdown).toContain('# Content Day-to-Day Evaluation Baseline Results');
    expect(markdown).toContain('Failure Taxonomy Counts');
    expect(markdown).toContain('Release gate');
    expect(markdown).toContain('Script quality score');
    expect(markdown).toContain('iOS visible-text extraction');
  });
});
