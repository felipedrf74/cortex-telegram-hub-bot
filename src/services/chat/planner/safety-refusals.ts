// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { foldCalendarText } from '../../calendar-natural-language-parser';
import {
  getChatActionRegistry,
  selectRegistrySubsetForMessage,
  type ChatActionName,
  type ChatActionSkill,
} from '../registry';
import type {
  ChatActionPlan,
  ChatPlannerInput,
} from '../types';
import { makeStep } from '../../skills/step-builder';
import {
  buildNeedsInputPlan,
  buildPlanFromSteps,
} from './plan-builder';

// Phase 2 batch 7 (2026-05-15): top-of-planner prompt-injection refusal.
// Emits a refusal-shape step (`requiredArgsPresent: false`,
// `args.rejectedRequest = <original text>`) instead of letting a mutation
// parser claim. The skill+action is inferred from the registry subset so the
// downstream UI surfaces the right card.
export function parsePromptInjectionRefusal(input: ChatPlannerInput): ChatActionPlan | null {
  if (!containsPromptInjectionMarker(input.text)) return null;
  return buildSafetyRefusalPlan(input, 'prompt_injection_marker_detected', [
    'prompt_injection_refusal',
    'deterministic_safety_gate',
  ]);
}

export function parseSensitiveDataExfiltrationRefusal(input: ChatPlannerInput): ChatActionPlan | null {
  if (!containsSensitiveDataExfiltrationRequest(input.text)) return null;
  return buildSafetyRefusalPlan(input, 'sensitive_data_exfiltration_detected', [
    'sensitive_data_exfiltration_refusal',
    'deterministic_safety_gate',
  ], { skill: 'mail', action: 'send_email' });
}

export function parseBulkDestructiveRefusal(input: ChatPlannerInput): ChatActionPlan | null {
  if (!containsBulkDestructiveRequest(input.text)) return null;
  return buildSafetyRefusalPlan(input, 'bulk_destructive_request_detected', [
    'bulk_destructive_refusal',
    'deterministic_safety_gate',
  ], { skill: 'tasks', action: 'delete_task' });
}

export function buildIncompleteCalendarCreatePlan(input: ChatPlannerInput): ChatActionPlan {
  const isPortuguese = input.locale?.startsWith('pt');
  const isSpanish = input.locale?.startsWith('es');
  return buildNeedsInputPlan(input, {
    skill: 'secretary_calendar',
    action: 'schedule_event',
    question: isPortuguese
      ? 'Para agendar isso, preciso do horário e do título do evento.'
      : isSpanish
        ? 'Para programar eso, necesito la hora y el título del evento.'
        : 'To schedule that, I need the event time and title.',
    args: { rawRequest: input.text },
    routingSignals: ['calendar_write_intent_incomplete', 'deterministic_calendar_parser'],
  });
}

function buildSafetyRefusalPlan(
  input: ChatPlannerInput,
  rejectionReason: string,
  routingSignals: string[],
  fallback?: { skill: ChatActionSkill; action: ChatActionName },
): ChatActionPlan | null {
  // Infer the would-be skill from the registry subset. If the subset is empty
  // (the message doesn't look like any action), return null and let the rest
  // of the planner drop the message naturally: there is nothing to refuse.
  const subset = selectRegistrySubsetForMessage(input.text);
  const primary = subset[0] ?? (fallback
    ? getChatActionRegistry().find((entry) => entry.skill === fallback.skill && entry.action === fallback.action)
    : undefined);
  if (!primary) return null;
  const step = makeStep(input, {
    skill: primary.skill,
    action: primary.action,
    risk: 'ambiguous',
    provider: primary.providerDependencies[0] ?? 'nexus',
    args: {
      rejectedRequest: input.text,
      rejectionReason,
      ...(rejectionReason === 'bulk_destructive_request_detected' ? { rejectedTitle: input.text } : {}),
    },
    requiredArgsPresent: false,
  });
  return buildPlanFromSteps(
    input,
    [step],
    routingSignals,
    0.55,
  );
}

function containsSensitiveDataExfiltrationRequest(text: string): boolean {
  const folded = foldCalendarText(text);
  const mailOrExportIntent = /\b(send|draft|email|e-mail|forward|share|export|manda|envia|enviar|encaminha|reenviar)\b/.test(folded);
  const collectionIntent = /\b(all|every|todos|todas|containing|include|inclui|incluir|contendo|contenga|contener)\b/.test(folded);
  const sensitivePayload = /\b(provider\s+tokens?|access\s+tokens?|refresh\s+tokens?|oauth|api\s+keys?|client\s+secrets?|payment\s+confirmations?|stripe\s+receipts?|customer\s+emails?|backup\s+keys?|passwords?|senhas?|credenciais|credentials?)\b/.test(folded);
  return mailOrExportIntent && collectionIntent && sensitivePayload;
}

function containsBulkDestructiveRequest(text: string): boolean {
  const folded = foldCalendarText(text);
  if (/\b(create|add|cria|criar|adiciona|adicionar|crea|crear)\b.*\b(called|named|titled|chamad[oa]|llamad[ao]|titulad[ao])\b/.test(folded)) {
    return false;
  }
  const destructiveVerb = /\b(delete|remove|erase|wipe|cancel|apaga|apagar|elimina|eliminar|borra|borrar|cancela|cancelar)\b/.test(folded);
  const bulkTarget = /\b(every|all|everything|entire|history|todos|todas|todo\s+o|toda\s+a|todos\s+os|todas\s+as|cada|hist[oó]rico|todas\s+las|todos\s+los)\b/.test(folded);
  const object = /\b(tasks?|tarefas?|tareas?|events?|eventos?|calendar|calend[aá]rio|emails?|messages?|mensagens|correos?)\b/.test(folded);
  return destructiveVerb && bulkTarget && object;
}

// Audit §10.1 point 4: prompt-injection markers (LLM-instruction syntax) are
// NOT covered by the literal-title policy. These markers must refuse
// regardless of whether they appear inside a trusted title span. Distinct from
// task-title unsafe checks, which catch destructive natural-language vocabulary.
export function containsPromptInjectionMarker(title: string): boolean {
  return /\bignore\s+(?:previous|all|prior)\s+instructions?\b/i.test(title)
    || /\bignore\s+(?:all\s+)?access\s+checks?\b/i.test(title)
    || /\bbypass\s+(?:all\s+)?access\s+checks?\b/i.test(title)
    || /\benable\s+every\s+skill\b/i.test(title)
    || /\bdisregard\s+(?:previous|all|prior)\s+instructions?\b/i.test(title)
    || /\bforget\s+(?:everything|all|previous|prior)\b/i.test(title)
    || /\b(?:you\s+are\s+now|act\s+as|new\s+instructions)\b/i.test(title)
    || /<\|im_(?:start|end)\|>/i.test(title)
    || /\[\/?(?:INST|SYS|SYSTEM)\]/i.test(title)
    || /<\|(?:system|user|assistant)\|>/i.test(title)
    || /\bsystem\s+prompt\s*:/i.test(title)
    // Phase 2 batch 7 (2026-05-15): Portuguese injection markers. The same
    // refusal contract applies: these phrasings target the LLM rather than
    // describing what the user wants. Limited to forms that are unambiguous
    // attacks (i.e., not casual usage of "ignora" in everyday conversation,
    // which the trailing "instruções/regras/contexto" disambiguates).
    || /\bignor[ae]\s+(?:as\s+|todas\s+as\s+|qualquer\s+)?instru[cç][oõ]es\s+anteriores\b/i.test(title)
    || /\bdesconsiderar?\s+(?:as\s+)?instru[cç][oõ]es\s+(?:anteriores|pr[eé]vias)\b/i.test(title)
    || /\besquec[ae]\s+(?:tudo|as\s+instru[cç][oõ]es|o\s+que\s+eu\s+disse|o\s+contexto)\b/i.test(title)
    || /\bvoc[eê]\s+(?:agora\s+)?[eé]\s+(?:um\s+)?(?:admin|administrador|root)\b/i.test(title)
    || /\bnov[ao]s?\s+instru[cç][oõ]es\s*:/i.test(title)
    || /\bage?\s+como\s+(?:admin|administrador|sistema)\b/i.test(title);
}
