// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Bump whenever decision-visible Content agent eligibility changes. */
export const CONTENT_AGENT_LIFECYCLE_POLICY_VERSION = 'active-content-agents.v3';

export const PAUSED_CONTENT_AGENT_IDS = Object.freeze([
  'performance_agent',
  'reaction_radar',
  'seo_agent',
] as const);

const PAUSED_CONTENT_AGENT_ID_SET = new Set<string>(PAUSED_CONTENT_AGENT_IDS);

function normalizeContentAgentId(agentId: string): string {
  const normalized = agentId.trim().toLowerCase().replaceAll('-', '_');
  // Historical Reaction Radar rows used both the manifest id and the former
  // runtime producer id. They share one lifecycle and must be retired together.
  return normalized === 'reaction_radar_agent' ? 'reaction_radar' : normalized;
}

export function isPausedContentAgent(agentId: string): boolean {
  return PAUSED_CONTENT_AGENT_ID_SET.has(normalizeContentAgentId(agentId));
}

export function isActiveContentAgentSignal(
  signal: { source_agent: string },
): boolean {
  return !isPausedContentAgent(signal.source_agent);
}

export function filterActiveContentAgentSignals<T extends { source_agent: string }>(
  signals: readonly T[],
): T[] {
  return signals.filter(isActiveContentAgentSignal);
}
