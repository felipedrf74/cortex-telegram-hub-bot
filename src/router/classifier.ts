// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, ClassificationResult } from '../domains/types';
import { classifyMessage } from '../services/anthropic';
import { logger } from '../utils/logger';

export interface ConversationContext {
  domain: DomainName;
  lastAssistantMessage: string;
}

// ─── Pattern-based quick matching (no API call) ─────────────────────

const DOMAIN_PATTERNS: Record<DomainName, RegExp[]> = {
  secretary: [
    /^\/(sec|agenda|schedule|todo|todos|done|undone|remind|email|week|day|plan|review|move|cancel)\b/i,
    /^\/(lists|tasks|newtask|newlist|deletelist|deletetask|due|priority|search|todosummary|digest|digesttime)\b/i,
    /^\/(overdue|duetoday|dueweek|movetask|alltasks|completed|edittask|notetask|addstep|steps)\b/i,
  ],
  triathlon: [
    /^\/(train|gym|run|bike|checkin|meal|macros|deload|pain|running|cycling|plan|workout|session|logworkout)\b/i,
  ],
  content: [
    /^\/(content|video|reel|script|caption|thumbnail|trend|ideas|discover|deepsearch|sources|hotnews)\b/i,
    /^\/(trending|reaction|hooks|genscript|titles|genthumbnail|gencaption)\b/i,
    /^\/(competitor|gaps|seo|repurpose|feedback|report)\b/i,
  ],
};

export function patternMatch(message: string): DomainName | null {
  const trimmed = message.trim();
  for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        return domain as DomainName;
      }
    }
  }
  return null;
}

// ─── Natural language keyword matching (no API call) ────────────────

const NL_KEYWORD_ROUTES: { domain: DomainName; pattern: RegExp }[] = [
  // Domain-specific unique keywords — EN + PT-BR (checked first for specificity)
  { domain: 'triathlon', pattern: /\b(workout|gym(?:\s+session)?|running\s+plan|cycling\s+plan|sets?\s*[x×]\s*\d|protein|carnivore|training(?:\s+plan)?|macros|deload|squat|deadlift|bench\s+press|heart\s+rate|RPE|RIR|tempo\s+run|intervals?|FTP|soreness|recovery\s+day|muscle|hypertrophy|endurance|coach\s*(?:report|briefing|rec)|lower\s+body|upper\s+body|periodization|mesocycle|microcycle|training\s+week|log\s+(?:workout|session)|workout\s+plan|auto.?adjust|session\s+complete|my\s+plan|adherence|treino|corrida|pedal(?:ada)?|muscula[çc][aã]o|prote[ií]na|dieta\s+carn[ií]vora|agachamento|supino|levantamento\s+terra|frequ[eê]ncia\s+card[ií]aca|dor\s+muscular|recupera[çc][aã]o|s[eé]ries?\s*[x×]\s*\d|academia|plano\s+de\s+treino)\b/i },
  { domain: 'content', pattern: /\b(youtube|instagram|reels?|thumbnail|video\s+(?:idea|script)|content\s+(?:strategy|calendar|idea)|caption|hashtag|subscribers?|audience|viral|hook|CTA|engagement|v[ií]deo|roteiro|legenda|inscritos|miniatura|conte[uú]do|id[eé]ia\s+de\s+(?:v[ií]deo|conte[uú]do)|calend[aá]rio\s+(?:de\s+)?conte[uú]do|engajamento)\b/i },
  // Secretary catch-all — EN + PT-BR (common task/scheduling language)
  { domain: 'secretary', pattern: /\b(tasks?|to-?dos?|remind(?:ers?)?|(?:my\s+)?calendar|schedule|meetings?|appointments?|(?:my\s+)?emails?|inbox|overdue|due\s+(?:today|tomorrow|this\s+week)|planning|digest|unread|mark\s+(?:as\s+)?(?:done|complete)|pending|priority|deadline|tarefas?|lembretes?|agend(?:a|ar)|reuni[oõ]es?|compromissos?|e-?mails?|caixa\s+de\s+entrada|atrasad[ao]s?|pra\s+hoje|pendentes?|prioridade|prazo)\b/i },
];

export function keywordMatch(message: string): DomainName | null {
  // Check domain-specific keywords first (non-secretary for specificity)
  for (const { domain, pattern } of NL_KEYWORD_ROUTES) {
    if (domain !== 'secretary' && pattern.test(message)) {
      return domain;
    }
  }
  // Secretary last (broader match)
  for (const { domain, pattern } of NL_KEYWORD_ROUTES) {
    if (domain === 'secretary' && pattern.test(message)) {
      return domain;
    }
  }
  return null;
}

// ─── Greeting / casual message detection ───────────────────────────
// Simple messages that should NOT trigger heavy state context loading
// or AI classification. These get routed directly to secretary with
// minimal context to prevent hallucinated briefings. (Bug P0 fix)

const GREETING_PATTERNS = [
  /^(?:h(?:ello|i|ey)|yo)\b[!.?\s]*$/i,                  // hello, hi, hey, yo
  /^(?:hi|hey)\s+there[!.?\s]*$/i,                         // hi there, hey there
  /^(?:good\s+(?:morning|afternoon|evening))[!.?\s]*$/i,   // good morning, etc.
  /^(?:bom\s+dia|boa\s+(?:tarde|noite))[!.?\s]*$/i,       // PT-BR greetings
  /^(?:ol[áa]|oi)[!.?\s]*$/i,                              // olá, oi
  /^(?:thanks?(?:\s+you)?|obrigad[oa]|valeu)[!.?\s]*$/i,   // thanks, obrigado
  /^(?:ok(?:ay)?|sure|alright|got\s+it|certo|entendi)[!.?\s]*$/i, // acknowledgments
  /^(?:yes|no|sim|n[ãa]o|yep|nope|yeah|nah)[!.?\s]*$/i,   // yes/no responses
];

/**
 * Detects whether a message is a simple greeting or casual acknowledgment.
 * These messages should NOT trigger heavy state context building or AI classification,
 * as that leads to hallucinated briefings (Bug P0).
 *
 * Only matches "pure" greetings — if the message contains additional content
 * beyond the greeting (e.g., "hello can you check my calendar"), it's NOT a greeting.
 */
export function isGreeting(message: string): boolean {
  const trimmed = message.trim();
  return GREETING_PATTERNS.some((p) => p.test(trimmed));
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
