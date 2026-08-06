// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatActionDefinition,
  ChatActionName,
  ChatActionRiskClass,
  ChatActionSkill,
} from './chat/registry';
import { redactSensitivePromptText, sanitizeLlmPromptValue } from './llm-prompt-safety';

export type LlmSafeRiskLabel = 'safe' | 'sensitive' | 'destructive';

export type LlmSafeSlotType = 'string' | 'datetime' | 'number' | 'enum' | 'boolean';

export interface LlmSafeSlotDescriptor {
  name: string;
  type: LlmSafeSlotType;
  values?: string[];
}

export interface LlmSafeExample {
  text: string;
  locale?: 'en' | 'pt' | 'mixed';
  expectedSlots?: Record<string, unknown>;
}

export interface LlmSafeActionView {
  skill: ChatActionSkill;
  action: ChatActionName;
  description: string;
  readableIntents: string[];
  requiredFields: LlmSafeSlotDescriptor[];
  optionalFields: LlmSafeSlotDescriptor[];
  examples: LlmSafeExample[];
  riskLabel: LlmSafeRiskLabel;
  confirmationRequired: boolean;
}

// Tags whose examples must NOT reach LLM context. prompt_injection and
// adversarial are security-critical (audit §security review). negative and
// ambiguous are test-only fixtures — they document gate-negatives and
// clarification cases for the deterministic planner's shadow parity, not
// canonical user-intent shapes for the LLM to few-shot from. Including them
// would confuse the LLM about what the user typically wants from this action.
// (Phase 2 batch 9, 2026-05-15.)
const FORBIDDEN_EXAMPLE_TAGS = new Set([
  'prompt_injection',
  'adversarial',
  'negative',
  'ambiguous',
]);

export function buildLlmSafePromptSlice(entry: ChatActionDefinition): LlmSafeActionView {
  return {
    skill: entry.skill,
    action: entry.action,
    description: deriveDescription(entry),
    readableIntents: [...entry.readableIntents],
    requiredFields: entry.requiredFields.map((field) => describeSlot(field, entry.action)),
    optionalFields: entry.optionalFields.map((field) => describeSlot(field, entry.action)),
    examples: filterAndStripExamples(entry.examples),
    riskLabel: riskLabelForRiskClass(deriveRiskClass(entry)),
    confirmationRequired: entry.confirmationPolicy !== 'none',
  };
}

function deriveDescription(entry: ChatActionDefinition): string {
  // `skill` is already a sibling field in every serialized action view, so
  // repeating it here spends prompt budget without adding routing context.
  return entry.action.replace(/_/g, ' ');
}

function describeSlot(name: string, action: ChatActionName): LlmSafeSlotDescriptor {
  if (
    name === 'startDateTime' ||
    name === 'endDateTime' ||
    name === 'dueDateTime' ||
    name === 'startDate' ||
    name === 'until' ||
    name === 'reminderAt' ||
    name === 'date' ||
    name === 'dateTime' ||
    name === 'dueDate' ||
    name === 'scheduledDateTime'
  ) {
    return { name, type: 'datetime' };
  }
  if (name === 'priority' && action.includes('task')) {
    return { name, type: 'enum', values: ['low', 'normal', 'high'] };
  }
  if (
    name === 'durationWeeks' ||
    name === 'sessionsPerWeek' ||
    name === 'amount' ||
    name === 'limit'
  ) {
    return { name, type: 'number' };
  }
  if (name === 'startPolicy') {
    return { name, type: 'enum', values: ['today', 'next_full_week'] };
  }
  if (name === 'provider') {
    return {
      name,
      type: 'enum',
      values: ['google_calendar', 'outlook_calendar', 'gmail', 'outlook_mail', 'nexus'],
    };
  }
  return { name, type: 'string' };
}

type RawExample = NonNullable<ChatActionDefinition['examples']>[number] & {
  locale?: LlmSafeExample['locale'];
  tags?: string[];
};

function filterAndStripExamples(examples: ChatActionDefinition['examples']): LlmSafeExample[] {
  if (!examples || examples.length === 0) return [];
  const out: LlmSafeExample[] = [];
  for (const example of examples) {
    const raw = example as RawExample;
    const tags = Array.isArray(raw.tags) ? raw.tags : [];
    if (tags.some((tag) => FORBIDDEN_EXAMPLE_TAGS.has(tag))) continue;
    const safe: LlmSafeExample = { text: redactSensitivePromptText(raw.text) };
    if (raw.locale) safe.locale = raw.locale;
    if (raw.expectedSlots && typeof raw.expectedSlots === 'object') {
      safe.expectedSlots = sanitizeLlmPromptValue(raw.expectedSlots) as Record<string, unknown>;
    }
    out.push(safe);
  }
  return out;
}

function deriveRiskClass(entry: ChatActionDefinition): ChatActionRiskClass {
  if (entry.riskClass) return entry.riskClass;
  if (entry.risk === 'read_only') return 'R0';
  if (entry.risk === 'safe_write') return 'R1';
  if (entry.risk === 'external_side_effect') return 'R2';
  if (
    entry.risk === 'destructive' ||
    entry.risk === 'financial' ||
    entry.risk === 'admin_security'
  ) {
    return 'R3';
  }
  return 'R4';
}

function riskLabelForRiskClass(rc: ChatActionRiskClass): LlmSafeRiskLabel {
  if (rc === 'R0' || rc === 'R1') return 'safe';
  if (rc === 'R2') return 'sensitive';
  return 'destructive';
}
