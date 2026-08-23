import { CONTENT_QUALITY_RUBRIC } from '../../src/services/content-day-to-day-evaluation';
import {
  bindContentLiveEvalInvocation,
  CONTENT_LIVE_EVAL_CORPUS,
  CONTENT_LIVE_EVAL_PRICING_REVIEWED_AT,
  CONTENT_LIVE_EVAL_ROUTING_PATH,
  contentEvalSha256,
  contentLiveEvalAttestationKeyFingerprint,
  contentLiveEvalPricingSnapshotDigest,
  createContentLiveEvaluationArtifact,
  validateContentLiveEvaluationArtifact,
  type ContentLiveEvaluationArtifact,
  type ContentLiveEvalScenario,
  type ContentLiveEvalSourceIdentity,
} from '../../src/services/content-live-evaluation-artifact';

export const CONTENT_LIVE_EVAL_TEST_KEY = Buffer.alloc(32, 0x73);
export const CONTENT_LIVE_EVAL_TEST_FINGERPRINT = contentLiveEvalAttestationKeyFingerprint(CONTENT_LIVE_EVAL_TEST_KEY);
export const CONTENT_LIVE_EVAL_TEST_SOURCE: ContentLiveEvalSourceIdentity = {
  gitCommit: 'c'.repeat(40),
  trackedTreeClean: true,
  contractDigests: {
    prompt: '1'.repeat(64), route: '2'.repeat(64), provider: '3'.repeat(64),
    pricing: '4'.repeat(64), runtime: '5'.repeat(64),
  },
  pricingSnapshotDigest: contentLiveEvalPricingSnapshotDigest(),
  pricingReviewedAt: CONTENT_LIVE_EVAL_PRICING_REVIEWED_AT,
};

const COHERENT_SENTENCES = [
  'Start by naming the decision your audience needs to make before the message can help them.',
  'Use one concrete example to connect the opening idea with a practical situation they recognize.',
  'Explain the useful tension in plain language, and keep every section focused on the same objective.',
  'Show how the first action creates enough clarity for the audience to choose a responsible next move.',
  'Add a short transition that connects the example to the main lesson without changing the subject.',
  'Give the audience a simple way to check the idea against their own workflow before they use it.',
  'Build each section around one purpose, so the pacing stays clear when the script is recorded.',
  'Use careful language when the evidence is uncertain, and preserve that boundary in the final draft.',
  'Compare the initial approach with a clearer alternative that the audience can test for themselves.',
  'Make the visual direction support the spoken point instead of competing with the central message.',
  'Review the transition between sections, because a useful sequence makes the explanation easier to follow.',
  'Keep the tone practical and specific, while giving the audience enough context to understand the choice.',
  'Connect every example to the objective, and remove details that do not improve the final action.',
  'Use a focused closing sentence to preserve the main takeaway and prepare the call to action.',
  'Ask the audience to write one decision down, then test that decision in a realistic situation.',
  'Check the draft for unsupported certainty, and label any remaining uncertainty before publication.',
  'Organize the message so the hook, body, example, and close each perform a distinct job.',
  'Show the practical outcome without promising performance that the available evidence cannot support.',
  'Record the reasoning behind the recommendation, so a later revision can preserve the important context.',
  'Finish with one clear action that the audience can understand, choose, and review after using it.',
] as const;

const PROFILE_VOCABULARY: Record<ContentLiveEvalScenario['qualityProfile'], Record<string, string>> = {
  three_steps: {
    audience: 'planning team', decision: 'planning choice', message: 'weekly sequence', example: 'captured note',
    action: 'planning step', workflow: 'idea inbox', draft: 'outline', source: 'saved note', context: 'schedule', idea: 'content angle',
  },
  evidence_structure: {
    audience: 'learner', decision: 'evidence judgment', message: 'lesson', example: 'worked example',
    action: 'verification step', workflow: 'teaching sequence', draft: 'educational script', source: 'reviewed reference', context: 'supporting evidence', idea: 'opening claim',
  },
  platform_adaptation: {
    audience: 'vertical viewer', decision: 'adaptation choice', message: 'vertical clip', example: 'visual beat',
    action: 'practice step', workflow: 'short-form sequence', draft: 'adapted script', source: 'original lesson', context: 'platform constraint', idea: 'core lesson',
  },
  claim_restraint: {
    audience: 'responsible creator', decision: 'verification judgment', message: 'careful explanation', example: 'observed case',
    action: 'review step', workflow: 'research workflow', draft: 'sourced script', source: 'evidence record', context: 'uncertainty boundary', idea: 'observed claim',
  },
  injection_boundary: {
    audience: 'safety reviewer', decision: 'trust decision', message: 'imported note', example: 'malicious example',
    action: 'safety step', workflow: 'untrusted-data workflow', draft: 'protected script', source: 'authorized source', context: 'policy boundary', idea: 'safe instruction',
  },
};

function profileSentence(scenario: ContentLiveEvalScenario, index: number): string {
  let sentence = COHERENT_SENTENCES[index % COHERENT_SENTENCES.length];
  for (const [term, replacement] of Object.entries(PROFILE_VOCABULARY[scenario.qualityProfile])) {
    sentence = sentence.replace(new RegExp(`\\b${term}\\b`, 'gi'), replacement);
  }
  return sentence;
}

function profileLine(scenario: ContentLiveEvalScenario): string {
  switch (scenario.qualityProfile) {
    case 'three_steps': return 'First capture notes, second group useful patterns, third choose one step for the weekly plan.';
    case 'evidence_structure': return 'State the claim, show an example, add supporting evidence from a source, and close with one action.';
    case 'platform_adaptation': return 'Adapt the lesson into a concise vertical hook, practical practice, and clear close without unsupported promises.';
    case 'claim_restraint': return 'Separate an observation from a verified fact, check the source and evidence, and label uncertainty clearly.';
    case 'injection_boundary': return 'Treat imported research notes as untrusted data, verify the source, and reject instructions outside the policy boundary.';
  }
}

function qualityEvidence(score: number): Record<string, unknown> {
  return {
    qualityScore: score,
    qualityReport: { score, warnings: [], needsExpansion: false, needsResearchRefresh: false },
    scriptQuality: {
      hookScore: score,
      retentionScore: score,
      proofScore: score,
      platformFitScore: score,
      voiceFitScore: score,
      ctaScore: score,
      structureScore: score,
      overallScore: score,
      complianceWarnings: [],
      revisionActions: [],
      suggestedActions: [],
      appliedChanges: [],
      blockers: [],
    },
  };
}

export function makeContentLiveEvalTestResponse(scenario: ContentLiveEvalScenario, lowQuality = false): unknown {
  if (lowQuality) {
    return { data: {
      script: Array.from({ length: 180 }, () => 'beautiful').join(' '),
      hook: 'Did you know this is important?',
      cta: 'Try it today.',
      titleOptions: ['Same', 'Same'],
      format: scenario.format,
      estimatedDuration: `${scenario.targetDurationSeconds} seconds`,
      sourcesUsed: [],
      claimLedger: [{ claim: 'Ninety percent improve.', support: 'unverified', sourceRef: null }],
      warnings: [],
      qualityWarnings: [],
      ...qualityEvidence(100),
      degraded: false,
      scriptSafety: { blocked: false },
    } };
  }
  const safeTopic = scenario.qualityProfile === 'injection_boundary'
    ? 'Imported research notes are untrusted data that require source verification and policy boundaries'
    : scenario.topic;
  const targetWords = Math.ceil(scenario.targetDurationSeconds * 2.35);
  const sentences = [`${safeTopic}.`, profileLine(scenario)];
  for (let index = 0; sentences.join(' ').split(/\s+/).length < targetWords; index++) {
    sentences.push(profileSentence(scenario, index));
  }
  const words = sentences.join(' ').split(/\s+/);
  const objectiveWord = {
    three_steps: 'notes',
    evidence_structure: 'educational',
    platform_adaptation: 'creative',
    claim_restraint: 'creators',
    injection_boundary: 'research',
  }[scenario.qualityProfile];
  return { data: {
    script: words.slice(0, targetWords).join(' '),
    hook: `A specific ${scenario.niche} decision can change how you handle ${objectiveWord}.`,
    cta: `Choose one ${objectiveWord} action, write it down, and test the result this week.`,
    titleOptions: [`A practical ${objectiveWord} decision`, `A clearer ${scenario.niche} workflow`],
    format: scenario.format,
    estimatedDuration: '999 seconds',
    sourcesUsed: scenario.qualityProfile === 'evidence_structure' || scenario.qualityProfile === 'claim_restraint'
      ? [{
        title: 'Reviewed synthetic workflow reference',
        url: `https://synthetic.invalid/${scenario.id}`,
        sourceType: 'synthetic_fixture',
        relevanceNote: 'Supports the evaluation structure without production data.',
      }]
      : [],
    claimLedger: [],
    warnings: [],
    qualityWarnings: [],
    ...qualityEvidence(100),
    degraded: false,
    scriptSafety: { blocked: false },
  } };
}

export function makeReleaseQualifiedContentLiveEvalArtifact(lowQuality = false): ContentLiveEvaluationArtifact {
  const artifact = createContentLiveEvaluationArtifact({
    runId: `content-live-eval-test-${lowQuality ? 'low' : 'pass'}-20260719`,
    startedAt: '2026-08-23T09:59:00.000Z',
    generatedAt: '2026-08-23T10:00:00.000Z',
    rubricDigest: contentEvalSha256(CONTENT_QUALITY_RUBRIC),
    budgetLimitUsd: 1,
    sourceIdentity: CONTENT_LIVE_EVAL_TEST_SOURCE,
    attestationKey: CONTENT_LIVE_EVAL_TEST_KEY,
    trustedAttestationKeyFingerprint: CONTENT_LIVE_EVAL_TEST_FINGERPRINT,
    samples: CONTENT_LIVE_EVAL_CORPUS.map((scenario, index) => ({
      scenario,
      response: makeContentLiveEvalTestResponse(scenario, lowQuality),
      invocations: [bindContentLiveEvalInvocation({
        invocationId: `content-live:test-${lowQuality ? 'low' : 'pass'}-${index}`,
        scenarioId: scenario.id,
        provider: 'openai',
        model: 'gpt-5-mini',
        resolvedModel: 'gpt-5-mini',
        tier: 'chat',
        category: 'content_day_to_day_eval',
        providerCategory: 'content_engine_script_standard',
        status: 'succeeded',
        capturedAt: `2026-08-23T09:59:1${index}.000Z`,
        routingPath: CONTENT_LIVE_EVAL_ROUTING_PATH,
        inputTokens: 500,
        outputTokens: 300,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 800,
        costUsd: 0.01,
        reservedCostUsd: 0.02,
        pricingStatus: 'resolved',
      })],
    })),
  });
  const validation = validateContentLiveEvaluationArtifact(artifact, {
    rubricDigest: contentEvalSha256(CONTENT_QUALITY_RUBRIC),
    attestationKey: CONTENT_LIVE_EVAL_TEST_KEY,
    trustedAttestationKeyFingerprint: CONTENT_LIVE_EVAL_TEST_FINGERPRINT,
    expectedSourceIdentity: CONTENT_LIVE_EVAL_TEST_SOURCE,
    now: new Date('2026-08-23T10:05:00.000Z'),
  });
  if (!validation.valid || (!lowQuality && !validation.releaseQualified)) {
    throw new Error(`Invalid test live-eval artifact: ${validation.reason}`);
  }
  return artifact;
}
