// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Cross-Agent Learning Service
 *
 * Builds per-agent context from peer signals so each agent can incorporate
 * learnings from other agents in its analysis. Pull-based model — each
 * agent requests what it needs before running.
 *
 * Signal flow:
 *   Performance → pillar_performance, hook_effectiveness, retention_pattern
 *   SEO         → keyword_opportunity, keyword_rank_change
 *   Reaction    → reaction_opportunity, trending_spike
 *   Voice       → voice_pattern, voice_phrase_trend
 *   Pipeline    → pipeline_bottleneck, pipeline_capacity
 *
 * Cross-agent consumption (NEW in v2):
 *   Performance reads: voice_pattern (correlate voice alignment with views)
 *   SEO reads: retention_pattern, hook_effectiveness (inform keyword strategy)
 *   Reaction reads: voice_pattern (suggest reactions in Felipe's style)
 *   Voice reads: pillar_performance (focus analysis on high-performing content)
 *   Pipeline reads: keyword_opportunity, hook_effectiveness (prioritize topics)
 */

import {
  readSignals, writeSignal, markConsumed,
  type SignalType, type AgentSignal,
} from './intelligence-bus';
import { logger } from '../utils/logger';

// ── Types ──────────────────────────────────────────────────────────

export interface AgentContext {
  /** Voice patterns from Voice Evolution Agent (phrases, style notes). */
  voicePatterns: VoiceContext[];
  /** Pillar performance rankings from Performance Agent. */
  pillarRankings: PillarContext[];
  /** Active hook effectiveness insights. */
  hookInsights: HookContext[];
  /** Retention patterns (what keeps viewers watching). */
  retentionInsights: RetentionContext[];
  /** Keyword opportunities from SEO Agent. */
  keywordOpportunities: KeywordContext[];
  /** Content formulas — validated content patterns that work. */
  contentFormulas: ContentFormulaContext[];
  /** Raw signals consumed (for agent run logging). */
  signalsConsumed: number;
}

export interface VoiceContext {
  observation: string;
  patterns: { pattern: string; frequency: string }[];
  strength: number;
}

export interface PillarContext {
  pillar: string;
  avgViews: number;
  engagementRate: number;
  trend: string;
}

export interface HookContext {
  hookType: string;
  effectiveness: number;
  examples: string[];
}

export interface RetentionContext {
  pattern: string;
  impact: string;
  avgRetention: number;
}

export interface KeywordContext {
  keyword: string;
  direction: string;
  volumeHint: string;
}

export interface ContentFormulaContext {
  formula: string;
  pillar: string;
  confidence: number;
  source: string;
}

// ── Agent-specific signal consumption maps ─────────────────────────

/** Which signal types each agent should consume from peers. */
const AGENT_PEER_SIGNALS: Record<string, SignalType[]> = {
  'performance-agent': ['voice_pattern', 'keyword_opportunity', 'content_formula'],
  'seo-agent': ['retention_pattern', 'hook_effectiveness', 'pillar_performance', 'content_formula'],
  'reaction-radar': ['voice_pattern', 'pillar_performance', 'hook_effectiveness', 'content_formula'],
  'voice-evolution': ['pillar_performance', 'retention_pattern', 'content_formula'],
  'pipeline-agent': ['keyword_opportunity', 'hook_effectiveness', 'pillar_performance', 'content_formula'],
};

// ── Context Builder ────────────────────────────────────────────────

/**
 * Build cross-agent context for a specific agent.
 * Reads peer signals and structures them into typed context.
 * Call this at the start of each agent run.
 */
export function buildAgentContext(agentName: string): AgentContext {
  const peerTypes = AGENT_PEER_SIGNALS[agentName] || [];
  if (peerTypes.length === 0) {
    return emptyContext();
  }

  const signals = readSignals(agentName, peerTypes, 100);
  let consumed = 0;

  const ctx: AgentContext = emptyContext();

  for (const signal of signals) {
    consumed++;
    try {
      switch (signal.signal_type) {
        case 'voice_pattern':
          ctx.voicePatterns.push(extractVoice(signal));
          break;
        case 'pillar_performance':
          ctx.pillarRankings.push(...extractPillarRankings(signal));
          break;
        case 'hook_effectiveness':
          ctx.hookInsights.push(extractHook(signal));
          break;
        case 'retention_pattern':
          ctx.retentionInsights.push(extractRetention(signal));
          break;
        case 'keyword_opportunity':
          ctx.keywordOpportunities.push(extractKeyword(signal));
          break;
        case 'content_formula':
          ctx.contentFormulas.push(extractFormula(signal));
          break;
      }
      markConsumed(signal.id, agentName);
    } catch (err) {
      logger.debug({ err, signal: signal.id }, 'Cross-agent: skipped malformed signal');
    }
  }

  ctx.signalsConsumed = consumed;
  logger.info(
    { agent: agentName, consumed, voices: ctx.voicePatterns.length, pillars: ctx.pillarRankings.length },
    'Cross-agent context built',
  );
  return ctx;
}

/**
 * Format cross-agent context as a text block for inclusion in agent prompts.
 * Returns empty string if no relevant learnings.
 */
export function formatContextForPrompt(ctx: AgentContext): string {
  const sections: string[] = [];

  if (ctx.voicePatterns.length > 0) {
    const voiceLines = ctx.voicePatterns
      .filter(v => v.strength >= 0.5)
      .slice(0, 5)
      .map(v => `  - ${v.observation} (confidence: ${(v.strength * 100).toFixed(0)}%)`);
    if (voiceLines.length > 0) {
      sections.push(`Voice patterns (from Voice Evolution Agent):\n${voiceLines.join('\n')}`);
    }
  }

  if (ctx.pillarRankings.length > 0) {
    const pillarLines = ctx.pillarRankings
      .slice(0, 5)
      .map(p => `  - ${p.pillar}: ${p.avgViews} avg views, ${(p.engagementRate * 100).toFixed(1)}% engagement, trend: ${p.trend}`);
    sections.push(`Pillar performance (from Performance Agent):\n${pillarLines.join('\n')}`);
  }

  if (ctx.hookInsights.length > 0) {
    const hookLines = ctx.hookInsights
      .slice(0, 3)
      .map(h => `  - ${h.hookType}: ${(h.effectiveness * 100).toFixed(0)}% effective`);
    sections.push(`Hook effectiveness (from Performance Agent):\n${hookLines.join('\n')}`);
  }

  if (ctx.keywordOpportunities.length > 0) {
    const kwLines = ctx.keywordOpportunities
      .filter(k => k.direction !== 'stable')
      .slice(0, 5)
      .map(k => `  - "${k.keyword}" — ${k.direction}, volume: ${k.volumeHint}`);
    if (kwLines.length > 0) {
      sections.push(`Keyword opportunities (from SEO Agent):\n${kwLines.join('\n')}`);
    }
  }

  if (ctx.contentFormulas.length > 0) {
    const formulaLines = ctx.contentFormulas
      .filter(f => f.confidence >= 0.6)
      .slice(0, 3)
      .map(f => `  - ${f.formula} (pillar: ${f.pillar}, confidence: ${(f.confidence * 100).toFixed(0)}%)`);
    if (formulaLines.length > 0) {
      sections.push(`Validated content formulas:\n${formulaLines.join('\n')}`);
    }
  }

  if (sections.length === 0) return '';
  return `\n--- Cross-Agent Learnings ---\n${sections.join('\n\n')}\n---`;
}

// ── Learning Digest Writer ─────────────────────────────────────────

/**
 * Produce a learning_digest signal that synthesizes insights from
 * multiple agents. Called weekly (after Performance Agent runs).
 */
export function produceLearningDigest(): number {
  const voiceSignals = readSignals('learning-digest', ['voice_pattern'], 10);
  const pillarSignals = readSignals('learning-digest', ['pillar_performance'], 5);
  const hookSignals = readSignals('learning-digest', ['hook_effectiveness'], 10);
  const kwSignals = readSignals('learning-digest', ['keyword_opportunity'], 10);

  if (voiceSignals.length === 0 && pillarSignals.length === 0) {
    return -1; // nothing to digest
  }

  // Extract top insights
  const topPillars = pillarSignals.flatMap(s => extractPillarRankings(s))
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, 3);

  const topVoice = voiceSignals
    .map(s => extractVoice(s))
    .filter(v => v.strength >= 0.7)
    .slice(0, 3);

  const risingKeywords = kwSignals
    .map(s => extractKeyword(s))
    .filter(k => k.direction === 'up' || k.direction === 'new')
    .slice(0, 5);

  const digest = {
    period: new Date().toISOString().slice(0, 10),
    topPillars,
    voiceInsights: topVoice,
    risingKeywords,
    hookCount: hookSignals.length,
    summary: buildDigestSummary(topPillars, topVoice, risingKeywords),
  };

  // Mark all source signals as consumed by digest
  for (const s of [...voiceSignals, ...pillarSignals, ...hookSignals, ...kwSignals]) {
    markConsumed(s.id, 'learning-digest');
  }

  return writeSignal({
    source_agent: 'learning-digest',
    signal_type: 'learning_digest',
    payload: digest,
    priority: 'normal',
  });
}

/**
 * Produce a content_formula signal when a successful pattern is detected.
 */
export function writeContentFormula(
  sourceAgent: string,
  formula: string,
  pillar: string,
  confidence: number,
  evidence: string,
): number {
  return writeSignal({
    source_agent: sourceAgent,
    signal_type: 'content_formula',
    payload: { formula, pillar, confidence, evidence, detected_at: new Date().toISOString() },
    priority: confidence >= 0.8 ? 'normal' : 'background',
  });
}

// ── Extractors (signal payload → typed context) ────────────────────

function extractVoice(signal: AgentSignal): VoiceContext {
  const p = signal.payload;
  return {
    observation: p.observation || p.description || '',
    patterns: Array.isArray(p.patterns) ? p.patterns.map((pt: any) => ({
      pattern: pt.pattern || pt.description || '',
      frequency: pt.frequency || 'unknown',
    })) : [],
    strength: typeof p.strength === 'number' ? p.strength : 0.5,
  };
}

function extractPillarRankings(signal: AgentSignal): PillarContext[] {
  const rankings = signal.payload.rankings;
  if (!Array.isArray(rankings)) return [];
  return rankings.map((r: any) => ({
    pillar: r.pillar || '',
    avgViews: r.avg_views || 0,
    engagementRate: r.engagement_rate || 0,
    trend: r.trend || 'stable',
  }));
}

function extractHook(signal: AgentSignal): HookContext {
  const p = signal.payload;
  return {
    hookType: p.hook_type || p.hookType || 'unknown',
    effectiveness: typeof p.effectiveness === 'number' ? p.effectiveness : 0.5,
    examples: Array.isArray(p.examples) ? p.examples : [],
  };
}

function extractRetention(signal: AgentSignal): RetentionContext {
  const p = signal.payload;
  return {
    pattern: p.pattern || p.description || '',
    impact: p.impact || 'neutral',
    avgRetention: typeof p.avg_retention === 'number' ? p.avg_retention : 0,
  };
}

function extractKeyword(signal: AgentSignal): KeywordContext {
  const p = signal.payload;
  return {
    keyword: p.keyword || '',
    direction: p.direction || 'stable',
    volumeHint: p.volume_hint || p.volumeHint || 'unknown',
  };
}

function extractFormula(signal: AgentSignal): ContentFormulaContext {
  const p = signal.payload;
  return {
    formula: p.formula || '',
    pillar: p.pillar || '',
    confidence: typeof p.confidence === 'number' ? p.confidence : 0.5,
    source: signal.source_agent,
  };
}

function buildDigestSummary(
  pillars: PillarContext[],
  voice: VoiceContext[],
  keywords: KeywordContext[],
): string {
  const parts: string[] = [];
  if (pillars.length > 0) {
    parts.push(`Top pillars: ${pillars.map(p => p.pillar).join(', ')}`);
  }
  if (voice.length > 0) {
    parts.push(`${voice.length} voice pattern(s) detected`);
  }
  if (keywords.length > 0) {
    parts.push(`${keywords.length} rising keyword(s): ${keywords.map(k => k.keyword).join(', ')}`);
  }
  return parts.join('. ') || 'No significant learnings this period';
}

function emptyContext(): AgentContext {
  return {
    voicePatterns: [],
    pillarRankings: [],
    hookInsights: [],
    retentionInsights: [],
    keywordOpportunities: [],
    contentFormulas: [],
    signalsConsumed: 0,
  };
}
