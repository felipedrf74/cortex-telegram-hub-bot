// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { SourceReference } from './content-engine';
import { normalizeSupportedLang, type Lang } from '../utils/i18n';

export interface ScriptPreflightBrief {
  language: Lang;
  audience: string;
  platform: 'youtube' | 'short_form' | 'generic';
  format: string;
  objective: string;
  emotionalDriver: string;
  proofLibrary: string[];
  toneVoiceConstraints: string[];
  retentionGoal: string;
  ctaGoal: string;
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
  /**
   * A derived quality suggestion for review. This is deliberately separate
   * from the user-visible/generated script: quality analysis must never
   * replace or truncate the engine's lossless output.
   */
  suggestedScript: string;
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
const CTA_PATTERN = /\b(?:save|comment|reply|subscribe|follow|book|try|test|measure|compare|watch|download|share|salva|salve|guarda|comenta|subscreve|segue|testa|mede|meça|compara|partilha|baixa)\b/i;
const VISUAL_PATTERN = /\b(?:visual|first frame|on screen|b-roll|cut to|show|caption|overlay|sfx|edit|camera|frame|screen|imagem|corte|mostra|legenda)\b/i;
const PROOF_PATTERN = /\b(?:proof|example|source|data|case|before|after|demo|reference|metric|evidence|prova|exemplo|fonte|dado|métrica)\b/i;

interface ScriptQualityCopy {
  audienceFallback: string;
  emotionalDriverShort: string;
  emotionalDriverLong: string;
  proofFallback: string;
  toneWithVoice: string;
  toneWithoutVoice: string;
  retentionLong: string;
  ctaGoal: string;
  supportingContext: string;
  riskReview: string;
  riskGuarantee: string;
  objective: (topic: string) => string;
  retentionShort: (duration: string) => string;
  bodyFallback: (topic: string) => string;
  titleOptions: (topic: string) => string[];
  hook: (topic: string) => string;
  ctaShort: string;
  ctaLong: string;
  promiseShort: (topic: string) => string;
  promiseLong: (topic: string) => string;
  setup: (audience: string, emotionalDriver: string, objective: string) => string;
  beats: (topic: string) => string[];
  visualShort: () => string[];
  visualLong: () => string[];
  editShort: () => string[];
  editLong: () => string[];
  headings: {
    firstThreeSeconds: string;
    promise: string;
    setup: string;
    beats: string;
    visualDirection: string;
    editNotes: string;
    proofSourceNotes: string;
    cta: string;
    riskClaimNotes: string;
  };
}

const SCRIPT_QUALITY_COPY: Record<Lang, ScriptQualityCopy> = {
  'en-US': {
    audienceFallback: 'specific audience for this topic',
    emotionalDriverShort: 'tension plus immediate payoff',
    emotionalDriverLong: 'curiosity plus credible progression',
    proofFallback: 'Add one concrete example, demo, source, or before/after proof before publishing.',
    toneWithVoice: 'Apply user-scoped Voice DNA without quoting it verbatim.',
    toneWithoutVoice: 'Use a clear creator voice; do not impersonate another creator.',
    retentionLong: 'Deliver the title/thumbnail promise early, then reset attention every major section.',
    ctaGoal: 'Give one clear next action, not multiple competing CTAs.',
    supportingContext: 'Use as supporting context.',
    riskReview: 'Review factual claims before publishing.',
    riskGuarantee: 'Remove guarantees or mark them as opinion before publishing.',
    objective: (topic) => `Make ${topic} useful, memorable, and worth acting on.`,
    retentionShort: (duration) => `Hold attention through ${duration} with a first-frame promise, quick proof, and one payoff.`,
    bodyFallback: (topic) => `Explain ${topic} with one concrete example and one action.`,
    titleOptions: (topic) => [`The ${topic} mistake nobody notices`, `${topic}: the proof-first version`],
    hook: (topic) => `The ${topic} mistake is not effort; it is missing the proof that makes people care.`,
    ctaShort: 'Save this and test the first step today.',
    ctaLong: 'Pick one action from this video and measure the result this week.',
    promiseShort: (topic) => `In under a minute, make ${topic} feel concrete, useful, and worth saving.`,
    promiseLong: (topic) => `Show the audience the problem, the proof, and the practical rule behind ${topic}.`,
    setup: (audience, emotionalDriver, objective) => `Audience: ${audience}. Emotional driver: ${emotionalDriver}. Objective: ${objective}`,
    beats: (topic) => [
      `Name the specific tension behind ${topic}.`,
      `Show the common mistake people make with ${topic}.`,
      `Demonstrate one concrete reset, example, or proof point for ${topic}.`,
      `Explain the operating rule the viewer should remember about ${topic}.`,
      `Close with one action the viewer can test the next time ${topic} comes up.`,
    ],
    visualShort: () => [
      'First frame: creator on screen with a concrete problem overlay.',
      'Show one proof object, screen, before/after, or demo by the second beat.',
      'Use native sound only when it supports the proof rhythm; keep voice/captions understandable without audio.',
      'Use large captions for the action step.',
    ],
    visualLong: () => [
      'Title/thumbnail promise should match the first section.',
      'Show proof, demo, source, or example before the first major transition.',
      'Use section cards or screen captures to reset attention.',
    ],
    editShort: () => [
      'Cut dead air aggressively.',
      'Reset attention every 2-3 beats.',
      'Keep one idea per caption.',
      'End on the CTA, not a second topic.',
    ],
    editLong: () => [
      'Compress the intro.',
      'Add retention resets between sections.',
      'Bring proof earlier if the setup feels abstract.',
      'Close with one CTA.',
    ],
    headings: {
      firstThreeSeconds: 'FIRST 3 SECONDS',
      promise: 'PROMISE',
      setup: 'SETUP',
      beats: 'BEATS',
      visualDirection: 'VISUAL DIRECTION',
      editNotes: 'EDIT NOTES',
      proofSourceNotes: 'PROOF / SOURCE NOTES',
      cta: 'CTA',
      riskClaimNotes: 'RISK / CLAIM NOTES',
    },
  },
  'pt-BR': {
    audienceFallback: 'público específico para este tema',
    emotionalDriverShort: 'tensão com recompensa imediata',
    emotionalDriverLong: 'curiosidade com progressão confiável',
    proofFallback: 'Adicione um exemplo concreto, demonstração, fonte ou prova de antes e depois antes de publicar.',
    toneWithVoice: 'Aplique o DNA de Voz do usuário sem citá-lo literalmente.',
    toneWithoutVoice: 'Use uma voz clara de criador; não imite outro criador.',
    retentionLong: 'Entregue cedo a promessa do título e da miniatura e recupere a atenção a cada seção importante.',
    ctaGoal: 'Dê uma próxima ação clara, sem várias chamadas concorrentes.',
    supportingContext: 'Use como contexto de apoio.',
    riskReview: 'Revise as afirmações factuais antes de publicar.',
    riskGuarantee: 'Remova garantias ou marque-as como opinião antes de publicar.',
    objective: (topic) => `Torne ${topic} útil, memorável e capaz de gerar ação.`,
    retentionShort: (duration) => `Prenda a atenção por ${duration} com uma promessa no primeiro quadro, uma prova rápida e uma recompensa.`,
    bodyFallback: (topic) => `Explique ${topic} com um exemplo concreto e uma ação.`,
    titleOptions: (topic) => [`O erro em ${topic} que ninguém percebe`, `${topic}: a versão guiada por provas`],
    hook: (topic) => `O erro em ${topic} não é falta de esforço; é falta da prova que faz as pessoas se importarem.`,
    ctaShort: 'Salve isto e teste o primeiro passo hoje.',
    ctaLong: 'Escolha uma ação deste vídeo e meça o resultado nesta semana.',
    promiseShort: (topic) => `Em menos de um minuto, torne ${topic} concreto, útil e digno de ser salvo.`,
    promiseLong: (topic) => `Mostre ao público o problema, a prova e a regra prática por trás de ${topic}.`,
    setup: (audience, emotionalDriver, objective) => `Público: ${audience}. Motivação emocional: ${emotionalDriver}. Objetivo: ${objective}`,
    beats: (topic) => [
      `Defina a tensão específica por trás de ${topic}.`,
      `Mostre o erro comum que as pessoas cometem com ${topic}.`,
      `Demonstre um ajuste, exemplo ou ponto de prova concreto para ${topic}.`,
      `Explique a regra prática que o público deve lembrar sobre ${topic}.`,
      `Termine com uma ação que o público possa testar quando ${topic} surgir novamente.`,
    ],
    visualShort: () => [
      'Primeiro quadro: criador em cena com uma sobreposição que mostra um problema concreto.',
      'Mostre um objeto de prova, tela, antes e depois ou demonstração até a segunda etapa.',
      'Use som nativo apenas quando ele apoiar o ritmo da prova; mantenha a voz e as legendas compreensíveis sem áudio.',
      'Use legendas grandes para o passo de ação.',
    ],
    visualLong: () => [
      'A promessa do título e da miniatura deve corresponder à primeira seção.',
      'Mostre uma prova, demonstração, fonte ou exemplo antes da primeira transição importante.',
      'Use cartões de seção ou capturas de tela para recuperar a atenção.',
    ],
    editShort: () => [
      'Corte pausas desnecessárias de forma agressiva.',
      'Recupere a atenção a cada 2 ou 3 etapas.',
      'Mantenha uma ideia por legenda.',
      'Termine na chamada para ação, sem introduzir um segundo tema.',
    ],
    editLong: () => [
      'Encurte a introdução.',
      'Adicione retomadas de atenção entre as seções.',
      'Antecipe a prova se o contexto parecer abstrato.',
      'Termine com uma única chamada para ação.',
    ],
    headings: {
      firstThreeSeconds: 'PRIMEIROS 3 SEGUNDOS',
      promise: 'PROMESSA',
      setup: 'CONTEXTO',
      beats: 'ETAPAS',
      visualDirection: 'DIREÇÃO VISUAL',
      editNotes: 'NOTAS DE EDIÇÃO',
      proofSourceNotes: 'NOTAS DE PROVAS / FONTES',
      cta: 'CHAMADA PARA AÇÃO',
      riskClaimNotes: 'NOTAS DE RISCO / AFIRMAÇÕES',
    },
  },
  'pt-PT': {
    audienceFallback: 'público específico para este tema',
    emotionalDriverShort: 'tensão com recompensa imediata',
    emotionalDriverLong: 'curiosidade com progressão credível',
    proofFallback: 'Adiciona um exemplo concreto, demonstração, fonte ou prova de antes e depois antes de publicar.',
    toneWithVoice: 'Aplica o ADN de Voz do utilizador sem o citar literalmente.',
    toneWithoutVoice: 'Usa uma voz clara de criador; não imites outro criador.',
    retentionLong: 'Entrega cedo a promessa do título e da miniatura e recupera a atenção em cada secção importante.',
    ctaGoal: 'Dá uma próxima ação clara, sem várias chamadas concorrentes.',
    supportingContext: 'Usa como contexto de apoio.',
    riskReview: 'Revê as afirmações factuais antes de publicar.',
    riskGuarantee: 'Remove garantias ou identifica-as como opinião antes de publicar.',
    objective: (topic) => `Torna ${topic} útil, memorável e capaz de gerar ação.`,
    retentionShort: (duration) => `Mantém a atenção durante ${duration} com uma promessa no primeiro plano, uma prova rápida e uma recompensa.`,
    bodyFallback: (topic) => `Explica ${topic} com um exemplo concreto e uma ação.`,
    titleOptions: (topic) => [`O erro em ${topic} que ninguém nota`, `${topic}: a versão orientada por provas`],
    hook: (topic) => `O erro em ${topic} não é a falta de esforço; é a falta da prova que faz as pessoas interessarem-se.`,
    ctaShort: 'Guarda isto e testa o primeiro passo hoje.',
    ctaLong: 'Escolhe uma ação deste vídeo e mede o resultado esta semana.',
    promiseShort: (topic) => `Em menos de um minuto, torna ${topic} concreto, útil e digno de ser guardado.`,
    promiseLong: (topic) => `Mostra ao público o problema, a prova e a regra prática por trás de ${topic}.`,
    setup: (audience, emotionalDriver, objective) => `Público: ${audience}. Motivação emocional: ${emotionalDriver}. Objetivo: ${objective}`,
    beats: (topic) => [
      `Define a tensão específica por trás de ${topic}.`,
      `Mostra o erro comum que as pessoas cometem com ${topic}.`,
      `Demonstra um ajuste, exemplo ou ponto de prova concreto para ${topic}.`,
      `Explica a regra prática que o público deve recordar sobre ${topic}.`,
      `Termina com uma ação que o público possa testar quando ${topic} voltar a surgir.`,
    ],
    visualShort: () => [
      'Primeiro plano: criador em cena com uma sobreposição de um problema concreto.',
      'Mostra um elemento de prova, ecrã, antes e depois ou demonstração até à segunda etapa.',
      'Usa som nativo apenas quando apoiar o ritmo da prova; mantém a voz e as legendas compreensíveis sem áudio.',
      'Usa legendas grandes para o passo de ação.',
    ],
    visualLong: () => [
      'A promessa do título e da miniatura deve corresponder à primeira secção.',
      'Mostra uma prova, demonstração, fonte ou exemplo antes da primeira transição importante.',
      'Usa cartões de secção ou capturas de ecrã para recuperar a atenção.',
    ],
    editShort: () => [
      'Corta agressivamente as pausas desnecessárias.',
      'Recupera a atenção a cada 2 ou 3 etapas.',
      'Mantém uma ideia por legenda.',
      'Termina na chamada para ação, sem introduzir um segundo tema.',
    ],
    editLong: () => [
      'Encurta a introdução.',
      'Adiciona retomadas de atenção entre as secções.',
      'Antecipa a prova se o contexto parecer abstrato.',
      'Termina com uma única chamada para ação.',
    ],
    headings: {
      firstThreeSeconds: 'PRIMEIROS 3 SEGUNDOS',
      promise: 'PROMESSA',
      setup: 'CONTEXTO',
      beats: 'ETAPAS',
      visualDirection: 'DIREÇÃO VISUAL',
      editNotes: 'NOTAS DE EDIÇÃO',
      proofSourceNotes: 'NOTAS DE PROVAS / FONTES',
      cta: 'CHAMADA PARA AÇÃO',
      riskClaimNotes: 'NOTAS DE RISCO / AFIRMAÇÕES',
    },
  },
};

export function buildScriptPreflightBrief(params: {
  topic: string;
  niche?: string | null;
  format?: string | null;
  language?: string | null;
  cta?: string | null;
  targetDurationSeconds?: number | null;
  sources?: Array<Partial<SourceReference>> | null;
  voiceMemory?: string | null;
}): ScriptPreflightBrief {
  const language = normalizeSupportedLang(params.language, 'en-US');
  const copy = SCRIPT_QUALITY_COPY[language];
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
    language,
    audience: params.niche?.trim() || copy.audienceFallback,
    platform,
    format,
    objective: copy.objective(params.topic.trim()),
    emotionalDriver: platform === 'short_form' ? copy.emotionalDriverShort : copy.emotionalDriverLong,
    proofLibrary: proofLibrary.length > 0 ? proofLibrary : [copy.proofFallback],
    toneVoiceConstraints: params.voiceMemory?.trim()
      ? [copy.toneWithVoice]
      : [copy.toneWithoutVoice],
    retentionGoal: platform === 'short_form'
      ? copy.retentionShort(duration)
      : copy.retentionLong,
    ctaGoal: params.cta?.trim() || copy.ctaGoal,
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
  const language = normalizeSupportedLang(
    input.language ?? input.preflightBrief?.language,
    'en-US',
  );
  const copy = SCRIPT_QUALITY_COPY[language];
  const preflight = input.preflightBrief ?? buildScriptPreflightBrief({
    topic: input.topic,
    format: input.format,
    language,
    cta: input.cta,
    sources: input.sources,
  });
  const rawScript = (input.script || '').trim();
  const hook = cleanLine(input.hook) || deriveHook(rawScript, input.topic, copy);
  const cta = cleanLine(input.cta) || deriveCta(rawScript, preflight, copy);
  const titleOptions = (input.titleOptions ?? []).map(cleanLine).filter(Boolean).slice(0, 5);
  const scriptWithoutWeakIntro = rawScript
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !WEAK_INTRO_PATTERN.test(line))
    .join('\n');
  const baseBody = scriptWithoutWeakIntro || rawScript || copy.bodyFallback(input.topic);
  const visualDirection = buildVisualDirection(preflight, copy);
  const editNotes = buildEditNotes(preflight, copy);
  const proofNotes = buildProofNotes(input.sources ?? [], preflight, copy);
  const riskClaimNotes = buildRiskNotes(baseBody, copy);
  const structuredOutput: ScriptStructuredOutput = {
    titleOptions: titleOptions.length > 0 ? titleOptions : copy.titleOptions(input.topic),
    firstThreeSeconds: hook,
    promise: buildPromise(input.topic, preflight, copy),
    shortSetup: buildShortSetup(preflight, copy),
    beatByBeatScript: buildBeats(baseBody, input.topic, preflight, copy),
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
  if (preflight.platform === 'short_form' && rawScript.length > 1800) complianceWarnings.push('short_form_script_too_long_for_platform');

  const hookScore = scoreBoolean(hook.length >= 18 && !WEAK_INTRO_PATTERN.test(hook), 96, 62);
  const proofScore = scoreBoolean(PROOF_PATTERN.test(fullText) || proofNotes.length > 0, 95, 70);
  const platformFitScore = scoreBoolean(preflight.platform !== 'short_form' || (visualDirection.length > 0 && editNotes.length > 0), 96, 68);
  const ctaScore = scoreBoolean(Boolean(cta && CTA_PATTERN.test(cta)), 95, 70);
  const structureScore = scoreBoolean(structuredOutput.beatByBeatScript.length >= 5, 96, 68);
  const retentionScore = scoreBoolean(editNotes.length >= 3 && structuredOutput.firstThreeSeconds.length >= 18, 95, 70);
  const voiceFitScore = scoreBoolean(preflight.toneVoiceConstraints.length > 0, 93, 78);
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
    suggestedScript: renderStructuredScript(structuredOutput, copy),
    structuredOutput,
  };
}

function cleanLine(value?: string | null): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function deriveHook(script: string, topic: string, copy: ScriptQualityCopy): string {
  const firstUsefulLine = script
    .split(/\n+/)
    .map(cleanLine)
    .find((line) => line.length >= 18 && !WEAK_INTRO_PATTERN.test(line));
  return firstUsefulLine || copy.hook(topic.trim());
}

function deriveCta(script: string, brief: ScriptPreflightBrief, copy: ScriptQualityCopy): string {
  const ctaLine = script
    .split(/\n+/)
    .map(cleanLine)
    .find((line) => CTA_PATTERN.test(line));
  if (ctaLine) return ctaLine.replace(/^(?:CTA|Fecho|Call to action)\s*:?\s*/i, '').trim();
  return brief.platform === 'short_form'
    ? copy.ctaShort
    : copy.ctaLong;
}

function buildPromise(topic: string, brief: ScriptPreflightBrief, copy: ScriptQualityCopy): string {
  return brief.platform === 'short_form'
    ? copy.promiseShort(topic.trim())
    : copy.promiseLong(topic.trim());
}

function buildShortSetup(brief: ScriptPreflightBrief, copy: ScriptQualityCopy): string {
  return copy.setup(brief.audience, brief.emotionalDriver, brief.objective);
}

function buildBeats(
  script: string,
  topic: string,
  brief: ScriptPreflightBrief,
  copy: ScriptQualityCopy,
): string[] {
  const existing = script
    .split(/\n+/)
    .map(cleanLine)
    .filter((line) => !/^(?:hook|intro|cta|call to action|fecho|abertura)\s*:?\s*$/i.test(line))
    .map((line) => line.replace(/^(?:hook|intro|cta|call to action|fecho|abertura)\s*:\s*/i, '').trim())
    .filter(Boolean)
    .slice(0, 8);
  const defaultBeats = copy.beats(topic.trim());
  const beats = existing.length >= 4 ? existing : [...existing, ...defaultBeats];
  const sliced = beats.slice(0, 10);
  if (brief.platform !== 'short_form') return sliced;
  const markers = ['0-3s', '3-8s', '8-15s', '15-25s', '25-35s', '35-45s', '45-55s', '55-60s'];
  return sliced.map((beat, index) => `[${markers[Math.min(index, markers.length - 1)]}] ${beat}`);
}

function buildVisualDirection(brief: ScriptPreflightBrief, copy: ScriptQualityCopy): string[] {
  return brief.platform === 'short_form' ? copy.visualShort() : copy.visualLong();
}

function buildEditNotes(brief: ScriptPreflightBrief, copy: ScriptQualityCopy): string[] {
  return brief.platform === 'short_form'
    ? copy.editShort()
    : copy.editLong();
}

function buildProofNotes(
  sources: Array<Partial<SourceReference>>,
  brief: ScriptPreflightBrief,
  copy: ScriptQualityCopy,
): string[] {
  if (sources.length > 0) {
    return sources.slice(0, 4).map((source) => `${source.title}: ${source.relevance_note || copy.supportingContext}`);
  }
  return brief.proofLibrary;
}

function buildRiskNotes(script: string, copy: ScriptQualityCopy): string[] {
  const notes = [copy.riskReview];
  if (ABSOLUTE_CLAIM_PATTERN.test(script)) notes.push(copy.riskGuarantee);
  return notes;
}

function renderStructuredScript(output: ScriptStructuredOutput, copy: ScriptQualityCopy): string {
  return [
    `${copy.headings.firstThreeSeconds}:\n${output.firstThreeSeconds}`,
    `${copy.headings.promise}:\n${output.promise}`,
    `${copy.headings.setup}:\n${output.shortSetup}`,
    `${copy.headings.beats}:\n${output.beatByBeatScript.map((beat, index) => `${index + 1}. ${beat}`).join('\n')}`,
    `${copy.headings.visualDirection}:\n${output.visualDirection.map((item) => `- ${item}`).join('\n')}`,
    `${copy.headings.editNotes}:\n${output.editNotes.map((item) => `- ${item}`).join('\n')}`,
    `${copy.headings.proofSourceNotes}:\n${output.proofSourceNotes.map((item) => `- ${item}`).join('\n')}`,
    `${copy.headings.cta}:\n${output.cta}`,
    `${copy.headings.riskClaimNotes}:\n${output.riskClaimNotes.map((item) => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

function scoreBoolean(value: boolean, yes: number, no: number): number {
  return value ? yes : no;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}
