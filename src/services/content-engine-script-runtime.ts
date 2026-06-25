// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { AgentSignal } from './intelligence-bus';
import type { ScriptTopicContext } from './content-engine';
import { requireTenantIdParam } from './tenant-scope';

export type ScriptGenerationMode = 'draft' | 'quick' | 'standard' | 'deep';
export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptStyle = 'detailed' | 'bullets';

export const MODE_CONFIG: Record<ScriptGenerationMode, { cacheTtl: number; signalDays: number; timeoutMs: number }> = {
  draft: { cacheTtl: 48 * 3600, signalDays: 0, timeoutMs: 45_000 },
  quick: { cacheTtl: 48 * 3600, signalDays: 0, timeoutMs: 60_000 },
  standard: { cacheTtl: 24 * 3600, signalDays: 14, timeoutMs: 120_000 },
  deep: { cacheTtl: 0, signalDays: 90, timeoutMs: 300_000 },
};

export function normalizeScriptLanguage(language?: string | null): string {
  const normalized = String(language || 'pt-BR').trim().toLowerCase();
  if (normalized.startsWith('en')) return 'en-US';
  if (normalized === 'pt-pt' || normalized.includes('european')) return 'pt-PT';
  return 'pt-BR';
}

export function normalizeScriptRenderMode(renderMode?: string | null): ScriptRenderMode {
  return String(renderMode || 'structured').trim().toLowerCase() === 'chat'
    ? 'chat'
    : 'structured';
}

export function normalizeScriptStyle(style?: string | null): ScriptStyle {
  const normalized = String(style || 'detailed').trim().toLowerCase();
  return ['bullet', 'bullets', 'outline', 'pontos'].includes(normalized)
    ? 'bullets'
    : 'detailed';
}

function hashBrandVoice(brandVoice?: string | null): string {
  const normalized = (brandVoice || '').trim();
  if (!normalized) return 'default';
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function hashScriptContext(context?: ScriptTopicContext | null): string {
  if (!context) return 'default';
  const normalized = {
    ideaId: context.ideaId ?? null,
    pipelineId: context.pipelineId ?? null,
    topicFeedbackId: context.topicFeedbackId ?? null,
    niche: context.niche?.trim().toLowerCase() || null,
    hookIdea: context.hookIdea?.trim().toLowerCase() || null,
    whyNow: context.whyNow?.trim().toLowerCase() || null,
    angleTag: context.angleTag?.trim().toLowerCase() || null,
    sourceJob: context.sourceJob?.trim().toLowerCase() || null,
  };
  if (Object.values(normalized).every((value) => value == null)) return 'default';
  return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex').slice(0, 12);
}

function hashRegenerationSeed(seed?: string | null): string | null {
  const normalized = (seed || '').trim();
  if (!normalized) return null;
  return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
}

function tokenizeContentText(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9à-ÿ]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

export function collectSignalPayloadText(payload: unknown): string {
  if (payload == null) return '';
  if (typeof payload === 'string' || typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => collectSignalPayloadText(item)).join(' ');
  }
  if (typeof payload === 'object') {
    return Object.values(payload as Record<string, unknown>)
      .map((item) => collectSignalPayloadText(item))
      .join(' ');
  }
  return '';
}

const SIGNAL_TYPE_RELEVANCE_WEIGHT: Partial<Record<string, number>> = {
  hook_effectiveness: 1.4,
  voice_pattern: 1.25,
  voice_phrase_trend: 1.15,
  keyword_rank_change: 1.1,
  pillar_performance: 1.0,
  retention_pattern: 0.95,
  channel_dna: 0.9,
  book_knowledge: 0.85,
};

export function rankScriptSignals(
  signals: AgentSignal[],
  topic: string,
  niche: string,
  scriptContext?: ScriptTopicContext | null,
): AgentSignal[] {
  const keywordSet = new Set([
    ...tokenizeContentText(topic),
    ...tokenizeContentText(niche),
    ...tokenizeContentText(scriptContext?.hookIdea || ''),
    ...tokenizeContentText(scriptContext?.whyNow || ''),
    ...tokenizeContentText(scriptContext?.angleTag || ''),
  ]);

  if (keywordSet.size === 0) return signals;

  return [...signals]
    .map((signal, index) => {
      const haystack = `${signal.signal_type} ${collectSignalPayloadText(signal.payload)}`.toLowerCase();
      let topicalMatches = 0;
      for (const keyword of keywordSet) {
        if (haystack.includes(keyword)) topicalMatches++;
      }

      const topicalScore = Math.min(topicalMatches, 5) * 0.45;
      const typeScore = SIGNAL_TYPE_RELEVANCE_WEIGHT[signal.signal_type] ?? 0.7;
      const freshnessScore = Math.max(0, 1 - index / Math.max(1, signals.length)) * 0.35;
      return {
        signal,
        score: topicalScore + typeScore + freshnessScore,
      };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.signal);
}

export function buildScriptCacheKey(
  topic: string,
  niche = 'general',
  maxDuration = 8,
  format = 'YouTube',
  targetDurationSeconds?: number | null,
  mode: ScriptGenerationMode = 'draft',
  brandVoice?: string | null,
  language?: string | null,
  renderMode: ScriptRenderMode = 'structured',
  userId?: number,
  scriptContext?: ScriptTopicContext | null,
  scriptStyle: ScriptStyle = 'detailed',
  regenerationSeed?: string | null,
  tenantId?: number,
): string {
  const tenantKey = tenantId == null && userId == null
    ? 'global'
    : String(requireTenantIdParam(tenantId, 'buildScriptCacheKey'));
  const parts = [
    'script-v8',
    topic.toLowerCase().trim(),
    niche,
    format,
    `duration:${maxDuration}`,
    `target:${targetDurationSeconds ?? maxDuration * 60}`,
    `mode:${mode}`,
    `lang:${normalizeScriptLanguage(language)}`,
    `voice:${hashBrandVoice(brandVoice)}`,
    `render:${normalizeScriptRenderMode(renderMode)}`,
    `style:${normalizeScriptStyle(scriptStyle)}`,
    `ctx:${hashScriptContext(scriptContext)}`,
    `scope:${userId ?? 'global'}`,
    `tenant:${tenantKey}`,
  ];
  const seedHash = hashRegenerationSeed(regenerationSeed);
  if (seedHash) parts.push(`regen:${seedHash}`);
  return parts.join(':');
}
