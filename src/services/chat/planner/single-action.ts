// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import {
  messageHasActionCandidate,
  selectRegistrySubsetForMessage,
} from '../registry';
import type {
  ChatActionPlan,
  ChatPlannerInput,
} from '../types';
import {
  tryBuildEscalationReviewerPlan,
  tryBuildLlmStructuredPlan,
  tryBuildTier1ClassifierPlan,
} from './tiers';
import { buildClarificationPlan } from './plan-builder';

export type DeterministicPlanBuilder = (input: ChatPlannerInput) => ChatActionPlan | null;

export async function buildSingleActionChatActionPlan(
  input: ChatPlannerInput,
  buildDeterministicPlan: DeterministicPlanBuilder,
): Promise<ChatActionPlan | null> {
  const deterministic = buildDeterministicPlan(input);
  if (deterministic) return deterministic;

  const folded = foldCalendarText(input.text);
  const looksComplex = /(?:\be\b|\band\b|\+|,).{8,}/.test(folded) || selectRegistrySubsetForMessage(input.text).length > 1;
  const tier1Plan = await tryBuildTier1ClassifierPlan(input);
  if (tier1Plan) return tier1Plan;

  if (looksComplex || messageHasActionCandidate(input.text)) {
    const llmPlan = await tryBuildLlmStructuredPlan(input);
    if (llmPlan) return llmPlan;
    const reviewerPlan = await tryBuildEscalationReviewerPlan(input);
    if (reviewerPlan) return reviewerPlan;
  }

  if (messageHasActionCandidate(input.text)) {
    return buildClarificationPlan(input, input.locale?.startsWith('pt')
      ? 'Preciso só de mais detalhes para fazer isso. Qual é o título, data, hora e destino?'
      : 'I need a few more details to do that. What title, date, time, and destination should I use?');
  }
  return null;
}
