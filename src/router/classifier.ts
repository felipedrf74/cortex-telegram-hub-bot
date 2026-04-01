// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, ClassificationResult } from '../domains/types';
import { classifyMessage } from '../services/anthropic';
import {
  getEnabledPatternRoutes,
  getEnabledKeywordRoutes,
  getEnabledClassificationHints,
} from '../skills/skill-manager';
import { logger } from '../utils/logger';

export interface ConversationContext {
  domain: DomainName;
  lastAssistantMessage: string;
}

// ─── Pattern-based quick matching (no API call) ─────────────────────
//
// Routes are built dynamically from enabled skills via getPatternRoutes().
// Each skill defines its own command patterns in skill-config.ts.

export function patternMatch(message: string): string | null {
  const trimmed = message.trim();
  for (const route of getEnabledPatternRoutes()) {
    for (const pattern of route.patterns) {
      if (pattern.test(trimmed)) {
        return route.domain;
      }
    }
  }
  return null;
}

// ─── Natural language keyword matching (no API call) ────────────────
//
// Routes are built dynamically from enabled skills via getKeywordRoutes().
// Non-secretary domains are checked first for specificity (lower priority number).

export function keywordMatch(message: string): string | null {
  const routes = getEnabledKeywordRoutes();
  // Routes are pre-sorted: non-secretary first (priority 0), secretary last (priority 99)
  for (const route of routes) {
    if (route.pattern.test(message)) {
      return route.domain;
    }
  }
  return null;
}

// ─── Dynamic classifier prompt builder ──────────────────────────────

/**
 * Build the classifier system prompt dynamically from enabled skill hints.
 * Falls back to the static classifier.md prompt if no hints available.
 */
export function buildClassifierHints(): string {
  const hints = getEnabledClassificationHints();
  if (hints.length === 0) return '';

  const lines = hints.map(h =>
    `- "${h.label}" — ${h.description}`
  );
  return lines.join('\n');
}

// ─── Claude-based classification ────────────────────────────────────

export async function classifyWithClaude(
  message: string,
  activeContext?: ConversationContext | null,
): Promise<ClassificationResult> {
  const result = await classifyMessage(message, activeContext ?? undefined);
  logger.debug({ result }, 'Claude classification result');
  return result;
}
