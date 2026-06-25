// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { SourceReference } from './content-engine';

export interface ScriptPreflightBrief {
  audience: string;
  platform: 'youtube' | 'short_form' | 'generic';
  format: string;
  objective: string;
  emotionalDriver: string;
  proofLibrary: string[];
  toneVoiceConstraints: string[];
  voiceFitCriteria?: ScriptVoiceFitCriteria;
  retentionGoal: string;
  ctaGoal: string;
}

export interface ScriptVoiceFitCriteria {
  audience?: string | null;
  contentPillars?: string[];
  toneRules?: string[];
  phrasesToAvoid?: string[];
  preferredCtas?: string[];
  proofLibrary?: string[];
  confidence?: number;
}

export interface ScriptStructuredOutput {
  titleOptions: string[];
  firstThreeSeconds: string;
  promise: string;
  shortSetup: string;
  beatByBeatScript: string[];
  visualDirection: string[];
  editNotes: string[];
  proofSourceNotes: string[];
  cta: string;
  riskClaimNotes: string[];
}

export interface ScriptQualityReport {
  hookScore: number;
  retentionScore: number;
  proofScore: number;
  platformFitScore: number;
  voiceFitScore: number;
  ctaScore: number;
  structureScore: number;
  overallScore: number;
  complianceWarnings: string[];
  revisionActions: string[];
  blockers: string[];
  revisedScript: string;
  structuredOutput: ScriptStructuredOutput;
}

const RAW_SCRIPT_ARTIFACT_PATTERNS = [
  /```json/i,
  /\b(?:SYSTEM_PROMPT|RAW_PROVIDER_OUTPUT|INTERNAL_ID|DEBUG|TRACE)\b/i,
  /<!--\s*(?:PROMPT|MODEL|COACH|SCRIPT).*?-->/i,
];

const WEAK_INTRO_PATTERN = /^\s*(?:today|hoje)\s+(?:we(?:'|’)re|we are|vamos)\s+(?:going\s+to\s+)?(?:talk|falar)\s+(?:about|sobre)\b/i;
const GENERIC_MOTIVATION_PATTERN = /\b(?:believe in yourself|nunca desista|follow your dreams|sonhe grande)\b/i;
const ABSOLUTE_CLAIM_PATTERN = /\b(?:guaranteed|always works|never fails|will go viral|100%|garantido|sempre funciona)\b/i;
const COPIED_COMPETITOR_PATTERN = /\b(?:copy this exact|use the same script|use exact words|copy their words|same words as competitor|same visual identity)\b/i;
const SHORT_FORM_LONG_FORM_MISMATCH_PATTERN = /\b(?:thumbnail|chapters?|chapter one|section one|eight minutes|ten minutes|long-form intro)\b/i;
const CTA_PATTERN = /\b(?:save|comment|reply|subscribe|follow|book|try|test|measure|compare|watch|download|share|salva|comenta|subscreve|segue|testa|mede|compara|partilha|baixa)\b/i;
const VISUAL_PATTERN = /\b(?:visual|first frame|on screen|b-roll|cut to|show|caption|overlay|sfx|edit|camera|frame|screen|imagem|corte|mostra|legenda)\b/i;
const PROOF_PATTERN = /\b(?:proof|example|source|data|case|before|after|demo|reference|metric|evidence|prova|exemplo|fonte|dado|métrica)\b/i;

export function buildScriptPreflightBrief(params: {
  topic: string;
  niche?: string | null;
  format?: string | null;
  language?: string | null;
  cta?: string | null;
  targetDurationSeconds?: number | null;
  sources?: Array<Partial<SourceReference>> | null;
  voiceMemory?: string | null;
  voiceFitCriteria?: ScriptVoiceFitCriteria | null;
}): ScriptPreflightBrief {
  const format = params.format?.trim() || 'YouTube';
  const lowerFormat = format.toLowerCase();
  const platform: ScriptPreflightBrief['platform'] = lowerFormat.includes('reel')
    || lowerFormat.includes('short')
    || lowerFormat.includes('tiktok')
    ? 'short_form'
    : lowerFormat.includes('youtube')
      ? 'youtube'
      : 'generic';
  const proofLibrary = (params.sources ?? [])
    .map((source) => [source.title, source.relevance_note].filter(Boolean).join(' — '))
    .filter((value) => value.trim().length > 0)
    .slice(0, 5);
  const duration = params.targetDurationSeconds && params.targetDurationSeconds > 0
    ? `${params.targetDurationSeconds}s`
    : platform === 'short_form'
      ? '30-60s'
      : '6-10min';

  return {
    audience: params.voiceFitCriteria?.audience?.trim() || params.niche?.trim() || 'specific audience for this topic',
    platform,
    format,
    objective: `Make ${params.topic.trim()} useful, memorable, and worth acting on.`,
    emotionalDriver: platform === 'short_form' ? 'tension plus immediate payoff' : 'curiosity plus credible progression',
    proofLibrary: proofLibrary.length > 0 ? proofLibrary : ['Add one concrete example, demo, source, or before/after proof before publishing.'],
    toneVoiceConstraints: params.voiceMemory?.trim()
      ? [
        'Apply user-scoped Voice DNA without quoting it verbatim.',
        ...(params.voiceFitCriteria?.toneRules ?? []),
      ].filter(Boolean).slice(0, 8)
      : [
        'Use a clear creator voice; do not impersonate another creator.',
        ...(params.voiceFitCriteria?.toneRules ?? []),
      ].filter(Boolean).slice(0, 8),
    voiceFitCriteria: params.voiceFitCriteria ?? undefined,
    retentionGoal: platform === 'short_form'
      ? `Hold attention through ${duration} with a first-frame promise, quick proof, and one payoff.`
      : `Deliver the title/thumbnail promise early, then reset attention every major section.`,
    ctaGoal: params.cta?.trim() || 'Give one clear next action, not multiple competing CTAs.',
  };
}

export function analyzeAndImproveScript(input: {
  topic: string;
  script: string;
  hook?: string | null;
  titleOptions?: string[] | null;
  cta?: string | null;
  sources?: Array<Partial<SourceReference>> | null;
  format?: string | null;
  language?: string | null;
  preflightBrief?: ScriptPreflightBrief | null;
}): ScriptQualityReport {
  const preflight = input.preflightBrief ?? buildScriptPreflightBrief({
    topic: input.topic,
    format: input.format,
    language: input.language,
    cta: input.cta,
    sources: input.sources,
  });
  const rawScript = (input.script || '').trim();
  const hook = cleanLine(input.hook) || deriveHook(rawScript, input.topic, preflight);
  const cta = cleanLine(input.cta) || deriveCta(rawScript, preflight);
  const titleOptions = (input.titleOptions ?? []).map(cleanLine).filter(Boolean).slice(0, 5);
  const scriptWithoutWeakIntro = rawScript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !WEAK_INTRO_PATTERN.test(line))
    .join('\n');
  const baseBody = scriptWithoutWeakIntro || rawScript || `Explain ${input.topic} with one concrete example and one action.`;
  const visualDirection = buildVisualDirection(baseBody, preflight);
  const editNotes = buildEditNotes(baseBody, preflight);
  const proofNotes = buildProofNotes(baseBody, input.sources ?? [], preflight);
  const riskClaimNotes = buildRiskNotes(baseBody);
  const structuredOutput: ScriptStructuredOutput = {
    titleOptions: titleOptions.length > 0 ? titleOptions : [`The ${input.topic} mistake nobody notices`, `${input.topic}: the proof-first version`],
    firstThreeSeconds: hook,
    promise: buildPromise(input.topic, preflight),
    shortSetup: buildShortSetup(input.topic, preflight),
    beatByBeatScript: buildBeats(baseBody, preflight),
    visualDirection,
    editNotes,
    proofSourceNotes: proofNotes,
    cta,
    riskClaimNotes,
  };

  const blockers: string[] = [];
  const complianceWarnings: string[] = [];
  const revisionActions: string[] = [];
  const fullText = [rawScript, hook, cta, titleOptions.join(' ')].join('\n');
  if (RAW_SCRIPT_ARTIFACT_PATTERNS.some((pattern) => pattern.test(fullText))) blockers.push('raw_script_artifact_blocked');
  if (COPIED_COMPETITOR_PATTERN.test(fullText)) blockers.push('copied_competitor_language_blocked');
  if (ABSOLUTE_CLAIM_PATTERN.test(fullText)) complianceWarnings.push('unsupported_or_overconfident_claim_review_required');
  if (preflight.platform === 'short_form' && SHORT_FORM_LONG_FORM_MISMATCH_PATTERN.test(fullText)) {
    complianceWarnings.push('platform_mismatch_review_required');
  }
  if (GENERIC_MOTIVATION_PATTERN.test(fullText)) revisionActions.push('generic_motivational_language_replaced_with_specific_payoff');
  if (WEAK_INTRO_PATTERN.test(rawScript)) revisionActions.push('weak_intro_rewritten_to_first_three_seconds_hook');
  if (!PROOF_PATTERN.test(fullText)) revisionActions.push('proof_or_example_added_before_publish');
  if (!VISUAL_PATTERN.test(fullText)) revisionActions.push('platform_visual_direction_added');
  if (!CTA_PATTERN.test(fullText)) revisionActions.push('single_primary_cta_added');
  const voiceFit = scoreVoiceFit(fullText, preflight);
  if (voiceFit.missingSignals.includes('no_voice_dna_configured')) {
    complianceWarnings.push('no_voice_dna_configured');
  }
  if (voiceFit.bannedPhraseHits.length > 0) {
    complianceWarnings.push('brand_voice_banned_phrase_review_required');
    revisionActions.push('remove_banned_or_off_brand_phrasing');
  }
  if (voiceFit.score < 65) revisionActions.push('strengthen_brand_voice_alignment');
  if (preflight.platform === 'short_form' && rawScript.length > 1800) complianceWarnings.push('short_form_script_too_long_for_platform');

  const hookScore = scoreBoolean(hook.length >= 18 && !WEAK_INTRO_PATTERN.test(hook), 96, 62);
  const proofScore = scoreBoolean(PROOF_PATTERN.test(fullText) || proofNotes.length > 0, 95, 70);
  const platformFitScore = scoreBoolean(preflight.platform !== 'short_form' || (visualDirection.length > 0 && editNotes.length > 0), 96, 68);
  const ctaScore = scoreBoolean(Boolean(cta && CTA_PATTERN.test(cta)), 95, 70);
  const structureScore = scoreBoolean(structuredOutput.beatByBeatScript.length >= 5, 96, 68);
  const retentionScore = scoreBoolean(editNotes.length >= 3 && structuredOutput.firstThreeSeconds.length >= 18, 95, 70);
  const voiceFitScore = voiceFit.score;
  const penalty = blockers.length * 25 + complianceWarnings.length * 4;
  const overallScore = clampScore(Math.round(
    (hookScore + retentionScore + proofScore + platformFitScore + voiceFitScore + ctaScore + structureScore) / 7 - penalty,
  ));

  return {
    hookScore,
    retentionScore,
    proofScore,
    platformFitScore,
    voiceFitScore,
    ctaScore,
    structureScore,
    overallScore,
    complianceWarnings: [...new Set(complianceWarnings)],
    revisionActions: [...new Set(revisionActions)],
    blockers,
    revisedScript: renderStructuredScript(structuredOutput),
    structuredOutput,
  };
}

export function scoreVoiceFit(
  text: string,
  preflight: Pick<ScriptPreflightBrief, 'audience' | 'toneVoiceConstraints' | 'voiceFitCriteria'>,
): { score: number; matchedSignals: string[]; missingSignals: string[]; bannedPhraseHits: string[] } {
  const criteria = preflight.voiceFitCriteria;
  const folded = text.toLowerCase();
  const matchedSignals: string[] = [];
  const missingSignals: string[] = [];
  const bannedPhraseHits = (criteria?.phrasesToAvoid ?? [])
    .map((phrase) => phrase.trim())
    .filter((phrase) => phrase.length >= 4 && phraseBoundaryHit(folded, phrase))
    .slice(0, 5);

  let score = criteria ? 58 : 42;
  if (!criteria) missingSignals.push('no_voice_dna_configured');
  if (preflight.toneVoiceConstraints.length > 0) {
    score += criteria ? 8 : 15;
    matchedSignals.push('tone_constraints_present');
  }
  if (criteria?.audience && tokenOverlapHit(folded, criteria.audience)) {
    score += 8;
    matchedSignals.push('audience_language_present');
  } else if (criteria?.audience) {
    missingSignals.push('audience_language_missing');
  }
  if ((criteria?.contentPillars ?? []).some((pillar) => tokenOverlapHit(folded, pillar))) {
    score += 8;
    matchedSignals.push('pillar_language_present');
  } else if ((criteria?.contentPillars ?? []).length > 0) {
    missingSignals.push('pillar_language_missing');
  }
  if (criteria && ((criteria.preferredCtas ?? []).some((cta) => tokenOverlapHit(folded, cta)) || CTA_PATTERN.test(text))) {
    score += 6;
    matchedSignals.push('cta_style_present');
  } else if ((criteria?.preferredCtas ?? []).length > 0) {
    missingSignals.push('cta_style_missing');
  }
  if (criteria && ((criteria.proofLibrary ?? []).some((proof) => tokenOverlapHit(folded, proof)) || PROOF_PATTERN.test(text))) {
    score += 6;
    matchedSignals.push('proof_style_present');
  } else if ((criteria?.proofLibrary ?? []).length > 0) {
    missingSignals.push('proof_style_missing');
  }
  if (bannedPhraseHits.length === 0 && (criteria?.phrasesToAvoid ?? []).length > 0) {
    score += 8;
    matchedSignals.push('banned_phrases_avoided');
  }
  score -= bannedPhraseHits.length * 16;
  if ((criteria?.confidence ?? 0) < 0.4) {
    score -= 5;
    missingSignals.push('voice_card_low_confidence');
  }

  return {
    score: clampScore(Math.round(score)),
    matchedSignals,
    missingSignals,
    bannedPhraseHits,
  };
}

function cleanLine(value?: string | null): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function deriveHook(script: string, topic: string, brief: ScriptPreflightBrief): string {
  const firstUsefulLine = script
    .split(/\n+/)
    .map(cleanLine)
    .find((line) => line.length >= 18 && !WEAK_INTRO_PATTERN.test(line));
  return firstUsefulLine || `The ${topic.trim()} mistake is not effort; it is missing the proof that makes people care.`;
}

function deriveCta(script: string, brief: ScriptPreflightBrief): string {
  const ctaLine = script
    .split(/\n+/)
    .map(cleanLine)
    .find((line) => CTA_PATTERN.test(line));
  if (ctaLine) return ctaLine.replace(/^(?:CTA|Fecho|Call to action)\s*:?\s*/i, '').trim();
  return brief.platform === 'short_form'
    ? 'Save this and test the first step today.'
    : 'Pick one action from this video and measure the result this week.';
}

function buildPromise(topic: string, brief: ScriptPreflightBrief): string {
  return brief.platform === 'short_form'
    ? `In under a minute, make ${topic.trim()} feel concrete, useful, and worth saving.`
    : `Show the audience the problem, the proof, and the practical rule behind ${topic.trim()}.`;
}

function buildShortSetup(topic: string, brief: ScriptPreflightBrief): string {
  return `Audience: ${brief.audience}. Emotional driver: ${brief.emotionalDriver}. Objective: ${brief.objective}`;
}

function buildBeats(script: string, brief: ScriptPreflightBrief): string[] {
  const existing = script
    .split(/\n+/)
    .map(cleanLine)
    .filter((line) => !/^(?:hook|intro|cta|call to action|fecho|abertura)\s*:?\s*$/i.test(line))
    .map((line) => line.replace(/^(?:hook|intro|cta|call to action|fecho|abertura)\s*:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const topicLabel = brief.objective
    .replace(/^Make\s+/i, '')
    .replace(/\s+useful, memorable, and worth acting on\.$/i, '')
    .trim();
  const defaultBeats = [
    `Name the specific tension behind ${topicLabel}.`,
    `Show the common mistake people make with ${topicLabel}.`,
    `Demonstrate one concrete reset, example, or proof point for ${topicLabel}.`,
    `Explain the operating rule the viewer should remember about ${topicLabel}.`,
    `Close with one action the viewer can test the next time ${topicLabel} comes up.`,
  ];
  const beats = existing.length >= 4 ? existing : [...existing, ...defaultBeats];
  const sliced = beats.slice(0, 10);
  if (brief.platform !== 'short_form') return sliced;
  const markers = ['0-3s', '3-8s', '8-15s', '15-25s', '25-35s', '35-45s', '45-55s', '55-60s'];
  return sliced.map((beat, index) => `[${markers[Math.min(index, markers.length - 1)]}] ${beat}`);
}

function buildVisualDirection(script: string, brief: ScriptPreflightBrief): string[] {
  const defaultShort = [
    'First frame: creator on screen with a concrete problem overlay.',
    'Show one proof object, screen, before/after, or demo by the second beat.',
    'Use native sound only when it supports the proof rhythm; keep voice/captions understandable without audio.',
    'Use large captions for the action step.',
  ];
  const defaultLong = [
    'Title/thumbnail promise should match the first section.',
    'Show proof, demo, source, or example before the first major transition.',
    'Use section cards or screen captures to reset attention.',
  ];
  return brief.platform === 'short_form' ? defaultShort : defaultLong;
}

function buildEditNotes(script: string, brief: ScriptPreflightBrief): string[] {
  return brief.platform === 'short_form'
    ? ['Cut dead air aggressively.', 'Reset attention every 2-3 beats.', 'Keep one idea per caption.', 'End on the CTA, not a second topic.']
    : ['Compress the intro.', 'Add retention resets between sections.', 'Bring proof earlier if the setup feels abstract.', 'Close with one CTA.'];
}

function buildProofNotes(script: string, sources: Array<Partial<SourceReference>>, brief: ScriptPreflightBrief): string[] {
  if (sources.length > 0) {
    return sources.slice(0, 4).map((source) => `${source.title}: ${source.relevance_note || 'Use as supporting context.'}`);
  }
  return brief.proofLibrary;
}

function buildRiskNotes(script: string): string[] {
  const notes = ['Review factual claims before publishing.'];
  if (ABSOLUTE_CLAIM_PATTERN.test(script)) notes.push('Remove guarantees or mark them as opinion before publishing.');
  return notes;
}

function renderStructuredScript(output: ScriptStructuredOutput): string {
  return [
    `FIRST 3 SECONDS:\n${output.firstThreeSeconds}`,
    `PROMISE:\n${output.promise}`,
    `SETUP:\n${output.shortSetup}`,
    `BEATS:\n${output.beatByBeatScript.map((beat, index) => `${index + 1}. ${beat}`).join('\n')}`,
    `VISUAL DIRECTION:\n${output.visualDirection.map((item) => `- ${item}`).join('\n')}`,
    `EDIT NOTES:\n${output.editNotes.map((item) => `- ${item}`).join('\n')}`,
    `PROOF / SOURCE NOTES:\n${output.proofSourceNotes.map((item) => `- ${item}`).join('\n')}`,
    `CTA:\n${output.cta}`,
    `RISK / CLAIM NOTES:\n${output.riskClaimNotes.map((item) => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

function scoreBoolean(value: boolean, yes: number, no: number): number {
  return value ? yes : no;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function tokenOverlapHit(textLower: string, candidate: string): boolean {
  const tokens = candidate
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
  if (tokens.length === 0) return false;
  const boundedTokens = tokens.slice(0, 8);
  const hits = boundedTokens.filter((token) => wordBoundaryHit(textLower, token)).length;
  return hits >= Math.min(2, boundedTokens.length);
}

function phraseBoundaryHit(textLower: string, phrase: string): boolean {
  const tokens = phrase
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const escaped = tokens.map(escapeRegExp).join('\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(textLower);
}

function wordBoundaryHit(textLower: string, token: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(token)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(textLower);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
