// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 5 batch 28 (2026-05-15): telemetry-driven readableIntents proposer.
//
// Cross-references the Phase 4 telemetry report's phrase-gap candidates with
// the current registry `readableIntents` arrays to surface actions whose
// example bank is undersized relative to user-clarification volume.
//
// The proposer DOES NOT generate intent strings — telemetry doesn't store
// user-text. It surfaces COVERAGE GAPS by computing:
//
//   • current readableIntents count
//   • clarification volume (rows where outcome = needs_clarification)
//   • coverage score = readableIntents.length / (1 + clarificationVolume)
//
// Low-score actions are surfaced as candidates. Felipe (or Phase 6
// automation) reviews the list, samples conversations from that action's
// telemetry timeframe, and adds new readableIntents + examples to the
// registry.

import Database from 'better-sqlite3';
import {
  readTelemetryRows,
  summarizeByAction,
  type ActionTelemetrySummary,
} from './registry-telemetry-report';
import {
  getChatActionRegistry,
  type ChatActionDefinition,
} from './chat-action-registry';

export interface ReadableIntentsProposal {
  skill: string;
  action: string;
  currentReadableIntentsCount: number;
  currentExamplesCount: number;
  clarificationVolume: number;
  totalVolume: number;
  clarificationRate: number;
  coverageScore: number;
  recommendation: string;
}

export interface ReadableIntentsProposerOptions {
  since?: string;
  tenantId?: number;
  /** Minimum volume per action to consider. Default: 5. */
  minVolume?: number;
  /** Maximum coverage score for an action to surface. Default: 0.3. */
  maxCoverageScore?: number;
}

/**
 * Builds a list of registry actions whose readableIntents coverage is
 * undersized for the observed clarification volume. Lower coverage score =
 * higher priority.
 */
export function proposeReadableIntentsExtensions(
  db: Database.Database,
  options: ReadableIntentsProposerOptions = {},
): ReadableIntentsProposal[] {
  const rows = readTelemetryRows(db, {
    since: options.since,
    tenantId: options.tenantId,
  });
  const summaries = summarizeByAction(rows);
  const registry = getChatActionRegistry();
  const byKey = new Map<string, ChatActionDefinition>();
  for (const entry of registry) {
    byKey.set(`${entry.skill}/${entry.action}`, entry);
  }

  const minVolume = options.minVolume ?? 5;
  const maxCoverageScore = options.maxCoverageScore ?? 0.3;
  const proposals: ReadableIntentsProposal[] = [];
  for (const summary of summaries) {
    if (!summary.skill || !summary.action) continue;
    if (summary.total < minVolume) continue;
    const entry = byKey.get(`${summary.skill}/${summary.action}`);
    if (!entry) continue;
    const proposal = computeProposal(entry, summary);
    if (proposal.coverageScore > maxCoverageScore) continue;
    proposals.push(proposal);
  }
  proposals.sort((a, b) => a.coverageScore - b.coverageScore);
  return proposals;
}

function computeProposal(
  entry: ChatActionDefinition,
  summary: ActionTelemetrySummary,
): ReadableIntentsProposal {
  const readableIntentsCount = entry.readableIntents.length;
  const examplesCount = (entry.examples ?? []).length;
  const clarificationVolume =
    (summary.outcomes.needs_clarification ?? 0) + (summary.outcomes.clarification ?? 0);
  // Coverage score: a higher readableIntents bank with low clarification
  // volume is well-covered (high score). Low score = undersized bank for the
  // user-clarification volume observed.
  const coverageScore = readableIntentsCount / (1 + clarificationVolume);
  const recommendation = buildRecommendation(entry, summary, readableIntentsCount, examplesCount);
  return {
    skill: entry.skill,
    action: entry.action,
    currentReadableIntentsCount: readableIntentsCount,
    currentExamplesCount: examplesCount,
    clarificationVolume,
    totalVolume: summary.total,
    clarificationRate: summary.clarificationRate,
    coverageScore,
    recommendation,
  };
}

function buildRecommendation(
  _entry: ChatActionDefinition,
  summary: ActionTelemetrySummary,
  intentsCount: number,
  examplesCount: number,
): string {
  const parts: string[] = [];
  if (intentsCount <= 1) {
    parts.push('Add ≥2 paraphrase variants to readableIntents (current bank is minimal)');
  }
  if (examplesCount <= 1) {
    parts.push('Add ≥1 golden example covering the common user phrasing');
  }
  if (summary.clarificationRate > 0.5) {
    parts.push('High clarification rate: review conversations to identify a recurring phrasing the parser misses');
  }
  if (summary.byTier.tier2_structured_planner && summary.byTier.tier2_structured_planner / summary.total > 0.5) {
    parts.push('Frequently lands in tier2 (LLM planner) — likely missing a deterministic parser branch');
  }
  if (parts.length === 0) parts.push('Review timeline of recent clarification conversations.');
  return parts.join('; ');
}

/** Emits a markdown report of the proposals. */
export function formatReadableIntentsProposalsMarkdown(
  proposals: ReadableIntentsProposal[],
): string {
  const lines: string[] = [];
  lines.push(`# Chat Action Registry — readableIntents Proposer`);
  lines.push(``);
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push(``);
  lines.push(`Lower coverage score = higher priority. Actions are surfaced when their readableIntents bank is undersized for the observed clarification volume.`);
  lines.push(``);
  if (proposals.length === 0) {
    lines.push(`_No actions exceed the coverage-gap threshold._`);
    return lines.join('\n');
  }
  lines.push(`| Skill.Action | Coverage | Clarify% | Vol | Intents | Examples | Recommendation |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const p of proposals) {
    lines.push(
      `| ${p.skill}.${p.action} | ${p.coverageScore.toFixed(3)} | ${(p.clarificationRate * 100).toFixed(1)}% | ${p.totalVolume} | ${p.currentReadableIntentsCount} | ${p.currentExamplesCount} | ${p.recommendation} |`,
    );
  }
  return lines.join('\n');
}
