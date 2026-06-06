// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 7 close-out (2026-05-15): telemetry-driven adversarial example
// proposer.
//
// Cross-references the Phase 6 adversarial discovery output with the
// registry's current `adversarial` / `prompt_injection` example bank to
// surface CANDIDATE registry examples — patterns observed in telemetry
// (refusal clusters) that aren't yet represented as locked-in examples.
//
// The output is NOT auto-committed; it's a markdown report for engineer
// review. Each candidate names the skill+action, the failure_reason
// observed, the volume, and a suggested example shape Felipe can copy into
// the registry.
//
// The proposer is read-only over both telemetry and the registry.

import Database from 'better-sqlite3';
import {
  discoverAdversarialCandidates,
  type AdversarialCandidateCluster,
  type AdversarialDiscoveryOptions,
} from './registry-adversarial-discovery';
import {
  getChatActionRegistry,
  type ChatActionDefinition,
} from './chat/registry';

export interface AdversarialExampleProposal {
  skill: string;
  action: string;
  cluster: AdversarialCandidateCluster;
  /** Whether the action ALREADY has at least one prompt_injection / adversarial example. */
  hasExistingSafetyExample: boolean;
  /** Existing example count (any tag). */
  existingExampleCount: number;
  /** Suggested example shape — a starting template Felipe edits. */
  suggestedExampleTemplate: string;
  /** Suggested tag for the new example: prompt_injection (for marker-based) or adversarial. */
  suggestedTag: 'prompt_injection' | 'adversarial';
  /** Priority score — higher = more urgent. */
  priority: number;
}

export interface AdversarialExampleProposerOptions
  extends AdversarialDiscoveryOptions {
  /** Skip clusters where the action already has ≥N safety examples. Default: 1. */
  minMissingSafetyExamples?: number;
  /** Maximum number of proposals to return. Default: 20. */
  maxProposals?: number;
}

/**
 * Generates candidate adversarial example proposals from telemetry refusal
 * clusters that lack registry coverage. Sorts by priority (cluster size +
 * coverage gap + breadth across conversations).
 */
export function proposeAdversarialExamples(
  db: Database.Database,
  options: AdversarialExampleProposerOptions = {},
): AdversarialExampleProposal[] {
  const clusters = discoverAdversarialCandidates(db, {
    since: options.since,
    tenantId: options.tenantId,
    minCount: options.minCount,
  });
  const registry = getChatActionRegistry();
  const byKey = new Map<string, ChatActionDefinition>();
  for (const entry of registry) {
    byKey.set(`${entry.skill}/${entry.action}`, entry);
  }

  const minMissing = options.minMissingSafetyExamples ?? 1;
  const proposals: AdversarialExampleProposal[] = [];
  for (const cluster of clusters) {
    if (!cluster.skill || !cluster.action) continue;
    const entry = byKey.get(`${cluster.skill}/${cluster.action}`);
    if (!entry) continue;
    const examples = (entry.examples ?? []) as Array<{ tags?: string[] }>;
    const safetyExamples = examples.filter((ex) =>
      Array.isArray(ex.tags) && ex.tags.some((t) => t === 'prompt_injection' || t === 'adversarial'),
    );
    // Skip when the action already has the minimum number of safety examples.
    if (safetyExamples.length >= minMissing) continue;
    const suggestedTag: AdversarialExampleProposal['suggestedTag'] =
      cluster.failureReason && cluster.failureReason.includes('injection') ? 'prompt_injection' : 'adversarial';
    proposals.push({
      skill: cluster.skill,
      action: cluster.action,
      cluster,
      hasExistingSafetyExample: safetyExamples.length > 0,
      existingExampleCount: examples.length,
      suggestedExampleTemplate: buildExampleTemplate(cluster, suggestedTag),
      suggestedTag,
      priority: computePriority(cluster, examples.length),
    });
  }
  proposals.sort((a, b) => b.priority - a.priority);
  return proposals.slice(0, options.maxProposals ?? 20);
}

function buildExampleTemplate(
  cluster: AdversarialCandidateCluster,
  suggestedTag: 'prompt_injection' | 'adversarial',
): string {
  const conditionHint = cluster.failureReason ?? 'telemetry_observed_pattern';
  return `{
  // ${suggestedTag}: telemetry observed ${cluster.count} ${cluster.failureReason ?? 'refusal'} rows
  // (${cluster.conversationCount} conversations, first ${cluster.firstSeen}, last ${cluster.lastSeen})
  text: '<draft a representative phrasing that triggers the refusal>',
  locale: 'en' | 'pt',
  tags: ['${suggestedTag}'],
  expectedAction: null,
  condition: '${conditionHint}',
}`;
}

function computePriority(
  cluster: AdversarialCandidateCluster,
  existingExamplesCount: number,
): number {
  // Higher priority when: high volume, more conversations, fewer existing examples.
  const volumeScore = Math.log1p(cluster.count) * 10;
  const breadthScore = Math.log1p(cluster.conversationCount) * 15;
  const coverageScore = Math.max(0, 10 - existingExamplesCount * 2);
  return Math.round(volumeScore + breadthScore + coverageScore);
}

/** Markdown formatter for proposals. */
export function formatAdversarialExampleProposalsMarkdown(
  proposals: AdversarialExampleProposal[],
): string {
  const lines: string[] = [];
  lines.push(`# Chat Action Registry — Adversarial Example Proposer`);
  lines.push(``);
  lines.push(`_Generated ${new Date().toISOString()}_`);
  lines.push(``);
  lines.push(`Proposals surface registry actions that have OBSERVED adversarial telemetry but lack a locked-in registry example. Each suggestion is a starting template — review the cluster's source conversations, draft a representative phrasing, and commit to the registry.`);
  lines.push(``);
  if (proposals.length === 0) {
    lines.push(`_No proposals — every observed cluster already has registry coverage._`);
    return lines.join('\n');
  }
  lines.push(`## Proposals (sorted by priority)`);
  lines.push(``);
  for (const proposal of proposals) {
    lines.push(`### ${proposal.skill}.${proposal.action} — priority ${proposal.priority}`);
    lines.push(``);
    lines.push(`- Cluster: **${proposal.cluster.count}** rows, **${proposal.cluster.conversationCount}** distinct conversations`);
    lines.push(`- Failure reason: \`${proposal.cluster.failureReason ?? 'unknown'}\``);
    lines.push(`- First seen: ${proposal.cluster.firstSeen} | Last seen: ${proposal.cluster.lastSeen}`);
    lines.push(`- Existing examples on action: ${proposal.existingExampleCount}`);
    lines.push(`- Has existing safety example: ${proposal.hasExistingSafetyExample ? 'yes' : 'no'}`);
    lines.push(``);
    lines.push(`Suggested registry entry (template):`);
    lines.push('```typescript');
    lines.push(proposal.suggestedExampleTemplate);
    lines.push('```');
    lines.push(``);
  }
  return lines.join('\n');
}
