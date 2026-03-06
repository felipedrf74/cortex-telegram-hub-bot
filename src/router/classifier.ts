import { DomainName, ClassificationResult } from '../domains/types';
import { classifyMessage } from '../services/anthropic';
import { logger } from '../utils/logger';

// ─── Pattern-based quick matching (no API call) ─────────────────────

const DOMAIN_PATTERNS: Record<DomainName, RegExp[]> = {
  secretary: [
    /^\/(sec|agenda|schedule|todo|todos|done|undone|remind|email|week|day|plan|review|move|cancel)\b/i,
    /^\/(lists|tasks|newtask|newlist|deletelist|deletetask|due|priority|search|todosummary|digest|digesttime)\b/i,
    /^\/(overdue|duetoday|dueweek|movetask|alltasks|completed|edittask|notetask|addstep|steps)\b/i,
  ],
  triathlon: [
    /^\/(train|gym|run|bike|checkin|meal|macros|deload|pain|running|cycling)\b/i,
  ],
  content: [
    /^\/(content|video|reel|script|caption|thumbnail|trend)\b/i,
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
  // Domain-specific unique keywords (checked first for specificity)
  { domain: 'triathlon', pattern: /\b(workout|gym\s+session|running\s+plan|cycling\s+plan|sets?\s*[x×]\s*\d|protein|carnivore|training\s+plan|macros|deload|squat|deadlift|bench\s+press|heart\s+rate|RPE|RIR|tempo\s+run|intervals?|FTP|soreness|recovery\s+day|muscle|hypertrophy|endurance)\b/i },
  { domain: 'content', pattern: /\b(youtube|instagram|reels?|thumbnail|video\s+(?:idea|script)|content\s+(?:strategy|calendar|idea)|caption|hashtag|subscribers?|audience|viral|hook|CTA|engagement)\b/i },
  // Secretary catch-all (common task/scheduling language)
  { domain: 'secretary', pattern: /\b(tasks?|to-?dos?|remind(?:ers?)?|(?:my\s+)?calendar|schedule|meetings?|appointments?|(?:my\s+)?emails?|inbox|overdue|due\s+(?:today|tomorrow|this\s+week)|planning|digest|unread|mark\s+(?:as\s+)?(?:done|complete)|pending|priority|deadline)\b/i },
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

// ─── Claude-based classification ────────────────────────────────────

export async function classifyWithClaude(message: string): Promise<ClassificationResult> {
  const result = await classifyMessage(message);
  logger.debug({ result }, 'Claude classification result');
  return result;
}
