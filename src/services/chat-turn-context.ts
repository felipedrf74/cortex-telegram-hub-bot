// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 89 (2026-05-17): normalize-once helper.
//
// Before Batch 89, each per-skill parser called `foldCalendarText(input.text)`
// directly (~12 call sites in chat-action-planner.ts), re-running the same
// NFD + diacritic strip + lowercase fold per parser. This module centralizes
// the per-turn normalization into a single memoized bundle so each parser
// reads from a stable, shared `ChatTurnContext`.
//
// Adoption is incremental: the bundle is built lazily at the planner entry
// point and threaded through to per-skill parsers in subsequent Phase 17
// follow-up work. This batch lands the helper + types so the migration
// can begin without changing every parser signature.
//
// Score-based intent picking (the second half of Batch 89 in the
// original plan) was deferred to Phase 17 — the contract change (per-
// skill parsers returning `{step, score}`) is wider than the value it
// delivers in Phase 16 and risks regressing the first-match priority
// behavior that the Phase 10-15 batches relied on.

import { foldCalendarText } from './calendar-natural-language-parser';

export type ChatTurnLocale = 'pt-BR' | 'pt-PT' | 'en-US' | 'es-ES' | string;

export interface ChatTurnContextInputs {
  text: string;
  locale?: ChatTurnLocale;
  recentTurns?: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  pendingActionIds?: ReadonlyArray<string>;
}

export interface ChatTurnContext {
  readonly text: string;
  readonly folded: string;
  readonly locale: ChatTurnLocale;
  readonly isPortuguese: boolean;
  readonly isEnglish: boolean;
  readonly isSpanish: boolean;
  readonly recentTurns: ReadonlyArray<{ role: 'user' | 'assistant'; text: string }>;
  readonly pendingActionIds: ReadonlyArray<string>;
}

/**
 * Build the per-turn normalization bundle. `folded` is computed once and
 * memoized; downstream parsers re-use it via the bundle rather than
 * re-running `foldCalendarText`.
 */
export function buildChatTurnContext(inputs: ChatTurnContextInputs): ChatTurnContext {
  const text = inputs.text ?? '';
  const folded = foldCalendarText(text);
  const locale: ChatTurnLocale = inputs.locale ?? 'pt-BR';
  return {
    text,
    folded,
    locale,
    isPortuguese: locale.startsWith('pt'),
    isEnglish: locale.startsWith('en'),
    isSpanish: locale.startsWith('es'),
    recentTurns: Object.freeze([...(inputs.recentTurns ?? [])]),
    pendingActionIds: Object.freeze([...(inputs.pendingActionIds ?? [])]),
  };
}
