// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M10: shared helpers for the /message stage pipeline and /confirm-action.
 *
 * Every function here was moved VERBATIM from chat-message-routes.ts during
 * the stage-pipeline decomposition — behavior changes are forbidden (the
 * replay corpus pins envelopes byte-for-byte).
 */

import { randomUUID } from 'crypto';
import type { Request } from 'express';

import { logger } from '../../../utils/logger';
import { listChatMessages } from '../../../services/chat-history-store';
import { getUserLanguageById } from '../../../services/user-service';
import type { NexusSkillId } from '../../../services/chat-skill-orchestrator';
import type { PendingChatConfirmation } from '../../../services/chat-pending-confirmations';
import { signChatConfirmationToken } from '../../../services/chat-confirmation-token';
import type {
  NexusChatActionability,
  NexusChatOwnerSkill,
  NexusChatVerificationStatus,
} from '../../../services/chat-answer-contract';
import type { ChatTurnContract } from '../../../services/chat-turn-contract';
import {
  chooseChatCoreV2Locale,
  incrementLegacyFallback,
  incrementLegacyFallbackAttribution,
  resolveChatCoreV2ActivationConfig,
  shouldServeCanaryForTenant,
  type ChatCoreV2ActionGatewayResult,
  type ChatCoreV2LocalChatRecentTurn,
} from '../../../services/chat-core-v2';
import { getDb } from '../../../services/database';

export function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
}

export function buildUserMessageId(clientMessageId: string | null, fallbackTimestamp = Date.now()): string {
  return clientMessageId ? `msg-user-${clientMessageId}` : `msg-user-${fallbackTimestamp}`;
}

// M11 id-collision sweep: assistant message ids must be collision-free even
// when two turns land in the same millisecond. Timestamps stay available
// separately (requestStartedAt) for latency/timestamp fields.
export function newAssistantMessageId(): string {
  return `msg-${randomUUID()}`;
}

// M13: cheap anchor-entity extraction from planner steps — only ids that are
// already present in step args count (no extra reads on the hot path).
export function anchorEntityIdsFromPlanSteps(
  steps: ReadonlyArray<{ args: Record<string, unknown> }>,
): string[] {
  const ids = new Set<string>();
  for (const step of steps) {
    for (const key of ['taskId', 'task_id', 'eventId', 'event_id', 'entityId', 'reminderId']) {
      const value = step.args?.[key];
      if (typeof value === 'string' && value.trim()) ids.add(value.trim());
      else if (typeof value === 'number' && Number.isFinite(value)) ids.add(String(value));
    }
  }
  return [...ids];
}

export function safeGetChatEvidenceLanguage(req: Request, userId: number): string | null {
  try {
    const rawHeader = req.header?.('x-language');
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof headerValue === 'string' && /^mixed$/i.test(headerValue.trim())) {
      return 'mixed';
    }
    return getUserLanguageById(userId);
  } catch {
    return null;
  }
}

function safeGetChatCoreV2HeaderLocale(req: Request): string | null {
  try {
    const rawHeader = req.header?.('x-language');
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (typeof headerValue !== 'string') return null;
    const trimmed = headerValue.trim();
    return /^(?:en|pt|es)(?:-[a-z0-9]{2,3})?$/i.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

function detectChatCoreV2MessageLanguage(text: string): string | null {
  const normalized = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (/\b(?:portugues\s+europeu|portugues\s+de\s+portugal|pt-pt)\b/.test(normalized)) return 'pt-PT';
  if (/\b(?:portugues\s+brasileiro|brazilian\s+portuguese|pt-br)\b/.test(normalized)) return 'pt-BR';
  if (/\b(?:espanol|castellano|spanish)\b/.test(normalized)) return 'es';
  if (/\b(?:english|ingles)\b/.test(normalized)) return 'en';

  const tokens = new Set(normalized.match(/\b[\w-]+\b/g) ?? []);
  const countHits = (words: string[]) => words.reduce((count, word) => count + (tokens.has(word) ? 1 : 0), 0);
  const hasPtAccent = /[ãõçáéíóúâêôà]/i.test(text);
  const hasEsSignal = /[¿¡ñ]/i.test(text);
  const esHits = countHits([
    'dame',
    'muestra',
    'tengo',
    'tienes',
    'puedo',
    'puedes',
    'tarea',
    'tareas',
    'receta',
    'recetas',
    'cocinar',
    'cenar',
    'cena',
    'comida',
    'plato',
    'hoy',
    'manana',
    'completar',
    'cancelar',
    'entrenamiento',
  ]);
  const ptPtHits = countHits([
    'da-me',
    'diz-me',
    'mostra-me',
    'ajuda-me',
    'tens',
    'tu',
    'teu',
    'teus',
    'tuas',
    'planeadas',
    'planeados',
    'fatura',
    'poupanca',
    'frigorifico',
  ]);
  const ptBrHits = countHits([
    'voce',
    'voces',
    'seu',
    'sua',
    'suas',
    'concluida',
    'planejada',
    'planejadas',
    'geladeira',
  ]);
  const hasPtBrPhrase = /\b(?:me\s+da|me\s+de)\b/.test(normalized);
  const ptSharedHits = countHits([
    'tenho',
    'devo',
    'posso',
    'fazer',
    'cozinhar',
    'jantar',
    'almoco',
    'receita',
    'receitas',
    'tarefa',
    'tarefas',
    'agenda',
    'calendario',
    'treino',
    'hoje',
    'amanha',
    'foco',
  ]);
  const enHits = countHits(['what', 'how', 'when', 'show', 'create', 'mark', 'cancel', 'recipe', 'task', 'calendar']);

  if (hasEsSignal || esHits >= 2) return enHits > 0 ? 'mixed' : 'es';
  if (ptPtHits > 0 || (hasPtAccent && !ptBrHits)) {
    return 'pt-PT';
  }
  if (ptBrHits > 0 || hasPtBrPhrase) {
    return 'pt-BR';
  }
  if (ptSharedHits >= 2 || hasPtAccent) return 'pt';
  if (enHits > 0) return 'en';
  return null;
}

export function resolveChatCoreV2RouteLocale(req: Request, userId: number, normalizedText: string): string {
  return chooseChatCoreV2Locale({
    explicitLocaleOverride: safeGetChatCoreV2HeaderLocale(req),
    detectedUserLanguage: detectChatCoreV2MessageLanguage(normalizedText),
    userLocale: getUserLanguageById(userId),
  });
}

export function isChatV2UnsupportedClaimEvidenceProbe(req: Request): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const rawHeader = req.header?.('x-chat-v2-evidence-probe');
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return typeof headerValue === 'string' && headerValue.trim().toLowerCase() === 'unsupported_claim';
}

export function safeGetChatV2ClientFirstProgressMs(req: Request): number | null {
  if (process.env.NODE_ENV === 'production') return null;
  const rawHeader = req.header?.('x-chat-v2-first-progress-ms');
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof headerValue !== 'string' || !headerValue.trim()) return null;
  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 120_000) return null;
  return Math.floor(parsed);
}

export function isAcceptCurrentDecisionShortcut(text: string): boolean {
  // This shortcut is intentionally a short, explicit acknowledgement. Bound
  // untrusted chat text before the whitespace-heavy compatibility patterns so
  // a single oversized request cannot turn the parser into event-loop work.
  if (text.length > 512) return false;
  return /^(accept|approve|confirm|yes|sim|aceitar|aprovar|confirmar)\s+(this|current|the)?\s*(decision|choice|clarification|decisão|escolha)?$/i.test(text.trim())
    || /\b(accept|approve|confirm)\s+this\s+decision\b/i.test(text)
    || /\b(aceitar|aprovar|confirmar)\s+esta\s+decis[aã]o\b/i.test(text);
}

export function isChatCoreV2VisibleNaturalLanguageOwnerActive(tenantId: number): boolean {
  const activation = resolveChatCoreV2ActivationConfig(process.env);
  if (!activation.allowedSurfaces.includes('ios')) return false;
  if (activation.mode === 'on') return true;
  if (activation.mode === 'canary') return shouldServeCanaryForTenant(String(tenantId), process.env);
  return false;
}

export interface ChatCoreV2LegacyFallbackAttribution {
  domain?: string | null;
  routeOwner?: string | null;
  routeMethod?: string | null;
}

function defaultChatCoreV2LegacyFallbackAttribution(fellBack: boolean): ChatCoreV2LegacyFallbackAttribution {
  return fellBack
    ? {
      domain: 'unknown',
      routeOwner: 'legacy_route_unattributed',
      routeMethod: 'legacy_route',
    }
    : {
      domain: 'chat_core_v2',
      routeOwner: 'chat_core_v2',
      routeMethod: 'handled',
    };
}

export function recordChatCoreV2LegacyFallbackSample(input: {
  tenantId: number;
  normalizedText: string;
  hasAttachments: boolean;
  fellBack: boolean;
  now: Date;
  attribution?: ChatCoreV2LegacyFallbackAttribution;
}): void {
  if (!input.normalizedText.trim() || input.hasAttachments) return;
  if (!isChatCoreV2VisibleNaturalLanguageOwnerActive(input.tenantId)) return;
  incrementLegacyFallback(getDb(), String(input.tenantId), { fellBack: input.fellBack }, input.now);
  incrementLegacyFallbackAttribution(
    getDb(),
    String(input.tenantId),
    {
      fellBack: input.fellBack,
      ...defaultChatCoreV2LegacyFallbackAttribution(input.fellBack),
      ...(input.attribution ?? {}),
    },
    input.now,
  );
}

export function shouldBypassNaturalLanguageTokenZeroForChatCoreV2(tenantId: number, normalizedText: string): boolean {
  const activation = resolveChatCoreV2ActivationConfig(process.env);
  if (!activation.disableNaturalLanguageTokenZero) return false;
  if (!normalizedText.trim() || normalizedText.trim().startsWith('/')) return false;
  return isChatCoreV2VisibleNaturalLanguageOwnerActive(tenantId);
}

export function buildRecentTurnsForChatCoreV2(userId: number, tenantId: number): ChatCoreV2LocalChatRecentTurn[] {
  try {
    return listChatMessages(userId, 4, undefined, tenantId).messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        text: String(message.text ?? ''),
      }))
      .filter((message) => message.text.trim().length > 0)
      .slice(-4);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), userId, tenantId },
      'Chat Core v2 recent-turn context read failed; continuing without recent turns',
    );
    return [];
  }
}

export function mapActionPlannerSkillToNexusSkill(skill: string): NexusSkillId {
  if (skill === 'secretary_calendar' || skill === 'secretary_reminders' || skill === 'mail' || skill === 'tasks') return 'secretary';
  if (skill === 'training') return 'training';
  if (skill === 'cooking') return 'cooking';
  if (skill === 'finance') return 'finance';
  if (skill === 'content') return 'content';
  return 'tools';
}

export function statusForChatActionResponse(
  actionStatus: string,
  response: { metadata?: Record<string, unknown> | null },
): number {
  const error = response.metadata?.error as { code?: string } | undefined;
  if (error?.code === 'TIER_REQUIRED') return 403;
  if (error?.code === 'ACCESS_CHECK_UNAVAILABLE') return 503;
  return actionStatus === 'needs_confirmation' || actionStatus === 'needs_clarification' ? 202 : 200;
}

export function intentClassForAction(action: string | undefined, fallbackSkills: string[] = []): string {
  switch (action) {
    case 'create_task':
    case 'create_task_with_subtasks':
      return 'task_create';
    case 'add_subtasks_to_task':
      return 'task_update';
    case 'delete_task':
      return 'task_delete';
    case 'complete_task':
      return 'task_complete';
    case 'update_task':
      return 'task_update';
    case 'schedule_event':
      return 'event_create';
    case 'move_event':
    case 'update_event':
      return 'event_move';
    case 'delete_event':
      return 'event_delete';
    case 'set_reminder':
      return 'reminder_create';
    case 'finance_payment_action':
      return 'financial_transfer';
    case 'finance_create_reminder':
    case 'finance_categorize_receipt':
      return 'finance_write';
    case 'send_email':
      return 'email_send';
    default:
      if (fallbackSkills.includes('finance')) return 'financial_transfer';
      if (fallbackSkills.includes('secretary')) return 'secretary_write';
      return action ? String(action).replace(/-/g, '_') : 'chat_action';
  }
}

export function confirmationVariantForIntent(intentClass: string, reasonCodes: string[] = []): 'default' | 'destructive' | 'financial' {
  if (intentClass.startsWith('financial') || intentClass === 'fiscal_bundle_send') return 'financial';
  if (intentClass.includes('delete') || reasonCodes.some((reason) => reason.includes('destructive'))) return 'destructive';
  return 'default';
}

export function attachPendingConfirmationContract(input: {
  response: { metadata?: Record<string, any> };
  pendingConfirmation: PendingChatConfirmation;
  intentClass: string;
  summary: Record<string, unknown>;
  decisionId?: string | null;
}): void {
  const token = signChatConfirmationToken({
    pendingId: input.pendingConfirmation.id,
    userId: input.pendingConfirmation.userId,
    tenantId: input.pendingConfirmation.tenantId,
    intentClass: input.intentClass,
    expiresAt: input.pendingConfirmation.expiresAt,
    sourceMessageId: input.pendingConfirmation.sourceMessageId ?? null,
  });
  const variant = confirmationVariantForIntent(input.intentClass, input.pendingConfirmation.reasonCodes);
  input.response.metadata = input.response.metadata ?? {};
  input.response.metadata.pendingConfirmation = {
    kind: 'pending_confirmation',
    id: input.pendingConfirmation.id,
    intent_class: input.intentClass,
    intentClass: input.intentClass,
    summary: input.summary,
    actionSummary: input.pendingConfirmation.actionSummary,
    confirmation_token: token,
    confirmationToken: token,
    expires_at: input.pendingConfirmation.expiresAt,
    expiresAt: input.pendingConfirmation.expiresAt,
    sourceMessageId: input.pendingConfirmation.sourceMessageId,
    decisionId: input.decisionId ?? null,
  };
  const existing = input.response.metadata.actionConfirmation && typeof input.response.metadata.actionConfirmation === 'object'
    ? input.response.metadata.actionConfirmation as Record<string, unknown>
    : {};
  input.response.metadata.actionConfirmation = {
    ...existing,
    variant,
    destructive: variant === 'destructive' || existing.destructive === true,
    requiresStrongConfirm: variant === 'financial',
    intentClass: input.intentClass,
    confirmationToken: token,
    expiresAt: input.pendingConfirmation.expiresAt,
    summary: input.summary,
    actionLabel: existing.actionLabel ?? (variant === 'financial' ? 'Confirm send' : 'Confirm'),
    cancelLabel: existing.cancelLabel ?? 'Cancel',
  };
}

export function withIdempotentConfirmationReplay(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const response = body as Record<string, any>;
  return {
    ...response,
    metadata: {
      ...(response.metadata && typeof response.metadata === 'object' ? response.metadata : {}),
      idempotentReplay: true,
      confirmationReplay: true,
    },
  };
}

export function domainForTurnContractSkill(skill: NexusChatOwnerSkill): string | null {
  switch (skill) {
    case 'secretary':
    case 'tasks':
    case 'connections':
    case 'notifications':
    case 'decision_center':
      return 'secretary';
    case 'training':
      return 'triathlon';
    case 'content':
    case 'finance':
    case 'cooking':
      return skill;
    default:
      return null;
  }
}

function shouldApplyTurnContractRouteHint(contract: ChatTurnContract, route: { domain: string; confidence: number }): boolean {
  if (contract.routeKind === 'action') return false;
  if (contract.riskClass === 'high' || contract.riskClass === 'destructive') return false;
  if (contract.skill === 'chat' || contract.skill === 'system' || contract.skill === 'owner_admin') return false;
  const hintedDomain = domainForTurnContractSkill(contract.skill);
  if (!hintedDomain || route.domain === hintedDomain) return false;
  return contract.confidence >= 0.8;
}

export function applyTurnContractRouteHint<T extends { domain: string; method: string; confidence: number }>(
  route: T,
  contract: ChatTurnContract,
): T {
  if (!shouldApplyTurnContractRouteHint(contract, route)) return route;
  const hintedDomain = domainForTurnContractSkill(contract.skill);
  if (!hintedDomain) return route;
  return {
    ...route,
    domain: hintedDomain,
    method: `${route.method}+turn-contract`,
    confidence: Math.max(route.confidence, contract.confidence),
  };
}

export function actionGatewayStopText(
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>,
  locale: string | null | undefined,
): string {
  if (result.kind === 'needs_clarification') return result.question;
  const normalizedLocale = String(locale ?? '').toLowerCase();
  const isPT = normalizedLocale.startsWith('pt');
  const isES = normalizedLocale.startsWith('es');
  if (result.kind === 'blocked_legacy_fallback') {
    if (isPT) return 'Preciso confirmar exatamente o que devo alterar antes de executar essa ação.';
    if (isES) return 'Necesito confirmar exactamente qué debo cambiar antes de ejecutar esa acción.';
    return 'I need to confirm exactly what to change before I run that action.';
  }
  if (result.reason === 'write_intent_negated_or_hypothetical') {
    if (isPT) return 'Não executei nenhuma ação. Posso ajudar a preparar uma prévia se quiseres.';
    if (isES) return 'No ejecuté ninguna acción. Puedo ayudarte a preparar una vista previa si quieres.';
    return 'I did not run any action. I can help prepare a preview if you want.';
  }
  if (isPT) return 'Ainda não consigo executar essa ação com segurança. Posso ajudar a preparar uma prévia ou pedir mais detalhes.';
  if (isES) return 'Todavía no puedo ejecutar esa acción con seguridad. Puedo preparar una vista previa o pedir más detalles.';
  return 'I cannot run that action safely yet. I can prepare a preview or ask for more details.';
}

export function destructiveConfirmationCopy(locale: string | null | undefined): {
  title: string;
  confirmLabel: string;
  declineLabel: string;
  openDecisionLabel: string;
  text: string;
} {
  const normalizedLocale = String(locale ?? '').toLowerCase();
  if (normalizedLocale.startsWith('pt')) {
    return {
      title: 'Confirmação necessária',
      confirmLabel: 'Confirmar',
      declineLabel: 'Não executar',
      openDecisionLabel: 'Abrir decisão',
      text: 'Antes de fazer uma alteração destrutiva, preciso de confirmação explícita. Confirme a ação exata que quer que eu faça, incluindo o item/plano/evento afetado. Não vou apagar, cancelar, enviar ou limpar nada sem essa confirmação.',
    };
  }
  if (normalizedLocale.startsWith('es')) {
    return {
      title: 'Confirmación necesaria',
      confirmLabel: 'Confirmar',
      declineLabel: 'No ejecutar',
      openDecisionLabel: 'Abrir decisión',
      text: 'Antes de hacer un cambio destructivo, necesito una confirmación explícita. Confirma la acción exacta que quieres que haga, incluyendo el elemento, plan, evento o mensaje afectado. No voy a borrar, cancelar, enviar ni limpiar nada sin esa confirmación.',
    };
  }
  return {
    title: 'Confirmation needed',
    confirmLabel: 'Confirm',
    declineLabel: 'Do not run',
    openDecisionLabel: 'Open decision',
    text: 'Before I make a destructive change, I need explicit confirmation. Please confirm the exact action you want, including the affected item, plan, event, or message. I will not delete, cancel, send, or clear anything without that confirmation.',
  };
}

export function isChatCoreV2GuardOnlyPendingConfirmation(pending: PendingChatConfirmation): boolean {
  return pending.summary?.mode === 'chat_core_v2_guard_only';
}

export function shouldCreateChatCoreV2GuardOnlyConfirmation(
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>,
): boolean {
  if (result.kind === 'unsupported_write' && result.reason === 'write_intent_negated_or_hypothetical') return false;
  const reasonCodes = result.telemetry.reasonCodes.join(' ').toLowerCase();
  const actionType = String(result.telemetry.actionType ?? '').toLowerCase();
  return result.kind === 'blocked_legacy_fallback'
    || result.telemetry.detectedIntent === 'other_write'
    || result.telemetry.detectedIntent === 'task_delete'
    || actionType.includes('delete')
    || actionType.includes('finance')
    || reasonCodes.includes('ambiguous_mutation')
    || reasonCodes.includes('unsupported_task_mutation_intent')
    || reasonCodes.includes('unsafe_write_intent')
    || reasonCodes.includes('broad_write_intent')
    || reasonCodes.includes('restricted_finance_write_intent');
}

export function buildChatCoreV2GuardOnlyConfirmationText(locale: string | null | undefined): string {
  const normalizedLocale = String(locale ?? '').toLowerCase();
  if (normalizedLocale.startsWith('pt')) {
    return 'Mantive a ação pausada e não alterei nada. Diz-me o item exato e preparo uma prévia segura.';
  }
  if (normalizedLocale === 'es') {
    return 'Mantuve la acción en pausa y no cambié nada. Dime el elemento exacto y preparo una vista previa segura.';
  }
  return 'I kept the action paused and did not change anything. Tell me the exact item and I will prepare a safe preview.';
}

export function buildChatCoreV2GuardOnlyConfirmationLabels(locale: string | null | undefined): {
  title: string;
  actionLabel: string;
  cancelLabel: string;
} {
  const normalizedLocale = String(locale ?? '').toLowerCase();
  if (normalizedLocale.startsWith('pt')) {
    return {
      title: 'Confirmação necessária',
      actionLabel: 'Manter pausado',
      cancelLabel: 'Cancelar',
    };
  }
  if (normalizedLocale === 'es') {
    return {
      title: 'Confirmación necesaria',
      actionLabel: 'Mantener pausado',
      cancelLabel: 'Cancelar',
    };
  }
  return {
    title: 'Confirmation needed',
    actionLabel: 'Keep paused',
    cancelLabel: 'Cancel',
  };
}

export function actionGatewayActionability(
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>,
): NexusChatActionability {
  return result.kind === 'needs_clarification' || result.kind === 'blocked_legacy_fallback' ? 'clarify' : 'blocked';
}

// M16/M8 adversarial fix: the planner emits the ChatActionRunStatus
// vocabulary ('verified_success' / 'partial_success' / …). Both statuses are
// EXECUTED action turns — mapping them to the default 'answer_only' /
// 'not_required' made the full quality gate treat honest per-step completion
// lines as unverified success claims and rewrite live partial answers.
export function actionabilityForReasoningStatus(status: string): NexusChatActionability {
  switch (status) {
    case 'completed':
    case 'verified_success':
    case 'partial_success':
    case 'partial_failure':
    case 'failed':
      return 'execute';
    case 'needs_clarification':
      return 'clarify';
    case 'needs_confirmation':
      return 'preview';
    case 'deferred':
      return 'blocked';
    case 'in_progress':
      return 'execute';
    default:
      return 'answer_only';
  }
}

export function verificationForReasoningMetadata(metadata: Record<string, unknown> | undefined, status: string): NexusChatVerificationStatus {
  const verification = typeof metadata?.verificationStatus === 'string' ? metadata.verificationStatus : undefined;
  // 'verified_success' is the executor envelope value (result-response.ts);
  // 'verified' is the contract vocabulary — both mean read-back verified.
  if (verification === 'verified' || verification === 'verified_success') return 'verified';
  if (verification === 'partial_failure') return 'partial_failure';
  if (status === 'failed') return 'failed';
  if (status === 'needs_confirmation' || status === 'needs_clarification') return 'pending';
  if (status === 'deferred') return 'blocked';
  if (status === 'completed' || status === 'verified_success') return 'verified';
  if (status === 'partial_success') return 'partial_failure';
  return 'not_required';
}
