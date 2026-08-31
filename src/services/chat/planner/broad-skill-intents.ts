// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';

import { foldCalendarText } from '../../calendar-natural-language-parser';
import { messageHasActionCandidate, selectRegistrySubsetForMessage } from '../registry';
import { parseConnectionsActionStep } from '../../skills/connections/parser';
import { parseContentActionStep } from '../../skills/content/parser';
import { isCookingLegacyToolIntent, parseCookingActionStep } from '../../skills/cooking/parser';
import { parseDecisionActionStep } from '../../skills/decision_center/parser';
import { parseFinanceActionStep } from '../../skills/finance/parser';
import { parseMailActionStep } from '../../skills/mail/parser';
import { parseNotificationActionStep } from '../../skills/notifications/parser';
import { parseTrainingActionStep } from '../../skills/training/parser';
import { makeStep } from '../../skills/step-builder';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
} from '../types';
import { buildPlanFromSteps } from './plan-builder';

export const BROAD_SKILL_SLOT_COMPLETENESS_BONUS = 0.005;
export const BROAD_SKILL_MIN_PRIORITY_GAP = 0.01;

export function parseBroadSkillActionIntent(input: ChatPlannerInput): ChatActionPlan | null {
  const folded = foldCalendarText(input.text);
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString()).setZone(input.timezone);

  // Phase 16 batch 89 second half (2026-05-17): score-based intent picking.
  //
  // Before this batch the dispatch was first-match priority — each parser
  // returned `step | null` and the first non-null result won. The original
  // Phase 6 batch 6 routing-gap fix established a hand-coded priority
  // ordering (notifications/decisions ahead of training because "disable
  // training notifications" should pick notifications). Score-based
  // picking preserves that ordering as scoreboard weights AND adds slot-
  // completeness as a TIE-BREAKER (small enough not to cross the
  // smallest priority gap of 0.01) so when two parsers at the same
  // base weight both match, the more-confident extraction wins.
  //
  // The score = baseWeight + (requiredArgsPresent ? bonus : 0). The
  // bonus is intentionally smaller than the smallest inter-skill priority
  // gap between adjacent skills so it only tie-breaks within a priority
  // tier; it never demotes a higher-priority skill.
  const candidates: Array<{
    step: ChatPlanStep;
    routingSignals: string[];
    confidence: number;
    score: number;
  }> = [];
  function consider(step: ChatPlanStep | null, baseWeight: number, signals: string[]) {
    if (!step) return;
    const score = baseWeight + (step.requiredArgsPresent ? BROAD_SKILL_SLOT_COMPLETENESS_BONUS : 0);
    candidates.push({ step, routingSignals: signals, confidence: baseWeight, score });
  }

  consider(parseNotificationActionStep(input, folded), 0.78, ['notification_action_intent', 'deterministic_skill_parser']);
  consider(parseDecisionActionStep(input, folded), 0.77, ['decision_action_intent', 'deterministic_skill_parser']);
  consider(parseContentActionStep(input, folded), 0.78, ['content_action_intent', 'deterministic_skill_parser']);
  consider(parseMailActionStep(input, folded), 0.77, ['mail_action_intent', 'deterministic_skill_parser']);
  consider(
    isCookingLegacyToolIntent(input.text) ? null : parseCookingActionStep(input, folded, now),
    0.76,
    ['cooking_action_intent', 'deterministic_skill_parser'],
  );
  consider(parseFinanceActionStep(input, folded, now), 0.75, ['finance_action_intent', 'deterministic_skill_parser']);
  consider(parseConnectionsActionStep(input, folded), 0.74, ['connections_action_intent', 'deterministic_skill_parser']);
  consider(parseTrainingActionStep(input, folded), 0.72, ['training_action_intent', 'deterministic_skill_parser']);

  if (candidates.length > 0) {
    // Stable sort: highest score wins; first declared wins on tie to
    // preserve the historic priority ordering.
    const best = candidates.reduce((a, b) => (b.score > a.score ? b : a));
    return buildPlanFromSteps(input, [best.step], best.routingSignals, best.confidence);
  }

  // Cooking CRUD without an equivalent typed action belongs to the legacy
  // tool path. Keep this gate after the other skill parsers so an explicit
  // task, notification, or calendar command that merely mentions the pantry
  // can still be claimed by its owning skill.
  if (isCookingLegacyToolIntent(input.text)) return null;

  if (messageHasActionCandidate(input.text)) {
    const subset = selectRegistrySubsetForMessage(input.text);
    const primary = subset[0];
    if (primary) {
      const step = makeStep(input, {
        skill: primary.skill,
        action: primary.action,
        risk: primary.risk,
        provider: primary.providerDependencies[0] ?? 'nexus',
        args: { rawRequest: input.text },
        requiredArgsPresent: false,
      });
      return buildPlanFromSteps(input, [step], ['unknown_action_candidate', primary.skill], 0.42);
    }
  }
  return null;
}
