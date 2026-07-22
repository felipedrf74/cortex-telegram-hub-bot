// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Chat Core v2 domain space → legacy runtime domain space.
 *
 * Keep this mapping in a provider-free module. Read-only operational paths
 * (health, chat-quality dashboards, and retirement reports) consume it while
 * the live divergence evaluator also depends on it; importing the mapping
 * must never initialize a classifier or an LLM provider.
 */
export const V2_TO_LEGACY_DOMAIN: Readonly<Record<string, string>> = Object.freeze({
  secretary: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
});
