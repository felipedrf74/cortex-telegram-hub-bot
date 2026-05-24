// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ActionRisk,
  AICommandEnvelope,
  AuditSensitivity,
  CapabilityDefinition,
  CommandStatus,
  UnsupportedReason,
} from './types';

export const CHAT_CORE_V2_RESPONSE_SCHEMA_VERSION = 'chat_response_v2@1.0.0';
export const CHAT_CORE_V2_CARD_SCHEMA_VERSION = 'chat_card_v2@1.0.0';

export type ChatCoreV2Locale = 'en' | 'pt-PT' | 'pt-BR' | 'es';

export type ChatCoreV2ResponseKind =
  | 'message'
  | 'action_preview'
  | 'action_result'
  | 'clarification'
  | 'unsupported';

export type ChatCoreV2ResponseActionKind = 'confirm' | 'cancel' | 'edit' | 'undo' | 'view' | 'retry';

export type ChatCoreV2ResponseActionStyle = 'primary' | 'secondary' | 'destructive' | 'plain';

export type ChatCoreV2ResponseCardType =
  | 'task_preview_card'
  | 'training_change_preview_card'
  | 'finance_action_preview_card'
  | 'multi_step_plan_preview_card'
  | 'notification_preview_card'
  | 'decision_preview_card'
  | 'calendar_change_preview_card'
  | 'grocery_preview_card'
  | 'content_brief_preview_card'
  | 'confirmation_required_card'
  | 'command_result_card'
  | 'partial_failure_card'
  | 'clarification_card';

export interface ChatCoreV2ResponseAction {
  id: string;
  kind: ChatCoreV2ResponseActionKind;
  label: string;
  style: ChatCoreV2ResponseActionStyle;
  confirmationToken?: string;
}

export interface ChatCoreV2ResponseDiffItem {
  label: string;
  before?: string;
  after?: string;
}

export interface ChatCoreV2BaseResponseCard {
  type: ChatCoreV2ResponseCardType;
  version: string;
  title: string;
  summary: string;
  risk: ActionRisk;
  sensitivity: AuditSensitivity;
  capabilityId?: string;
  commandId?: string;
  confirmationToken?: string;
  expiresAt?: string;
  sourceEntityIds: string[];
  diff: ChatCoreV2ResponseDiffItem[];
  primaryAction?: ChatCoreV2ResponseAction;
  secondaryActions: ChatCoreV2ResponseAction[];
}

export interface TaskPreviewCard extends ChatCoreV2BaseResponseCard {
  type: 'task_preview_card';
}

export interface TrainingChangePreviewCard extends ChatCoreV2BaseResponseCard {
  type: 'training_change_preview_card';
}

export interface FinanceActionPreviewCard extends ChatCoreV2BaseResponseCard {
  type: 'finance_action_preview_card';
}

export interface MultiStepPlanPreviewCard extends ChatCoreV2BaseResponseCard {
  type: 'multi_step_plan_preview_card';
}

export interface ConfirmationRequiredCard extends ChatCoreV2BaseResponseCard {
  type: 'confirmation_required_card';
}

export interface CommandResultCard extends ChatCoreV2BaseResponseCard {
  type: 'command_result_card' | 'partial_failure_card';
  status: CommandStatus;
}

export interface ClarificationCard extends ChatCoreV2BaseResponseCard {
  type: 'clarification_card';
  options: string[];
}

export type ChatCoreV2ResponseCard =
  | TaskPreviewCard
  | TrainingChangePreviewCard
  | FinanceActionPreviewCard
  | MultiStepPlanPreviewCard
  | ConfirmationRequiredCard
  | CommandResultCard
  | ClarificationCard
  | ChatCoreV2BaseResponseCard;

export interface ChatCoreV2Response {
  schemaVersion: string;
  kind: ChatCoreV2ResponseKind;
  locale: ChatCoreV2Locale;
  text: string;
  cards: ChatCoreV2ResponseCard[];
  reasonCodes: string[];
}

export type ChatCoreV2ResponseContractIssue =
  | 'missing_title'
  | 'missing_summary'
  | 'missing_card_version'
  | 'missing_primary_action'
  | 'missing_visible_diff'
  | 'unknown_card_type';

export interface ChatCoreV2ResponseContractValidation {
  ok: boolean;
  issues: ChatCoreV2ResponseContractIssue[];
}

interface BuildActionPreviewInput {
  capability: CapabilityDefinition;
  command: Pick<AICommandEnvelope, 'commandId' | 'basedOn'>;
  title: string;
  summary: string;
  locale?: string | null;
  diff?: ChatCoreV2ResponseDiffItem[];
  confirmationToken?: string;
  expiresAt?: string;
}

interface BuildCommandResultInput {
  capability: CapabilityDefinition;
  commandId: string;
  title: string;
  summary: string;
  status: CommandStatus;
  locale?: string | null;
  sourceEntityIds?: string[];
  diff?: ChatCoreV2ResponseDiffItem[];
  undoToken?: string;
}

interface BuildClarificationInput {
  question: string;
  locale?: string | null;
  options?: string[];
  reasonCodes?: string[];
}

interface BuildUnsupportedInput {
  reason: UnsupportedReason;
  locale?: string | null;
  supportedAlternative?: string;
}

const DIFF_REQUIRED_CARD_TYPES = new Set<ChatCoreV2ResponseCardType>([
  'training_change_preview_card',
  'finance_action_preview_card',
  'multi_step_plan_preview_card',
  'calendar_change_preview_card',
]);

const KNOWN_CARD_TYPES: ReadonlySet<ChatCoreV2ResponseCardType> = new Set([
  'task_preview_card',
  'training_change_preview_card',
  'finance_action_preview_card',
  'multi_step_plan_preview_card',
  'notification_preview_card',
  'decision_preview_card',
  'calendar_change_preview_card',
  'grocery_preview_card',
  'content_brief_preview_card',
  'confirmation_required_card',
  'command_result_card',
  'partial_failure_card',
  'clarification_card',
]);

const LABELS: Record<ChatCoreV2Locale, Record<ChatCoreV2ResponseActionKind | 'review_preview' | 'unsupported', string>> = {
  en: {
    confirm: 'Confirm',
    cancel: 'Cancel',
    edit: 'Edit',
    undo: 'Undo',
    view: 'View',
    retry: 'Retry',
    review_preview: 'Review this before I change anything.',
    unsupported: "I can't do that directly yet. I can help prepare the next step instead.",
  },
  'pt-PT': {
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    edit: 'Editar',
    undo: 'Anular',
    view: 'Ver',
    retry: 'Tentar de novo',
    review_preview: 'Revê isto antes de eu alterar alguma coisa.',
    unsupported: 'Ainda não consigo fazer isso diretamente. Posso ajudar a preparar o próximo passo.',
  },
  'pt-BR': {
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    edit: 'Editar',
    undo: 'Desfazer',
    view: 'Ver',
    retry: 'Tentar novamente',
    review_preview: 'Revise isso antes de eu alterar qualquer coisa.',
    unsupported: 'Ainda não consigo fazer isso diretamente. Posso ajudar a preparar o próximo passo.',
  },
  es: {
    confirm: 'Confirmar',
    cancel: 'Cancelar',
    edit: 'Editar',
    undo: 'Deshacer',
    view: 'Ver',
    retry: 'Intentar de nuevo',
    review_preview: 'Revísalo antes de cambiar nada.',
    unsupported: 'Todavía no puedo hacerlo directamente. Puedo ayudarte a preparar el siguiente paso.',
  },
};

export function normalizeChatCoreV2Locale(language: string | null | undefined): ChatCoreV2Locale {
  const normalized = String(language ?? '').trim().toLowerCase();
  if (normalized.startsWith('pt-br')) return 'pt-BR';
  if (normalized.startsWith('pt')) return 'pt-PT';
  if (normalized.startsWith('es')) return 'es';
  return 'en';
}

export function chatCoreV2Label(
  language: string | null | undefined,
  key: ChatCoreV2ResponseActionKind | 'review_preview' | 'unsupported',
): string {
  return LABELS[normalizeChatCoreV2Locale(language)][key];
}

export function buildChatCoreV2ActionPreviewResponse(input: BuildActionPreviewInput): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const { cardType, cardVersion } = parseVersionedCardType(input.capability.previewCardType);
  const requiresConfirmation = input.capability.support.execute === 'supported'
    && input.capability.confirmationPolicy !== 'never_execute';
  const diff = input.diff ?? [];
  const primaryAction = requiresConfirmation
    ? makeAction('confirm', locale, 'primary', input.confirmationToken)
    : makeAction('view', locale, 'primary');
  const secondaryActions = requiresConfirmation
    ? [makeAction('edit', locale, 'secondary'), makeAction('cancel', locale, 'secondary')]
    : [];

  const card: ChatCoreV2BaseResponseCard = {
    type: cardType,
    version: cardVersion,
    title: input.title,
    summary: input.summary,
    risk: input.capability.risk,
    sensitivity: input.capability.sensitivity,
    capabilityId: input.capability.capabilityId,
    commandId: input.command.commandId,
    confirmationToken: input.confirmationToken,
    expiresAt: input.expiresAt,
    sourceEntityIds: [...input.command.basedOn.entityIds],
    diff,
    primaryAction,
    secondaryActions,
  };
  const validation = validateChatCoreV2ResponseCard(card);

  return {
    schemaVersion: CHAT_CORE_V2_RESPONSE_SCHEMA_VERSION,
    kind: 'action_preview',
    locale,
    text: validation.ok ? input.summary : chatCoreV2Label(locale, 'review_preview'),
    cards: [card],
    reasonCodes: validation.issues,
  };
}

export function buildChatCoreV2CommandResultResponse(input: BuildCommandResultInput): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const cardType: ChatCoreV2ResponseCardType = input.status === 'partially_failed'
    ? 'partial_failure_card'
    : 'command_result_card';
  const secondaryActions = input.capability.undoPolicy.supported && input.undoToken
    ? [makeAction('undo', locale, 'secondary', input.undoToken)]
    : [];
  const card: CommandResultCard = {
    type: cardType,
    version: CHAT_CORE_V2_CARD_SCHEMA_VERSION,
    title: input.title,
    summary: input.summary,
    risk: input.capability.risk,
    sensitivity: input.capability.sensitivity,
    capabilityId: input.capability.capabilityId,
    commandId: input.commandId,
    sourceEntityIds: input.sourceEntityIds ?? [],
    diff: input.diff ?? [],
    secondaryActions,
    status: input.status,
  };

  return {
    schemaVersion: CHAT_CORE_V2_RESPONSE_SCHEMA_VERSION,
    kind: 'action_result',
    locale,
    text: input.summary,
    cards: [card],
    reasonCodes: validateChatCoreV2ResponseCard(card).issues,
  };
}

export function buildChatCoreV2ClarificationResponse(input: BuildClarificationInput): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const card: ClarificationCard = {
    type: 'clarification_card',
    version: CHAT_CORE_V2_CARD_SCHEMA_VERSION,
    title: input.question,
    summary: input.question,
    risk: 'low',
    sensitivity: 'personal',
    sourceEntityIds: [],
    diff: [],
    secondaryActions: [],
    options: input.options ?? [],
  };

  return {
    schemaVersion: CHAT_CORE_V2_RESPONSE_SCHEMA_VERSION,
    kind: 'clarification',
    locale,
    text: input.question,
    cards: [card],
    reasonCodes: input.reasonCodes ?? [],
  };
}

export function buildChatCoreV2UnsupportedResponse(input: BuildUnsupportedInput): ChatCoreV2Response {
  const locale = normalizeChatCoreV2Locale(input.locale);
  const baseText = chatCoreV2Label(locale, 'unsupported');
  const text = input.supportedAlternative ? `${baseText} ${input.supportedAlternative}` : baseText;

  return {
    schemaVersion: CHAT_CORE_V2_RESPONSE_SCHEMA_VERSION,
    kind: 'unsupported',
    locale,
    text,
    cards: [],
    reasonCodes: [input.reason],
  };
}

export function validateChatCoreV2ResponseCard(card: ChatCoreV2ResponseCard): ChatCoreV2ResponseContractValidation {
  const issues: ChatCoreV2ResponseContractIssue[] = [];
  if (!KNOWN_CARD_TYPES.has(card.type)) issues.push('unknown_card_type');
  if (!card.version.includes('@')) issues.push('missing_card_version');
  if (!card.title.trim()) issues.push('missing_title');
  if (!card.summary.trim()) issues.push('missing_summary');
  if (card.type !== 'clarification_card' && card.type !== 'command_result_card' && card.type !== 'partial_failure_card') {
    if (!card.primaryAction) issues.push('missing_primary_action');
  }
  if (DIFF_REQUIRED_CARD_TYPES.has(card.type) && card.diff.length === 0) {
    issues.push('missing_visible_diff');
  }

  return {
    ok: issues.length === 0,
    issues,
  };
}

export function chatCoreV2CardTypeRequiresVisibleDiff(cardType: ChatCoreV2ResponseCardType): boolean {
  return DIFF_REQUIRED_CARD_TYPES.has(cardType);
}

function makeAction(
  kind: ChatCoreV2ResponseActionKind,
  locale: ChatCoreV2Locale,
  style: ChatCoreV2ResponseActionStyle,
  confirmationToken?: string,
): ChatCoreV2ResponseAction {
  return {
    id: kind,
    kind,
    label: chatCoreV2Label(locale, kind),
    style,
    confirmationToken,
  };
}

function parseVersionedCardType(value: string | undefined): {
  cardType: ChatCoreV2ResponseCardType;
  cardVersion: string;
} {
  if (!value) return { cardType: 'confirmation_required_card', cardVersion: CHAT_CORE_V2_CARD_SCHEMA_VERSION };
  const [rawType, rawVersion] = value.split('@');
  const cardType = KNOWN_CARD_TYPES.has(rawType as ChatCoreV2ResponseCardType)
    ? rawType as ChatCoreV2ResponseCardType
    : 'confirmation_required_card';
  return {
    cardType,
    cardVersion: rawVersion ? `${rawType}@${rawVersion}` : CHAT_CORE_V2_CARD_SCHEMA_VERSION,
  };
}
