// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Per-skill deterministic parser for the notifications skill. Extracted from
// chat-action-planner.ts on 2026-05-15 (planner-split, audit implementation
// plan Phase 0).

import { makeStep, type StepKeyInputs } from '../step-builder';
import { extractTopic } from '../text-extractors';
import type { ChatPlanStep } from '../../chat-action-planner';

export function parseNotificationActionStep(
  input: StepKeyInputs & { text: string },
  folded: string,
): ChatPlanStep | null {
  // Phase 11 batch 58 (2026-05-16): Spanish "notificación" / "notificaciones"
  // (folds to "notificacion[es]") added. PT-PT has "notificação" → "notificacao"
  // (no 'n') while ES has "notificación" → "notificacion" (with 'n') — the
  // singular char-class can't cover both, so we add a separate alternation.
  if (!/\b(notifications?|notificacao|notificacoes|notificação|notificações|notificaci[oó]n(?:es)?|alerta[s]?|push\s+notification)\b/.test(folded)) return null;
  // Explain intent: a why/how question about a specific notification, not a
  // preference change or new alert. Checked first because it's the most
  // specific intent class (read-only, requires topic).
  if (/\b(explain|why|por\s+que[ê]?|o\s+que\s+significa|why\s+(?:did|do|am)|porque|porquê|why\s+did\s+i\s+get|why\s+am\s+i\s+getting)\b/.test(folded)
    || /\b(what'?s?\s+(?:this|that)\s+notification|qual\s+(?:e|é)\s+essa\s+notifica[cç][aã]o)\b/.test(folded)) {
    return makeStep(input, {
      skill: 'notifications',
      action: 'notification_explain',
      risk: 'read_only',
      provider: 'nexus',
      args: { topic: extractTopic(input.text) || input.text.trim() },
      requiredArgsPresent: true,
    });
  }
  return makeStep(input, {
    skill: 'notifications',
    // Phase 3 batch 15: PT-BR "desliga/liga" (BR colloquial for
    // disable/enable) added as preference-update cue.
    // Phase 11 batch 58: Spanish "desactiva[r]?"/"activa[r]?" added.
    action: /\b(preference|preferencia|preferência|preferencias?|desativa[r]?|desactiva[r]?|disable|ativa[r]?|activa[r]?|enable|desliga[r]?|liga[r]?)\b/.test(folded)
      ? 'notification_update_preference'
      : 'notification_create_intent',
    risk: 'safe_write',
    provider: 'nexus',
    args: { title: extractTopic(input.text) || input.text.trim(), trigger: null },
    requiredArgsPresent: false,
  });
}
