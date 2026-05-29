// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { logger } from '../../utils/logger';
import {
  tryBuildChatCoreV2CommandPreviewRoute,
  type BuildChatCoreV2CommandPreviewRouteInput,
  type ChatCoreV2CommandPreviewRouteResult,
} from './command-preview-route';
import { classifyShadowRoute } from './shadow-route-classifier';
import type { AICommandEnvelope } from './types';

export const CHAT_CORE_V2_ACTION_GATEWAY_VERSION = 'chat_core_v2_action_gateway@1.0.0';

export type ChatCoreV2ActionGatewayMode = 'off' | 'shadow' | 'enforce';

export interface ActionCandidate {
  capabilityId: string;
  label: string;
  entityId?: string;
}

export type ChatCoreV2ActionGatewayResult =
  | { kind: 'no_write_intent'; telemetry: ChatCoreV2WriteIntentGuardTelemetry }
  | {
    kind: 'resolved_preview';
    command: AICommandEnvelope;
    preview: ChatCoreV2CommandPreviewRouteResult;
    telemetry: ChatCoreV2WriteIntentGuardTelemetry;
  }
  | {
    kind: 'resolved_execute';
    command: AICommandEnvelope;
    preview: ChatCoreV2CommandPreviewRouteResult;
    telemetry: ChatCoreV2WriteIntentGuardTelemetry;
  }
  | {
    kind: 'needs_clarification';
    question: string;
    candidates?: ActionCandidate[];
    telemetry: ChatCoreV2WriteIntentGuardTelemetry;
  }
  | { kind: 'unsupported_write'; reason: string; telemetry: ChatCoreV2WriteIntentGuardTelemetry }
  | { kind: 'blocked_legacy_fallback'; reason: string; telemetry: ChatCoreV2WriteIntentGuardTelemetry };

export interface ChatCoreV2ActionGatewayInput extends BuildChatCoreV2CommandPreviewRouteInput {
  requestId: string;
  env?: NodeJS.ProcessEnv;
  shouldAutoExecute?: (preview: ChatCoreV2CommandPreviewRouteResult) => boolean;
}

export interface ChatCoreV2WriteIntentProbe {
  mayMutate: boolean;
  detectedIntent: 'none' | 'task_create' | 'task_complete' | 'task_update' | 'task_delete' | 'other_write';
  actionType?: string;
  reasonCodes: string[];
}

export interface ChatCoreV2WriteIntentGuardTelemetry {
  event: 'chat_core_v2_write_intent_guard';
  gatewayVersion: string;
  requestId: string;
  userId: number;
  tenantId: number;
  messageHash: string;
  detectedIntent: ChatCoreV2WriteIntentProbe['detectedIntent'];
  actionType?: string;
  resolverResult: string;
  resolvedEntityIds: string[];
  policyDecision: string;
  legacyFallbackBlocked: boolean;
  finalOutcome: string;
  verificationStatus: 'not_required' | 'pending' | 'verified' | 'failed';
  latencyMs: number;
  reasonCodes: string[];
  mode: ChatCoreV2ActionGatewayMode;
}

const TASK_NOUN_RE = /\b(tasks?|todos?|to-dos?|tarefas?|tareas?)\b/i;
const TASK_COMPLETE_RE = /\b(mark|complete|finish|done|tick|check|concluir|conclui|conclua|completar|terminar|finalizar|marca|marcar|marque)\b/i;
const TASK_CREATE_RE = /\b(create|make|add|new|cria|criar|crie|adiciona|adicionar|nova?|crea|crear|agregar|añadir|anadir)\b/i;
const TASK_DELETE_UPDATE_RE = /\b(delete|remove|rename|change|edit|update|apagar|deletar|remover|renomear|alterar|editar|borrar|eliminar|cambiar|actualizar)\b/i;
const SUBTASK_RE = /\b(sub\s*-?\s*tasks?|subtarefas?|subtareas?|check\s*-?\s*list|checklist)\b/i;

const NEGATION_RES = [
  /\b(don['’]?t|do\s+not|never|stop|nao|nunca|sem|no|not)\s+(?:please\s+)?(?:mark|complete|finish|tick|check|concluir|conclua|completar|terminar|finalizar|marca|marcar|marque|marques)\b/i,
  /\b(?:ainda\s+nao|haven['’]?t|have\s+not|not\s+yet|todavia\s+no)\b.*\b(?:complete[d]?|done|conclu|complet)\b/i,
];
const HYPOTHETICAL_RE = /\b(should\s+i|can\s+i|could\s+i|how\s+do\s+i|why\s+is|would\s+you|devo|posso|como\s+(?:eu\s+)?(?:marco|marcar|concluo|concluir)|por\s+que|porque|deber[ií]a|puedo|como\s+(?:marco|marcar)|por\s+qu[eé])\b/i;
const BROADER_WRITE_RES = [
  /\b(schedule|reschedule|cancel|delete|send|email|notify|remind|transfer|pay|payment|move|snooze|dismiss|create)\b.*\b(calendar|event|meeting|email|message|notification|reminder|money|payment|training|workout|decision)\b/i,
  /\b(agendar|remarcar|cancelar|enviar|notificar|lembrar|transferir|pagar|mover|adiar|descartar|dispensar)\b.*\b(calendario|agenda|evento|reuniao|email|mensagem|notifica|lembrete|dinheiro|pagamento|treino|decisao)\b/i,
];

// Bare imperative mutation verbs (incl. imperative stems like "adia"/"cancela"/
// "muda") that may carry an ambiguous referent ("cancel that").
const AMBIGUOUS_MUTATION_RE = /\b(cancel(?:a|ar|e|ed|led|ado|ada)?|reschedul(?:e|ing)?|remarc(?:a|ar|e)|adi(?:a|ar|e|am)|postpone[d]?|mov(?:e|er|a)|mud(?:a|ar|e)|delet(?:e|a|ar)|apag(?:a|ar|ue)|remov(?:e|a|er)|descart(?:a|ar|e)|dismiss(?:ed)?)\b/i;
// Interrogative/read phrasing that must not be misread as a write intent.
const READ_QUESTION_RE = /\b(o que|que tenho|what (?:do i|are|is|s)|which|qual|quais|mostra|mostrar|show me|list|lista|listar|tenho|do i have|any |algum|alguma|quanto|quantos|how many|status)\b/i;

export function resolveChatCoreV2ActionGatewayMode(
  env: NodeJS.ProcessEnv = process.env,
): ChatCoreV2ActionGatewayMode {
  if (String(env.CHAT_CORE_V2_ORCHESTRATOR_MODE ?? '').trim().toLowerCase() === 'off') return 'off';
  const raw = String(env.CHAT_CORE_V2_ACTION_GATEWAY_MODE ?? '').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  if (env.CHAT_CORE_V2_ENABLED === 'true' && (env.CHAT_CORE_V2_WRITES_ENABLED === 'true' || env.CHAT_CORE_V2_PREVIEWS_ENABLED === 'true')) {
    return 'enforce';
  }
  return 'off';
}

export function detectChatCoreV2WriteIntent(text: string): ChatCoreV2WriteIntentProbe {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { mayMutate: false, detectedIntent: 'none', reasonCodes: ['empty_message'] };
  }

  const hasTaskNoun = TASK_NOUN_RE.test(normalized);
  const hasSubtask = SUBTASK_RE.test(normalized);
  const hasTaskComplete = TASK_COMPLETE_RE.test(normalized) && (hasTaskNoun || /\b(done|complete[d]?|conclu[ií]da|conclu[ií]do|feita|feito)\b/i.test(normalized));
  const hasTaskCreate = TASK_CREATE_RE.test(normalized) && (hasTaskNoun || hasSubtask);
  const hasTaskDeleteUpdate = TASK_DELETE_UPDATE_RE.test(normalized) && hasTaskNoun;

  if (hasNegationOrHypothetical(normalized) && (hasTaskComplete || hasTaskCreate || hasTaskDeleteUpdate)) {
    return {
      mayMutate: true,
      detectedIntent: hasTaskComplete ? 'task_complete' : hasTaskCreate ? 'task_create' : 'task_update',
      actionType: hasTaskComplete ? 'tasks.complete' : hasTaskCreate ? 'tasks.create' : 'tasks.update',
      reasonCodes: ['write_intent_safety_guard'],
    };
  }

  if (hasTaskComplete) {
    return { mayMutate: true, detectedIntent: 'task_complete', actionType: 'tasks.complete', reasonCodes: ['task_complete_intent'] };
  }
  if (hasTaskCreate) {
    return { mayMutate: true, detectedIntent: 'task_create', actionType: 'tasks.create', reasonCodes: [hasSubtask ? 'task_with_subtasks_intent' : 'task_create_intent'] };
  }
  if (hasTaskDeleteUpdate) {
    return { mayMutate: true, detectedIntent: normalized.includes('delete') || normalized.includes('apagar') || normalized.includes('eliminar') ? 'task_delete' : 'task_update', actionType: 'tasks.update_or_delete', reasonCodes: ['unsupported_task_mutation_intent'] };
  }

  const isReadQuestion = READ_QUESTION_RE.test(normalized);

  // Bare imperative mutations with an ambiguous referent ("cancel that",
  // "cancela isso", "adia o treino") carry no task noun, so the checks above
  // miss them and they used to fall through to the free-text answerer, which
  // could fabricate the action. Treat them as a write intent so the gateway
  // resolves/clarifies. Skip read questions and how-to/hypothetical phrasing.
  if (!isReadQuestion && !hasNegationOrHypothetical(normalized) && AMBIGUOUS_MUTATION_RE.test(normalized)) {
    return { mayMutate: true, detectedIntent: 'other_write', actionType: 'other.write', reasonCodes: ['ambiguous_mutation_intent'] };
  }

  const routeGuess = classifyShadowRoute(text);
  // A shadow-route action guess must not override a plain read question
  // (e.g. "o que tenho na agenda hoje?"), which must stay a read.
  if (!isReadQuestion && (routeGuess.intent === 'create_action' || routeGuess.intent === 'modify_action')) {
    return {
      mayMutate: true,
      detectedIntent: routeGuess.domains[0] === 'tasks' ? 'task_update' : 'other_write',
      actionType: routeGuess.capabilityIds[0] ?? `${routeGuess.domains[0] ?? 'unknown'}.write`,
      reasonCodes: ['shadow_route_write_intent'],
    };
  }
  if (routeGuess.intent === 'unsafe_or_disallowed' && /\b(delete\s+all|wipe\s+all|pay|payment|send\s+money|transfer)\b/i.test(normalized)) {
    return {
      mayMutate: true,
      detectedIntent: 'other_write',
      actionType: routeGuess.capabilityIds[0] ?? 'unsafe.write',
      reasonCodes: ['unsafe_write_intent'],
    };
  }

  if (BROADER_WRITE_RES.some((pattern) => pattern.test(normalized))) {
    return { mayMutate: true, detectedIntent: 'other_write', actionType: 'other.write', reasonCodes: ['broad_write_intent'] };
  }

  return { mayMutate: false, detectedIntent: 'none', reasonCodes: ['no_write_intent'] };
}

/**
 * Whether the read fast paths (token-zero shortcut, deterministic read) should
 * be suppressed because this turn is a write intent the gateway will handle.
 * Only true when the gateway is actively enforcing — with
 * CHAT_CORE_V2_ORCHESTRATOR_MODE=off (or the gateway in shadow), routing must be
 * an unchanged legacy passthrough so the master kill switch stays authoritative
 * (Binding Doctrine #11/#12).
 */
export function shouldGateReadFastPathsForWriteIntent(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (resolveChatCoreV2ActionGatewayMode(env) !== 'enforce') return false;
  return detectChatCoreV2WriteIntent(text).mayMutate;
}

export function runChatCoreV2ActionGateway(
  input: ChatCoreV2ActionGatewayInput,
): ChatCoreV2ActionGatewayResult {
  const startedAt = Date.now();
  const env = input.env ?? process.env;
  const mode = resolveChatCoreV2ActionGatewayMode(env);
  const shouldBlockLegacy = mode === 'enforce' && isLegacyWriteFallthroughBlockEnabled(env);
  const probe = detectChatCoreV2WriteIntent(input.normalizedText);
  const baseTelemetry = (overrides: Partial<ChatCoreV2WriteIntentGuardTelemetry>): ChatCoreV2WriteIntentGuardTelemetry => ({
    event: 'chat_core_v2_write_intent_guard',
    gatewayVersion: CHAT_CORE_V2_ACTION_GATEWAY_VERSION,
    requestId: input.requestId,
    userId: input.userId,
    tenantId: input.tenantId,
    messageHash: hmacMessageHash({
      text: input.normalizedText,
      tenantId: input.tenantId,
      userId: input.userId,
      env,
    }),
    detectedIntent: probe.detectedIntent,
    actionType: probe.actionType,
    resolverResult: 'not_run',
    resolvedEntityIds: [],
    policyDecision: 'not_applicable',
    legacyFallbackBlocked: false,
    finalOutcome: 'no_write_intent',
    verificationStatus: 'not_required',
    latencyMs: Date.now() - startedAt,
    reasonCodes: probe.reasonCodes,
    mode,
    ...overrides,
  });

  if (mode === 'off' || !probe.mayMutate) {
    return { kind: 'no_write_intent', telemetry: baseTelemetry({ policyDecision: mode === 'off' ? 'gateway_off' : 'no_write_intent' }) };
  }

  if (hasNegationOrHypothetical(input.normalizedText)) {
    const result: ChatCoreV2ActionGatewayResult = {
      kind: 'unsupported_write',
      reason: 'write_intent_negated_or_hypothetical',
      telemetry: baseTelemetry({
        resolverResult: 'blocked_by_safety_guard',
        policyDecision: mode === 'shadow' ? 'shadow_would_block' : 'block_legacy',
        legacyFallbackBlocked: shouldBlockLegacy,
        finalOutcome: 'unsupported_write',
        reasonCodes: [...probe.reasonCodes, 'negation_or_hypothetical_guard'],
      }),
    };
    logTelemetry(result.telemetry);
    return shouldBlockLegacy ? result : { kind: 'no_write_intent', telemetry: result.telemetry };
  }

  const preview = tryBuildChatCoreV2CommandPreviewRoute(input);
  if (preview) {
    const shouldExecute = input.shouldAutoExecute?.(preview) === true;
    const telemetry = baseTelemetry({
      resolverResult: preview.gateVerdict.ok ? 'resolved' : 'rejected_by_command_bus',
      resolvedEntityIds: preview.command.basedOn.entityIds,
      policyDecision: shouldExecute ? 'execute' : 'preview',
      legacyFallbackBlocked: shouldBlockLegacy,
      finalOutcome: shouldExecute ? 'resolved_execute' : 'resolved_preview',
      verificationStatus: shouldExecute ? 'pending' : 'not_required',
      reasonCodes: [...probe.reasonCodes, preview.capabilityId],
    });
    logTelemetry(telemetry);
    if (mode === 'shadow') return { kind: 'no_write_intent', telemetry };
    return shouldExecute
      ? { kind: 'resolved_execute', command: preview.command, preview, telemetry }
      : { kind: 'resolved_preview', command: preview.command, preview, telemetry };
  }

  const unresolved = unresolvedResultForProbe(probe, input, baseTelemetry({
    resolverResult: 'unresolved',
    policyDecision: mode === 'shadow' ? 'shadow_would_block' : 'block_legacy',
    legacyFallbackBlocked: shouldBlockLegacy,
    finalOutcome: 'unresolved_write_intent',
  }));
  logTelemetry(unresolved.telemetry);
  return shouldBlockLegacy ? unresolved : { kind: 'no_write_intent', telemetry: unresolved.telemetry };
}

function isLegacyWriteFallthroughBlockEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = String(env.CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK ?? '').trim().toLowerCase();
  return raw !== 'false' && raw !== 'off' && raw !== '0';
}

function unresolvedResultForProbe(
  probe: ChatCoreV2WriteIntentProbe,
  input: ChatCoreV2ActionGatewayInput,
  telemetry: ChatCoreV2WriteIntentGuardTelemetry,
): ChatCoreV2ActionGatewayResult {
  if (probe.detectedIntent === 'task_complete') {
    return {
      kind: 'needs_clarification',
      question: localized(input.locale, {
        pt: 'Encontrei um pedido para concluir uma tarefa, mas não consegui identificar exatamente qual. Diz-me o nome exato da tarefa.',
        en: 'I found a request to complete a task, but I could not identify exactly which task. Tell me the exact task name.',
      }),
      telemetry: {
        ...telemetry,
        finalOutcome: 'needs_clarification',
        reasonCodes: [...telemetry.reasonCodes, 'task_complete_unresolved'],
      },
    };
  }
  if (probe.detectedIntent === 'task_create') {
    return {
      kind: 'needs_clarification',
      question: localized(input.locale, {
        pt: 'Encontrei um pedido para criar uma tarefa, mas faltam detalhes seguros. Diz-me o título exato da tarefa.',
        en: 'I found a request to create a task, but I need the exact task title first.',
      }),
      telemetry: {
        ...telemetry,
        finalOutcome: 'needs_clarification',
        reasonCodes: [...telemetry.reasonCodes, 'task_create_unresolved'],
      },
    };
  }
  if (probe.reasonCodes.includes('ambiguous_mutation_intent')) {
    return {
      kind: 'needs_clarification',
      question: localized(input.locale, {
        pt: 'Encontrei um pedido para alterar ou cancelar algo, mas não percebi exatamente o quê. Diz-me qual item.',
        en: 'I found a request to change or cancel something, but I could not tell which item. Tell me which one.',
      }),
      telemetry: {
        ...telemetry,
        finalOutcome: 'needs_clarification',
        reasonCodes: [...telemetry.reasonCodes, 'ambiguous_mutation_unresolved'],
      },
    };
  }
  return {
    kind: 'blocked_legacy_fallback',
    reason: 'unsupported_write_intent_v1',
    telemetry: {
      ...telemetry,
      finalOutcome: 'blocked_legacy_fallback',
      reasonCodes: [...telemetry.reasonCodes, 'unsupported_write_intent_v1'],
    },
  };
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasNegationOrHypothetical(text: string): boolean {
  const normalized = normalizeText(text);
  return NEGATION_RES.some((pattern) => pattern.test(normalized)) || HYPOTHETICAL_RE.test(normalized);
}

function hmacMessageHash(input: {
  text: string;
  tenantId: number;
  userId: number;
  env: NodeJS.ProcessEnv;
}): string {
  const secret = input.env.CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET
    ?? input.env.CLASSIFY_SHADOW_HASH_SECRET
    ?? 'local-dev-chat-core-v2-write-intent-secret';
  return crypto
    .createHmac('sha256', `${secret}:${input.tenantId}:${input.userId}`)
    .update(input.text)
    .digest('hex');
}

function localized(locale: string | null | undefined, copy: { pt: string; en: string }): string {
  return String(locale ?? '').toLowerCase().startsWith('pt') ? copy.pt : copy.en;
}

function logTelemetry(telemetry: ChatCoreV2WriteIntentGuardTelemetry): void {
  logger.info(telemetry, 'Chat Core v2 write intent guard evaluated');
}
