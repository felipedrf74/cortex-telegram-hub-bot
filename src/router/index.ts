// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName } from '../domains/types';
import {
  patternMatch,
  keywordMatch,
  classifyWithClaude,
  ConversationContext,
  hasStrongSecretaryIntent,
} from './classifier';
import { logger } from '../utils/logger';

export { keywordMatch };

export interface RouteResult {
  domain: DomainName;
  method: 'pattern' | 'keyword' | 'classifier' | 'context';
  confidence: number;
  strippedMessage: string;
}

const CONTEXT_OVERRIDE_SAFE_KEYWORD_DOMAINS = new Set<DomainName>([
  'content',
  'cooking',
  'finance',
]);

// Secretary noun + imperative phrasings that should beat any active
// context — the user is clearly asking for a reminder/task/calendar
// operation, not continuing the previous topic. Codex QA round 2
// caught two extra gaps: PT "chamada/ligação" verbs and EN time-block
// idioms ("block 2 hours...", "hold 30 min..."). Broadened below.
// Codex QA round 4 rewrote these from generic verb+noun regexes (which
// stole "book a content review" and "block calendar pressure") into
// narrow lists of unambiguous scheduling nouns. The rule of thumb:
// the noun must be a calendar/task primitive, not a domain object.
const SCHEDULING_NOUNS_EN = '(?:meeting|call|sync|appointment|slot|lunch|dinner|breakfast|coffee|demo|interview|hangout|standup|stand-?up|kickoff|catch[-\\s]?up|check[-\\s]?in|1[:-]?on[:-]?1|one[-\\s]?on[-\\s]?one|focus\\s+block|focus\\s+time|deep\\s+work)';
const SCHEDULING_NOUNS_PT = '(?:reuni[aã]o|chamada|liga[cç][aã]o|consulta|encontro|call|aula|hor[aá]rio|janela|sess[aã]o\\s+de\\s+foco|tempo\\s+de\\s+foco)';
// Things that LOOK calendar-y in writing but belong to other domains
// — defensive list to keep my patterns honest. `book a content review`
// must NOT be secretary even though it contains `book a X for Friday`.
const NON_SECRETARY_OBJECT = new RegExp([
  // Domain-specific compound objects that look schedulable but belong elsewhere
  '\\b(workout|training|run|ride|swim|gym\\s+session|race(?:s)?|competition(?:s)?|tournament(?:s)?|treino|corrida|pedal(?:ada)?|prova)\\b',
  '\\b(content\\s+(?:review|brief|plan|piece|draft)|video\\s+(?:review|edit)|script\\s+review|filming\\s+block|recording\\s+block|edit\\s+block|finance\\s+review|budget\\s+review|tax\\s+review|meal\\s+plan|recipe|grocery\\s+list)\\b',
  // Calendar-as-burden idioms: "calendar pressure/stress" — the noun
  // after "calendar" is a feeling, not an operation. Adds a triathlon-
  // shaped feel to a message that just happens to mention calendar.
  '\\bcalendar\\s+(?:pressure|stress|anxiety|overwhelm|overload|fatigue|burnout|chaos|crunch|carga|press[aã]o|stress|ansiedade)\\b',
].join('|'), 'i');

const SECRETARY_FRESH_OPS_PATTERNS = [
  // EN action verb + scheduling noun (unchanged from round 2)
  /\b(remind\s+me\b|set\s+(?:a\s+)?reminder|create\s+(?:a\s+)?(?:task|reminder)|add\s+(?:a\s+)?(?:task|reminder|event)|schedule\s+(?:a\s+)?(?:meeting|event|call)|move\s+(?:my\s+)?(?:meeting|event)|cancel\s+(?:my\s+)?(?:meeting|event))/i,
  // EN time-block idioms with unambiguous time units.
  // `block calendar X` is handled separately below — it requires a
  // temporal anchor IMMEDIATELY after `calendar` to distinguish from
  // "block calendar pressure from competitions".
  /\b(block|hold|reserve|carve\s+out|set\s+aside)\s+(?:(?:a|an|\d+|some)\s+)?(?:hour|hours|min|minute|minutes|slot|window)\b/i,
  // EN "block/reserve calendar" — must be followed by a temporal
  // anchor or "for X" with a calendar-shaped object. "block calendar
  // pressure" does not match; "block calendar Friday at 14:00" does.
  /\b(block|reserve)\s+(?:my\s+)?(?:calendar|agenda)\s+(?:for|on|at|this|next|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|\d)/i,
  // EN verb + scheduling-noun-only + temporal. Restricted to the
  // unambiguous noun list — "book a content review for Friday" no
  // longer matches because `content review` isn't in SCHEDULING_NOUNS_EN.
  new RegExp(`\\b(schedule|book|set\\s+up|arrange|plan|put)\\s+(?:a|an|the|my)\\s+${SCHEDULING_NOUNS_EN}(?:\\s+\\w+){0,2}\\s+(?:for|on|at|this|next)\\s+(?:tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|night|week|\\d)`, 'i'),
  // PT action verb + scheduling noun (chamada=call, ligação=phone call, consulta=appointment)
  /\b(me\s+lembra|cria\s+(?:um\s+)?lembrete|cria\s+(?:uma\s+)?tarefa|adiciona\s+(?:uma\s+)?tarefa|agenda\s+(?:uma\s+)?(?:reuni[aã]o|chamada|liga[cç][aã]o|consulta|call)|marca\s+(?:uma\s+)?(?:reuni[aã]o|chamada|liga[cç][aã]o|consulta|call))/i,
  // PT time-block idioms: "reserva 2 horas amanhã", "bloqueia 30 min para X"
  /\b(reserva|bloqueia|guarda|separa)\s+(?:(?:um|uma|\d+)\s+)?(?:hora|horas|min|minuto|minutos|janela|hor[aá]rio|sess[aã]o)/i,
  // PT verb + scheduling noun + temporal (mirrors the new EN list)
  new RegExp(`\\b(agenda|marca|reserva|bloqueia)\\s+(?:um|uma|o|a|meu|minha)\\s+${SCHEDULING_NOUNS_PT}(?:\\s+\\w+){0,2}\\s+(?:para|em|na|no|hoje|amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado|domingo|\\d)`, 'i'),
];

// Codex QA round 5: catch the "I don't want to schedule a meeting"
// case so negated scheduling intents don't route to secretary as
// fresh write intents. The negation precedes the verb in EN/PT.
const NEGATED_INTENT_PATTERN = /\b(don'?t|do\s+not|don't|cannot|can'?t|won'?t|will\s+not|n[aã]o\s+(?:quero|preciso|vou|deveria|posso)|sem\s+precisar)\s+(?:want\s+to|need\s+to|have\s+to|going\s+to|gotta|wanna|going)?\s*(?:remind|set|create|add|schedule|book|move|cancel|block|reserve|agenda|marca|cria|bloqueia|reserva)/i;

// Codex QA round 6: strip quoted spans before the negation check so
// quoted negation like `She said 'don't schedule' but I want to
// schedule a meeting tomorrow` doesn't suppress the legitimate
// affirmative intent OUTSIDE the quotes.
function stripQuotedForRouting(message: string): string {
  return message
    .replace(/^>\s+.*$/gm, '')
    .replace(/"[^"]*"/g, '')
    .replace(/'[^']*'/g, '')
    .replace(/[“][^”]*[”]/g, '')
    .replace(/[‘][^’]*[’]/g, '');
}

function hasNegatedSchedulingIntent(message: string): boolean {
  return NEGATED_INTENT_PATTERN.test(stripQuotedForRouting(message));
}

function hasFreshSecretaryOperationalIntent(message: string): boolean {
  // Codex QA round 5: negation guard runs first — "don't schedule X"
  // is not a fresh write intent regardless of any other signal.
  if (hasNegatedSchedulingIntent(message)) return false;
  if (hasStrongSecretaryIntent(message)) return true;
  // Codex QA round 4: even if a fresh-ops pattern fires, bail out
  // when the message's actual object is a non-secretary domain noun
  // (workout, content review, finance review, etc.).
  if (NON_SECRETARY_OBJECT.test(message)) return false;
  return SECRETARY_FRESH_OPS_PATTERNS.some((pattern) => pattern.test(message));
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

const FINANCE_REFINEMENT_PATTERNS = [
  /\b(categori[sz]e|reclassif(?:y|ies)|tag|mark|split|rename|attach|file|reconcile|deductible|business\s+expense|personal\s+expense|software|travel|meals?)\b/i,
  /\b(categoriza|reclassifica|marca|separa|divide|renomeia|anexa|lan[çc]a|reconcilia|dedut[ií]vel|despesa\s+(?:da\s+empresa|pessoal)|software|viagem|refei[çc][aã]o|almo[cç]o|jantar)\b/i,
];

const SECRETARY_REFINEMENT_PATTERNS = [
  /\b(move it|reschedule it|cancel it|delete it|complete it|mark it done|shift it|fit it|slot it|push it|bring it forward|later today|tomorrow instead|this afternoon|next week)\b/i,
  /\b(muda isso|move isso|remarca isso|reagenda isso|cancela isso|apaga isso|conclui isso|encaixa isso|mais tarde hoje|amanh[ãa] em vez disso|na pr[oó]xima semana)\b/i,
  /^(what(?:'s| is)? my priority(?: today)?|what should i do first(?: today)?|prioriti[sz]e my day|o que fa[çc]o primeiro|o que devo fazer primeiro|qual(?: é| a)? prioridade(?: hoje)?|prioriza o meu dia)[\s?!.]*$/i,
];

const TRIATHLON_REFINEMENT_PATTERNS = [
  /\b(make it easier|make it harder|make it shorter|make it longer|move it to|swap it for|change the session|change the workout|keep the same plan|after the workout|before the workout|after the ride|before the run)\b/i,
  /\b(deixa mais leve|deixa mais forte|deixa mais curto|deixa mais longo|muda para|troca por|altera o treino|mant[eé]m o plano|depois do treino|antes do treino|depois da corrida|antes da bike)\b/i,
];

function shouldPreferContext(message: string, activeContext?: ConversationContext | null): boolean {
  if (!activeContext) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;

  const tokenCount = trimmed.split(/\s+/).length;
  const maxTokens = activeContext.domain === 'secretary' || activeContext.domain === 'triathlon' ? 18 : 12;
  if (tokenCount > maxTokens) return false;

  return CONTEXT_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function shouldForceActiveContext(message: string, activeContext?: ConversationContext | null): boolean {
  if (!activeContext) return false;
  const trimmed = message.trim();
  if (!trimmed) return false;

  if (activeContext.domain === 'content') {
    const tokenCount = trimmed.split(/\s+/).length;
    if (tokenCount > 18) return false;
    return CONTENT_REFINEMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  if (activeContext.domain === 'finance') {
    const tokenCount = trimmed.split(/\s+/).length;
    if (tokenCount > 18) return false;
    return FINANCE_REFINEMENT_PATTERNS.some((pattern) => pattern.test(trimmed))
      && !hasStrongSecretaryIntent(trimmed);
  }

  if (activeContext.domain === 'secretary') {
    const tokenCount = trimmed.split(/\s+/).length;
    if (tokenCount > 22) return false;
    return SECRETARY_REFINEMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
  }

  if (activeContext.domain === 'triathlon') {
    const tokenCount = trimmed.split(/\s+/).length;
    if (tokenCount > 22) return false;
    return TRIATHLON_REFINEMENT_PATTERNS.some((pattern) => pattern.test(trimmed));
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
  tenantId?: number,
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
  let kwDomain = keywordMatch(message);

  // Step 2: keyword matching stays the default free fast path, but
  // short follow-up turns with an active context should not be ripped
  // out of that context just because they contain a broad keyword.
  // Codex QA round 4 also caught the "block calendar pressure" case:
  // the secretary `calendar` keyword matched but the actual object is
  // a non-secretary noun. Reject the keyword route in that case so
  // we either preserve context or fall through to the classifier.
  if (kwDomain === 'secretary' && NON_SECRETARY_OBJECT.test(message) && !hasFreshSecretaryOperationalIntent(message)) {
    logger.debug({ rejectedKw: 'secretary', reason: 'non_secretary_object' }, 'Skipping secretary keyword route — domain-specific object detected');
    kwDomain = null;
  }
  // Codex QA round 5: negated scheduling intent ("I don't want to
  // schedule a meeting tomorrow") should not route to secretary even
  // when the keyword fires. Fall through to context preservation or
  // classifier.
  if (kwDomain === 'secretary' && hasNegatedSchedulingIntent(message)) {
    logger.debug({ rejectedKw: 'secretary', reason: 'negated_intent' }, 'Skipping secretary keyword route — message is negated');
    kwDomain = null;
  }

  if (kwDomain) {
    const shouldUseKeyword =
      !preferContext ||
      !activeContext ||
      kwDomain === activeContext.domain ||
      CONTEXT_OVERRIDE_SAFE_KEYWORD_DOMAINS.has(kwDomain) ||
      (kwDomain === 'secretary' && hasFreshSecretaryOperationalIntent(message));

    if (shouldUseKeyword) {
      logger.debug({ domain: kwDomain, method: 'keyword', hadActiveContext: !!activeContext }, 'Routed by keyword');
      return {
        domain: kwDomain,
        method: 'keyword',
        confidence: 0.9,
        strippedMessage: message,
      };
    }

    // Honor the "preserve active context" decision instead of paying the
    // classifier on a broad follow-up keyword. The log message used to
    // assert the intent but the function still fell through to the LLM.
    logger.debug(
      { domain: activeContext!.domain, preservedOverKeyword: kwDomain },
      'Preserving active context over broad follow-up keyword',
    );
    return {
      domain: activeContext!.domain,
      method: 'context',
      confidence: 0.85,
      strippedMessage: message,
    };
  }

  // Pure follow-up: matched CONTEXT_FOLLOW_UP_PATTERNS, no fresh keyword.
  // The classifier hop adds cost without information in this branch.
  if (preferContext && activeContext) {
    // Codex QA round 2: "block 2 hours tomorrow for the dentist" has
    // no keyword route (block/hold/reserve aren't in NL_KEYWORD_ROUTES)
    // but is unmistakably a secretary write intent. Check the fresh-ops
    // patterns before the context short-circuit so these don't get
    // trapped in stale triathlon/content/cooking context.
    if (hasFreshSecretaryOperationalIntent(message)) {
      logger.debug(
        { from: activeContext.domain, to: 'secretary', method: 'context' },
        'Overriding active context for explicit secretary write intent',
      );
      return {
        domain: 'secretary',
        method: 'context',
        confidence: 0.88,
        strippedMessage: message,
      };
    }
    logger.debug(
      { domain: activeContext.domain, method: 'context' },
      'Preserving active context for follow-up turn (no fresh keyword)',
    );
    return {
      domain: activeContext.domain,
      method: 'context',
      confidence: 0.82,
      strippedMessage: message,
    };
  }

  // Codex QA round 2: last chance for explicit secretary writes that
  // didn't match the pattern/keyword stages — e.g. PT time-block
  // phrasings like "reserva 30 minutos amanhã" where the existing
  // CONTEXT_FOLLOW_UP_PATTERNS regex fails on `ã` due to the JS
  // word-boundary behavior with non-ASCII chars. Avoids paying the
  // classifier for an intent we can route deterministically.
  if (hasFreshSecretaryOperationalIntent(message)) {
    logger.debug({ method: 'keyword', via: 'fresh_secretary_fallback' }, 'Routed to secretary by fresh-ops fallback');
    return {
      domain: 'secretary',
      method: 'keyword',
      confidence: 0.88,
      strippedMessage: message,
    };
  }

  // Step 3: Claude classifier for genuinely ambiguous messages.
  // Pass activeContext if available so the classifier has conversation history.
  // Pass userId so the api_usage row attributes the cost to the caller.
  const classification = await classifyWithClaude(message, activeContext ?? undefined, userId, tenantId);
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
