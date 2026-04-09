// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DefaultDomainName, ClassificationResult } from '../domains/types';
import { classifyMessage } from '../services/anthropic';
import { getClassificationHints } from '../skills/skill-config';
import { logger } from '../utils/logger';

export interface ConversationContext {
  domain: DomainName;
  lastAssistantMessage: string;
}

// ─── Pattern-based quick matching (no API call) ─────────────────────

const DOMAIN_PATTERNS: Record<DefaultDomainName, RegExp[]> = {
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
  finance: [
    /^\/(finance|budget|expense|tax|darf|receipt|invoice)\b/i,
  ],
  cooking: [
    /^\/(cook|recipe|recipes|meal|mealplan|shopping|shoppinglist|menu)\b/i,
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
  { domain: 'finance', pattern: /\b(despesas?|gastos?|or[çc]amento|imposto|carn[eê]-le[aã]o|DARF|receita\s+federal|nota\s+fiscal|budget|expenses?|tax(?:es)?|income\s+tax|financial|freelancer?\s+tax|dedu[çc][aã]o|faturamento|NF(?:-?e)?)\b/i },
  { domain: 'cooking', pattern: /\b(recipe|recipes|meal\s+plan|meal\s+prep|shopping\s+list|cook(?:ing)?|ingredient|groceries|what\s+(?:to|should\s+I)\s+(?:cook|eat|make)|dinner\s+ideas?|breakfast\s+ideas?|lunch\s+ideas?|receita|cardápio|lista\s+de\s+compras|cozinhar|refeição|jantar|almoço|café\s+da\s+manhã)\b/i },
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

// ─── Dynamic classifier prompt builder ──────────────────────────────

/**
 * Build the classifier hints text from registered skill classification hints.
 */
export function buildClassifierHints(): string {
  const hints = getClassificationHints();
  if (hints.length === 0) return '';
  return hints.map(h =>
    `- "${h.label}" — ${h.description}`
  ).join('\n');
}

// ─── Claude-based classification ────────────────────────────────────

/**
 * Route a user message through Claude classification.
 *
 * April 9 2026: added optional `userId` so the downstream
 * `trackedCreate` / `completeOneShotWithFallback` calls attribute
 * the classification cost row to the real user. Callers that don't
 * have a user in scope (tests, scheduled jobs) can omit it and the
 * row falls back to `user_id = 0` as before.
 */
export async function classifyWithClaude(
  message: string,
  activeContext?: ConversationContext | null,
  userId?: number,
): Promise<ClassificationResult> {
  const result = await classifyMessage(message, activeContext ?? undefined, userId);
  logger.debug({ result }, 'Claude classification result');
  return result;
}
