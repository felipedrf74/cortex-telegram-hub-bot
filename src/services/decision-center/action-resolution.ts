// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Deterministic resolution of a human-facing Decision Center choice.
 *
 * Chat surfaces commonly receive compact aliases such as A/B or 1/2. Those
 * aliases are presentation input, never executable action identifiers. This
 * resolver binds them to the currently fetched server option and returns the
 * exact action/payload pair that the normal command path must authorize.
 */

export interface ResolvableDecisionOption {
  optionId: string;
  actionId: string;
  actionPayload?: Record<string, unknown>;
}

export interface ResolvableDecisionAction {
  id: string;
}

export interface ResolvableDecisionChoice {
  options?: ResolvableDecisionOption[];
  actions: ResolvableDecisionAction[];
}

export interface ResolvedDecisionChoice {
  optionId: string | null;
  actionId: string;
  payload: Record<string, unknown>;
}

export type DecisionChoiceResolution =
  | { ok: true; value: ResolvedDecisionChoice }
  | { ok: false; code: 'DECISION_CHOICE_REQUIRED' | 'DECISION_CHOICE_NOT_AVAILABLE' };

const LETTER_ALIASES = ['a', 'b', 'c', 'd'] as const;

function normalizedChoice(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function aliasIndex(value: string): number | null {
  const normalized = normalizedChoice(value);
  const letter = LETTER_ALIASES.indexOf(normalized as (typeof LETTER_ALIASES)[number]);
  if (letter >= 0) return letter;
  if (/^[1-4]$/.test(normalized)) return Number(normalized) - 1;
  return null;
}

/**
 * Resolve against the exact current item returned by the authoritative read.
 * Options take precedence because their payload is part of the decision
 * contract. When a legacy item has no structured options, exact action IDs
 * remain accepted; ordinal aliases may select only from its declared actions.
 */
export function resolveDecisionChoice(
  item: ResolvableDecisionChoice,
  requestedChoice: string,
): DecisionChoiceResolution {
  const requested = normalizedChoice(requestedChoice);
  if (!requested) return { ok: false, code: 'DECISION_CHOICE_REQUIRED' };

  const options = item.options ?? [];
  const exactOption = options.find((option) => (
    normalizedChoice(option.optionId) === requested
    || normalizedChoice(option.actionId) === requested
  ));
  if (exactOption) {
    return {
      ok: true,
      value: {
        optionId: exactOption.optionId,
        actionId: exactOption.actionId,
        payload: { ...(exactOption.actionPayload ?? {}) },
      },
    };
  }

  const index = aliasIndex(requestedChoice);
  if (index != null && options[index]) {
    const option = options[index];
    return {
      ok: true,
      value: {
        optionId: option.optionId,
        actionId: option.actionId,
        payload: { ...(option.actionPayload ?? {}) },
      },
    };
  }

  const exactAction = item.actions.find((action) => normalizedChoice(action.id) === requested);
  if (exactAction) {
    return { ok: true, value: { optionId: null, actionId: exactAction.id, payload: {} } };
  }

  if (index != null && options.length === 0 && item.actions[index]) {
    return {
      ok: true,
      value: { optionId: null, actionId: item.actions[index].id, payload: {} },
    };
  }

  return { ok: false, code: 'DECISION_CHOICE_NOT_AVAILABLE' };
}
