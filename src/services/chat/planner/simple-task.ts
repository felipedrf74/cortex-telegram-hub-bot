// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { DateTime } from 'luxon';

export interface MinimalChatPlannerInput {
  text: string;
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  locale?: string;
  timezone?: string;
  nowIso?: string;
}

export interface MinimalTaskStep {
  action: 'create_task';
  risk: 'safe_write';
  requiredArgsPresent: boolean;
  args: Record<string, unknown>;
  idempotencyKey: string;
}

export function parseSimpleTaskStep(input: MinimalChatPlannerInput, text = input.text): MinimalTaskStep | null {
  const parsed = extractSimpleTaskTitle(text, input);
  if (!parsed) return null;
  if (isUnsafeTaskTitle(parsed.title)) {
    return {
      action: 'create_task',
      risk: 'safe_write',
      requiredArgsPresent: false,
      args: { title: null, rejectedTitle: parsed.title },
      idempotencyKey: stableTaskKey(input, 'create_task_rejected', parsed.title),
    };
  }
  return {
    action: 'create_task',
    risk: 'safe_write',
    requiredArgsPresent: true,
    args: { title: parsed.title, dueDateTime: parsed.dueDateTime },
    idempotencyKey: stableTaskKey(input, 'create_task', `${parsed.title}:${parsed.dueDateTime ?? ''}`),
  };
}

function extractSimpleTaskTitle(text: string, input: MinimalChatPlannerInput): { title: string; dueDateTime: string | null } | null {
  const normalized = text.trim().replace(/\s+/g, ' ');
  const match = normalized.match(/^(?:create|crie|criar|cria|add|adicionar|adicione|crear|crea|agregar|añadir|anadir)\s+(?:a\s+|uma?\s+|una?\s+)?(?:task|tarefa|tarea)\s+(?:called|named|chamada?|chamado|llamada?|llamado|com\s+o\s+t[ií]tulo|con\s+el\s+t[ií]tulo|for\s+|para\s+)?(.+)$/i)
    ?? normalized.match(/^(?:create|crie|criar|cria|add|adicionar|adicione|crear|crea|agregar|añadir|anadir)\s+(.+?)\s+(?:task|tarefa|tarea)$/i);
  const raw = match?.[1]?.trim().replace(/[.!?]+$/g, '');
  if (!raw || /[\n]/.test(raw)) return null;
  const due = extractDueDateTime(raw, input);
  const title = stripDuePhrase(raw).trim();
  if (!title) return null;
  return { title: title.slice(0, 180), dueDateTime: due };
}

function extractDueDateTime(value: string, input: MinimalChatPlannerInput): string | null {
  const zone = input.timezone || 'UTC';
  const now = DateTime.fromISO(input.nowIso ?? new Date().toISOString(), { zone }).isValid
    ? DateTime.fromISO(input.nowIso ?? new Date().toISOString(), { zone })
    : DateTime.now().setZone(zone);
  const match = value.match(/(?:^|\s)(?<date>tomorrow|today|amanh[ãa]|hoje|ma[ñn]ana|hoy)(?=\s|$)(?:\s+(?:at|às?|as|pelas?|a\s+las)\s*)?(?<time>\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i);
  if (!match?.groups) return null;
  const dateWord = match.groups.date.toLowerCase();
  let date = /tomorrow|amanh|ma[ñn]ana/.test(dateWord) ? now.plus({ days: 1 }) : now;
  const timeWord = match.groups.time?.trim();
  if (timeWord) {
    const parsed = parseClock(timeWord);
    date = date.set({ hour: parsed.hour, minute: parsed.minute, second: 0, millisecond: 0 });
  } else {
    date = date.startOf('day');
  }
  return date.toISO({ suppressMilliseconds: false });
}

function parseClock(value: string): { hour: number; minute: number } {
  const normalized = value.toLowerCase().replace(/\s+/g, '');
  const hMatch = normalized.match(/^(\d{1,2})h(\d{2})?$/);
  if (hMatch) return { hour: Number(hMatch[1]), minute: Number(hMatch[2] ?? '0') };
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/);
  if (!match) return { hour: 9, minute: 0 };
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? '0');
  if (match[3] === 'pm' && hour < 12) hour += 12;
  if (match[3] === 'am' && hour === 12) hour = 0;
  return { hour, minute };
}

function stripDuePhrase(value: string): string {
  return value
    .replace(/\s+(?:tomorrow|today|amanh[ãa]|hoje|ma[ñn]ana|hoy)(?=\s|$)(?:\s+(?:at|às?|as|pelas?|a\s+las)\s*)?(?:\d{1,2}h(?:\d{2})?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s*$/i, '')
    .trim();
}

function isUnsafeTaskTitle(title: string): boolean {
  return /<\|im_start\|>|\[INST\]|ignore\s+previous\s+instructions/i.test(title)
    || /\b(delete|remove|erase|wipe|apaga|apagar|elimina|eliminar)\b.*\b(all|every|todos|todas|everything|tasks|tarefas|events|emails?)\b/i.test(title);
}

function stableTaskKey(input: MinimalChatPlannerInput, action: string, title: string): string {
  return crypto
    .createHash('sha256')
    .update(`${input.tenantId}:${input.userId}:${input.conversationId}:${input.messageId}:${action}:${title}`)
    .digest('hex')
    .slice(0, 32);
}
