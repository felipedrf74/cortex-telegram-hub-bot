// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName } from '../domains/types';
import { patternMatch, keywordMatch, classifyWithClaude, ConversationContext } from './classifier';
import { logger } from '../utils/logger';

export { keywordMatch };

export interface RouteResult {
  domain: DomainName;
  method: 'pattern' | 'keyword' | 'classifier';
  confidence: number;
  strippedMessage: string;
}

// System commands that don't route to a domain
const SYSTEM_COMMANDS = [
  '/help', '/status', '/clear', '/start', '/discover', '/deepsearch', '/sources', '/hotnews',
  '/trending', '/reaction', '/hooks', '/genscript', '/titles', '/genthumbnail', '/gencaption',
  '/competitor', '/gaps', '/seo', '/repurpose', '/feedback', '/report',
  '/learnfrom', '/references', '/relearn', '/studyvideo', '/transcribe', '/script', '/repurpose',
  '/contenttopic', '/contentretro',
  '/onboard', '/profile',
  '/skills', '/skill',
  '/connect', '/connections',
];

export function isSystemCommand(message: string): string | null {
  const lower = message.trim().toLowerCase();
  for (const cmd of SYSTEM_COMMANDS) {
    if (lower.startsWith(cmd)) return cmd;
  }
  return null;
}

/**
 * Route a user message to the right domain.
 *
 * Three-stage pipeline:
 *   1. Pattern match (free, exact slash commands)
 *   2. Keyword match (free, noun-based fast path)
 *   3. Claude/Gemini classification (paid, for ambiguous messages)
 *
 * April 9 2026: added optional `userId` so stage 3 can attribute
 * the classification cost row to the real user in `api_usage`.
 * Stages 1 and 2 are free and don't need the user id.
 */
export async function routeMessage(
  message: string,
  activeContext?: ConversationContext | null,
  userId?: number,
): Promise<RouteResult> {
  // Step 1: Try pattern matching (explicit /commands always win)
  const patternDomain = patternMatch(message);
  if (patternDomain) {
    const stripped = message.replace(/^\/\S+\s*/, '').trim();
    logger.debug({ domain: patternDomain, method: 'pattern' }, 'Routed by pattern');
    return {
      domain: patternDomain,
      method: 'pattern',
      confidence: 1.0,
      strippedMessage: stripped || message,
    };
  }

  // Step 2: ALWAYS try keyword matching (free, no API call) — even with active context.
  // This saves ~40% of classifier API calls. Only truly ambiguous messages need Claude.
  const kwDomain = keywordMatch(message);
  if (kwDomain) {
    logger.debug({ domain: kwDomain, method: 'keyword', hadActiveContext: !!activeContext }, 'Routed by keyword');
    return {
      domain: kwDomain,
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: message,
    };
  }

  // Step 3: Claude classifier for genuinely ambiguous messages.
  // Pass activeContext if available so the classifier has conversation history.
  // Pass userId so the api_usage row attributes the cost to the caller.
  const classification = await classifyWithClaude(message, activeContext ?? undefined, userId);
  logger.debug(
    { domain: classification.domain, confidence: classification.confidence, method: 'classifier', hadActiveContext: !!activeContext },
    'Routed by classifier',
  );
  return {
    domain: classification.domain,
    method: 'classifier',
    confidence: classification.confidence,
    strippedMessage: message,
  };
}
