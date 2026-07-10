// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

export interface SecretaryAgendaStateRevisionInput {
  version: number;
  updatedAt: string;
  sourceShapeHash: string;
  startAt: string | null;
  endAt: string | null;
  lifecycleState: string;
  providerSyncState: string;
  providerEventId: string | null;
  providerSource: string | null;
  decisionAction?: string | null;
  decisionReasonCodes?: unknown;
  decisionExplanation?: string | null;
  scheduledSegments?: unknown;
}

/** Canonical privacy-safe identity of every agenda field material to execution. */
export function secretaryAgendaStateRevision(input: SecretaryAgendaStateRevisionInput): string {
  const materialState = [
    String(input.version),
    input.updatedAt,
    input.sourceShapeHash,
    input.startAt ?? '',
    input.endAt ?? '',
    input.lifecycleState,
    input.providerSyncState,
    input.providerEventId ?? '',
    input.providerSource ?? '',
    input.decisionAction ?? '',
    canonicalJsonValue(input.decisionReasonCodes),
    input.decisionExplanation
      ? createHash('sha256').update(input.decisionExplanation).digest('hex')
      : '',
    canonicalJsonValue(input.scheduledSegments),
  ];
  return `agenda_state_${createHash('sha256').update(JSON.stringify(materialState)).digest('hex').slice(0, 32)}`;
}

function canonicalJsonValue(value: unknown): unknown {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  if (Array.isArray(parsed)) return parsed.map(canonicalJsonValue);
  if (parsed && typeof parsed === 'object') {
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJsonValue(child)]));
  }
  return parsed ?? null;
}
