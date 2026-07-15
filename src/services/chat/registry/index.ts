// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText, hasCalendarWriteIntent, hasMailReadIntent } from '../../calendar-natural-language-parser';
import type {
  ChatActionDefinition,
  ChatActionName,
  ChatActionOwner,
  ChatActionRisk,
  ChatActionRiskClass,
  ChatActionSkill,
  ChatActionStatus,
  ChatProvider,
  ChatSkillMetadata,
  SlotContext,
  SlotExtractionResult,
  SlotExtractor,
  SlotValidationResult,
  SlotValidator,
} from './types';
import { makeRequiredFieldsValidator, riskClassForRisk } from './helpers';
import { SECRETARY_CALENDAR_ACTIONS } from './definitions/secretary-calendar';
import { SECRETARY_REMINDER_ACTIONS } from './definitions/secretary-reminders';
import { MAIL_ACTIONS } from './definitions/mail';
import { TASK_ACTIONS } from './definitions/tasks';
import { TRAINING_ACTIONS } from './definitions/training';
import { CONTENT_ACTIONS } from './definitions/content';
import { COOKING_ACTIONS } from './definitions/cooking';
import { FINANCE_ACTIONS } from './definitions/finance';
import { CONNECTIONS_ACTIONS } from './definitions/connections';
import { NOTIFICATION_ACTIONS } from './definitions/notifications';
import { DECISION_CENTER_ACTIONS } from './definitions/decision-center';
import { getCapabilityUiSkillMetadata } from '../../capability-manifest';

export type {
  ChatActionDefinition,
  ChatActionName,
  ChatActionOwner,
  ChatActionRisk,
  ChatActionRiskClass,
  ChatActionSkill,
  ChatActionStatus,
  ChatProvider,
  ChatSkillMetadata,
  SlotContext,
  SlotExtractionResult,
  SlotExtractor,
  SlotValidationResult,
  SlotValidator,
} from './types';

export { makeRequiredFieldsValidator, riskClassForRisk } from './helpers';

// ──────────────────────────── Per-skill metadata ────────────────────────────
//
// Stable UI metadata comes from CapabilityManifest. Granular action schemas,
// executors, slot policies, and risk rules remain owned by this registry.

export const SKILL_METADATA = getCapabilityUiSkillMetadata() as Record<ChatActionSkill, ChatSkillMetadata>;

export function getSkillMetadata(skill: ChatActionSkill): ChatSkillMetadata {
  return SKILL_METADATA[skill];
}

// ──────────────────────────── Typed slot system ────────────────────────────
//
// Phase 11 batch 59 (2026-05-16): typed slot-extractor / slot-validator
// function refs (Phase 0 audit "TYPE TIGHTEN" item).
//
// Each registry entry can ship its extraction / validation logic as a
// callable function, not just a label string. The legacy string fields
// (`slotExtractors`, `slotValidators`) remain for backwards-compat and
// continue to work as advisory labels.

export const CHAT_ACTION_REGISTRY: ChatActionDefinition[] = [
  ...SECRETARY_CALENDAR_ACTIONS,
  ...SECRETARY_REMINDER_ACTIONS,
  ...MAIL_ACTIONS,
  ...TASK_ACTIONS,
  ...TRAINING_ACTIONS,
  ...CONTENT_ACTIONS,
  ...COOKING_ACTIONS,
  ...FINANCE_ACTIONS,
  ...CONNECTIONS_ACTIONS,
  ...NOTIFICATION_ACTIONS,
  ...DECISION_CENTER_ACTIONS,
];

export function getChatActionRegistry(): ChatActionDefinition[] {
  return CHAT_ACTION_REGISTRY.map((entry) => ({
    ...entry,
    version: entry.version ?? '2026-05-14',
    status: entry.status ?? 'active',
    owner: entry.owner ?? defaultOwnerForSkill(entry.skill),
    riskClass: entry.riskClass ?? riskClassForRisk(entry.risk),
    slotExtractors: entry.slotExtractors ?? ['deterministic_patterns', 'llm_allowed'],
    slotValidators: entry.slotValidators ?? entry.requiredFields.map((field) => `${field}_required`),
    executionPolicy: entry.executionPolicy ?? (entry.risk === 'read_only' ? 'read_only' : entry.risk === 'ambiguous' ? 'blocked' : 'idempotent_write'),
    verificationPolicy: entry.verificationPolicy ?? (
      entry.verifier === 'provider_read_back'
        ? 'provider_readback_required'
        : entry.verifier === 'local_read_back'
          ? 'local_readback_required'
          : 'not_required'
    ),
    uiSurfaces: entry.uiSurfaces ?? defaultUiSurfaces(entry.skill, entry.action),
    supportedCards: [...entry.supportedCards],
    examples: entry.examples ? [...entry.examples] : [],
  }));
}

function defaultOwnerForSkill(skill: ChatActionSkill): ChatActionOwner {
  switch (skill) {
    case 'tasks':
    case 'secretary_calendar':
    case 'secretary_reminders':
    case 'mail':
      return 'productivity';
    case 'training':
      return 'training';
    case 'content':
      return 'content';
    case 'finance':
      return 'finance';
    case 'cooking':
      return 'cooking';
    case 'connections':
    case 'notifications':
    case 'decision_center':
      return 'platform';
  }
}

export function findChatActionDefinition(skill: ChatActionSkill, action: ChatActionName): ChatActionDefinition | null {
  return CHAT_ACTION_REGISTRY.find((entry) => entry.skill === skill && entry.action === action) ?? null;
}

export function selectRegistrySubsetForMessage(text: string): ChatActionDefinition[] {
  const folded = foldCalendarText(text);
  const selected = new Set<ChatActionSkill>();
  if (hasCalendarWriteIntent(text) || /\b(calendar|calendario|agenda|evento|event)\b/.test(folded)) selected.add('secretary_calendar');
  if (/\b(remind\s+me|reminder|lembrete|lembra-?me|lembre-?me|lembrar|avisa-?me|avise-?me|avisame|alerta-?me|recordatorio|recuerdame|recu[eé]rdame)\b/.test(folded)
    || /^\s*(?:avisa|alerta)\b(?!\s+(?:que|es)\b)/.test(folded)) selected.add('secretary_reminders');
  if (hasMailReadIntent(text) || /\b(email|mail|gmail|outlook mail|inbox|caixa de entrada)\b/.test(folded)) selected.add('mail');
  if (/\b(task|todo|tarefa|subtarefa|checklist|lembrete|reminder)\b/.test(folded)) selected.add('tasks');
  if (/\b(treino|training|plan[o]? de treino|corrida|gym|ginasio)\b/.test(folded)) selected.add('training');
  if (/\b(content|conteudo|conteudo|script|roteiro|reel|tiktok|youtube|brief)\b/.test(folded)) selected.add('content');
  if (/\b(cozinha|meal|refeicao|jantar|almoco|ceia|lanche|comida|grocery|compras|fueling|recipe|receita|receitas|dinner|lunch|breakfast|snack|ingredient|ingredients)\b/.test(folded)) selected.add('cooking');
  if (/\b(finance|financas|financeiro|financeira|pagamento|stripe|invoice|fatura|recibo|receipt)\b/.test(folded)) selected.add('finance');
  if (/\b(connection|conexao|ligacao|google|outlook|garmin|health)\b/.test(folded)) selected.add('connections');
  if (/\b(notification|notificacao|notificacoes|alerta|push)\b/.test(folded)) selected.add('notifications');
  if (/\b(decision|decisao|escolha|snooze|adiar)\b/.test(folded)) selected.add('decision_center');
  if (selected.size === 0) return [];
  return getChatActionRegistry().filter(
    (entry) => selected.has(entry.skill) && entry.status === 'active',
  );
}

export function messageHasActionCandidate(text: string): boolean {
  const subset = selectRegistrySubsetForMessage(text);
  if (subset.length === 0) return false;
  const folded = foldCalendarText(text);
  return /\b(cria|criar|gera|gerar|marca|marcar|agenda|agendar|adiciona|adicionar|coloca|mete|poe|faz|apaga|apagar|remove|delete|move|mover|send|enviar|draft|create|add|generate|schedule|complete|concluir|reflow|ajusta|ajustar|atualiza|atualizar|adjust|update|publish|publicar|paga|pay|refund|categorize|rotate|revoke|revoga|revogar|mostra|mostrar|show|list|listar|resume|summary|relatorio|relatório|explain|explica|help|ajuda|check|retry|reconnect|snooze|dismiss|follow|remind|lembra|lembre|avisa|alerta|recordatorio|recuerdame|recu[eé]rdame)\b/.test(folded);
}

// Phase 11 batch 59 (2026-05-16): typed slot accessors.
//
// These helpers prefer typed entries when present and fall back to the
// legacy string labels otherwise. They never throw — callers must guard
// against `undefined` if the entry has neither typed nor legacy data.

/**
 * Returns the typed slot extractors for an action, falling back to a
 * label-only shape (no `extract` function) when the entry only defines
 * the legacy string field. Use `getSlotExtractorNames` if you only need
 * the names without the typed shape.
 */
export function getSlotExtractors(entry: ChatActionDefinition): SlotExtractor[] {
  if (entry.typedSlotExtractors && entry.typedSlotExtractors.length > 0) {
    return entry.typedSlotExtractors;
  }
  const labels = entry.slotExtractors ?? [];
  return labels.map((name) => ({ name, extract: () => ({ slots: {} }) }));
}

/**
 * Returns the typed slot validators for an action. Falls back to an
 * auto-generated required-fields validator built from
 * `entry.requiredFields` (mirrors the legacy `<field>_required` labels
 * but is callable). Use `getSlotValidatorNames` for label-only access.
 */
export function getSlotValidators(entry: ChatActionDefinition): SlotValidator[] {
  if (entry.typedSlotValidators && entry.typedSlotValidators.length > 0) {
    return entry.typedSlotValidators;
  }
  if (entry.slotValidators && entry.slotValidators.length > 0) {
    return entry.slotValidators.map((name) => ({
      name,
      validate: () => ({ ok: true }),
    }));
  }
  if (entry.requiredFields.length > 0) {
    return [makeRequiredFieldsValidator(entry.requiredFields)];
  }
  return [];
}

/** Returns just the names (typed-first, legacy-fallback). */
export function getSlotExtractorNames(entry: ChatActionDefinition): string[] {
  if (entry.typedSlotExtractors && entry.typedSlotExtractors.length > 0) {
    return entry.typedSlotExtractors.map((e) => e.name);
  }
  return entry.slotExtractors ?? [];
}

/** Returns just the names (typed-first, legacy-fallback). */
export function getSlotValidatorNames(entry: ChatActionDefinition): string[] {
  if (entry.typedSlotValidators && entry.typedSlotValidators.length > 0) {
    return entry.typedSlotValidators.map((v) => v.name);
  }
  if (entry.slotValidators && entry.slotValidators.length > 0) return entry.slotValidators;
  return entry.requiredFields.map((field) => `${field}_required`);
}

/**
 * Runs every typed validator for an action against the supplied slots,
 * aggregating per-slot errors and missing-field lists into one result.
 * Legacy string-only validators are skipped (they have no callable
 * `validate`). Returns `{ ok: true }` when no typed validators run.
 */
export function runSlotValidators(
  entry: ChatActionDefinition,
  slots: Record<string, unknown>,
  ctx?: SlotContext,
): SlotValidationResult {
  const validators = getSlotValidators(entry);
  const errors: Record<string, string> = {};
  const missingSet = new Set<string>();
  let ok = true;
  for (const v of validators) {
    const result = v.validate(slots, ctx);
    if (!result.ok) ok = false;
    if (result.errors) {
      for (const [k, m] of Object.entries(result.errors)) errors[k] = m;
    }
    if (result.missing) {
      for (const f of result.missing) missingSet.add(f);
    }
  }
  return {
    ok,
    errors: Object.keys(errors).length > 0 ? errors : undefined,
    missing: missingSet.size > 0 ? Array.from(missingSet) : undefined,
  };
}


function defaultUiSurfaces(skill: ChatActionSkill, action: ChatActionName): string[] {
  if (skill === 'training' && action === 'training_plan_create') return ['training_plan_builder'];
  if (skill === 'content') return ['script_studio', 'content_pipeline'];
  if (skill === 'tasks') return ['task_detail'];
  if (skill === 'secretary_reminders') return ['reminder_detail'];
  if (skill === 'secretary_calendar') return ['calendar_event'];
  if (skill === 'finance') return ['finance_review'];
  if (skill === 'cooking') return ['cooking_meal_plan'];
  return [skill];
}
