// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type ChatActionSkill =
  | 'secretary_calendar'
  | 'secretary_reminders'
  | 'mail'
  | 'tasks'
  | 'training'
  | 'content'
  | 'cooking'
  | 'finance'
  | 'connections'
  | 'notifications'
  | 'decision_center';

export type ChatActionRisk =
  | 'read_only'
  | 'safe_write'
  | 'external_side_effect'
  | 'destructive'
  | 'financial'
  | 'admin_security'
  | 'ambiguous';

export type ChatActionRiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export type ChatActionName =
  | 'schedule_event'
  | 'update_event'
  | 'move_event'
  | 'delete_event'
  | 'check_calendar_conflicts'
  | 'summarize_agenda'
  | 'set_reminder'
  | 'mail_unread_count'
  | 'mail_inbox_summary'
  | 'draft_email'
  | 'send_email'
  | 'create_task'
  | 'create_task_with_subtasks'
  | 'add_subtasks_to_task'
  | 'update_task'
  | 'complete_task'
  | 'delete_task'
  | 'create_checklist'
  | 'set_task_reminder'
  | 'training_explain_session'
  | 'training_coach_report'
  | 'training_plan_create'
  | 'training_reflow_preview'
  | 'training_reflow_confirm'
  | 'training_adjust_plan'
  | 'content_brief_create'
  | 'content_script_create'
  | 'content_rewrite'
  | 'content_schedule_work'
  | 'content_publish_now'
  | 'content_pipeline_handoff'
  | 'content_pipeline_stage_transition'
  | 'cooking_meal_support'
  | 'cooking_grocery_list'
  | 'cooking_meal_plan'
  | 'cooking_substitute_ingredient'
  | 'cooking_fueling_support'
  | 'finance_summary'
  | 'finance_create_reminder'
  | 'finance_categorize_receipt'
  | 'finance_payment_action'
  | 'connections_status'
  | 'connections_retry_sync'
  | 'connections_reconnect_guidance'
  | 'notification_explain'
  | 'notification_update_preference'
  | 'notification_create_intent'
  | 'decision_choose'
  | 'decision_dismiss'
  | 'decision_snooze'
  | 'decision_follow_up';

export type ChatProvider =
  | 'google_calendar'
  | 'outlook_calendar'
  | 'gmail'
  | 'outlook_mail'
  | 'nexus'
  | 'stripe'
  | 'telegram'
  | 'none';

export type ChatActionStatus = 'active' | 'deprecated' | 'experimental';

export type ChatActionOwner =
  | 'productivity'
  | 'training'
  | 'content'
  | 'finance'
  | 'cooking'
  | 'platform';

export interface ChatSkillMetadata {
  displayName: string;
  responseCardType: string;
  latencyBudgetMs: number;
  privacyPolicy: 'safe_preview' | 'private_detail' | 'sensitive_redacted' | 'owner_admin_only';
}

export interface SlotContext {
  /** BCP-47 locale (e.g. 'en-US', 'pt-BR', 'pt-PT'). */
  locale?: string;
  /** IANA timezone (e.g. 'Europe/Lisbon'). */
  timezone?: string;
  /** ISO timestamp anchoring relative date phrases ("tomorrow", "in 2 weeks"). */
  nowIso?: string;
}

export interface SlotExtractionResult {
  /** Extracted slot name -> value pairs. */
  slots: Record<string, unknown>;
  /** Optional 0-1 confidence for this extraction pass. */
  confidence?: number;
}

export interface SlotExtractor {
  /** Stable identifier (used in telemetry; matches the legacy label). */
  name: string;
  /** Human-readable description. Defaults to name. */
  label?: string;
  /** Run the extraction over raw user text. */
  extract: (text: string, ctx: SlotContext) => SlotExtractionResult;
}

export interface SlotValidationResult {
  ok: boolean;
  /** Per-slot error message (slot-name -> message). */
  errors?: Record<string, string>;
  /** Required slots not present (subset of definition.requiredFields). */
  missing?: string[];
}

export interface SlotValidator {
  /** Stable identifier (used in telemetry; matches the legacy label). */
  name: string;
  /** Human-readable description. Defaults to name. */
  label?: string;
  /** Validate slot values for this action. */
  validate: (slots: Record<string, unknown>, ctx?: SlotContext) => SlotValidationResult;
}

export interface ChatActionDefinition {
  skill: ChatActionSkill;
  action: ChatActionName;
  version?: string;
  status?: ChatActionStatus;
  owner?: ChatActionOwner;
  readableIntents: string[];
  requiredFields: string[];
  optionalFields: string[];
  slotExtractors?: string[];
  slotValidators?: string[];
  /**
   * Phase 11 batch 59 (2026-05-16): typed slot-extractor / slot-validator
   * function refs. Coexist with the legacy string fields above -- when a
   * typed entry is present, helpers prefer it; otherwise the string list
   * still labels the extractor/validator (as it did pre-Phase-11).
   */
  typedSlotExtractors?: SlotExtractor[];
  typedSlotValidators?: SlotValidator[];
  providerDependencies: ChatProvider[];
  risk: ChatActionRisk;
  riskClass?: ChatActionRiskClass;
  confirmationPolicy: 'none' | 'clarify' | 'confirm' | 'strong_confirm';
  /**
   * Exact destructive/external-send grant staged with a confirmation.
   * `tool` is the canonical tool-authorization name and `argumentField` is
   * the planner argument whose value identifies the authorized target.
   * High-risk actions must declare this mapping; missing values fail closed.
   */
  confirmationTarget?: {
    tool: string;
    argumentField: string;
  };
  executionPolicy?: 'read_only' | 'idempotent_write' | 'preview_then_confirm' | 'blocked';
  executor: string;
  /**
   * M16 (multi-step upgrade): entity fields this action's RESULT exposes for
   * cross-step `$ref` chaining, mapped to their path inside the executor's
   * result object (e.g. create_task -> { taskId: 'task.id' } means a later
   * step may reference `step_N.result.task.id`). The segment router uses
   * these declarations — instead of a hardcoded action list — to wire
   * pronoun references ("create X and add IT to my calendar") into $refs,
   * matching a producer's declared outputs against the consumer action's
   * missing required/optional fields. Absent = this action's result exposes
   * no chainable entities.
   */
  outputRefs?: Record<string, string>;
  verifier: 'provider_read_back' | 'local_read_back' | 'none';
  verificationPolicy?: 'provider_readback_required' | 'local_readback_required' | 'not_required';
  uiSurfaces?: string[];
  examples?: Array<{
    text: string;
    /**
     * Supported product-locale cohort used for active evaluation. Input-only
     * compatibility examples leave this unset and declare requestLocale plus
     * responseLocale instead.
     */
    locale?: 'en' | 'pt' | 'mixed';
    /**
     * Language in which the user-authored example is written. Spanish is
     * retained only as an input-routing compatibility signal.
     */
    requestLocale?: 'en' | 'pt' | 'es' | 'mixed';
    /** Supported assistant response language required for this example. */
    responseLocale?: 'en' | 'pt';
    expectedSlots?: Record<string, unknown>;
    expectedAction?: ChatActionName | null;
    tags?: Array<'golden' | 'ambiguous' | 'adversarial' | 'negative' | 'prompt_injection'>;
    condition?: string;
    requiresPendingActionId?: boolean;
    /**
     * Phase 5 batch 25 (2026-05-15): multi-turn examples. When `turns` is
     * provided, it replaces `text` as the canonical sequence of user inputs
     * for this example. `text` remains required for backwards compatibility.
     */
    turns?: string[];
  }>;
  supportedCards: string[];
}
