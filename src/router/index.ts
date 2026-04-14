// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName } from '../domains/types';
import { patternMatch, keywordMatch, classifyWithClaude, ConversationContext } from './classifier';
import { logger } from '../utils/logger';

export { keywordMatch };

export interface RouteResult {
  domain: DomainName;
  method: 'pattern' | 'keyword' | 'classifier' | 'context';
  confidence: number;
  strippedMessage: string;
}

const CONTEXT_FOLLOW_UP_PATTERNS = [
  /^(yes|yeah|yep|sure|ok|okay|do it|make it|move it|change it|shorten it|make it shorter|what about|how about|and do|and move|sim|claro|faz isso|faça isso|faz|muda|altera|encurta|resume|resuma|e faz|e move|e muda)\b/i,
  /\b(it|that|this|them|those|same|instead|shorter|tomorrow|wednesday|thursday|friday|saturday|sunday|monday|tuesday|isso|isto|disto|disso|essa|esse|essas|esses|mesmo|amanhã|quarta|quinta|sexta|sábado|domingo|segunda|terça|mais\s+curt[oa]|mais\s+long[oa])\b/i,
];

const CONTENT_REFINEMENT_PATTERNS = [
  /\b(make it|make this|rewrite|shorten|translate|adapt|turn it into|rework|make it shorter|make this shorter)\b/i,
  /\b(reescrev(?:e|a)|encurt(?:a|e)|resume|resuma|traduz|adapta|transforma|melhora|faz)\b/i,
  /\b(in\s+portuguese|in\s+english|portugu[eê]s|portugues|ingl[eê]s|european\s+portuguese|portugu[eê]s\s+europeu|mais\s+curt[oa]|mais\s+long[oa])\b/i,
];

function shouldPreferContext(message: string, activeContext?: ConversationContext | null): boolean {
  if (!activeContext) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;

  const tokenCount = trimmed.split(/\s+/).length;
  if (tokenCount > 12) return false;

  return CONTEXT_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function shouldForceActiveContext(message: string, activeContext?: ConversationContext | null): boolean {
  if (!activeContext) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;

  const tokenCount = trimmed.split(/\s+/).length;
  if (tokenCount > 18) return false;

  if (activeContext.domain === 'content') {
    return CONTENT_REFINEMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  return false;
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

  if (shouldForceActiveContext(message, activeContext)) {
    logger.debug({ domain: activeContext?.domain, method: 'context' }, 'Routed by active context override');
    return {
      domain: activeContext!.domain,
      method: 'context',
      confidence: 0.98,
      strippedMessage: message,
    };
  }

  const preferContext = shouldPreferContext(message, activeContext);

  // Step 2: keyword matching stays the default free fast path, but
  // short follow-up turns with an active context should not be ripped
  // out of that context just because they contain a broad keyword.
  if (!preferContext) {
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
