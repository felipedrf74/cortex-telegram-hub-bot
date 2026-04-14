// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { listTodos } from '../state/todos';
import { getSharedMemorySummary } from '../state/shared-memory';
import { now, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { getActivePlanSummary } from '../services/training-plans';
import { ensureActiveProvider, getActiveProvider } from '../services/provider-registry';
import { getDailyContext } from '../services/context-engine';
import {
  formatAthleteProfileBlock,
  getMissingProfileFields,
  getQuestionnaire,
  type QuestionStep,
} from '../services/onboarding';
import { classifySport, type Sport } from '../router/sport-classifier';
import {
  getStrengthProgression,
  formatStrengthProgressionForPrompt,
  getCardioProgression,
  formatCardioProgressionForPrompt,
} from '../services/progression-analytics';
import type { AIToolResultMessage } from '../services/ai-provider';
import { logger } from '../utils/logger';
import type { CoachRecommendation } from '../services/garmin-coach';
import { LRUMap } from '../utils/lru-map';
import { deleteCoachState, loadCoachState, saveCoachState } from '../state/coach-state';

// ─── Phase 3 Slice A — Chat-triggered onboarding ────────────────────
//
// Map the sport classifier's enum to the profile type that owns its
// questionnaire. The sport enum and the profile id differ by a hyphen
// prefix; this mapping stays local so the classifier enum doesn't
// leak into the onboarding module.
const SPORT_TO_PROFILE_TYPE: Record<Sport, string> = {
  gym: 'triathlon-gym',
  running: 'triathlon-running',
  cycling: 'triathlon-cycling',
  swim: 'triathlon-swim',
};

/**
 * Build the onboarding-pending block that tells the sport coach to
 * pause and collect profile data before prescribing. Returns an empty
 * string when:
 *   - No message provided (state context rebuild without a fresh turn)
 *   - Sport classifier doesn't confidently identify a sport
 *   - The sport's profile is already complete
 *   - Fewer than 0 fields are missing (should never happen — belt)
 *
 * The block uses XML-tag-style delimiters so the coach persona prompt
 * can reference `<onboarding_pending>` unambiguously.
 */
function buildOnboardingPendingBlock(userId: number, message: string): string {
  if (!message || message.trim().length === 0) return '';
  const result = classifySport(message);
  if (!result.sport || result.confidence < 0.7) return '';

  const profileType = SPORT_TO_PROFILE_TYPE[result.sport];
  let missing: QuestionStep[];
  try {
    missing = getMissingProfileFields(userId, profileType);
  } catch {
    return '';
  }
  if (missing.length === 0) return '';

  const questionnaire = getQuestionnaire(profileType);
  const title = questionnaire?.title ?? profileType;

  const lines: string[] = [];
  lines.push(`<onboarding_pending sport="${result.sport}" profile="${profileType}">`);
  lines.push(
    `The user has NOT completed their ${title} yet. Before generating any specific training prescription (workout, plan, intensity target, session structure), collect the missing profile data by asking the user ONE QUESTION AT A TIME.`,
  );
  lines.push('');
  lines.push(
    'As the user answers (including when they volunteer an answer inside a longer message), save each one with the save_athlete_profile_field tool. The tool returns the remaining pending fields so you know when you\'re done.',
  );
  lines.push('');
  lines.push('Rules:');
  lines.push('- Ask ONE question per turn. Do not dump the whole list.');
  lines.push('- Use the exact field_key and profile_type below when calling the tool.');
  lines.push(
    "- For choice/multi_choice fields, offer the options verbatim. For number fields, accept the user's number and pass it as a string.",
  );
  lines.push('- If the user types "skip" or "later", thank them, stop asking, and answer the original question using generic guidance.');
  lines.push(`- Once all fields are saved, thank the user and address their ORIGINAL question from this conversation about ${result.sport}.`);
  lines.push('');
  lines.push(`Missing fields (${missing.length}):`);
  for (const step of missing) {
    const kind = step.type === 'choice' || step.type === 'multi_choice'
      ? ` [options: ${(step.options ?? []).join(' | ')}]`
      : ` [${step.type}]`;
    lines.push(`- ${step.key}${kind}: ${step.prompt}`);
  }
  lines.push('</onboarding_pending>');
  return lines.join('\n');
}

// ─── Last Coach Briefing State (per-user, in-memory) ─────────────────

interface LastCoachState {
  recommendations: CoachRecommendation[];
  briefingSummary: string;
  timestamp: number;
}

// LRU-bounded at 500 users. At 1 user that's ~1 entry; at multi-user scale
// (up to 500 active) it's naturally bounded and the oldest user's coach
// state gets evicted when a 501st arrives. Audit Month 2 #3.
//
// Size chosen: 500 > any plausible active-user count for a single-server
// deployment. Each entry is ~a few KB (recommendations array + summary
// string truncated to 500 chars), so 500 × ~2KB = ~1MB max footprint.
const lastCoachStates = new LRUMap<number, LastCoachState>(500);
const COACH_STATE_TTL = 12 * 60 * 60 * 1000; // 12 hours

/** Store the latest coach briefing so the triathlon domain can reference it */
export function setLastCoachState(userId: number, recs: CoachRecommendation[], summary: string): void {
  const timestamp = Date.now();
  lastCoachStates.set(userId, { recommendations: recs, briefingSummary: summary, timestamp });
  saveCoachState(userId, recs, summary, timestamp, COACH_STATE_TTL);
}

/** Get the last coach state if it's still fresh (within TTL). */
export function getLastCoachState(userId: number): LastCoachState | null {
  const state = lastCoachStates.get(userId);
  if (state) {
    if (Date.now() - state.timestamp > COACH_STATE_TTL) {
      lastCoachStates.delete(userId);
      deleteCoachState(userId);
      return null;
    }
    return state;
  }

  const persisted = loadCoachState(userId);
  if (!persisted) return null;

  const restored = {
    recommendations: persisted.recommendations,
    briefingSummary: persisted.briefingSummary,
    timestamp: persisted.timestamp,
  };
  lastCoachStates.set(userId, restored);
  return restored;
}

export function __resetLastCoachStateCacheForTests(): void {
  lastCoachStates.clear();
}

/**
 * Shared state context builder for simple domains (triathlon, content).
 * Only fetches local to-dos — no external API calls needed.
 *
 * `message` is optional for backwards compatibility with call sites
 * that don't have it yet (tests, direct repl debugging). When
 * provided, the triathlon branch uses it to run the sport classifier
 * and inject the onboarding-pending block if the user hasn't
 * completed the matching sport profile (Phase 3 Slice A).
 */
export async function buildSimpleStateContext(
  domain: DomainName,
  userId?: number,
  message?: string,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  const todos = listTodos(userId ?? 0, { domain, status: 'pending' });
  if (todos.length > 0) {
    const label = domain.charAt(0).toUpperCase() + domain.slice(1);
    parts.push(`\n${label} to-dos (${todos.length}):`);
    for (const t of todos) {
      let line = `- [${t.priority}] ${t.title}`;
      if (t.due_date) line += ` (due: ${formatDateTime(t.due_date)})`;
      parts.push(line);
    }
  }

  // Inject last coach recommendations for triathlon domain
  if (domain === 'triathlon' && userId) {
    const coachState = getLastCoachState(userId);
    if (coachState && coachState.recommendations.length > 0) {
      parts.push(`\n[COACH RECOMMENDATIONS — ${new Date(coachState.timestamp).toISOString()}]`);
      parts.push('CRITICAL: These are recommendations for EXISTING calendar events based on Garmin data already analyzed (sleep, HRV, body battery, stress, training readiness).');
      parts.push('When the athlete asks to "apply recommendations" or "apply changes" or similar:');
      parts.push('- IMMEDIATELY apply the recommendations below using tool calls — do NOT ask for additional information');
      parts.push('- The analysis was already done with real Garmin biometric data — all decisions are already made');
      parts.push('- NEVER use create_calendar_event — the events ALREADY EXIST on the calendar');
      parts.push('- For KEEP: do nothing (no tool call needed)');
      parts.push('- For MODIFY/SWAP: use update_calendar_event with the exact event_id and calendar_source below');
      parts.push('- For REST/cancel: use delete_calendar_event with the exact event_id and calendar_source below');
      parts.push('- Always include calendar_source in your tool call');
      parts.push('- After applying, confirm what was changed in a brief summary\n');
      for (const rec of coachState.recommendations) {
        const details = [
          `action: ${rec.action}`,
          `event_id: "${rec.eventId}"`,
          `calendar_source: "${rec.source}"`,
          `current_title: "${rec.originalTitle}"`,
        ];
        if (rec.newTitle && rec.action !== 'KEEP') details.push(`new_title: "${rec.newTitle}"`);
        if (rec.newStart) details.push(`new_start: "${rec.newStart}"`);
        if (rec.newEnd) details.push(`new_end: "${rec.newEnd}"`);
        details.push(`summary: ${rec.summary}`);
        parts.push(`  ${details.join(' | ')}`);
      }
      parts.push('\nCorrect tool usage examples:');
      parts.push('- MODIFY/SWAP → update_calendar_event(event_id="...", calendar_source="outlook", new_title="...", new_start="...", new_end="...")');
      parts.push('- REST/cancel → delete_calendar_event(event_id="...", calendar_source="outlook")');
    }
  }

  // Active training plan context for triathlon domain
  if (domain === 'triathlon' && userId) {
    try {
      const planSummary = getActivePlanSummary(userId);
      if (planSummary) parts.push(`\n${planSummary}`);
    } catch {
      // Training plan tables may not exist yet — skip silently
    }
  }

  // Phase 2 Slice B — athlete profile injection for triathlon domain.
  // Reads the user's completed onboarding questionnaires (fitness +
  // triathlon-gym/running/cycling/swim) and formats them as an
  // <athlete_profile> block the coach persona can reference directly.
  // Empty string when the user hasn't completed any — we don't add
  // noise to the prompt.
  if (domain === 'triathlon' && userId) {
    try {
      const profileBlock = formatAthleteProfileBlock(userId);
      if (profileBlock) parts.push(`\n${profileBlock}`);
    } catch {
      // Profile tables may not exist yet — skip silently
    }
  }

  // Phase 3 Slice A — Chat-triggered onboarding for triathlon domain.
  // When the classifier confidently identifies a sport in the user's
  // message AND that sport's profile is incomplete, prepend an
  // <onboarding_pending> block so the coach persona pauses and
  // collects the missing profile data before prescribing.
  //
  // This runs AFTER the athlete_profile block so the coach sees both
  // "what you already know" and "what's still missing" in one pass.
  if (domain === 'triathlon' && userId && message) {
    try {
      const onboardingBlock = buildOnboardingPendingBlock(userId, message);
      if (onboardingBlock) parts.push(`\n${onboardingBlock}`);
    } catch (err) {
      logger.warn({ err, userId }, 'buildOnboardingPendingBlock failed — skipping');
    }
  }

  // Phase 4 Slice D + F — Progression injection for triathlon.
  // Reads the last 8 weeks of logged completions and emits a
  // unified <athlete_progression> block containing strength lifts
  // plus running + cycling weekly volume. Each sport independently
  // returns empty string when the user has no data, so the block
  // only shows up for the sports the user actually trains.
  if (domain === 'triathlon' && userId) {
    try {
      const strength = getStrengthProgression(userId, 8);
      const running = getCardioProgression(userId, 'running', 8);
      const cycling = getCardioProgression(userId, 'cycling', 8);

      const strengthBlock = formatStrengthProgressionForPrompt(strength);
      const runningBlock = formatCardioProgressionForPrompt(running);
      const cyclingBlock = formatCardioProgressionForPrompt(cycling);

      // Build the unified block only if at least one sport has data.
      // The strength formatter returns a tagged <athlete_progression>
      // wrapper; the cardio formatters return raw multi-line sections.
      // Splice the cardio sections inside the strength wrapper so the
      // whole thing lands as one XML-ish block, or wrap cardio alone
      // if there's no strength data.
      const cardioSections = [runningBlock, cyclingBlock].filter(Boolean);
      let combined = '';
      if (strengthBlock && cardioSections.length > 0) {
        const closingTag = '</athlete_progression>';
        const insertAt = strengthBlock.lastIndexOf(closingTag);
        if (insertAt >= 0) {
          combined =
            strengthBlock.slice(0, insertAt) +
            '\n' +
            cardioSections.join('\n') +
            '\n' +
            strengthBlock.slice(insertAt);
        } else {
          combined = strengthBlock + '\n' + cardioSections.join('\n');
        }
      } else if (strengthBlock) {
        combined = strengthBlock;
      } else if (cardioSections.length > 0) {
        combined =
          `<athlete_progression window_weeks="8">\n` +
          cardioSections.join('\n') +
          `\n</athlete_progression>`;
      }

      if (combined) parts.push(`\n${combined}`);
    } catch (err) {
      logger.warn({ err, userId }, 'progression block build failed — skipping');
    }
  }

  // Cross-domain shared context
  const sharedCtx = getSharedMemorySummary(userId ?? 0);
  if (sharedCtx) parts.push(sharedCtx);

  // Daily cross-domain context summary (TASK-16a).
  // Pre-built at 5 AM and refreshed on every task write — replaces the
  // 5+ speculative tool calls the AI used to make to gather "what's my
  // day looking like?" before answering. Cost: ~500 tokens per message
  // instead of ~1350. See src/services/context-engine.ts.
  if (userId) {
    const dailyContext = getDailyContext(userId);
    if (dailyContext) {
      parts.push('\n--- Daily Context ---\n' + dailyContext);
    }
  }

  return parts.join('\n');
}

/**
 * Shared tool-use loop for non-secretary domains.
 * Routes through the active AI provider (Anthropic, Gemini, or OpenAI)
 * via the TaskRoutingProvider, which handles fallback and circuit breaker.
 *
 * IMPORTANT: This function is PROVIDER-AGNOSTIC. It uses the AIProvider
 * interface, not Anthropic-specific types. The provider routing layer
 * decides which AI backend handles each domain.
 */
export async function handleSimpleDomain(
  domain: DomainName,
  message: string,
  maxIterations = 5,
  userId?: number,
  maxTokensOverride?: number,
): Promise<DomainResponse> {
  const uid = userId ?? 0;
  const history = getConversationHistory(uid, domain);
  // Phase 3 Slice A: pass the incoming message so the triathlon
  // branch of buildSimpleStateContext can run the sport classifier
  // and inject the onboarding-pending block when appropriate.
  const stateContext = await buildSimpleStateContext(domain, uid, message);

  try {
    // Get the active routing provider (handles fallback + circuit breaker)
    const provider = getActiveProvider() || ensureActiveProvider();
    if (!provider) {
      // Fallback to direct Anthropic if routing provider not initialized
      const { callDomain, continueWithToolResults } = require('../services/anthropic');
      return await handleWithDirectCalls(domain, history, message, stateContext, maxIterations, uid, maxTokensOverride, callDomain, continueWithToolResults);
    }

    // Route through the provider-agnostic interface
    let result = await provider.callDomain(domain, history, message, stateContext, maxTokensOverride);
    let finalText = result.text;

    logger.debug({ domain, provider: provider.name, hasTools: result.toolCalls.length > 0 }, 'Domain call completed via routing provider');

    // Provider-agnostic tool conversation (no Anthropic-specific types)
    const toolConversation: AIToolResultMessage[] = [];
    const toolsUsed: string[] = [];
    let iterations = 0;

    while (result.toolCalls.length > 0 && iterations < maxIterations) {
      iterations++;

      // Build assistant content (provider-agnostic format)
      const assistantContent: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }> = [];
      if (result.text) assistantContent.push({ type: 'text', text: result.text });
      for (const tc of result.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        toolsUsed.push(tc.name);
      }

      // Execute tool calls in parallel
      const toolResults = await Promise.all(
        result.toolCalls.map(async (tc) => {
          const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>, userId);
          let content = JSON.stringify(toolResult);
          if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
          return { type: 'tool_result' as const, tool_use_id: tc.id, content };
        }),
      );

      // Build tool conversation in provider-agnostic format
      toolConversation.push(
        { role: 'assistant' as const, content: assistantContent as any },
        { role: 'user' as const, content: toolResults },
      );

      // Continue with tool results via the routing provider
      result = await provider.continueWithToolResults(domain, history, message, stateContext, toolConversation);
      finalText = result.text;
    }

    // Store conversation
    addToConversation(uid, domain, 'user', message);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addToConversation(uid, domain, 'assistant', storedText);

    return { text: finalText, domain };
  } catch (err: unknown) {
    const { AITimeoutError } = require('../utils/timeout');
    if (err instanceof AITimeoutError) {
      return { text: '⏱ Sorry, I took too long to respond. Please try again with a simpler question.', domain };
    }
    throw err;
  }
}

/**
 * Fallback: direct Anthropic calls when routing provider isn't initialized.
 * This preserves backward compatibility during startup or if routing fails to init.
 */
async function handleWithDirectCalls(
  domain: DomainName, history: any[], message: string, stateContext: string,
  maxIterations: number, userId: number, maxTokensOverride: number | undefined,
  callDomainFn: (...args: any[]) => Promise<any>, continueWithToolResultsFn: (...args: any[]) => Promise<any>,
): Promise<DomainResponse> {
  let result = await callDomainFn(domain, history, message, stateContext, maxTokensOverride, userId);
  let finalText = result.text;

  const toolConversation: any[] = [];
  const toolsUsed: string[] = [];
  let iterations = 0;

  while (result.toolCalls.length > 0 && iterations < maxIterations) {
    iterations++;
    const assistantContent: any[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const tc of result.toolCalls) {
      assistantContent.push(tc);
      toolsUsed.push(tc.name);
    }
    const toolResults = await Promise.all(
      result.toolCalls.map(async (tc: any) => {
        const toolResult = await executeToolCall(tc.name, tc.input as Record<string, any>, userId);
        let content = JSON.stringify(toolResult);
        // Truncate large results (consistent with primary path)
        if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
        return { type: 'tool_result' as const, tool_use_id: tc.id, content };
      }),
    );
    toolConversation.push(
      { role: 'assistant' as const, content: assistantContent },
      { role: 'user' as const, content: toolResults },
    );
    result = await continueWithToolResultsFn(domain, history, message, stateContext, toolConversation, userId);
    finalText = result.text;
  }

  addToConversation(userId ?? 0, domain, 'user', message);
  const storedText = toolsUsed.length > 0
    ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
    : finalText;
  addToConversation(userId ?? 0, domain, 'assistant', storedText);

  return { text: finalText, domain };
}
