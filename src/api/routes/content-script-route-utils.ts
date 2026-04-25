// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildGenerationMeta, type GenerationMode } from './content-generation-meta';

export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptFormat = 'YouTube' | 'Reel';
export type ScriptStyle = 'detailed' | 'bullets';

interface ContentKnowledgeLike {
  category?: string | null;
  synthesized_text?: string | null;
}

export interface ScriptSourceUsed {
  title?: string;
  url?: string;
  source_type?: string;
  relevance_note?: string;
}

export interface ContentScriptEngineResult {
  topic: string;
  script: string;
  hook?: string;
  title_options?: string[];
  sources_used?: ScriptSourceUsed[] | null;
  estimated_duration?: string;
  duration_ms?: number;
  hashtags?: string[];
  caption?: string;
  cta?: string;
  degraded?: boolean;
  warnings?: string[];
}

export function resolveScriptGenerationMode(mode: unknown): GenerationMode {
  return mode === 'quick' || mode === 'standard' || mode === 'deep'
    ? mode
    : 'standard';
}

export function resolveScriptRenderMode(renderMode: unknown): ScriptRenderMode {
  if (typeof renderMode !== 'string') return 'structured';
  const normalized = renderMode.trim().toLowerCase();
  return normalized === 'structured' || normalized === 'chat'
    ? normalized
    : 'structured';
}

export function resolveScriptStyle(style: unknown): ScriptStyle {
  if (typeof style !== 'string') return 'detailed';
  const normalized = style.trim().toLowerCase();
  if (['bullet', 'bullets', 'outline', 'pontos'].includes(normalized) || normalized.includes('ponto')) return 'bullets';
  if (
    ['detailed', 'full', 'script', 'roteiro', 'completo'].includes(normalized)
    || normalized.includes('roteiro')
    || normalized.includes('complete')
  ) return 'detailed';
  return 'detailed';
}

export function resolveScriptTargetLanguage(
  language: unknown,
  userId: number,
  readUserLanguage: (userId: number) => string | undefined | null,
): string {
  if (typeof language === 'string' && language.trim().length > 0) {
    return language.trim();
  }

  try {
    return readUserLanguage(userId) || 'pt-BR';
  } catch {
    return 'pt-BR';
  }
}

export function buildUserVoiceMemory(
  userId: number,
  readAllKnowledge: (userId: number) => ContentKnowledgeLike[],
): string | null {
  try {
    const knowledge = readAllKnowledge(userId) || [];
    const preferredCategories = [
      'brand_voice',
      'voice_summary',
      'voice_pattern',
      'voice_phrase_trend',
      'hook_style',
      'storytelling',
      'content_structure',
      'cta_pattern',
      'audience_engagement',
    ];
    const byCategory = new Map<string, string>();

    for (const entry of knowledge) {
      const category = (entry.category || '').trim();
      const text = (entry.synthesized_text || '').trim();
      if (!category || !text || byCategory.has(category)) continue;
      byCategory.set(category, text);
    }

    const lines = preferredCategories
      .map((category) => {
        const text = byCategory.get(category);
        return text ? `[${category}] ${text}` : null;
      })
      .filter((line): line is string => Boolean(line));

    if (lines.length === 0) return null;
    return lines.join('\n\n').slice(0, 6000);
  } catch {
    return null;
  }
}

export function buildScriptCreatorProfile(params: {
  language: string;
  niche?: string | null;
  voiceMemory?: string | null;
}): string {
  const language = params.language?.trim() || 'pt-BR';
  const niche = params.niche?.trim() || 'general';
  const lines = [
    'Creator scope: current authenticated Nexus Hub user only.',
    `Primary output language: ${language}.`,
    `Requested niche/context: ${niche}.`,
  ];

  const voiceMemory = params.voiceMemory?.trim();
  if (voiceMemory) {
    lines.push(
      'User-scoped Voice DNA follows. Apply it to sentence rhythm, stance, vocabulary, examples, and CTA style without quoting it verbatim.',
      voiceMemory.slice(0, 6000),
    );
  } else {
    lines.push(
      'No stored Voice DNA exists yet. Use a neutral creator voice grounded in this topic, niche, language, and research. Do not borrow another creator identity, brand, audience, politics, biography, or hashtags.',
    );
  }

  return lines.join('\n');
}

export function buildScriptSuccessResponse(params: {
  result: ContentScriptEngineResult;
  format: ScriptFormat;
  renderMode: ScriptRenderMode;
  scriptStyle: ScriptStyle;
  generationMode: GenerationMode;
  startMs: number;
  cacheHit: boolean;
}) {
  const {
    result,
    format,
    renderMode,
    scriptStyle,
    generationMode,
    startMs,
    cacheHit,
  } = params;

  const sources = Array.isArray(result.sources_used) ? result.sources_used : [];

  return {
    topic: result.topic,
    script: result.script,
    hook: result.hook,
    titleOptions: result.title_options,
    sourcesUsed: sources.map((source) => ({
      title: source.title,
      url: source.url,
      sourceType: source.source_type,
      relevanceNote: source.relevance_note,
    })),
    estimatedDuration: result.estimated_duration,
    format,
    renderMode,
    scriptStyle,
    durationMs: result.duration_ms,
    hashtags: result.hashtags ?? [],
    caption: result.caption ?? '',
    cta: result.cta ?? '',
    degraded: result.degraded ?? false,
    warnings: result.warnings ?? [],
    generation: buildGenerationMeta({
      mode: generationMode,
      startMs,
      cacheHit,
      provider: 'content-engine',
      researchUsed: generationMode !== 'quick' && !cacheHit,
    }),
    // Backward compat — keep old fields until iOS migrates.
    generationMode,
    cacheHit,
    usageImpact: cacheHit ? 'none' : generationMode === 'deep' ? 'high' : generationMode,
  };
}
