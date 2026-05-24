// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const CONTENT_PIPELINE_TRANSITION_STAGES = ['scripted', 'filmed', 'editing', 'published'] as const;

export type ContentPipelineTransitionStage = typeof CONTENT_PIPELINE_TRANSITION_STAGES[number];

const STAGE_PATTERN_BY_STAGE: Record<ContentPipelineTransitionStage, string> = {
  scripted: 'scripted|script\\s+ready|roteiro\\s+pronto|gui[oó]n\\s+listo|guion\\s+listo',
  filmed: 'filmed|filming|ready\\s+to\\s+film|filmado|filmada|gravado|gravada|filmagem|grabado|grabada',
  editing: 'editing|edit|edited|ready\\s+to\\s+edit|edi[cç][aã]o|editar|editado|editada|edici[oó]n|editarlo',
  published: 'published|posted|live|publicado|publicada|publicaci[oó]n',
};

const STAGE_ALIASES: Array<{ stage: ContentPipelineTransitionStage; pattern: RegExp }> = CONTENT_PIPELINE_TRANSITION_STAGES.map((stage) => ({
  stage,
  pattern: new RegExp(`\\b(?:${STAGE_PATTERN_BY_STAGE[stage]})\\b`, 'i'),
}));

const TRANSITION_VERB = '(?:mark|set|move|advance|put|send|pass|promote|marca|marcar|mete|meter|move|mover|avanca|avança|avancar|avançar|envia|enviar|manda|mandar|poner|pon|pasa|pasar|avanza|avanzar)';
const ARTICLE = '(?:the|this|that|o|a|os|as|este|esta|esse|essa|el|la|este|esta)?';
const YOUTUBE_URL = /(https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\S+)/i;

export interface ContentPipelineStageSlots {
  topicTitle: string | null;
  targetStage: ContentPipelineTransitionStage | null;
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

  const youtubeUrl = text.match(YOUTUBE_URL)?.[1] ?? null;
  const withoutUrl = youtubeUrl ? text.replace(youtubeUrl, '').trim() : text;
  const stageWords = STAGE_PATTERN_BY_STAGE[targetStage];

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
