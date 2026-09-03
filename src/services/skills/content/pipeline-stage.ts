// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

// The canonical workspace currently proves only a saved script revision.
// Filming/editing need their own canonical evidence model, and publication has
// a separate explicit refusal path rather than a stage transition.
export const CONTENT_PIPELINE_TRANSITION_STAGES = ['scripted'] as const;

export type ContentPipelineTransitionStage = typeof CONTENT_PIPELINE_TRANSITION_STAGES[number];

const STAGE_PATTERN_BY_STAGE: Record<ContentPipelineTransitionStage, string> = {
  scripted: 'scripted|script\\s+ready|roteiro\\s+pronto|gui[oó]n\\s+listo|guion\\s+listo',
};

const PUBLISHED_STAGE_PATTERN = 'published|posted|publicado|publicada|publicaci[oó]n';

const STAGE_ALIASES: Array<{ stage: ContentPipelineTransitionStage; pattern: RegExp }> = CONTENT_PIPELINE_TRANSITION_STAGES.map((stage) => ({
  stage,
  pattern: new RegExp(`\\b(?:${STAGE_PATTERN_BY_STAGE[stage]})\\b`, 'i'),
}));

const TRANSITION_VERB = '(?:mark|set|record|track|log|move|advance|put|send|pass|promote|marca|marcar|regista|registar|registra|registrar|anota|anotar|mete|meter|move|mover|avanca|avança|avancar|avançar|envia|enviar|manda|mandar|poner|pon|pasa|pasar|mueve|avanza|avanzar)';
const TRANSITION_VERB_SIGNAL = new RegExp(`\\b${TRANSITION_VERB}\\b`, 'i');
const PUBLISHED_TRACKING_VERB = /\b(?:mark|set|record|track|log|marca|marcar|regista|registar|registra|registrar|anota|anotar)\b/i;
const ARTICLE = '(?:the|this|that|o|a|os|as|este|esta|esse|essa|el|la|este|esta)?';
const YOUTUBE_URL = /(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\S+)/i;

export interface ContentPipelineStageSlots {
  topicTitle: string | null;
  targetStage: ContentPipelineTransitionStage | null;
  youtubeUrl?: string | null;
  rawRequest?: string;
}

export interface ContentPublicationTrackingSlots {
  topicTitle: string | null;
  targetStage: 'published' | null;
  youtubeUrl?: string | null;
  rawRequest?: string;
}

export function normalizeContentPipelineTransitionStage(value: unknown): ContentPipelineTransitionStage | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  for (const alias of STAGE_ALIASES) {
    if (alias.pattern.test(trimmed)) return alias.stage;
  }
  if ((CONTENT_PIPELINE_TRANSITION_STAGES as readonly string[]).includes(trimmed)) {
    return trimmed as ContentPipelineTransitionStage;
  }
  return null;
}

export function parseContentPipelineStageTransition(text: string): ContentPipelineStageSlots {
  const targetStage = normalizeContentPipelineTransitionStage(text);
  if (!targetStage) return { topicTitle: null, targetStage: null };
  if (!TRANSITION_VERB_SIGNAL.test(text)) return { topicTitle: null, targetStage: null };

  return parseContentPipelineStageSlots(text, targetStage, STAGE_PATTERN_BY_STAGE[targetStage]);
}

export function parseContentPublicationTrackingRequest(text: string): ContentPublicationTrackingSlots {
  if (!new RegExp(`\\b(?:${PUBLISHED_STAGE_PATTERN})\\b`, 'i').test(text)) {
    return { topicTitle: null, targetStage: null };
  }
  if (!TRANSITION_VERB_SIGNAL.test(text) || !PUBLISHED_TRACKING_VERB.test(text)) {
    return { topicTitle: null, targetStage: null };
  }
  return parseContentPipelineStageSlots(text, 'published', PUBLISHED_STAGE_PATTERN);
}

function parseContentPipelineStageSlots<TStage extends ContentPipelineTransitionStage | 'published'>(
  text: string,
  targetStage: TStage,
  stageWords: string,
): {
  topicTitle: string | null;
  targetStage: TStage;
  youtubeUrl: string | null;
  rawRequest: string;
} {

  const youtubeUrl = text.match(YOUTUBE_URL)?.[1] ?? null;
  const withoutUrl = youtubeUrl ? text.replace(youtubeUrl, '').trim() : text;

  const patterns = [
    new RegExp(`${TRANSITION_VERB}\\s+${ARTICLE}\\s*(.+?)\\s+(?:as|to|into|for|para|como|a|em|en)\\s+(?:${stageWords})\\b`, 'i'),
    new RegExp(`${TRANSITION_VERB}\\s+${ARTICLE}\\s*(?:.+?)\\s+(?:as|to|into|for|para|como|a|em|en)\\s+(?:${stageWords})\\s+(.+)$`, 'i'),
    new RegExp(`(?:${stageWords})\\s+${ARTICLE}\\s*(.+)$`, 'i'),
    new RegExp(`${TRANSITION_VERB}\\s+${ARTICLE}\\s*(.+?)\\s+(?:${stageWords})\\b`, 'i'),
  ];

  let topicTitle: string | null = null;
  for (const pattern of patterns) {
    const match = withoutUrl.match(pattern);
    const candidate = cleanPipelineTopicTitle(match?.[1]);
    if (candidate) {
      topicTitle = candidate;
      break;
    }
  }

  if (!topicTitle) {
    topicTitle = cleanPipelineTopicTitle(
      withoutUrl
        .replace(new RegExp(stageWords, 'ig'), ' ')
        .replace(new RegExp(TRANSITION_VERB, 'ig'), ' '),
    );
  }

  return {
    topicTitle,
    targetStage,
    youtubeUrl,
    rawRequest: text,
  };
}

function cleanPipelineTopicTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[.?!]+$/g, '')
    .replace(/^\s*(?:the|this|that|o|a|os|as|este|esta|esse|essa|el|la|mi|meu|minha|my)\s+/i, '')
    .replace(/\s+(?:as|to|into|for|para|como|a|em|en)\s*$/i, '')
    .trim();
  if (cleaned.length < 3) return null;
  return cleaned;
}
