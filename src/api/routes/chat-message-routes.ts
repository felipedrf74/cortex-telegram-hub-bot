// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';

import { Router, Response, type Request } from 'express';
import { AuthenticatedRequest } from '../auth-middleware';
import { routeMessage } from '../../router';
import { logger } from '../../utils/logger';
import { pushEvent } from '../../portal/telemetry';
import {
  claimUserChatMessage,
  findCompletedAssistantForClientMessage,
  listChatMessages,
} from '../../services/chat-history-store';
import { getUserLanguageById, getUserTimezoneById } from '../../services/user-service';
import { acquireAiBudgetReservation } from '../../services/cost-guardrail';
import { getCurrentRequestId } from '../../utils/request-context';
import {
  buildDefaultButtonsForChatDomain,
  getChatDomainHandler,
  rememberChatActiveDomain,
  resolveChatActiveContext,
} from './chat-message-context';
import {
  buildChatHandlerResponseEnvelope,
  executeChatDomainHandler,
} from './chat-message-execution';
import {
  deterministicReadGroundingFact,
  finalizeChatAnswerMetadata,
  finalizeChatMessageResponse,
} from './chat-message-finalizer';
import {
  analyzeChatSkillOrchestration,
  applyChatSkillRoutingDecision,
  buildChatSkillRoutingLogContext,
  type NexusSkillId,
} from '../../services/chat-skill-orchestrator';
import { runWithChatToolAuthorization } from '../../services/chat-tool-authorization';
import { issueContentIdeaCaptureConsent } from '../../services/content-workspace-chat-consent';
import {
  buildBlocksFromMarkdown,
  type ChatResponseBlock,
} from '../../services/chat-response-blocks';
import {
  clearPendingChatConfirmation,
  getCompletedChatConfirmation,
  getPendingChatConfirmation,
  rememberCompletedChatConfirmation,
  trackPendingChatConfirmation,
  type PendingChatConfirmation,
} from '../../services/chat-pending-confirmations';
import {
  signChatConfirmationToken,
  validateChatConfirmationToken,
} from '../../services/chat-confirmation-token';
import { buildChatResponseSufficiencyMetadata } from '../../services/chat-response-sufficiency';
import { asyncHandler, sendAiBudgetError, sendInternalError } from '../response-helpers';
import {
  persistExchange,
  syncConversationStateForShortcut,
} from './chat-persistence';
import { buildChatAttachmentResponse } from './chat-message-attachments';
import { tryBuildChatMessageShortcutResponse, tryBuildTokenZeroChatMessageShortcutResponse } from './chat-message-shortcuts';
import {
  getCachedChatCommandResponse,
  maybeCacheChatCommandResponse,
  tryBuildAuthenticatedIdentityResponse,
  tryBuildFastPathChatResponse,
  tryBuildTrainingPlanShortcutResponse,
} from './chat-message-local-responses';
import { parseContentScriptShortcut } from './chat-shortcut-parsers';
import {
  normalizeChatMessageRequest,
  persistChatLanguagePreference,
} from './chat-message-request';
import { sendChatTierRequiredIfNeeded } from './chat-message-tier-gate';
import { sendRetryableChatFailureResponseIfNeeded } from './chat-message-degraded-response';
import {
  executeConfirmedChatActionRuns,
  tryHandleChatActionPlan,
} from '../../services/chat';
import { getPendingChatActionById } from '../../services/chat-action-state';
import { cancelAllPendingChatWork } from '../../services/chat-pending-work';
import { isPendingChatWorkCancellationTurn } from '../../services/chat-pending-cancellation';
import {
  createChatLatencyTracker,
  type NexusChatActionability,
  type NexusChatOwnerSkill,
  type NexusChatVerificationStatus,
} from '../../services/chat-answer-contract';
import { inferChatTurnContract, type ChatTurnContract } from '../../services/chat-turn-contract';
import { buildChatInternetResearchAnswer } from '../../services/chat-internet-research';
import {
  textClaimsUnverifiedAction,
  textHasBareAppSuccessMarker,
} from '../../services/chat-success-claim-policy';
import {
  chooseChatCoreV2Locale,
  incrementLegacyFallback,
  incrementLegacyFallbackAttribution,
  runChatCoreV2ShadowRouteHook,
  runChatCoreV2ActionGateway,
  runChatCoreV2LocalChatTurn,
  claimPendingChatCoreV2Command,
  clearPendingChatCoreV2Command,
  evaluateChatCoreV2UnsupportedFallback,
  executeChatCoreV2Command,
  loadChatV2MemoryContextForOrchestrator,
  resolveChatCoreV2ActivationConfig,
  shouldServeCanaryForTenant,
  shouldGateReadFastPathsForWriteIntent,
  tryBuildChatCoreV2DeterministicReadRoute,
  type ChatCoreV2ActionGatewayResult,
  type ChatCoreV2CommandExecutionResult,
  type ChatCoreV2LocalChatRecentTurn,
  type PendingChatCoreV2Command,
} from '../../services/chat-core-v2';
import { getDb } from '../../services/database';
import { safeRecordChatV2CompletionEvidence } from '../../services/chat-v2-completion-evidence';
import { safeRecordChatV2DeterministicReadEvidence } from '../../services/chat-deterministic-read-evidence';
import { safeRecordChatV2WriteEvidence } from '../../services/chat-write-evidence';
import { buildSimpleStateContext } from '../../domains/domain-handler';
import { buildChatCoreV2CommandPreviewShortcutResponse } from './chat-core-v2-command-preview-response';
import { buildChatCoreV2CommandConfirmationShortcutResponse } from './chat-core-v2-command-confirmation-response';
import { buildChatCoreV2DeterministicReadShortcutResponse } from './chat-core-v2-deterministic-read-response';
import {
  isChatCoreV2ShadowRouteHookEnabled,
  isChatResearchRouterEnabled,
  isChatTurnContractEnabled,
} from '../../services/runtime-flags';
import {
  createDecisionIntent,
  findDecisionByRelatedEntity,
  performDecisionAction,
} from '../../services/decision-center';
// M6 stage-trace seam: no-op unless CHAT_STAGE_TRACE / the test seam is on.
// Each early-return checkpoint family below records its stage name so the
// replay corpus can pin the /message stage ORDER ahead of the M10
// stage-pipeline decomposition.
import { recordChatStage } from '../../services/chat-stage-trace';

type ChatRouteScopeGuard = (
  res: Response,
  userId: number | undefined,
  tenantId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
) => userId is number;

export { clearChatActiveDomain } from './chat-message-context';

function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 160);
}

function buildUserMessageId(clientMessageId: string | null, fallbackTimestamp = Date.now()): string {
  return clientMessageId ? `msg-user-${clientMessageId}` : `msg-user-${fallbackTimestamp}`;
}

// M11 id-collision sweep: assistant message ids must be collision-free even
// when two turns land in the same millisecond. Timestamps stay available
// separately (requestStartedAt) for latency/timestamp fields.
function newAssistantMessageId(): string {
  return `msg-${randomUUID()}`;
}

// M13: cheap anchor-entity extraction from planner steps — only ids that are
// already present in step args count (no extra reads on the hot path).
function anchorEntityIdsFromPlanSteps(
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

function safeGetChatEvidenceLanguage(req: Request, userId: number): string | null {
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

function resolveChatCoreV2RouteLocale(req: Request, userId: number, normalizedText: string): string {
  return chooseChatCoreV2Locale({
    explicitLocaleOverride: safeGetChatCoreV2HeaderLocale(req),
    detectedUserLanguage: detectChatCoreV2MessageLanguage(normalizedText),
    userLocale: getUserLanguageById(userId),
  });
}

function isChatV2UnsupportedClaimEvidenceProbe(req: Request): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  const rawHeader = req.header?.('x-chat-v2-evidence-probe');
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return typeof headerValue === 'string' && headerValue.trim().toLowerCase() === 'unsupported_claim';
}

function safeGetChatV2ClientFirstProgressMs(req: Request): number | null {
  if (process.env.NODE_ENV === 'production') return null;
  const rawHeader = req.header?.('x-chat-v2-first-progress-ms');
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof headerValue !== 'string' || !headerValue.trim()) return null;
  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 120_000) return null;
  return Math.floor(parsed);
}

function isAcceptCurrentDecisionShortcut(text: string): boolean {
  // This shortcut is intentionally a short, explicit acknowledgement. Bound
  // untrusted chat text before the whitespace-heavy compatibility patterns so
  // a single oversized request cannot turn the parser into event-loop work.
  if (text.length > 512) return false;
  return /^(accept|approve|confirm|yes|sim|aceitar|aprovar|confirmar)\s+(this|current|the)?\s*(decision|choice|clarification|decisão|escolha)?$/i.test(text.trim())
    || /\b(accept|approve|confirm)\s+this\s+decision\b/i.test(text)
    || /\b(aceitar|aprovar|confirmar)\s+esta\s+decis[aã]o\b/i.test(text);
}

function isChatCoreV2VisibleNaturalLanguageOwnerActive(tenantId: number): boolean {
  const activation = resolveChatCoreV2ActivationConfig(process.env);
  if (!activation.allowedSurfaces.includes('ios')) return false;
  if (activation.mode === 'on') return true;
  if (activation.mode === 'canary') return shouldServeCanaryForTenant(String(tenantId), process.env);
  return false;
}

interface ChatCoreV2LegacyFallbackAttribution {
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

function recordChatCoreV2LegacyFallbackSample(input: {
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

function shouldBypassNaturalLanguageTokenZeroForChatCoreV2(tenantId: number, normalizedText: string): boolean {
  const activation = resolveChatCoreV2ActivationConfig(process.env);
  if (!activation.disableNaturalLanguageTokenZero) return false;
  if (!normalizedText.trim() || normalizedText.trim().startsWith('/')) return false;
  return isChatCoreV2VisibleNaturalLanguageOwnerActive(tenantId);
}

function buildRecentTurnsForChatCoreV2(userId: number, tenantId: number): ChatCoreV2LocalChatRecentTurn[] {
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

function mapActionPlannerSkillToNexusSkill(skill: string): NexusSkillId {
  if (skill === 'secretary_calendar' || skill === 'secretary_reminders' || skill === 'mail' || skill === 'tasks') return 'secretary';
  if (skill === 'training') return 'training';
  if (skill === 'cooking') return 'cooking';
  if (skill === 'finance') return 'finance';
  if (skill === 'content') return 'content';
  return 'tools';
}

function statusForChatActionResponse(
  actionStatus: string,
  response: { metadata?: Record<string, unknown> | null },
): number {
  const error = response.metadata?.error as { code?: string } | undefined;
  if (error?.code === 'TIER_REQUIRED') return 403;
  if (error?.code === 'ACCESS_CHECK_UNAVAILABLE') return 503;
  return actionStatus === 'needs_confirmation' || actionStatus === 'needs_clarification' ? 202 : 200;
}

function intentClassForAction(action: string | undefined, fallbackSkills: string[] = []): string {
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

function confirmationVariantForIntent(intentClass: string, reasonCodes: string[] = []): 'default' | 'destructive' | 'financial' {
  if (intentClass.startsWith('financial') || intentClass === 'fiscal_bundle_send') return 'financial';
  if (intentClass.includes('delete') || reasonCodes.some((reason) => reason.includes('destructive'))) return 'destructive';
  return 'default';
}

function attachPendingConfirmationContract(input: {
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

function withIdempotentConfirmationReplay(body: unknown): unknown {
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

function domainForTurnContractSkill(skill: NexusChatOwnerSkill): string | null {
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

function applyTurnContractRouteHint<T extends { domain: string; method: string; confidence: number }>(
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

// M8: the metadata/contract enrichment helpers moved to
// ./chat-message-finalizer — the single terminal pipeline for every
// /message response family (finalizeChatMessageResponse /
// finalizeChatAnswerMetadata, policy table keyed by stage family and
// routeMethod; unknown families fail closed to the full quality gate).

export { isPendingChatWorkCancellationTurn };

function actionGatewayStopText(
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

function destructiveConfirmationCopy(locale: string | null | undefined): {
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

function isChatCoreV2GuardOnlyPendingConfirmation(pending: PendingChatConfirmation): boolean {
  return pending.summary?.mode === 'chat_core_v2_guard_only';
}

function shouldCreateChatCoreV2GuardOnlyConfirmation(
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

function buildChatCoreV2GuardOnlyConfirmationText(locale: string | null | undefined): string {
  const normalizedLocale = String(locale ?? '').toLowerCase();
  if (normalizedLocale.startsWith('pt')) {
    return 'Mantive a ação pausada e não alterei nada. Diz-me o item exato e preparo uma prévia segura.';
  }
  if (normalizedLocale === 'es') {
    return 'Mantuve la acción en pausa y no cambié nada. Dime el elemento exacto y preparo una vista previa segura.';
  }
  return 'I kept the action paused and did not change anything. Tell me the exact item and I will prepare a safe preview.';
}

function buildChatCoreV2GuardOnlyConfirmationLabels(locale: string | null | undefined): {
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

function actionGatewayActionability(
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>,
): NexusChatActionability {
  return result.kind === 'needs_clarification' || result.kind === 'blocked_legacy_fallback' ? 'clarify' : 'blocked';
}

function recordChatCoreV2GatewayPreviewEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'resolved_preview' | 'resolved_execute' }>;
}): void {
  const cards = input.result.preview.response.cards ?? [];
  const diffRequired = cards.some((card) => Array.isArray(card.diff) && card.diff.length > 0)
    || Boolean(input.result.preview.confirmationToken);
  const visibleDiffPresent = diffRequired
    ? cards.some((card) => Array.isArray(card.diff) && card.diff.length > 0)
      || Boolean(input.result.preview.confirmationToken)
    : true;
  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `action-gateway:${input.result.preview.capabilityId}:${input.result.command.commandId}`,
    phase: input.result.kind === 'resolved_execute' ? 'confirmed_writes' : 'write_preview',
    riskClass: input.result.writeRiskPolicy.riskClass,
    previewValid: input.result.preview.gateVerdict.ok,
    diffRequired,
    visibleDiffPresent,
    executed: input.result.kind === 'resolved_execute',
    validatedBeforeExecution: input.result.preview.gateVerdict.ok,
    successClaimed: false,
    verificationStatus: input.result.kind === 'resolved_execute' ? 'indeterminate' : 'not_required',
    escalatedPerPolicy: input.result.writeRiskPolicy.riskClass !== 'C',
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-core-v2-action-gateway',
      capabilityId: input.result.preview.capabilityId,
      commandType: input.result.command.commandType,
      policyDecision: input.result.telemetry.policyDecision,
      writeExecutionGateBlocked: input.result.telemetry.writeExecutionGateBlocked === true,
    },
  });
}

function recordChatCoreV2GatewayStopEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>;
}): void {
  const riskClass = toWriteEvidenceRiskClassForGatewayStop(input.result);
  const phase = riskClass === 'C' ? 'confirmed_writes' : 'write_preview';
  const reason = input.result.kind === 'needs_clarification' ? 'needs_clarification' : input.result.reason;

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `action-gateway-stop:${input.result.kind}:${input.result.telemetry.detectedIntent}:${reason}`,
    phase,
    riskClass,
    previewValid: true,
    diffRequired: true,
    visibleDiffPresent: true,
    executed: false,
    validatedBeforeExecution: true,
    successClaimed: false,
    verificationStatus: riskClass === 'C' ? 'indeterminate' : 'not_required',
    escalatedPerPolicy: riskClass !== 'C' || input.result.kind !== 'blocked_legacy_fallback' || input.result.telemetry.legacyFallbackBlocked,
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-core-v2-action-gateway',
      gatewayOutcome: input.result.kind,
      detectedIntent: input.result.telemetry.detectedIntent,
      actionType: input.result.telemetry.actionType ?? null,
      policyDecision: input.result.telemetry.policyDecision,
      legacyFallbackBlocked: input.result.telemetry.legacyFallbackBlocked,
      reason,
    },
  });
}

function actionabilityForReasoningStatus(status: string): NexusChatActionability {
  switch (status) {
    case 'completed':
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

function verificationForReasoningMetadata(metadata: Record<string, unknown> | undefined, status: string): NexusChatVerificationStatus {
  const verification = typeof metadata?.verificationStatus === 'string' ? metadata.verificationStatus : undefined;
  if (verification === 'verified') return 'verified';
  if (verification === 'partial_failure') return 'partial_failure';
  if (status === 'failed') return 'failed';
  if (status === 'needs_confirmation' || status === 'needs_clarification') return 'pending';
  if (status === 'deferred') return 'blocked';
  if (status === 'completed') return 'verified';
  return 'not_required';
}

function recordChatReasoningWriteEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  normalizedText: string;
  status: string;
  response: { text?: unknown; metadata?: Record<string, unknown> | undefined };
}): void {
  const metadata = input.response.metadata && typeof input.response.metadata === 'object'
    ? input.response.metadata
    : {};
  const actionFrame = metadata.actionFrame && typeof metadata.actionFrame === 'object'
    ? metadata.actionFrame as Record<string, unknown>
    : {};
  const riskClass = toWriteEvidenceRiskClass(actionFrame.riskLevel, metadata);
  const verificationStatus = toWriteEvidenceVerificationStatus(
    typeof metadata.verificationStatus === 'string' ? metadata.verificationStatus : undefined,
    input.status,
  );
  const executed = input.status === 'completed' || input.status === 'partial_failure' || input.status === 'failed';
  // Class C items are non-executing escalations in v1, but the Phase 6 gate
  // still needs runtime evidence that the escalation policy caught them.
  const phase = executed || riskClass === 'C' ? 'confirmed_writes' : 'write_preview';
  const previewValid = executed
    || input.status === 'needs_confirmation'
    || input.status === 'needs_clarification'
    || Boolean(metadata.actionConfirmation || Object.keys(actionFrame).length > 0);
  const diffRequired = Boolean(
    metadata.actionConfirmation
      || metadata.type === 'chat_action_confirmation_required'
      || metadata.type === 'chat_action_clarification_required'
      || Object.keys(actionFrame).length > 0
      || metadata.type === 'task_created'
      || metadata.type === 'task_subtasks_added',
  );
  const visibleDiffPresent = diffRequired
    ? Boolean(
      metadata.actionConfirmation
        || metadata.title
        || metadata.reason
        || (Array.isArray(metadata.subtasks) && metadata.subtasks.length > 0)
        || actionFrame.primaryIntent,
    )
    : true;

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `${input.status}:${String(metadata.type ?? 'chat_reasoning_write')}:${String(actionFrame.primaryIntent ?? '')}`,
    phase,
    riskClass,
    previewValid,
    diffRequired,
    visibleDiffPresent,
    executed,
    validatedBeforeExecution: true,
    successClaimed: executed && /\b(?:created|added|marked|done|criada?|criado|adicionei|conclu[ií]|feito|feita)\b/i
      .test(String(input.response.text ?? '')),
    verificationStatus,
    escalatedPerPolicy: riskClass !== 'C'
      || Boolean(metadata.escalatedPerPolicy)
      || input.status === 'needs_confirmation'
      || input.status === 'needs_clarification'
      || input.status === 'deferred',
    idempotencyPassed: metadata.idempotentReplay === true || Boolean(metadata.actionPlanId) || !executed,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-reasoning-engine',
      status: input.status,
      metadataType: typeof metadata.type === 'string' ? metadata.type : null,
      primaryIntent: typeof actionFrame.primaryIntent === 'string' ? actionFrame.primaryIntent : null,
      reason: typeof metadata.reason === 'string' ? metadata.reason : null,
      verificationStatus,
    },
  });
}

function recordConfirmedChatActionWriteEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  pending: PendingChatConfirmation;
  status: string;
  response: { text?: unknown; metadata?: Record<string, unknown> | undefined };
}): void {
  const metadata = input.response.metadata && typeof input.response.metadata === 'object'
    ? input.response.metadata
    : {};
  const verificationStatus = toWriteEvidenceVerificationStatus(
    typeof metadata.verificationStatus === 'string' ? metadata.verificationStatus : undefined,
    input.status,
  );
  const riskClass = toWriteEvidenceRiskClassForIntent(input.pending.intentClass);
  const executed = input.status === 'completed' || verificationStatus === 'verified' || verificationStatus === 'partial';
  const successClaimed = executed && responseAppearsToClaimWriteSuccess(String(input.response.text ?? ''));

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `confirm-action:${input.pending.intentClass}:${input.status}:${String(metadata.type ?? '')}`,
    phase: 'confirmed_writes',
    riskClass,
    previewValid: true,
    diffRequired: true,
    visibleDiffPresent: true,
    executed,
    validatedBeforeExecution: true,
    successClaimed,
    verificationStatus,
    escalatedPerPolicy: riskClass !== 'C' || input.status === 'needs_confirmation' || input.status === 'needs_clarification',
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'confirm-action',
      status: input.status,
      metadataType: typeof metadata.type === 'string' ? metadata.type : null,
      intentClass: input.pending.intentClass,
      verificationStatus,
    },
  });
}

function recordConfirmedChatCoreV2CommandWriteEvidence(input: {
  tenantId: number;
  userId: number;
  requestId: string;
  pending: PendingChatCoreV2Command;
  execution: ChatCoreV2CommandExecutionResult;
  response: { text?: unknown; metadata?: Record<string, unknown> | undefined };
}): void {
  const metadata = input.response.metadata && typeof input.response.metadata === 'object'
    ? input.response.metadata
    : {};
  const verificationStatus = toWriteEvidenceVerificationStatus(
    typeof metadata.verificationStatus === 'string' ? metadata.verificationStatus : undefined,
    input.execution.status,
  );
  const riskClass = toWriteEvidenceRiskClassForIntent(input.pending.command.commandType);
  const hasResultResponse = Boolean(input.execution.response);
  const executed = hasResultResponse
    && input.execution.status !== 'rejected_by_policy'
    && input.execution.status !== 'failed';
  const successClaimed = responseAppearsToClaimWriteSuccess(String(input.response.text ?? ''));
  const cards = input.execution.response?.cards ?? [];
  const diffRequired = true;
  const visibleDiffPresent = cards.some((card) => Array.isArray(card.diff) && card.diff.length > 0);

  safeRecordChatV2WriteEvidence({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    sampleKey: `confirm-action:${input.pending.command.commandType}:${input.execution.status}:${String(metadata.type ?? '')}`,
    phase: 'confirmed_writes',
    riskClass,
    previewValid: true,
    diffRequired,
    visibleDiffPresent,
    executed,
    validatedBeforeExecution: true,
    successClaimed,
    verificationStatus,
    escalatedPerPolicy: riskClass !== 'C' || input.execution.status === 'queued',
    idempotencyPassed: true,
    retryCancelPassed: true,
    safeMetadata: {
      routeMethod: 'chat-core-v2-command-confirmation',
      status: input.execution.status,
      metadataType: typeof metadata.type === 'string' ? metadata.type : null,
      commandType: input.pending.command.commandType,
      capabilityId: input.pending.capabilityId,
      verificationStatus,
    },
  });
}

function toWriteEvidenceRiskClass(
  value: unknown,
  metadata?: Record<string, unknown>,
): 'A' | 'B' | 'C' {
  if (value === 'high' || metadata?.riskLevel === 'high' || metadata?.reason === 'destructive_action') return 'C';
  if (value === 'medium' || metadata?.riskLevel === 'medium') return 'B';
  return 'A';
}

function toWriteEvidenceRiskClassForIntent(intentClass: string | null | undefined): 'A' | 'B' | 'C' {
  const intent = String(intentClass ?? '').toLowerCase();
  if (/(delete|remove|cancel|send|email|payment|transfer|finance|external)/.test(intent)) return 'C';
  if (/(calendar|recurring|schedule|reschedule|move)/.test(intent)) return 'B';
  return 'A';
}

function toWriteEvidenceRiskClassForGatewayStop(
  result: Extract<ChatCoreV2ActionGatewayResult, { kind: 'needs_clarification' | 'unsupported_write' | 'blocked_legacy_fallback' }>,
): 'A' | 'B' | 'C' {
  if (result.kind === 'unsupported_write' && result.writeRiskPolicy) {
    return result.writeRiskPolicy.riskClass;
  }
  if (result.telemetry.writeRiskClass === 'A' || result.telemetry.writeRiskClass === 'B' || result.telemetry.writeRiskClass === 'C') {
    return result.telemetry.writeRiskClass;
  }
  const actionType = String(result.telemetry.actionType ?? '').toLowerCase();
  const reasonCodes = result.telemetry.reasonCodes.join(' ').toLowerCase();
  if (
    result.telemetry.detectedIntent === 'task_delete'
    || actionType.includes('delete')
    || actionType.includes('destructive')
    || actionType.includes('finance')
    || actionType.includes('training')
    || reasonCodes.includes('write_risk_class_c')
    || reasonCodes.includes('unsupported_task_mutation_intent')
  ) {
    return 'C';
  }
  return result.kind === 'needs_clarification' ? 'B' : 'C';
}

function toWriteEvidenceVerificationStatus(
  verification: string | undefined,
  status: string,
): 'verified' | 'partial' | 'failed' | 'indeterminate' | 'not_required' {
  if (verification === 'verified' || verification === 'verified_success') return 'verified';
  if (verification === 'partial_failure' || verification === 'partial') return 'partial';
  if (status === 'failed' || status === 'verification_failed') return 'failed';
  if (status === 'completed') return 'verified';
  if (status === 'verified') return 'verified';
  if (status === 'verified_success') return 'verified';
  if (status === 'partial_failure') return 'partial';
  if (status === 'needs_confirmation' || status === 'needs_clarification' || status === 'in_progress') {
    return 'indeterminate';
  }
  return 'not_required';
}

function responseAppearsToClaimWriteSuccess(text: string): boolean {
  return textClaimsUnverifiedAction(text)
    || textHasBareAppSuccessMarker(text)
    || /\b(?:created|added|marked|done|criada?|criado|adicionei|conclu[ií]|feito|feita)\b/i.test(text);
}

export function registerChatMessageRoutes(
  router: Router,
  ensureValidChatRouteScope: ChatRouteScopeGuard,
): void {
  /**
   * GET /api/v1/chat/actions/:pendingActionId
   * Returns a scoped pending action for token-zero skill handoff prefill.
   */
  router.get('/actions/:pendingActionId', asyncHandler(async (req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Authorization');

    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_pending_action_read')) {
      return;
    }
    const pendingActionId = String(req.params.pendingActionId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(pendingActionId)) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid pending action id' } });
      return;
    }
    const action = getPendingChatActionById({
      userId,
      tenantId,
      pendingActionId,
    });
    if (!action) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending action not found' } });
      return;
    }
    res.json({
      ok: true,
      data: {
        id: action.id,
        schemaVersion: action.schemaVersion,
        skill: action.skill,
        action: action.action,
        status: action.status,
        collectedSlots: action.collectedSlots,
        missingSlots: action.missingSlots,
        riskClass: action.riskClass,
        locale: action.locale,
        timezone: action.timezone,
        originatingSurface: action.originatingSurface,
        expiresAt: action.expiresAt,
      },
      timestamp: new Date().toISOString(),
    });
  }));

  /**
   * POST /api/v1/chat/confirm-action
   * Executes a previously-issued pending confirmation token. This is a
   * deterministic write endpoint for iOS confirmation cards, not another
   * free-form chat turn.
   */
  router.post('/confirm-action', asyncHandler(async (req, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Vary', 'Authorization');

    const { userId, tenantId } = req as unknown as AuthenticatedRequest;
    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_confirm_action')) {
      return;
    }

    const confirmationToken = String(req.body?.confirmation_token ?? req.body?.confirmationToken ?? '').trim();
    const intentClass = String(req.body?.intent_class ?? req.body?.intentClass ?? '').trim();
    const validation = validateChatConfirmationToken(confirmationToken, {
      userId,
      tenantId,
      intentClass: intentClass || null,
    });
    if (!validation.ok) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired confirmation token' } });
      return;
    }

    const replay = getCompletedChatConfirmation(confirmationToken, userId, tenantId);
    if (replay) {
      res.status(replay.statusCode).json(withIdempotentConfirmationReplay(replay.responseBody));
      return;
    }

    const v2Claim = claimPendingChatCoreV2Command(validation.payload.pendingId, userId, tenantId);
    if (v2Claim.status === 'already_claimed') {
      res.status(202).json({
        id: newAssistantMessageId(),
        text: 'I am still applying that confirmed change. I will reuse the completed result instead of running it twice.',
        domain: 'secretary',
        routeMethod: 'chat-core-v2-command-confirmation-in-progress',
        confidence: 1,
        buttons: null,
        metadata: {
          type: 'chat_core_v2_command_confirmation_in_progress',
          commandId: validation.payload.pendingId,
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (v2Claim.status === 'claimed') {
      const confirmationStartedAt = Date.now();
      const execution = await executeChatCoreV2Command({
        command: v2Claim.pending.command,
        capabilityId: v2Claim.pending.capabilityId,
        userId,
        tenantId,
        locale: getUserLanguageById(userId) || undefined,
        now: new Date(confirmationStartedAt),
      });
      if (!execution.ok || !execution.response) {
        clearPendingChatCoreV2Command(validation.payload.pendingId, userId, tenantId);
        res.status(409).json({
          error: {
            code: 'CHAT_CORE_V2_CONFIRMATION_NOT_EXECUTABLE',
            message: execution.reason === 'command_gate_rejected'
              ? 'This preview is no longer safe to apply. Please ask again so I can refresh it.'
              : 'The confirmed Chat Core v2 command could not be executed.',
          },
        });
        return;
      }

      const response = buildChatCoreV2CommandConfirmationShortcutResponse({
        pending: v2Claim.pending,
        execution: execution as typeof execution & { response: NonNullable<typeof execution.response> },
        requestStartedAt: confirmationStartedAt,
      });
      recordConfirmedChatCoreV2CommandWriteEvidence({
        tenantId,
        userId,
        requestId: normalizeIdempotencyKey(req.body?.idempotencyKey)
          ?? `chat-core-v2-confirm:${tenantId}:${userId}:${v2Claim.pending.commandId}`,
        pending: v2Claim.pending,
        execution: execution as ChatCoreV2CommandExecutionResult,
        response,
      });
      rememberCompletedChatConfirmation({
        confirmationToken,
        userId,
        tenantId,
        expiresAt: v2Claim.pending.expiresAt,
        statusCode: 200,
        responseBody: response,
      });
      clearPendingChatCoreV2Command(validation.payload.pendingId, userId, tenantId);
      res.status(200).json(response);
      return;
    }

    const pending = getPendingChatConfirmation(userId, tenantId);
    if (!pending
      || pending.id !== validation.payload.pendingId
      || (pending.intentClass && pending.intentClass !== validation.payload.intentClass)
    ) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Confirmation token no longer matches a pending action' } });
      return;
    }

    const decision = findDecisionByRelatedEntity(userId, tenantId, 'chat_confirmation', pending.id);
    if (isChatCoreV2GuardOnlyPendingConfirmation(pending)) {
      const decisionResult = decision
        ? await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
          idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
            ?? `chat-core-v2-guard:${tenantId}:${userId}:${pending.id}`,
        })
        : null;
      const locale = resolveChatCoreV2RouteLocale(req, userId, pending.actionSummary);
      const response = {
        id: newAssistantMessageId(),
        text: buildChatCoreV2GuardOnlyConfirmationText(locale),
        domain: 'secretary',
        routeMethod: 'chat-core-v2-action-gateway-confirmation-hold',
        confidence: 1,
        buttons: null,
        metadata: {
          type: 'chat_core_v2_destructive_confirmation_hold',
          actionStatus: 'confirmation_acknowledged',
          verificationStatus: 'not_executed',
          pendingConfirmation: {
            kind: 'completed_confirmation',
            id: pending.id,
            intent_class: validation.payload.intentClass,
            intentClass: validation.payload.intentClass,
            expires_at: pending.expiresAt,
            expiresAt: pending.expiresAt,
          },
          chatCoreV2: {
            guardOnlyConfirmation: true,
            source: 'action_gateway',
            reasonCodes: pending.reasonCodes,
          },
          ...(decisionResult ? {
            confirmationDecision: {
              decisionId: decisionResult.item.decisionId,
              actionId: decisionResult.actionId,
              idempotent: decisionResult.idempotent,
              verification: decisionResult.verification,
            },
          } : {}),
        },
        timestamp: new Date().toISOString(),
        responseCards: [{
          kind: 'confirmationCard',
          title: buildChatCoreV2GuardOnlyConfirmationLabels(locale).title,
          message: buildChatCoreV2GuardOnlyConfirmationText(locale),
          destructive: true,
          confirmAction: null,
        }],
      };
      recordConfirmedChatActionWriteEvidence({
        tenantId,
        userId,
        requestId: normalizeIdempotencyKey(req.body?.idempotencyKey)
          ?? `chat-core-v2-guard:${tenantId}:${userId}:${pending.id}`,
        pending,
        status: 'needs_clarification',
        response,
      });
      rememberCompletedChatConfirmation({
        confirmationToken,
        userId,
        tenantId,
        expiresAt: pending.expiresAt,
        statusCode: 200,
        responseBody: response,
      });
      clearPendingChatConfirmation(userId, tenantId);
      res.status(200).json(response);
      return;
    }

    const decisionResult = decision
      ? await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
        idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
          ?? `chat-confirm:${tenantId}:${userId}:${pending.id}`,
      })
      : null;
    const confirmedAction = await executeConfirmedChatActionRuns({
      text: pending.actionSummary,
      userId,
      tenantId,
      conversationId: `confirm-${pending.id}`,
      messageId: `msg-confirm-${pending.id}`,
	      sourceMessageId: pending.sourceMessageId,
	      channel: 'ios',
	      locale: resolveChatCoreV2RouteLocale(req, userId, pending.actionSummary),
	      timezone: getUserTimezoneById(userId),
	    });

    if (!confirmedAction) {
      res.status(409).json({ error: { code: 'CONFIRMATION_NOT_EXECUTABLE', message: 'Pending action could not be executed' } });
      return;
    }

    const response = confirmedAction.response;
    if (decisionResult) {
      response.metadata.confirmationDecision = {
        decisionId: decisionResult.item.decisionId,
        actionId: decisionResult.actionId,
        idempotent: decisionResult.idempotent,
        verification: decisionResult.verification,
      };
    }
    response.metadata.pendingConfirmation = {
      kind: 'completed_confirmation',
      id: pending.id,
      intent_class: validation.payload.intentClass,
      intentClass: validation.payload.intentClass,
      expires_at: pending.expiresAt,
      expiresAt: pending.expiresAt,
    };

    const statusCode = statusForChatActionResponse(confirmedAction.status, response);
    recordConfirmedChatActionWriteEvidence({
      tenantId,
      userId,
      requestId: normalizeIdempotencyKey(req.body?.idempotencyKey)
        ?? `chat-confirm:${tenantId}:${userId}:${pending.id}`,
      pending,
      status: confirmedAction.status,
      response,
    });
    // Cache the completion before clearing pending so a concurrent duplicate confirm replays the result.
    rememberCompletedChatConfirmation({
      confirmationToken,
      userId,
      tenantId,
      expiresAt: pending.expiresAt,
      statusCode,
      responseBody: response,
    });
    clearPendingChatConfirmation(userId, tenantId);
    res.status(statusCode).json(response);
  }));

  /**
   * POST /api/v1/chat/message
   * Send a message — equivalent to typing in Telegram.
   * Routes through Router → Domain Handler → returns AI response.
   *
   * For system commands (/day, /tasks, etc.), we route them through the
   * domain handler as natural language since the handler functions
   * accept the raw message text including the / prefix.
   */
  // The API composition root applies the shared per-user limiter before /chat.
  router.post('/message', async (req, res: Response) => {
    const { userId, tenantId } = req as AuthenticatedRequest;
    const {
      normalizedText,
      normalizedTextLower,
      normalizedAttachments,
      clientMessageId,
      idempotencyKey,
    } = normalizeChatMessageRequest(req.body);

    if (!ensureValidChatRouteScope(res, userId, tenantId, 'chat_route_message', {
      hasAttachments: normalizedAttachments.length > 0,
      textLength: normalizedText.length,
    })) {
      return;
    }

    if (!normalizedText && normalizedAttachments.length === 0) {
      res.status(400).json({
        error: { code: 'BAD_REQUEST', message: 'text or attachments are required' },
      });
      return;
    }

    persistChatLanguagePreference(req, userId);

    // Token-zero reads/actions must never queue behind a long model call.
    // Acquire the per-user lock lazily only when this turn is definitely
    // entering a model-backed planner/provider path.
    // Keep the release callback in a mutable holder. TypeScript cannot track
    // assignments to a local variable made inside `ensureModelBudget`, and
    // otherwise narrows the finally-path optional call to `never`.
    const aiBudgetReservation = {
      release: null as (() => void) | null,
    };
    let modelBudgetAllowed = false;
    // Codex QA round 5: hoist idempotency ids OUT of the try block so
    // the catch can pass them to the degraded-response path. Without
    // this hoist the previous round-4 fix did not compile.
    const requestStartedAt = Date.now();
    const scopedClientMessageId = normalizeIdempotencyKey(
      clientMessageId ?? idempotencyKey ?? req.header('x-idempotency-key') ?? req.header('x-client-message-id'),
    );
    const userMessageId = buildUserMessageId(scopedClientMessageId, requestStartedAt);
    try {
      const ensureModelBudget = async (_logMessage: string): Promise<boolean> => {
        if (modelBudgetAllowed) return true;
        if (!aiBudgetReservation.release) {
          aiBudgetReservation.release = await acquireAiBudgetReservation({
            userId,
            requestSource: 'interactive',
            baseCategory: 'ios_chat_message',
            jobName: 'ios_chat_message',
            runId: getCurrentRequestId() || (req as any).requestId || `chat-${requestStartedAt}`,
          });
        }
        modelBudgetAllowed = true;
        return true;
      };
      const latency = createChatLatencyTracker(requestStartedAt);
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;

      recordChatStage(chatRequestId, 'request_received');

      const idempotentHit = findCompletedAssistantForClientMessage(userId, scopedClientMessageId, tenantId);
      if (idempotentHit) {
        recordChatStage(chatRequestId, idempotentHit.userText !== normalizedText ? 'idempotent_replay_conflict' : 'idempotent_replay');
        if (idempotentHit.userText !== normalizedText) {
          logger.warn(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
            'iOS chat idempotent retry used a client message id with different text',
          );
          res.status(409).json({
            error: {
              code: 'CHAT_IDEMPOTENCY_CONFLICT',
              message: 'This chat request id was already used for a different message.',
            },
          });
          return;
        }
        logger.info(
          { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
          'iOS chat idempotent retry returned existing assistant message',
        );
        // M8: replay envelopes were finalized on the ORIGINAL turn — the
        // finalizer policy for this family is 'passthrough' (byte-identical).
        const replayResponse = finalizeChatMessageResponse({
          id: idempotentHit.assistantMessage.id,
          text: idempotentHit.assistantMessage.text,
          domain: idempotentHit.assistantMessage.domain,
          routeMethod: idempotentHit.assistantMessage.routeMethod ?? 'idempotent-replay',
          confidence: idempotentHit.assistantMessage.confidence ?? 1,
          buttons: idempotentHit.assistantMessage.buttons ?? null,
          metadata: {
            ...(idempotentHit.assistantMessage.metadata && typeof idempotentHit.assistantMessage.metadata === 'object'
              ? idempotentHit.assistantMessage.metadata as Record<string, unknown>
              : {}),
            idempotentReplay: true,
            replayOfUserMessageId: idempotentHit.userMessageId,
          },
          timestamp: idempotentHit.assistantMessage.timestamp,
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier0_local',
          stageFamily: 'idempotent_replay',
        });
        res.json(replayResponse);
        return;
      }

      const isNewUserFlow = listChatMessages(userId, 1, undefined, tenantId).messages.length === 0;

      if (scopedClientMessageId) {
        const claim = claimUserChatMessage({
          userId,
          tenantId,
          messageId: userMessageId,
          text: normalizedText,
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
          timestamp: new Date(requestStartedAt).toISOString(),
        });
        if (claim.status === 'conflict') {
          recordChatStage(chatRequestId, 'idempotency_claim_conflict');
          logger.warn(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId },
            'iOS chat idempotency claim conflicted with existing message text',
          );
          res.status(409).json({
            error: {
              code: 'CHAT_IDEMPOTENCY_CONFLICT',
              message: 'This chat request id was already used for a different message.',
            },
          });
          return;
        }
        if (claim.status === 'duplicate') {
          recordChatStage(chatRequestId, 'idempotency_in_progress');
          logger.info(
            { chatRequestId, tenantId, userId, clientMessageId: scopedClientMessageId, lifecycleState: claim.existingLifecycleState },
            'iOS chat idempotent retry found an in-flight message claim',
          );
          const response = finalizeChatMessageResponse({
            id: newAssistantMessageId(),
            text: 'I am still processing that request. I will reuse the original result instead of running the action again.',
            domain: 'secretary',
            routeMethod: 'idempotency-in-progress',
            confidence: 1,
            buttons: null,
            metadata: {
              type: 'chat_idempotency_in_progress',
              idempotencyInProgress: true,
              replayOfUserMessageId: claim.messageId,
            },
            timestamp: new Date(requestStartedAt).toISOString(),
          }, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier4_long_running',
            actionability: 'degraded',
            verificationStatus: 'pending',
            stageFamily: 'idempotency_in_progress',
          });
          res.status(202).json(response);
          return;
        }
      }

      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          platform: 'ios',
          isNewUserFlow,
          hasAttachments: normalizedAttachments.length > 0,
          textLength: normalizedText.length,
        },
        'iOS chat request started',
      );
      latency.mark('request_validated');
      recordChatStage(chatRequestId, 'request_validated');

      const recordDeterministicReadEvidence = (
        response: Parameters<typeof safeRecordChatV2DeterministicReadEvidence>[0]['response'],
        tokenZeroSurface?: Parameters<typeof safeRecordChatV2DeterministicReadEvidence>[0]['tokenZeroSurface'],
      ) => {
        safeRecordChatV2DeterministicReadEvidence({
          tenantId,
          userId,
          requestId: chatRequestId,
          normalizedMessage: normalizedText,
          response,
          tokenZeroSurface,
          tokenZeroPreserved: tokenZeroSurface ? true : undefined,
          tenantUserIsolationPassed: true,
        });
      };
      const recordChatV2CompletionEvidenceForImmediateResponse = (
        response: Parameters<typeof safeRecordChatV2CompletionEvidence>[0]['response'],
      ) => {
        safeRecordChatV2CompletionEvidence({
          tenantId,
          userId,
          requestId: chatRequestId,
          normalizedMessage: normalizedText,
          userLanguage: safeGetChatEvidenceLanguage(req, userId),
          response,
          firstProgressMs: safeGetChatV2ClientFirstProgressMs(req) ?? Date.now() - requestStartedAt,
          unsupportedClaimProbe: isChatV2UnsupportedClaimEvidenceProbe(req),
        });
      };
      const bypassReadFastPathsForWriteIntent = normalizedText && normalizedAttachments.length === 0
        ? shouldGateReadFastPathsForWriteIntent(normalizedText, process.env, String(tenantId))
        : false;
      const chatCoreV2RouteLocale = resolveChatCoreV2RouteLocale(req, userId, normalizedText);
      const recordLegacyFallbackSample = (
        fellBack: boolean,
        attribution?: ChatCoreV2LegacyFallbackAttribution,
      ) => recordChatCoreV2LegacyFallbackSample({
        tenantId,
        normalizedText,
        hasAttachments: normalizedAttachments.length > 0,
        fellBack,
        now: new Date(requestStartedAt),
        attribution,
      });
      const bypassNaturalLanguageTokenZeroForChatCoreV2 = normalizedText
        ? shouldBypassNaturalLanguageTokenZeroForChatCoreV2(tenantId, normalizedText)
        : false;
      const tokenZeroShortcut = normalizedText
        && normalizedAttachments.length === 0
        && !bypassReadFastPathsForWriteIntent
        && !bypassNaturalLanguageTokenZeroForChatCoreV2
        ? await tryBuildTokenZeroChatMessageShortcutResponse({
          normalizedText,
          userId,
          tenantId,
          userLanguage: chatCoreV2RouteLocale,
        })
        : null;
      if (tokenZeroShortcut) {
        recordChatStage(chatRequestId, 'token_zero_shortcut');
        const { conversationDomain } = tokenZeroShortcut;
        if (sendChatTierRequiredIfNeeded(res, userId, conversationDomain)) return;
        const response = finalizeChatMessageResponse(tokenZeroShortcut.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: tokenZeroShortcut.response.routeMethod,
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          compositionMode: 'templated',
          groundingFacts: [deterministicReadGroundingFact('chat.token_zero_shortcut')],
          stageFamily: 'token_zero_shortcut',
        });
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
          syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
          recordDeterministicReadEvidence(response);
          recordChatV2CompletionEvidenceForImmediateResponse(response);
          res.json(response);
          return;
        }

      const chatCoreV2Read = normalizedText
        && normalizedAttachments.length === 0
        && !normalizedText.trim().startsWith('/')
        ? tryBuildChatCoreV2DeterministicReadRoute({
          normalizedText,
          userId,
          tenantId,
          locale: getUserLanguageById(userId),
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        })
        : null;
      if (chatCoreV2Read) {
        recordChatStage(chatRequestId, 'chat_core_v2_deterministic_read_early');
        latency.mark('chat_core_v2_deterministic_read_completed');
        const deterministicReadShortcut = buildChatCoreV2DeterministicReadShortcutResponse({
          result: chatCoreV2Read,
          requestStartedAt,
        });
        const { conversationDomain, response: shortcutResponse } = deterministicReadShortcut;
        const response = finalizeChatMessageResponse(shortcutResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'chat-core-v2-deterministic-read',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          stageFamily: 'chat_core_v2_deterministic_read_early',
        });
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        logger.info(
          {
            chatRequestId,
            platform: 'ios',
            mode: 'chat-core-v2-deterministic-read',
            tenantId,
            userId,
            capabilityId: deterministicReadShortcut.logContext.capabilityId,
            contextHash: deterministicReadShortcut.logContext.contextHash,
          },
          'iOS chat Chat Core v2 deterministic read hit',
        );
        recordLegacyFallbackSample(false, {
          domain: chatCoreV2Read.readModel.domain,
          routeOwner: 'chat_core_v2_deterministic_read',
          routeMethod: response.routeMethod,
        });
        res.json(response);
        return;
      }

      if (isChatCoreV2ShadowRouteHookEnabled(process.env, { userId, tenantId })) {
        const shadow = runChatCoreV2ShadowRouteHook({
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          userMessageId,
          clientMessageId: scopedClientMessageId,
          attachmentsCount: normalizedAttachments.length,
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        });
        if (shadow.recorded) {
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: shadow.result?.routeDecision.routeMethod,
              reasoningTier: shadow.result?.routeDecision.reasoningTier,
              replayBundleId: shadow.replayBundleId,
            },
            'Chat Core v2 shadow route hook recorded plan',
          );
        }
      }

      let chatV2EvidenceRecorderInstalled = false;
      const installChatV2EvidenceRecorder = () => {
        if (chatV2EvidenceRecorderInstalled) return;
        chatV2EvidenceRecorderInstalled = true;
        const originalJson = res.json.bind(res);
        res.json = ((body?: any) => {
          safeRecordChatV2CompletionEvidence({
            tenantId,
            userId,
            requestId: chatRequestId,
            normalizedMessage: normalizedText,
            userLanguage: safeGetChatEvidenceLanguage(req, userId),
            response: body,
            firstProgressMs: safeGetChatV2ClientFirstProgressMs(req) ?? Date.now() - requestStartedAt,
            unsupportedClaimProbe: isChatV2UnsupportedClaimEvidenceProbe(req),
          });
          return originalJson(body);
        }) as typeof res.json;
      };
      installChatV2EvidenceRecorder();

      if (normalizedText && normalizedAttachments.length === 0 && isPendingChatWorkCancellationTurn(normalizedText)) {
        const cancelled = cancelAllPendingChatWork({
          userId,
          tenantId,
          conversationId: scopedClientMessageId ?? chatRequestId,
          nowIso: new Date(requestStartedAt).toISOString(),
        });
        const totalCancelled = cancelled.chatPendingActions
          + cancelled.chatActionRuns
          + cancelled.chatCoreV2Commands
          + (cancelled.chatPendingConfirmation ? 1 : 0)
          + (cancelled.decisionDismissed ? 1 : 0);
        recordChatStage(chatRequestId, totalCancelled > 0 ? 'pending_work_cancelled' : 'pending_work_cancel_empty');
        if (totalCancelled > 0) {
          const isPT = chatCoreV2RouteLocale.startsWith('pt');
          const text = isPT
            ? 'Está cancelado. Não vou continuar essa ação pendente.'
            : 'Cancelled. I will not continue that pending action.';
          const response = finalizeChatMessageResponse({
            id: newAssistantMessageId(),
            text,
            domain: 'secretary',
            routeMethod: 'pending-action-cancelled',
            confidence: 1,
            buttons: null,
            metadata: {
              type: 'pending_action_cancelled',
              cancelled,
              mutationBlocked: true,
            },
            timestamp: new Date(requestStartedAt).toISOString(),
            responseBlocks: buildBlocksFromMarkdown(text),
          }, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier0_local',
            fallbackDomain: 'secretary',
            fallbackRouteMethod: 'pending-action-cancelled',
            actionability: 'answer_only',
            verificationStatus: 'not_required',
            compositionMode: 'templated',
            groundingFacts: [deterministicReadGroundingFact('chat.pending_work_cancellation')],
            stageFamily: 'pending_work_cancelled',
          });
          rememberChatActiveDomain(userId, 'secretary', Date.now(), tenantId);
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, 'secretary', normalizedText, response.text, tenantId);
          recordLegacyFallbackSample(false, {
            domain: 'secretary',
            routeOwner: 'chat_pending_work_cancellation',
            routeMethod: response.routeMethod,
          });
          res.json(response);
          return;
        }
        const isPT = chatCoreV2RouteLocale.startsWith('pt');
        const text = isPT
          ? 'Não há nenhuma ação pendente para cancelar.'
          : 'There is no pending action to cancel.';
        const response = finalizeChatMessageResponse({
          id: newAssistantMessageId(),
          text,
          domain: 'secretary',
          routeMethod: 'pending-action-cancel-empty',
          confidence: 1,
          buttons: null,
          metadata: {
            type: 'pending_action_cancel_empty',
            cancelled,
            mutationBlocked: true,
          },
          timestamp: new Date(requestStartedAt).toISOString(),
          responseBlocks: buildBlocksFromMarkdown(text),
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier0_local',
          fallbackDomain: 'secretary',
          fallbackRouteMethod: 'pending-action-cancel-empty',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          compositionMode: 'templated',
          groundingFacts: [deterministicReadGroundingFact('chat.pending_work_cancellation.empty')],
          stageFamily: 'pending_work_cancel_empty',
        });
        rememberChatActiveDomain(userId, 'secretary', Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, 'secretary', normalizedText, response.text, tenantId);
        recordLegacyFallbackSample(false, {
          domain: 'secretary',
          routeOwner: 'chat_pending_work_cancellation',
          routeMethod: response.routeMethod,
        });
        res.json(response);
        return;
      }

      // ── ChatCoreV2 Action Gateway ───────────────────────────────
      // Natural-language write intents are now a firewall, not a legacy
      // best-effort model/tool path: resolve to a command preview, ask for
      // clarification, or stop. Explicit button/slash paths above remain fast.
      if (normalizedText && normalizedAttachments.length === 0 && !parseContentScriptShortcut(normalizedText)) {
        const gatewayResult = runChatCoreV2ActionGateway({
          requestId: chatRequestId,
          normalizedText,
          userId,
          tenantId,
          conversationId: scopedClientMessageId ?? chatRequestId,
          messageId: userMessageId,
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        });
        if (gatewayResult.kind === 'resolved_preview' || gatewayResult.kind === 'resolved_execute') {
          recordChatStage(chatRequestId, 'action_gateway_preview');
          const built = buildChatCoreV2CommandPreviewShortcutResponse({
            result: gatewayResult.preview,
            requestStartedAt,
          });
          const response = finalizeChatMessageResponse(built.response, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier2_verified_write',
            fallbackDomain: built.conversationDomain,
            fallbackRouteMethod: built.response.routeMethod,
            actionability: 'preview',
            verificationStatus: 'pending',
            compositionMode: 'templated',
            groundingFacts: [deterministicReadGroundingFact('chat_core_v2.action_gateway')],
            stageFamily: 'action_gateway_preview',
          });
          rememberChatActiveDomain(userId, built.conversationDomain, Date.now(), tenantId);
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, built.conversationDomain, normalizedText, response.text, tenantId);
          recordChatCoreV2GatewayPreviewEvidence({
            tenantId,
            userId,
            requestId: chatRequestId,
            result: gatewayResult,
          });
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: response.routeMethod,
              capabilityId: built.logContext.capabilityId,
              commandId: built.logContext.commandId,
              gatewayOutcome: gatewayResult.kind,
            },
            'iOS chat ChatCoreV2 action gateway handled write intent',
          );
          recordLegacyFallbackSample(false, {
            domain: built.conversationDomain,
            routeOwner: 'chat_core_v2_action_gateway',
            routeMethod: response.routeMethod,
          });
          res.status(202).json(response);
          return;
        }
        if (
          gatewayResult.kind === 'needs_clarification'
          || gatewayResult.kind === 'unsupported_write'
          || gatewayResult.kind === 'blocked_legacy_fallback'
        ) {
          recordChatStage(chatRequestId, 'action_gateway_stop');
          const guardOnlyConfirmation = shouldCreateChatCoreV2GuardOnlyConfirmation(gatewayResult);
          const stopText = actionGatewayStopText(gatewayResult, chatCoreV2RouteLocale);
          const guardLabels = guardOnlyConfirmation
            ? buildChatCoreV2GuardOnlyConfirmationLabels(chatCoreV2RouteLocale)
            : null;
          const pendingGuardConfirmation = guardOnlyConfirmation
            ? trackPendingChatConfirmation({
              userId,
              tenantId,
              actionSummary: stopText,
              involvedSkills: ['secretary'],
              reasonCodes: [
                ...new Set([
                  ...gatewayResult.telemetry.reasonCodes,
                  'destructive_action',
                  'chat_core_v2_guard_only',
                ]),
              ],
              intentClass: 'chat_core_v2_destructive_hold',
              summary: {
                mode: 'chat_core_v2_guard_only',
                gatewayOutcome: gatewayResult.kind,
                detectedIntent: gatewayResult.telemetry.detectedIntent,
                actionType: gatewayResult.telemetry.actionType ?? null,
                reasonCodes: gatewayResult.telemetry.reasonCodes,
              },
              sourceMessageId: userMessageId,
            })
            : null;
          const guardDecisionResult = pendingGuardConfirmation
            ? await createDecisionIntent({
              userId,
              tenantId,
              sourceSkill: 'chat',
              type: 'decision_required',
              priority: 'active',
              relatedEntityId: pendingGuardConfirmation.id,
              relatedEntityType: 'chat_confirmation',
              title: guardLabels?.title ?? 'Confirmation needed',
              body: pendingGuardConfirmation.actionSummary,
              sensitiveBody: pendingGuardConfirmation.actionSummary,
              actionButtons: [
                { id: 'option_a', label: guardLabels?.actionLabel ?? 'Keep paused', style: 'secondary' },
                { id: 'option_b', label: guardLabels?.cancelLabel ?? 'Cancel', style: 'secondary' },
                { id: 'open_detail', label: chatCoreV2RouteLocale.startsWith('pt') ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
              ],
              deeplink: `nexus://notifications/${pendingGuardConfirmation.id}`,
              expiresAt: pendingGuardConfirmation.expiresAt,
              dedupeKey: `chat:chat-core-v2-guard:${tenantId}:${userId}:${pendingGuardConfirmation.id}`,
              requiresUserAction: true,
              deliveryPolicy: 'in_app_only',
              privacyPolicy: 'standard',
            })
            : null;
          const response = finalizeChatMessageResponse({
            id: newAssistantMessageId(),
            text: stopText,
            domain: 'secretary',
            routeMethod: 'chat-core-v2-action-gateway',
            confidence: 1,
            buttons: null,
            metadata: {
              type: 'chat_core_v2_write_intent_guard',
              responseKind: gatewayResult.kind === 'needs_clarification' || gatewayResult.kind === 'blocked_legacy_fallback'
                ? guardOnlyConfirmation ? 'action_preview' : 'clarification'
                : 'unsupported',
              gatewayOutcome: gatewayResult.kind,
              reason: gatewayResult.kind === 'needs_clarification' ? 'needs_clarification' : gatewayResult.reason,
              ...(guardLabels ? {
                actionConfirmation: {
                  title: guardLabels.title,
                  message: stopText,
                  actionLabel: guardLabels.actionLabel,
                  cancelLabel: guardLabels.cancelLabel,
                },
              } : {}),
              chatCoreV2: {
                actionGateway: {
                  telemetry: gatewayResult.telemetry,
                  candidates: gatewayResult.kind === 'needs_clarification' ? gatewayResult.candidates ?? [] : [],
                  humanReview: gatewayResult.kind === 'unsupported_write' ? gatewayResult.humanReview ?? null : null,
                  guardOnlyConfirmation,
                },
              },
            },
            timestamp: new Date(requestStartedAt).toISOString(),
            responseCards: guardOnlyConfirmation ? [{
              kind: 'confirmationCard',
              title: guardLabels?.title ?? 'Confirmation needed',
              message: stopText,
              destructive: true,
              confirmAction: null,
            }] : undefined,
          }, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier1_fast_read',
            fallbackDomain: 'secretary',
            fallbackRouteMethod: 'chat-core-v2-action-gateway',
            actionability: guardOnlyConfirmation ? 'preview' : actionGatewayActionability(gatewayResult),
            verificationStatus: guardOnlyConfirmation ? 'pending' : gatewayResult.kind === 'unsupported_write' ? 'blocked' : 'pending',
            compositionMode: 'templated',
            groundingFacts: [deterministicReadGroundingFact('chat_core_v2.action_gateway')],
            stageFamily: 'action_gateway_stop',
          });
          if (pendingGuardConfirmation) {
            attachPendingConfirmationContract({
              response,
              pendingConfirmation: pendingGuardConfirmation,
              intentClass: 'chat_core_v2_destructive_hold',
              summary: pendingGuardConfirmation.summary ?? {},
              decisionId: guardDecisionResult?.item?.decisionId ?? null,
            });
          }
          rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
          recordChatCoreV2GatewayStopEvidence({
            tenantId,
            userId,
            requestId: chatRequestId,
            result: gatewayResult,
          });
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: response.routeMethod,
              gatewayOutcome: gatewayResult.kind,
              reason: gatewayResult.kind === 'needs_clarification' ? 'needs_clarification' : gatewayResult.reason,
            },
            'iOS chat ChatCoreV2 action gateway stopped legacy write fallthrough',
          );
          recordLegacyFallbackSample(false, {
            domain: response.domain,
            routeOwner: 'chat_core_v2_action_gateway',
            routeMethod: response.routeMethod,
          });
          res.status(202).json(response);
          return;
        }
      }

      // ── ChatCoreV2 Deterministic Read Route ─────────────────────
      // Natural-language reads that have a V2 read-model equivalent are routed
      // through ChatCoreV2 when canary/on flags allow it. Explicit slash/button
      // token-zero reads are handled above and remain preserved.
      if (
        normalizedText
        && normalizedAttachments.length === 0
        && !normalizedText.trim().startsWith('/')
        && !bypassReadFastPathsForWriteIntent
      ) {
        const readRoute = tryBuildChatCoreV2DeterministicReadRoute({
          normalizedText,
          userId,
          tenantId,
          surface: 'ios',
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          now: new Date(requestStartedAt),
        });
        if (readRoute) {
          recordChatStage(chatRequestId, 'chat_core_v2_deterministic_read');
          const built = buildChatCoreV2DeterministicReadShortcutResponse({
            result: readRoute,
            requestStartedAt,
          });
          const response = finalizeChatMessageResponse(built.response, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier1_fast_read',
            fallbackDomain: built.conversationDomain,
            fallbackRouteMethod: built.response.routeMethod,
            actionability: 'answer_only',
            verificationStatus: 'not_required',
            compositionMode: 'templated',
            groundingFacts: [deterministicReadGroundingFact('chat_core_v2.deterministic_read')],
            stageFamily: 'chat_core_v2_deterministic_read',
          });
          rememberChatActiveDomain(userId, built.conversationDomain, Date.now(), tenantId);
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, built.conversationDomain, normalizedText, response.text, tenantId);
          recordDeterministicReadEvidence(response);
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              capabilityId: built.logContext.capabilityId,
              contextHash: built.logContext.contextHash,
            },
            'iOS chat ChatCoreV2 deterministic read route handled request',
          );
          recordLegacyFallbackSample(false, {
            domain: readRoute.readModel.domain,
            routeOwner: 'chat_core_v2_deterministic_read',
            routeMethod: response.routeMethod,
          });
          res.json(response);
          return;
        }
      }

      // Cache is deterministic and must remain available before entitlement
      // or budget enforcement.
      if (normalizedText && normalizedAttachments.length === 0) {
        const cached = getCachedChatCommandResponse(userId, normalizedTextLower, tenantId);
        if (cached) {
          recordChatStage(chatRequestId, 'cached_command');
          logger.debug({ cmdLength: normalizedText.length, platform: 'ios', tenantId, userId }, 'Returning cached chat command');
          const cachedResponse = finalizeChatMessageResponse(cached, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier0_local',
            actionability: 'answer_only',
            verificationStatus: 'not_required',
            compositionMode: 'templated',
            groundingFacts: [deterministicReadGroundingFact('chat.fast_path_cache')],
            stageFamily: 'cached_command',
          });
          persistExchange(userId, userMessageId, normalizedText, cachedResponse.id, cachedResponse, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, cachedResponse.domain, normalizedText, cachedResponse.text, tenantId);
          recordDeterministicReadEvidence(
            cachedResponse,
            normalizedText.trim().startsWith('/') ? 'slash' : undefined,
          );
          res.json(cachedResponse);
          return;
        }
      }

      // ── General Action Planner ─────────────────────────────────
      // Natural-language write intents must be routed before read-only
      // fast paths. Example: "agenda do Gmail" with event semantics means
      // Google Calendar, not Gmail unread count.
      if (normalizedText && normalizedAttachments.length === 0 && !parseContentScriptShortcut(normalizedText)) {
        const plannerInput = {
          text: normalizedText,
          userId,
          tenantId,
          conversationId: scopedClientMessageId ?? chatRequestId,
          messageId: userMessageId,
          channel: 'ios',
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          requireSafeWriteConfirmation: true,
        } as const;
        // First pass is strictly token-zero. Only if deterministic planning
        // cannot own the turn do we acquire/check the AI budget and permit
        // model-assisted planner tiers.
        const actionResult = await tryHandleChatActionPlan({
          ...plannerInput,
          allowModelPlanner: false,
        });
        if (actionResult) {
          recordChatStage(chatRequestId, 'action_planner_deterministic');
          latency.mark('action_planner_completed');
          // M8: planner envelopes carry their own contract metadata from
          // services/chat — the finalizer policy for the deterministic
          // planner family is 'passthrough'.
          const response = finalizeChatMessageResponse(actionResult.response, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier2_verified_write',
            stageFamily: 'action_planner_deterministic',
          });
          if (actionResult.status === 'needs_confirmation') {
            const lang = chatCoreV2RouteLocale;
            const isPT = lang.startsWith('pt');
            const involvedSkills = [...new Set(actionResult.plan.steps.map((step) => mapActionPlannerSkillToNexusSkill(step.skill)))];
            const reasonCodes = [...new Set(actionResult.plan.steps.map((step) => `${step.risk}_requires_confirmation`))];
            const intentClass = intentClassForAction(actionResult.plan.steps[0]?.action, involvedSkills);
            const summary = {
              text: response.text || normalizedText,
              steps: actionResult.plan.steps.map((step) => ({
                skill: step.skill,
                action: step.action,
                risk: step.risk,
                args: step.args,
              })),
            };
            const pendingConfirmation = trackPendingChatConfirmation({
              userId,
              tenantId,
              actionSummary: response.text || normalizedText,
              involvedSkills,
              reasonCodes,
              intentClass,
              summary,
              sourceMessageId: userMessageId,
            });
            const decisionResult = await createDecisionIntent({
              userId,
              tenantId,
              sourceSkill: 'chat',
              type: 'decision_required',
              priority: 'active',
              relatedEntityId: pendingConfirmation.id,
              relatedEntityType: 'chat_confirmation',
              title: isPT ? 'Nexus precisa de confirmação' : 'Nexus needs confirmation',
              body: pendingConfirmation.actionSummary,
              sensitiveBody: pendingConfirmation.actionSummary,
              actionButtons: [
                { id: 'option_a', label: isPT ? 'Confirmar' : 'Confirm', style: 'primary' },
                { id: 'option_b', label: isPT ? 'Não executar' : 'Do not run', style: 'secondary' },
                { id: 'open_detail', label: isPT ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
              ],
              deeplink: `nexus://notifications/${pendingConfirmation.id}`,
              expiresAt: pendingConfirmation.expiresAt,
              dedupeKey: `chat:action-confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
              requiresUserAction: true,
              deliveryPolicy: 'in_app_only',
              privacyPolicy: 'standard',
            });
            attachPendingConfirmationContract({
              response,
              pendingConfirmation,
              intentClass,
              summary,
              decisionId: decisionResult.item?.decisionId ?? null,
            });
          }
          // M13: durable continuity — this terminal knows the persisted
          // assistant message id and the planner step entity ids.
          rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId, {
            conversationId: scopedClientMessageId ?? chatRequestId,
            lastAssistantMessageId: response.id,
            anchorEntityIds: anchorEntityIdsFromPlanSteps(actionResult.plan.steps),
          });
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: response.routeMethod,
              actionStatus: actionResult.status,
              planner: actionResult.plan.planner,
              involvedSkills: actionResult.plan.steps.map((step) => step.skill),
            },
            'iOS chat action planner handled request',
          );
          recordLegacyFallbackSample(true, {
            domain: response.domain,
            routeOwner: 'chat_action_planner',
            routeMethod: response.routeMethod,
          });
          res.status(statusForChatActionResponse(actionResult.status, response)).json(response);
          return;
        }
      }

      if (normalizedAttachments.length > 0) {
        recordChatStage(chatRequestId, 'attachment');
        if (!await ensureModelBudget('iOS chat attachment blocked by AI budget')) return;

        const attachment = normalizedAttachments[0];
        const lang = getUserLanguageById(userId) || 'pt-BR';
        const result = await buildChatAttachmentResponse({
          attachment,
          normalizedText,
          userId,
          tenantId,
          language: lang,
        });
        rememberChatActiveDomain(userId, result.conversationDomain, Date.now(), tenantId);
        const response = finalizeChatMessageResponse(result.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: result.degraded ? 'tier4_long_running' : 'tier2_verified_write',
          fallbackDomain: result.conversationDomain,
          fallbackRouteMethod: 'attachment',
          stageFamily: 'attachment',
          requestStartedAt,
          actionability: result.degraded ? 'degraded' : 'answer_only',
          verificationStatus: result.degraded ? 'failed' : 'not_required',
          fallback: result.degraded ? {
            fallbackType: 'deterministic_summary',
            fallbackReason: result.degradedReason ?? 'attachment_processing_degraded',
            retryable: true,
            userActionRequired: false,
            operatorActionRequired: false,
          } : undefined,
        });
        persistExchange(userId, userMessageId, result.userText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, result.conversationDomain, result.userText, response.text, tenantId);
        if (result.degraded) {
          logger.warn(
            { err: result.error, chatRequestId, userId, reason: result.degradedReason, platform: 'ios' },
            'iOS chat attachment degraded',
          );
        }
        res.json(response);
        return;
      }

      // ── Authenticated identity fast-path ────────────────────────────
      // Identity questions must be answered from the server-scoped auth
      // session, not from a domain prompt or model memory. This prevents
      // founder/default persona text from ever overriding the logged-in
      // user's real account identity.
      const identityResponse = tryBuildAuthenticatedIdentityResponse(normalizedText, normalizedTextLower, userId);
      if (identityResponse) {
        recordChatStage(chatRequestId, 'authenticated_identity');
        const { conversationDomain } = identityResponse;
        const response = finalizeChatMessageResponse(identityResponse.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'authenticated-identity',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          compositionMode: 'templated',
          groundingFacts: [deterministicReadGroundingFact('auth.session')],
          stageFamily: 'authenticated_identity',
        });
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        logger.info({ chatRequestId, platform: 'ios', mode: 'authenticated-identity', tenantId, userId }, 'iOS chat authenticated identity fast-path hit');
        recordDeterministicReadEvidence(response);
        res.json(response);
        return;
      }

      // ── Token-zero fast-path ─────────────────────────────────────
      // Slash commands like /todo, /day, /overdue are pure data lookups.
      // Handle them directly without ever touching the AI pipeline.
      // They intentionally run before the lazy AI lock/quota gate, so Free
      // and quota-exhausted paid users retain deterministic Secretary access.
      // This is the difference between an instant ~200ms response and a
      // 30-50 second Claude tool-use loop. See specs/08-TOKEN-ZERO-ARCHITECTURE.md.
      const fastPath = bypassReadFastPathsForWriteIntent
        ? null
        : await tryBuildFastPathChatResponse(normalizedText, normalizedTextLower, userId, tenantId);
      if (fastPath) {
        recordChatStage(chatRequestId, 'fast_path');
        const { response: fastResponse, conversationDomain } = fastPath;
        const response = finalizeChatMessageResponse(fastResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'fast-path',
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          compositionMode: 'templated',
          groundingFacts: [deterministicReadGroundingFact('chat.fast_path')],
          stageFamily: 'fast_path',
        });
        // Track domain for conversation continuity even on fast-path.
        rememberChatActiveDomain(userId, conversationDomain, Date.now(), tenantId);
        // Cache deterministic responses for the next 60 seconds.
        maybeCacheChatCommandResponse(userId, normalizedTextLower, response, tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        logger.info({ cmdLength: normalizedText.length, platform: 'ios', mode: 'fast-path', tenantId, userId }, 'iOS chat fast-path hit');
        recordDeterministicReadEvidence(
          response,
          normalizedText.trim().startsWith('/') ? 'slash' : undefined,
        );
        res.json(response);
        return;
      }

      // ── Natural language plan-creation shortcut ───────────────────
      // Intercept "criar plano" / "create training plan" before the AI
      // pipeline. Returns a token-zero response directing the user to
      // the Training tab's one-shot plan generator ($0.01 vs $0.15).
      const trainingPlanShortcut = tryBuildTrainingPlanShortcutResponse(normalizedText, normalizedTextLower, userId);
      if (trainingPlanShortcut) {
        recordChatStage(chatRequestId, 'training_plan_shortcut');
        const { response: planResponse, conversationDomain } = trainingPlanShortcut;
        const response = finalizeChatMessageResponse(planResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: 'training-plan-shortcut',
          actionability: 'preview',
          verificationStatus: 'not_required',
          stageFamily: 'training_plan_shortcut',
        });
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        recordLegacyFallbackSample(true, {
          domain: conversationDomain,
          routeOwner: 'training_plan_shortcut',
          routeMethod: response.routeMethod,
        });
        res.json(response);
        return;
      }

      // Deterministic/cache/identity/fast-path work has now had first refusal.
      // Only at this boundary may the model-assisted action planner run.
      if (normalizedText && normalizedAttachments.length === 0 && !parseContentScriptShortcut(normalizedText)) {
        if (!await ensureModelBudget('iOS chat model planner blocked by AI budget')) return;
        const actionResult = await tryHandleChatActionPlan({
          text: normalizedText,
          userId,
          tenantId,
          conversationId: scopedClientMessageId ?? chatRequestId,
          messageId: userMessageId,
          channel: 'ios',
          locale: chatCoreV2RouteLocale,
          timezone: getUserTimezoneById(userId),
          requireSafeWriteConfirmation: true,
        });
        if (actionResult) {
          recordChatStage(chatRequestId, 'action_planner_model');
          latency.mark('action_planner_completed');
          // M8: model planner outputs are model-backed — run the full
          // compose + quality gate. A deterministic plan resolved on this
          // pass keeps the passthrough policy of its family.
          const response = finalizeChatMessageResponse(actionResult.response, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier3_model_assisted',
            fallbackDomain: actionResult.response.domain,
            fallbackRouteMethod: actionResult.response.routeMethod,
            fallbackConfidence: actionResult.response.confidence,
            actionability: actionabilityForReasoningStatus(actionResult.status),
            verificationStatus: verificationForReasoningMetadata(
              actionResult.response.metadata as Record<string, unknown> | undefined,
              actionResult.status,
            ),
            compositionMode: 'model_constrained',
            locale: chatCoreV2RouteLocale,
            stageFamily: actionResult.plan.planner === 'deterministic'
              ? 'action_planner_deterministic'
              : 'action_planner_model',
            requestStartedAt,
          });
          if (actionResult.status === 'needs_confirmation') {
            const isPT = chatCoreV2RouteLocale.startsWith('pt');
            const involvedSkills = [...new Set(actionResult.plan.steps.map((step) => mapActionPlannerSkillToNexusSkill(step.skill)))];
            const reasonCodes = [...new Set(actionResult.plan.steps.map((step) => `${step.risk}_requires_confirmation`))];
            const intentClass = intentClassForAction(actionResult.plan.steps[0]?.action, involvedSkills);
            const summary = {
              text: response.text || normalizedText,
              steps: actionResult.plan.steps.map((step) => ({
                skill: step.skill,
                action: step.action,
                risk: step.risk,
                args: step.args,
              })),
            };
            const pendingConfirmation = trackPendingChatConfirmation({
              userId,
              tenantId,
              actionSummary: response.text || normalizedText,
              involvedSkills,
              reasonCodes,
              intentClass,
              summary,
              sourceMessageId: userMessageId,
            });
            const decisionResult = await createDecisionIntent({
              userId,
              tenantId,
              sourceSkill: 'chat',
              type: 'decision_required',
              priority: 'active',
              relatedEntityId: pendingConfirmation.id,
              relatedEntityType: 'chat_confirmation',
              title: isPT ? 'Nexus precisa de confirmação' : 'Nexus needs confirmation',
              body: pendingConfirmation.actionSummary,
              sensitiveBody: pendingConfirmation.actionSummary,
              actionButtons: [
                { id: 'option_a', label: isPT ? 'Confirmar' : 'Confirm', style: 'primary' },
                { id: 'option_b', label: isPT ? 'Não executar' : 'Do not run', style: 'secondary' },
                { id: 'open_detail', label: isPT ? 'Abrir decisão' : 'Open decision', style: 'secondary' },
              ],
              deeplink: `nexus://notifications/${pendingConfirmation.id}`,
              expiresAt: pendingConfirmation.expiresAt,
              dedupeKey: `chat:action-confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
              requiresUserAction: true,
              deliveryPolicy: 'in_app_only',
              privacyPolicy: 'standard',
            });
            attachPendingConfirmationContract({
              response,
              pendingConfirmation,
              intentClass,
              summary,
              decisionId: decisionResult.item?.decisionId ?? null,
            });
          }
          // M13: durable continuity — model-planner terminal (assistant id +
          // planner step entity ids are known here).
          rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId, {
            conversationId: scopedClientMessageId ?? chatRequestId,
            lastAssistantMessageId: response.id,
            anchorEntityIds: anchorEntityIdsFromPlanSteps(actionResult.plan.steps),
          });
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
          logger.info({
            chatRequestId,
            tenantId,
            userId,
            routeMethod: response.routeMethod,
            actionStatus: actionResult.status,
            planner: actionResult.plan.planner,
            involvedSkills: actionResult.plan.steps.map((step) => step.skill),
          }, 'iOS chat model-assisted action planner handled request');
          recordLegacyFallbackSample(true, {
            domain: response.domain,
            routeOwner: 'chat_action_planner',
            routeMethod: response.routeMethod,
          });
          res.status(statusForChatActionResponse(actionResult.status, response)).json(response);
          return;
        }
      }

      const activeContext = resolveChatActiveContext(userId, Date.now(), tenantId);
      const preRoutingDecision = analyzeChatSkillOrchestration({
        message: normalizedText,
        activeContext,
        userId,
        tenantId,
      });
      const turnContractEnabled = isChatTurnContractEnabled(process.env, { userId, tenantId });
      const preTurnContract = turnContractEnabled
        ? inferChatTurnContract({
          message: normalizedText,
          activeContextDomain: activeContext?.domain ?? null,
          involvedSkills: preRoutingDecision.involvedSkills,
        })
        : null;

      if (
        isChatResearchRouterEnabled(process.env, { userId, tenantId })
        && preTurnContract?.routeKind === 'internet_research'
        && (preTurnContract.groundingRequired === 'web' || preTurnContract.groundingRequired === 'local_and_web')
      ) {
        recordChatStage(chatRequestId, 'internet_research');
        if (!await ensureModelBudget('iOS chat internet research blocked by AI budget')) return;
        const researchDomain = domainForTurnContractSkill(preTurnContract.skill) ?? 'chat';
        const localContext = preTurnContract.groundingRequired === 'local_and_web' && researchDomain !== 'chat'
          ? await buildSimpleStateContext(researchDomain, userId, normalizedText, tenantId)
          : null;
        const research = await buildChatInternetResearchAnswer({
          message: normalizedText,
          language: preTurnContract.language,
          skill: preTurnContract.skill,
          expectedResponseShape: preTurnContract.expectedResponseShape,
          userId,
          tenantId,
          groundingRequired: preTurnContract.groundingRequired,
          localContext,
        });
        latency.mark('internet_research_completed');
        const chatCoreV2ResearchOwner = isChatCoreV2VisibleNaturalLanguageOwnerActive(tenantId);
        const researchRouteMethod = chatCoreV2ResearchOwner
          ? 'chat-core-v2-internet-research'
          : 'internet-research';
        const researchMetadataType = chatCoreV2ResearchOwner
          ? 'chat_core_v2_internet_research'
          : 'chat_internet_research';
        const response = finalizeChatMessageResponse({
          id: newAssistantMessageId(),
          text: research.text,
          domain: researchDomain,
          routeMethod: researchRouteMethod,
          confidence: research.degraded ? 0.55 : preTurnContract.confidence,
          buttons: null,
          metadata: {
            type: researchMetadataType,
            webSources: research.sources,
            degraded: research.degraded,
            degradedReason: research.degradedReason ?? null,
            routeKind: preTurnContract.routeKind,
            groundingRequired: preTurnContract.groundingRequired,
            contextCompiler: research.context ?? null,
            ...(chatCoreV2ResearchOwner ? {
              chatCoreV2: {
                owner: 'internet_research_adapter',
                packetOnlyCloudFallback: false,
              },
            } : {}),
          },
          timestamp: new Date().toISOString(),
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier4_long_running',
          fallbackDomain: researchDomain,
          fallbackRouteMethod: researchRouteMethod,
          fallbackConfidence: research.degraded ? 0.55 : preTurnContract.confidence,
          actionability: research.degraded ? 'degraded' : 'answer_only',
          verificationStatus: research.sources.length > 0 ? 'verified' : 'not_required',
          fallback: research.degraded ? {
            fallbackType: 'model_unavailable',
            fallbackReason: research.degradedReason ?? 'web_research_unavailable',
            retryable: true,
            userActionRequired: false,
            operatorActionRequired: false,
          } : undefined,
          stageFamily: 'internet_research',
          requestStartedAt,
        });
        rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
        logger.info(
          {
            chatRequestId,
            tenantId,
            userId,
            skill: preTurnContract.skill,
            sourceCount: research.sources.length,
            degraded: research.degraded,
          },
          'iOS chat handled selective internet research turn',
        );
        recordLegacyFallbackSample(true, {
          domain: researchDomain,
          routeOwner: 'selective_internet_research',
          routeMethod: researchRouteMethod,
        });
        res.json(response);
        return;
      }

      if (isAcceptCurrentDecisionShortcut(normalizedTextLower)) {
        const pending = getPendingChatConfirmation(userId, tenantId);
        const decision = pending
          ? findDecisionByRelatedEntity(userId, tenantId, 'chat_confirmation', pending.id)
          : null;
        if (pending && decision) {
          recordChatStage(chatRequestId, 'decision_confirmation_shortcut');
          const result = await performDecisionAction(decision.decisionId, 'option_a', userId, tenantId, {
            idempotencyKey: normalizeIdempotencyKey(req.body?.idempotencyKey)
              ?? `chat-confirm:${tenantId}:${userId}:${pending.id}:${Date.now()}`,
          });
          const confirmedAction = await executeConfirmedChatActionRuns({
            text: pending.actionSummary,
            userId,
            tenantId,
            conversationId: scopedClientMessageId ?? chatRequestId,
            messageId: userMessageId,
            sourceMessageId: pending.sourceMessageId,
            channel: 'ios',
            locale: chatCoreV2RouteLocale,
            timezone: getUserTimezoneById(userId),
          });
          if (confirmedAction) {
            clearPendingChatConfirmation(userId, tenantId);
            // M8: confirmed action runs are read-back verified inside the
            // executor — finalizer policy 'passthrough'.
            const response = finalizeChatMessageResponse(confirmedAction.response, {
              normalizedText,
              userId,
              tenantId,
              chatRequestId,
              tracker: latency,
              latencyTier: 'tier2_verified_write',
              stageFamily: 'decision_confirmation_execute',
            });
            response.metadata.confirmationDecision = {
              decisionId: result.item.decisionId,
              actionId: result.actionId,
              idempotent: result.idempotent,
              verification: result.verification,
            };
            rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
            persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
              clientMessageId: scopedClientMessageId,
              requestId: chatRequestId,
            });
            syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
            recordLegacyFallbackSample(true, {
              domain: response.domain,
              routeOwner: 'decision_confirmation_shortcut',
              routeMethod: response.routeMethod,
            });
            res.status(statusForChatActionResponse(confirmedAction.status, response)).json(response);
            return;
          }
          const response = finalizeChatMessageResponse({
            id: newAssistantMessageId(),
            text: chatCoreV2RouteLocale.startsWith('pt')
              ? 'Confirmado. A decisão foi registada no Decision Center e verificada pelo servidor.'
              : 'Confirmed. The decision was recorded in Decision Center and verified by the server.',
            domain: 'chat',
            routeMethod: 'decision-center-action',
            confidence: 0.95,
            buttons: null,
            metadata: {
              type: 'decision_center_chat_confirmation_actioned',
              decisionId: result.item.decisionId,
              actionId: result.actionId,
              idempotent: result.idempotent,
              verification: result.verification,
            },
            timestamp: new Date().toISOString(),
          }, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: 'tier2_verified_write',
            actionability: 'execute',
            verificationStatus: 'verified',
            stageFamily: 'decision_confirmation_templated',
          });
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          recordLegacyFallbackSample(true, {
            domain: response.domain,
            routeOwner: 'decision_confirmation_shortcut',
            routeMethod: response.routeMethod,
          });
          res.json(response);
          return;
        }
      }

      if (preRoutingDecision.safety.requiresConfirmation && !preRoutingDecision.safety.explicitConfirmation) {
        recordChatStage(chatRequestId, 'destructive_confirmation_hold');
        const intentClass = intentClassForAction(undefined, preRoutingDecision.involvedSkills);
        const copy = destructiveConfirmationCopy(chatCoreV2RouteLocale);
        const summary = {
          text: normalizedText,
          involvedSkills: preRoutingDecision.involvedSkills,
          reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
        };
        const pendingConfirmation = trackPendingChatConfirmation({
          userId,
          tenantId,
          actionSummary: normalizedText,
          involvedSkills: preRoutingDecision.involvedSkills,
          reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
          intentClass,
          summary,
          sourceMessageId: userMessageId,
        });
        const decisionResult = await createDecisionIntent({
          userId,
          tenantId,
          sourceSkill: 'chat',
          type: 'decision_required',
          priority: 'active',
          relatedEntityId: pendingConfirmation.id,
          relatedEntityType: 'chat_confirmation',
          title: copy.title,
          body: pendingConfirmation.actionSummary,
          sensitiveBody: pendingConfirmation.actionSummary,
          actionButtons: [
            { id: 'option_a', label: copy.confirmLabel, style: 'primary' },
            { id: 'option_b', label: copy.declineLabel, style: 'secondary' },
            { id: 'open_detail', label: copy.openDecisionLabel, style: 'secondary' },
          ],
          deeplink: `nexus://notifications/${pendingConfirmation.id}`,
          expiresAt: pendingConfirmation.expiresAt,
          dedupeKey: `chat:confirmation:${tenantId}:${userId}:${pendingConfirmation.id}`,
          requiresUserAction: true,
          deliveryPolicy: 'in_app_only',
          privacyPolicy: 'standard',
        });
        const sufficiency = buildChatResponseSufficiencyMetadata({
          actionStatus: 'needs_confirmation',
          requiresConfirmation: true,
          unresolvedBlockers: ['target_identity_required'],
        });
        const confirmationResponse = finalizeChatMessageResponse({
          id: newAssistantMessageId(),
          text: copy.text,
          domain: preRoutingDecision.primaryDomain || 'secretary',
          routeMethod: 'confirmation-required',
          confidence: preRoutingDecision.confidence,
          buttons: null,
          metadata: {
            type: 'chat_action_confirmation_required',
            actionStatus: sufficiency.actionStatus,
            involvedSkills: preRoutingDecision.involvedSkills,
            reasonCodes: preRoutingDecision.safety.confirmationReasonCodes,
            unresolvedBlockers: sufficiency.unresolvedBlockers,
            responseSufficiency: sufficiency,
            actionConfirmation: {
              title: copy.title,
              message: pendingConfirmation.actionSummary,
              destructive: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes) === 'destructive',
              variant: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes),
              requiresStrongConfirm: confirmationVariantForIntent(intentClass, preRoutingDecision.safety.confirmationReasonCodes) === 'financial',
            },
          },
          timestamp: new Date().toISOString(),
        }, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier2_verified_write',
          actionability: 'preview',
          verificationStatus: 'pending',
          stageFamily: 'destructive_confirmation_hold',
        });
        attachPendingConfirmationContract({
          response: confirmationResponse,
          pendingConfirmation,
          intentClass,
          summary,
          decisionId: decisionResult.item?.decisionId ?? null,
        });
        rememberChatActiveDomain(userId, confirmationResponse.domain, Date.now(), tenantId);
        persistExchange(userId, userMessageId, normalizedText, confirmationResponse.id, confirmationResponse, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, confirmationResponse.domain, normalizedText, confirmationResponse.text, tenantId);
        logger.info(
          { chatRequestId, userId, tenantId, orchestration: buildChatSkillRoutingLogContext(preRoutingDecision) },
          'iOS chat destructive action paused for confirmation',
        );
        recordLegacyFallbackSample(true, {
          domain: confirmationResponse.domain,
          routeOwner: 'destructive_confirmation_hold',
          routeMethod: confirmationResponse.routeMethod,
        });
        res.json(confirmationResponse);
        return;
      }

      // ── ChatCoreV2 Local Answer Owner ───────────────────────────
      // Ordinary natural-language answer turns are served through the V2
      // planner/composer only when the explicit V2 local-chat serving flag is
      // visible (canary/on). Slash/button/token-zero paths above stay intact,
      // and write intents are already stopped by the action gateway.
      if (
        normalizedText
        && normalizedAttachments.length === 0
        && !normalizedText.trim().startsWith('/')
      ) {
        if (!await ensureModelBudget('iOS chat local answer blocked by AI budget')) return;
        const localChatResult = await runChatCoreV2LocalChatTurn({
          normalizedText,
          userId,
          tenantId,
          requestId: chatRequestId,
          locale: chatCoreV2RouteLocale,
          surface: 'ios',
          recentTurns: buildRecentTurnsForChatCoreV2(userId, tenantId),
          memoryContext: loadChatV2MemoryContextForOrchestrator({
            userId,
            tenantId,
            env: process.env,
          }),
          env: process.env,
        });
        if (localChatResult) {
          recordChatStage(chatRequestId, 'chat_core_v2_local_answer');
          latency.mark('chat_core_v2_local_answer_completed');
          const response = finalizeChatMessageResponse(localChatResult.response, {
            normalizedText,
            userId,
            tenantId,
            chatRequestId,
            tracker: latency,
            latencyTier: localChatResult.degraded ? 'tier1_fast_read' : 'tier3_model_assisted',
            fallbackDomain: localChatResult.response.domain,
            fallbackRouteMethod: localChatResult.response.routeMethod,
            fallbackConfidence: localChatResult.response.confidence,
            actionability: localChatResult.degraded ? 'degraded' : 'answer_only',
            verificationStatus: 'not_required',
            compositionMode: localChatResult.degraded ? 'templated' : 'model_constrained',
            fallback: localChatResult.degraded ? {
              fallbackType: 'model_unavailable',
              fallbackReason: String(localChatResult.response.metadata.reason ?? 'local_chat_degraded'),
              retryable: true,
              userActionRequired: false,
              operatorActionRequired: false,
            } : undefined,
            stageFamily: 'chat_core_v2_local_answer',
            requestStartedAt,
          });
          persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
            clientMessageId: scopedClientMessageId,
            requestId: chatRequestId,
          });
          syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
          if (response.domain !== 'chat') {
            // M13: durable continuity — local-answer terminal knows the
            // persisted assistant message id.
            rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId, {
              conversationId: scopedClientMessageId ?? chatRequestId,
              lastAssistantMessageId: response.id,
              anchorEntityIds: [],
            });
          }
          logger.info(
            {
              chatRequestId,
              tenantId,
              userId,
              routeMethod: response.routeMethod,
              degraded: localChatResult.degraded,
            },
            'iOS chat handled natural-language answer with ChatCoreV2 local answer owner',
          );
          recordLegacyFallbackSample(false, {
            domain: response.domain,
            routeOwner: 'chat_core_v2_local_answer',
            routeMethod: response.routeMethod,
          });
          res.json(response);
          return;
        }
      }

      // Route the message (handles both commands and natural language).
      // April 9 2026: thread userId into routeMessage so the classifier
      // cost row in api_usage attributes this call to the real user
      // instead of user_id=0. Without this, every iOS chat message's
      // classification cost was orphaned under user_id=0 and the
      // per-user cap (isUserOverDailyCap) couldn't see the spend.
      const unsupportedFallback = evaluateChatCoreV2UnsupportedFallback({
        normalizedText,
        locale: chatCoreV2RouteLocale,
        tenantId,
        env: process.env,
      });
      if (unsupportedFallback.response) {
        recordChatStage(chatRequestId, 'chat_core_v2_unsupported_fallback');
        latency.mark('chat_core_v2_unsupported_fallback_returned');
        const unsupportedResponse = {
          id: newAssistantMessageId(),
          text: unsupportedFallback.response.text,
          domain: 'chat',
          routeMethod: 'unsupported',
          confidence: 1,
          buttons: null,
          metadata: {
            type: 'chat_core_v2_unsupported_fallback',
            kind: unsupportedFallback.response.kind,
            locale: unsupportedFallback.response.locale,
            reasonCodes: unsupportedFallback.response.reasonCodes,
            decisionReason: unsupportedFallback.decisionReason,
            legacyFallbackDisabled: unsupportedFallback.legacyFallbackDisabled,
            routeGuess: {
              intent: unsupportedFallback.routeGuess.intent,
              domains: unsupportedFallback.routeGuess.domains,
              capabilityIds: unsupportedFallback.routeGuess.capabilityIds,
              confidence: unsupportedFallback.routeGuess.confidence,
              unsupportedReason: unsupportedFallback.routeGuess.unsupportedReason,
            },
          },
          timestamp: new Date(requestStartedAt).toISOString(),
          responseBlocks: buildBlocksFromMarkdown(unsupportedFallback.response.text),
          reasonCodes: unsupportedFallback.response.reasonCodes,
        };
        const response = finalizeChatMessageResponse(unsupportedResponse, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: unsupportedResponse.domain,
          fallbackRouteMethod: unsupportedResponse.routeMethod,
          fallbackConfidence: unsupportedResponse.confidence,
          actionability: 'blocked',
          verificationStatus: 'not_required',
          compositionMode: 'templated',
          locale: chatCoreV2RouteLocale,
          fallback: {
            fallbackType: 'degraded_response',
            fallbackReason: unsupportedFallback.decisionReason ?? 'chat_core_v2_unsupported_fallback',
            retryable: false,
            userActionRequired: true,
            operatorActionRequired: false,
          },
          stageFamily: 'chat_core_v2_unsupported_fallback',
        });
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, response.domain, normalizedText, response.text, tenantId);
        rememberChatActiveDomain(userId, response.domain, Date.now(), tenantId);
        logger.info(
          {
            chatRequestId,
            tenantId,
            userId,
            routeMethod: response.routeMethod,
            decisionReason: unsupportedFallback.decisionReason,
            legacyFallbackDisabled: unsupportedFallback.legacyFallbackDisabled,
          },
          'iOS chat returned ChatCoreV2 unsupported fallback instead of legacy routeMessage',
        );
        recordLegacyFallbackSample(false, {
          domain: response.domain,
          routeOwner: 'chat_core_v2_unsupported_fallback',
          routeMethod: response.routeMethod,
        });
        res.json(response);
        return;
      }

      if (!await ensureModelBudget('iOS chat provider routing blocked by AI budget')) return;
      const rawRoute = await routeMessage(normalizedText, activeContext, userId, tenantId);
      latency.mark('routed');
      recordChatStage(chatRequestId, 'legacy_route');
      const contractAwareRoute = preTurnContract ? applyTurnContractRouteHint(rawRoute, preTurnContract) : rawRoute;
      const routingDecision = analyzeChatSkillOrchestration({
        message: normalizedText,
        activeContext,
        routedDomain: contractAwareRoute.domain,
        userId,
        tenantId,
      });
      const pendingConfirmation = routingDecision.safety.explicitConfirmation
        ? getPendingChatConfirmation(userId, tenantId)
        : null;
      const route = applyChatSkillRoutingDecision(contractAwareRoute, routingDecision);
      recordLegacyFallbackSample(true, {
        domain: route.domain,
        routeOwner: 'legacy_route_message',
        routeMethod: route.method,
      });
      logger.info(
        {
          chatRequestId,
          domain: route.domain,
          method: route.method,
          confidence: route.confidence,
          platform: 'ios',
          orchestration: buildChatSkillRoutingLogContext(routingDecision),
          rawDomain: rawRoute.domain,
          contractHintedDomain: contractAwareRoute.domain !== rawRoute.domain ? contractAwareRoute.domain : null,
        },
        'iOS message routed',
      );

      // Track domain for continuity
      rememberChatActiveDomain(userId, route.domain, Date.now(), tenantId);

      // ─── Phase 1 Slice C — Tier gate for iOS chat entrypoint ───
      // Same two-layer check as the Telegram handler: explicit disable
      // first, then tier requirement. Fail-open on errors so a bus of
      // signal service issue never locks users out of their data.
      if (sendChatTierRequiredIfNeeded(res, userId, route.domain)) return;

      // Execute domain handler
      const handler = getChatDomainHandler(route.domain);
      if (!handler) {
        res.status(400).json({
          error: { code: 'UNKNOWN_DOMAIN', message: `No handler for domain: ${route.domain}` },
        });
        return;
      }

      const shortcutResult = await tryBuildChatMessageShortcutResponse({
        route,
        normalizedText,
        userId,
        tenantId,
        userLanguage: chatCoreV2RouteLocale,
        activeContext,
      });
      if (shortcutResult) {
        recordChatStage(chatRequestId, 'domain_shortcut');
        const { conversationDomain } = shortcutResult;
        const response = finalizeChatMessageResponse(shortcutResult.response, {
          normalizedText,
          userId,
          tenantId,
          chatRequestId,
          tracker: latency,
          latencyTier: 'tier1_fast_read',
          fallbackDomain: conversationDomain,
          fallbackRouteMethod: route.method,
          fallbackConfidence: route.confidence,
          actionability: 'answer_only',
          verificationStatus: 'not_required',
          stageFamily: 'domain_shortcut',
          requestStartedAt,
        });
        persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
          clientMessageId: scopedClientMessageId,
          requestId: chatRequestId,
        });
        syncConversationStateForShortcut(userId, conversationDomain, normalizedText, response.text, tenantId);
        res.json(response);
        return;
      }

      const result = await runWithChatToolAuthorization({
        userId,
        tenantId,
        confirmedDestructiveAction: routingDecision.safety.explicitConfirmation,
        // ADV-3: an accepted staged confirmation authorizes exactly the
        // targets it was staged with; a free-text confirmation collapses to a
        // single untyped grant (undefined) inside the authorization layer.
        confirmedDestructiveTargets: routingDecision.safety.explicitConfirmation
          ? pendingConfirmation?.confirmedTargets
          : undefined,
        confirmationSource: routingDecision.safety.explicitConfirmation
          ? pendingConfirmation ? 'pending_confirmation' : 'explicit_current_turn'
          : 'none',
        requireConfirmationForWrites: true,
        contentIdeaCaptureConsent: issueContentIdeaCaptureConsent({
          tenantId,
          userId,
          sourceMessageId: userMessageId,
          message: normalizedText,
        }),
      }, () => executeChatDomainHandler(handler, route.strippedMessage, userId, tenantId));
      latency.mark('domain_handler_completed');
      recordChatStage(chatRequestId, 'legacy_response');
      if (routingDecision.safety.explicitConfirmation) {
        clearPendingChatConfirmation(userId, tenantId);
      }

      // Extract buttons from the response text if present.
      // Secretary fast-path messages expose deterministic command buttons.
      // Triathlon coach replies can expose real "apply recommendation"
      // actions when the current request produced fresh coach state.
      const lang = chatCoreV2RouteLocale;
      const buttons = buildDefaultButtonsForChatDomain(result.domain || route.domain, lang, userId, requestStartedAt, tenantId);

      const enriched = finalizeChatAnswerMetadata({
        normalizedText,
        responseText: result.text,
        userId,
        tenantId,
        chatRequestId,
        routeMethod: route.method,
        domain: result.domain || route.domain,
        confidence: route.confidence,
        tracker: latency,
        latencyTier: 'tier3_model_assisted',
        activeContext,
        route,
        routingDecision,
        locale: chatCoreV2RouteLocale,
        existingMetadata: result.metadata && typeof result.metadata === 'object'
          ? result.metadata as Record<string, unknown>
          : null,
        stageFamily: 'legacy_response',
        requestStartedAt,
      });
      const response = buildChatHandlerResponseEnvelope({
        route,
        result: { ...result, text: enriched.text },
        buttons,
        metadata: enriched.metadata,
      });

      if (isNewUserFlow) {
        logger.debug(
          {
            chatRequestId,
            userId,
            domain: response.domain,
            routeMethod: response.routeMethod,
          hasButtons: Array.isArray(response.buttons) && response.buttons.length > 0,
          metadataType: (response.metadata as { type?: string } | null)?.type || null,
          textLength: response.text.length,
          },
          'iOS new-user chat response envelope',
        );
      }

      // Cache the response if it was a deterministic command
      maybeCacheChatCommandResponse(userId, normalizedTextLower, response, tenantId);

      persistExchange(userId, userMessageId, normalizedText, response.id, response, tenantId, {
        clientMessageId: scopedClientMessageId,
        requestId: chatRequestId,
      });
      // M13: durable continuity — the legacy terminal now knows the persisted
      // assistant message id (the earlier pin at routing time had no id yet).
      rememberChatActiveDomain(userId, response.domain || route.domain, Date.now(), tenantId, {
        conversationId: scopedClientMessageId ?? chatRequestId,
        lastAssistantMessageId: response.id,
        anchorEntityIds: [],
      });
      logger.info(
        {
          chatRequestId,
          tenantId,
          userId,
          domain: response.domain,
          durationMs: Date.now() - requestStartedAt,
        },
        'iOS chat request completed',
      );
      res.json(response);
    } catch (err: any) {
      const chatRequestId = getCurrentRequestId() || (req as any).requestId || `chat-${Date.now()}`;
      if (!res.headersSent && sendAiBudgetError(res, err)) return;
      // Codex QA round 4 / 5: the idempotency ids are now hoisted above
      // the try block, so they're in scope here and can flow into the
      // degraded-response persistence path.
      if (await sendRetryableChatFailureResponseIfNeeded({
        err,
        res,
        userId,
        tenantId,
        normalizedText,
        chatRequestId,
        userMessageId,
        clientMessageId: scopedClientMessageId ?? undefined,
      })) return;
      pushEvent({
        ts: new Date().toISOString(),
        type: 'error',
        summary: `chat failed (${chatRequestId})`,
        detail: 'Unhandled chat route failure',
        domain: 'secretary',
      });
      logger.error({ err, textLength: normalizedText.length, platform: 'ios', chatRequestId, tenantId, userId }, 'iOS chat/message failed');
      sendInternalError(res, 'Failed to process message');
    } finally {
      // Release the classified source/job/base/run reservation so the next
      // concurrent request can run its own check -> provider -> usage cycle.
      aiBudgetReservation.release?.();
    }
  });
}
