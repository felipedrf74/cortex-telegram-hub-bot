// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { buildGenerationMeta, type GenerationMode } from './content-generation-meta';

export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptFormat = 'YouTube' | 'Reel';

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

export function buildScriptSuccessResponse(params: {
  result: ContentScriptEngineResult;
  format: ScriptFormat;
  renderMode: ScriptRenderMode;
  generationMode: GenerationMode;
  startMs: number;
  cacheHit: boolean;
}) {
  const {
    result,
    format,
    renderMode,
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
