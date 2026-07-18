// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DomainName, DomainResponse } from './types';
import { getConversationHistory, addToConversation } from '../state/conversation';
import { listTodos } from '../state/todos';
import { getSharedMemorySummary } from '../state/shared-memory';
import { now, formatDateTime } from '../utils/date-parser';
import { executeToolCall } from '../services/tool-executor';
import { getActivePlanSummary } from '../services/training-plans';
import { ensureActiveProvider, getActiveProvider } from '../services/provider-registry';
import { getOrBuildDailyContext } from '../services/context-engine';
import { buildSharedDecisionContext } from '../services/shared-decision-context';
import { buildChatPromptContextBlock } from '../services/chat-context-engine';
import { inferChatTurnContract } from '../services/chat-turn-contract';
import { isChatContextCompilerEnabled } from '../services/runtime-flags';
import { buildAIUnavailableResponse, canUseDirectAnthropicFallback } from './ai-unavailable';
// Phase 13 batch 71 (2026-05-16): training intent detector moved to the
// per-skill module (was inline regex in this file). Closes Phase 0 audit
// MERGE-2 for domain-handler.ts.
import { isTrainingPrescriptionIntent } from '../services/skills/training/intent-detectors';
import {
  callDomain as callDirectAnthropicDomain,
  continueWithToolResults as continueDirectAnthropicWithToolResults,
} from '../services/anthropic';
import { normalizeReplyForUserLanguage } from '../services/reply-language-normalizer';
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
import { getUserLanguageById, resolveCurrentTenantIdForUser } from '../services/user-service';
import { buildCookingPreferenceReadModel } from '../services/cooking-preferences';
import {
  cookingSafetyLogPayload,
  evaluateCookingSafetyText,
  renderCookingSafetyBlockedResponse,
  renderCookingSafetyPromptBlock,
} from '../services/cooking-safety-policy';
import type { AIToolResultMessage } from '../services/ai-provider';
import { logger } from '../utils/logger';
import { AITimeoutError } from '../utils/timeout';
import type { CoachRecommendation } from '../services/garmin-coach';
import { LRUMap } from '../utils/lru-map';
import { deleteCoachState, loadCoachState, saveCoachState } from '../state/coach-state';
import { getChatToolRisk } from '../services/chat-tool-authorization';

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
  if (!isTrainingPrescriptionIntent(message)) return '';
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

// Phase 13 batch 71: `isTrainingPrescriptionIntent` moved to
// `src/services/skills/training/intent-detectors.ts` and imported above.

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

function addScopedConversation(
  userId: number,
  domain: DomainName,
  role: 'user' | 'assistant',
  content: string,
  tenantId?: number,
): void {
  if (typeof tenantId === 'number') {
    addToConversation(userId, domain, role, content, tenantId);
    return;
  }
  addToConversation(userId, domain, role, content);
}

function executeScopedToolCall(
  name: string,
  input: Record<string, any>,
  userId?: number,
  tenantId?: number,
): Promise<unknown> {
  if (typeof tenantId === 'number') {
    return executeToolCall(name, input, userId, tenantId);
  }
  return executeToolCall(name, input, userId);
}

function isLegacyDomainWriteTool(name: string): boolean {
  return getChatToolRisk(name) !== 'read';
}

function buildLegacyDomainWriteBlockedToolResult(name: string): Record<string, unknown> {
  return {
    success: false,
    code: 'ACTION_CONFIRMATION_REQUIRED',
    confirmation_required: true,
    error: `${name} is a write action and must run through the chat action planner confirmation flow.`,
  };
}

function buildLegacyDomainWriteBlockedReply(): string {
  return 'This action needs confirmation in the app before I change anything.';
}

/**
 * Drop the last coach state for a user from both the in-memory LRU
 * and the durable persistence layer. Called when the user's training
 * plan is hard-deleted so a stale "Strength + Core Support is on the
 * plan" summary doesn't keep being surfaced as the current coach
 * read after the plan rows are gone.
 */
export function clearLastCoachState(userId: number): void {
  lastCoachStates.delete(userId);
  deleteCoachState(userId);
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
  tenantId?: number,
): Promise<string> {
  const hasUserScope = typeof userId === 'number';
  const includeScopedContext = shouldIncludeScopedStateContext(domain, hasUserScope, message);
  const parts: string[] = [];
  parts.push(`Today: ${now().toFormat('cccc, LLLL dd yyyy, HH:mm')} (Europe/Lisbon)`);

  const todos = includeScopedContext ? listTodos(userId!, { domain, status: 'pending' }) : [];
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
  if (includeScopedContext && domain === 'triathlon' && userId) {
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
  if (includeScopedContext && domain === 'triathlon' && userId) {
    try {
      const scopedTenantId = typeof tenantId === 'number' && Number.isSafeInteger(tenantId) && tenantId > 0 ? tenantId : null;
      const planSummary = scopedTenantId ? getActivePlanSummary(userId, scopedTenantId) : null;
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
  if (includeScopedContext && domain === 'triathlon' && userId) {
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
  if (includeScopedContext && domain === 'triathlon' && userId && message) {
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
  if (includeScopedContext && domain === 'triathlon' && userId) {
    try {
      const scopedTenantId = typeof tenantId === 'number' && Number.isSafeInteger(tenantId) && tenantId > 0 ? tenantId : null;
      if (!scopedTenantId) {
        logger.warn({ userId }, 'progression block skipped — missing tenant scope');
      } else {
        const strength = getStrengthProgression(userId, scopedTenantId, 8);
        const running = getCardioProgression(userId, scopedTenantId, 'running', 8);
        const cycling = getCardioProgression(userId, scopedTenantId, 'cycling', 8);

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
            cardioSections.join('\n') +
            `\n</athlete_progression>`;
          combined = `<athlete_progression window_weeks="8">\n${combined}`;
        }

        if (combined) parts.push(`\n${combined}`);
      }
    } catch (err) {
      logger.warn({ err, userId }, 'progression block build failed — skipping');
    }
  }

  // Cross-domain shared context
  // Content prompts must not receive the all-domain free-form memory dump.
  // buildChatPromptContextBlock below keeps Content-owned memory and routes
  // peer facts through the purpose-limited derived-context gate.
  const sharedCtx = includeScopedContext && domain !== 'content'
    ? getSharedMemorySummary(userId!, tenantId)
    : '';
  if (sharedCtx) parts.push(sharedCtx);

  if (domain === 'cooking' && hasUserScope) {
    try {
      const cookingPreferences = buildCookingPreferenceReadModel(userId, tenantId).profile;
      const cookingSafetyBlock = renderCookingSafetyPromptBlock(cookingPreferences);
      if (cookingSafetyBlock) parts.push(cookingSafetyBlock);
    } catch (err) {
      logger.warn({ err, userId, tenantId }, 'Cooking preference context unavailable; continuing without preference block');
    }
  }

  // Content has one canonical prompt path through chat-context-engine. That
  // compiler attaches the purpose-gated projection and prevents an opted-in
  // cache entry from being reused by a default turn.
  if (includeScopedContext && domain !== 'content') {
    const decisionCtx = await buildSharedDecisionContext(domain, userId!, tenantId);
    if (decisionCtx) parts.push(`\n${decisionCtx}`);
  }

  // Daily cross-domain context summary (TASK-16a).
  // Lazy-built on first read each day (cached in daily_context_cache,
  // invalidated on every task write) — replaces the 5+ speculative tool
  // calls the AI used to make to gather "what's my day looking like?"
  // before answering. Cost: ~500 tokens per message instead of ~1350.
  // The 5 AM pre-build cron was removed 2026-07-03: nothing consumed it on
  // schedule, and mid-day invalidations left chat context-less until the
  // next morning. See src/services/context-engine.ts.
  // The legacy daily cache includes raw task/calendar titles, session names,
  // readiness scores, and counts, so it is not a valid Content projection.
  if (includeScopedContext && domain !== 'content') {
    const dailyContext = await getOrBuildDailyContext(userId!, tenantId);
    if (dailyContext) {
      parts.push('\n--- Daily Context ---\n' + dailyContext);
    }
  }

  if (includeScopedContext) {
    const promptContext = await buildChatPromptContextBlock({
      domain,
      message: message ?? '',
      userId: userId!,
      tenantId,
      budgetChars: 1800,
    });
    if (promptContext) parts.push(`\n${promptContext}`);
  }

  if (includeScopedContext) {
    parts.push('\nLocal grounding rule: answer only from scoped Nexus facts listed above. If the requested local item is absent, say no matching local records were found instead of inventing it.');
  }

  return parts.join('\n');
}

function shouldIncludeScopedStateContext(domain: DomainName, hasUserScope: boolean, message?: string): boolean {
  if (!hasUserScope) return false;
  if (!isChatContextCompilerEnabled()) return true;
  if (!message || !message.trim()) return true;
  if (domain === 'triathlon' && isTrainingPrescriptionIntent(message)) return true;
  const contract = inferChatTurnContract({ message, routedDomain: domain });
  return contract.groundingRequired !== 'none';
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
  tenantId?: number,
  // Phase K (2026-05-26): optional shape hints from the chat-message-
  // routes layer's NexusAnswerContract. The TaskRoutingProvider's
  // runtime hard-block reads these to decide whether to bypass Ollama
  // for tool-or-write requests. Both undefined → bypass uses
  // conservative defaults (e.g., finance routes to cloud when
  // ownerSkill is missing).
  phaseKHints?: { ownerSkill?: string; executeIntent?: boolean },
): Promise<DomainResponse> {
  const hasUserScope = typeof userId === 'number';
  const history = hasUserScope ? getConversationHistory(userId, domain, tenantId) : [];
  // Phase 3 Slice A: pass the incoming message so the triathlon
  // branch of buildSimpleStateContext can run the sport classifier
  // and inject the onboarding-pending block when appropriate.
  const stateContext = await buildSimpleStateContext(domain, userId, message, tenantId);

  try {
    // Get the active routing provider (handles fallback + circuit breaker)
    const provider = getActiveProvider() || ensureActiveProvider();
    if (!provider) {
      if (!canUseDirectAnthropicFallback()) {
        return buildAIUnavailableResponse(domain, userId);
      }
      // Fallback to direct Anthropic if routing provider not initialized
      return await handleWithDirectCalls(
        domain,
        history,
        message,
        stateContext,
        maxIterations,
        userId,
        maxTokensOverride,
        callDirectAnthropicDomain,
        continueDirectAnthropicWithToolResults,
        tenantId,
      );
    }

    // Phase K (2026-05-26): derive ownerSkill from the domain name.
    // chat-answer-contract.ts maps domain↔ownerSkill stably:
    //   cooking→cooking, content→content, finance→finance,
    //   triathlon→training, secretary→secretary.
    // Callers that have an explicit NexusAnswerContract may pass
    // `phaseKHints.ownerSkill` to override the derived value.
    const derivedOwnerSkill = phaseKHints?.ownerSkill
      ?? (domain === 'triathlon' ? 'training'
        : (domain === 'cooking' || domain === 'content' || domain === 'finance' || domain === 'secretary')
          ? domain
          : undefined);

    // Route through the provider-agnostic interface
    let result = await provider.callDomain(domain, history, message, stateContext, {
      maxTokensOverride,
      userId,
      tenantId,
      // Phase K (2026-05-26): forward NexusAnswerContract shape hints
      // so the TaskRoutingProvider's runtime hard-block can decide
      // whether to bypass Ollama for tool-or-write requests.
      ownerSkill: derivedOwnerSkill,
      executeIntent: phaseKHints?.executeIntent,
    });
    let finalText = result.text;

    logger.debug({ domain, provider: provider.name, hasTools: result.toolCalls.length > 0 }, 'Domain call completed via routing provider');

    // Provider-agnostic tool conversation (no Anthropic-specific types)
    const toolConversation: AIToolResultMessage[] = [];
    const toolsUsed: string[] = [];
    let legacyWriteBlocked = false;
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
          if (isLegacyDomainWriteTool(tc.name)) {
            legacyWriteBlocked = true;
            logger.warn(
              { domain, userId, tenantId, tool: tc.name },
              'Blocked legacy domain chat write tool; action planner confirmation is required',
            );
            const blockedResult = buildLegacyDomainWriteBlockedToolResult(tc.name);
            let content = JSON.stringify(blockedResult);
            if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
            return { type: 'tool_result' as const, tool_use_id: tc.id, content };
          }
          const toolResult = await executeScopedToolCall(tc.name, tc.input as Record<string, any>, userId, tenantId);
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
      result = await provider.continueWithToolResults(domain, history, message, stateContext, toolConversation, {
        userId,
        tenantId,
      });
      finalText = result.text;
    }

    if (legacyWriteBlocked) {
      finalText = buildLegacyDomainWriteBlockedReply();
    }

    // Codex QA round 5: if the loop exits at maxIterations with the
    // model STILL requesting tools, we used to silently return
    // finalText (often empty or stale). That hides a cap-exceeded
    // state from the user. Surface it explicitly so iOS shows a
    // "needs a follow-up" prompt instead of an apparently-done turn.
    if (result.toolCalls.length > 0 && iterations >= maxIterations) {
      logger.warn(
        { domain, iterations, toolsUsedCount: toolsUsed.length },
        'Tool loop exceeded maxIterations with model still requesting tools — returning partial-state notice',
      );
      finalText = (finalText && finalText.trim().length > 10)
        ? `${finalText}\n\n_Nexus reached the per-turn tool cap (${maxIterations}). Some steps are still pending — ask me to continue and I'll keep going._`
        : `Nexus ran out of tool-call iterations for this turn (${maxIterations}). I started the work but didn't finish — ask me to continue from where I left off.`;
    }

    if (legacyWriteBlocked) {
      finalText = buildLegacyDomainWriteBlockedReply();
    }

    finalText = normalizeReplyForUserLanguage(finalText, userId);
    finalText = enforceCookingDomainAnswerSafety(domain, finalText, userId, tenantId);

    if (hasUserScope) {
      const storedText = toolsUsed.length > 0
        ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
        : finalText;
      addScopedConversation(userId, domain, 'user', message, tenantId);
      addScopedConversation(userId, domain, 'assistant', storedText, tenantId);
    }

    return { text: finalText, domain };
  } catch (err: unknown) {
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
  maxIterations: number, userId: number | undefined, maxTokensOverride: number | undefined,
  callDomainFn: (...args: any[]) => Promise<any>, continueWithToolResultsFn: (...args: any[]) => Promise<any>,
  tenantId?: number,
): Promise<DomainResponse> {
  const directOptions = {
    maxTokensOverride,
    userId,
    tenantId,
  };
  let result = await callDomainFn(domain, history, message, stateContext, directOptions);
  let finalText = result.text;

  const toolConversation: any[] = [];
  const toolsUsed: string[] = [];
  let legacyWriteBlocked = false;
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
        if (isLegacyDomainWriteTool(tc.name)) {
          legacyWriteBlocked = true;
          logger.warn(
            { domain, userId, tenantId, tool: tc.name },
            'Blocked legacy direct-call write tool; action planner confirmation is required',
          );
          const blockedResult = buildLegacyDomainWriteBlockedToolResult(tc.name);
          let content = JSON.stringify(blockedResult);
          if (content.length > 2000) content = content.slice(0, 2000) + '...(truncated)';
          return { type: 'tool_result' as const, tool_use_id: tc.id, content };
        }
        const toolResult = await executeScopedToolCall(tc.name, tc.input as Record<string, any>, userId, tenantId);
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
    result = await continueWithToolResultsFn(domain, history, message, stateContext, toolConversation, userId, directOptions);
    finalText = result.text;
  }

  if (legacyWriteBlocked) {
    finalText = buildLegacyDomainWriteBlockedReply();
  }

  // Codex QA round 5/6: parity with the primary path — direct-calls
  // fallback must also surface a cap-reached notice when the loop
  // exits with the model still requesting tools.
  if (result.toolCalls && result.toolCalls.length > 0 && iterations >= maxIterations) {
    logger.warn(
      { domain, iterations, toolsUsedCount: toolsUsed.length, path: 'direct-calls' },
      'Tool loop exceeded maxIterations with model still requesting tools — returning partial-state notice',
    );
    finalText = (finalText && finalText.trim().length > 10)
      ? `${finalText}\n\n_Nexus reached the per-turn tool cap (${maxIterations}). Some steps are still pending — ask me to continue and I'll keep going._`
      : `Nexus ran out of tool-call iterations for this turn (${maxIterations}). I started the work but didn't finish — ask me to continue from where I left off.`;
  }

  if (legacyWriteBlocked) {
    finalText = buildLegacyDomainWriteBlockedReply();
  }

  finalText = normalizeReplyForUserLanguage(finalText, userId);
  finalText = enforceCookingDomainAnswerSafety(domain, finalText, userId, tenantId);

  if (typeof userId === 'number') {
    addScopedConversation(userId, domain, 'user', message, tenantId);
    const storedText = toolsUsed.length > 0
      ? `[Tools: ${[...new Set(toolsUsed)].join(', ')}]\n${finalText}`
      : finalText;
    addScopedConversation(userId, domain, 'assistant', storedText, tenantId);
  }

  return { text: finalText, domain };
}

function enforceCookingDomainAnswerSafety(
  domain: DomainName,
  finalText: string,
  userId?: number,
  tenantId?: number,
): string {
  if (domain !== 'cooking' || typeof userId !== 'number') {
    return finalText;
  }
  const resolvedTenantId = typeof tenantId === 'number'
    ? tenantId
    : resolveCurrentTenantIdForUser(userId);
  try {
    const evaluation = evaluateCookingSafetyText(userId, resolvedTenantId, 'legacy_domain_answer', [finalText]);
    if (!evaluation.blocked) return finalText;
    logger.warn(
      {
        userId,
        tenantId: resolvedTenantId,
        event: 'COOKING_SAFETY_BLOCKED',
        ...cookingSafetyLogPayload(evaluation),
      },
      'COOKING_SAFETY_BLOCKED',
    );
    return renderCookingSafetyBlockedResponse(getCookingSafetyLocale(userId));
  } catch (err) {
    logger.warn({ err, userId, tenantId: resolvedTenantId }, 'Cooking domain answer safety check failed; returning safe refusal');
    return renderCookingSafetyBlockedResponse(getCookingSafetyLocale(userId));
  }
}

function getCookingSafetyLocale(userId: number): string | undefined {
  try {
    return getUserLanguageById(userId);
  } catch {
    return undefined;
  }
}
