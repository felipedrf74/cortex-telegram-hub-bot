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
];

export function isSystemCommand(message: string): string | null {
  const lower = message.trim().toLowerCase();
  for (const cmd of SYSTEM_COMMANDS) {
    if (lower.startsWith(cmd)) return cmd;
  }
  return null;
}

export async function routeMessage(
  message: string,
  activeContext?: ConversationContext | null,
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

  // Step 2: If there's an active conversation, skip keyword matching and go
  // straight to the context-aware classifier. Keywords are too blunt — "calendar"
  // in a reply about moving a training session shouldn't hijack to secretary.
  if (activeContext) {
    const classification = await classifyWithClaude(message, activeContext);
    logger.debug(
      { domain: classification.domain, confidence: classification.confidence, activeContext: activeContext.domain },
      'Routed by context-aware classifier',
    );
    return {
      domain: classification.domain,
      method: 'classifier',
      confidence: classification.confidence,
      strippedMessage: message,
    };
  }

  // Step 3: No active conversation — try keyword matching (free, no API call)
  const kwDomain = keywordMatch(message);
  if (kwDomain) {
    logger.debug({ domain: kwDomain, method: 'keyword' }, 'Routed by keyword');
    return {
      domain: kwDomain,
      method: 'keyword',
      confidence: 0.9,
      strippedMessage: message,
    };
  }

  // Step 4: Claude classifier for ambiguous messages (no active conversation)
  const classification = await classifyWithClaude(message);
  logger.debug({ domain: classification.domain, confidence: classification.confidence, method: 'classifier' }, 'Routed by classifier');
  return {
    domain: classification.domain,
    method: 'classifier',
    confidence: classification.confidence,
    strippedMessage: message,
  };
}
