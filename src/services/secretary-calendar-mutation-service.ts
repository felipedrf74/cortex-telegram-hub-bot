// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { buildNormalizedDecisionAction } from './decision-action-contract';
import { evaluateDecisionConflicts, type ConflictComparisonAction } from './decision-conflict-evaluator';
import { createDecisionIntent } from './decision-center';
import {
  findSecretaryCalendarLedgerMutationTarget,
  SecretaryCalendarLedgerMutationError,
  settleSecretaryCalendarLedgerDelete,
  settleSecretaryCalendarLedgerUpdate,
  stageSecretaryCalendarLedgerDelete,
  stageSecretaryCalendarLedgerUpdate,
  type SecretaryCalendarLedgerMutationTarget,
} from './secretary-calendar-ledger-mutation';
import {
  claimSecretaryCalendarMutation,
  getSecretaryCalendarMutationReceipt,
  releaseSecretaryCalendarMutationProcessingLease,
  updateSecretaryCalendarMutationReceipt,
  type SecretaryCalendarMutationReceipt,
} from './secretary-calendar-mutation-store';
import {
  syncSecretaryAgendaItemsToProvider,
  type SecretaryAgendaProviderAdapter,
  type SecretaryProviderEventInput,
} from './secretary-agenda-provider-sync';
import {
  localConflictAsUnifiedCalendarEvent,
  readSecretaryLocalCalendarConflicts,
} from './secretary-local-calendar-conflicts';
import { createUnifiedCalendarSecretaryProviderAdapter } from './secretary-unified-calendar-provider-adapter';
import {
  deleteEvent,
  eventFingerprint,
  getEventById,
  getEventsWithDiagnostics,
  updateEvent,
  type CalendarSource,
  type UnifiedCalendarEvent,
  type UnifiedCalendarFetchResult,
} from './unified-calendar';
import { logger } from '../utils/logger';

const RECEIPT_RETENTION_DAYS = 30;
const MAX_KEY_LENGTH = 200;
const MAX_EVENT_ID_LENGTH = 500;
const MAX_TITLE_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 10_000;
const IDEMPOTENCY_KEY_PATTERN = /^[^\u0000-\u001f\u007f]+$/;

export interface SecretaryCalendarMutationInput {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  operation: 'update' | 'delete';
  source: CalendarSource;
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  description?: string;
  timezone: string;
  channel: 'rest' | 'ios' | 'chat';
  nowIso?: string;
}

export interface SecretaryCalendarMutationResult {
  status: 'succeeded' | 'review_required';
  replayed: boolean;
  event?: UnifiedCalendarEvent;
  deleted?: boolean;
  warningCodes: string[];
}

export interface SecretaryCalendarMutationIo {
  getEventById(eventId: string, source: CalendarSource, userId: number): Promise<UnifiedCalendarEvent | null>;
  getEventsWithDiagnostics(
    start: string,
    end: string,
    userId: number,
    options?: { sources?: CalendarSource[] },
  ): Promise<UnifiedCalendarFetchResult>;
  updateEvent(
    data: { event_id: string; new_start?: string; new_end?: string; new_title?: string; new_description?: string },
    source: CalendarSource,
    userId: number,
    options?: { signal?: AbortSignal },
  ): Promise<UnifiedCalendarEvent>;
  deleteEvent(
    eventId: string,
    source: CalendarSource,
    userId: number,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

export interface SecretaryCalendarMutationOptions {
  calendarIo?: SecretaryCalendarMutationIo;
  configuredSources?: CalendarSource[];
  providerAdapter?: SecretaryAgendaProviderAdapter;
}

export class SecretaryCalendarMutationError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'TENANT_SCOPE_MISMATCH'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'CALENDAR_EVENT_NOT_FOUND'
      | 'CALENDAR_CONFLICT_STATE_UNKNOWN'
      | 'CALENDAR_DECISION_REVIEW_PENDING'
      | 'CALENDAR_PROVIDER_WRITE_FAILED'
      | 'CALENDAR_SYNC_PENDING',
    message: string,
    readonly status: number,
    readonly warningCodes: string[] = [],
  ) {
    super(message);
    this.name = 'SecretaryCalendarMutationError';
  }
}

let legacyMissingKeyCount = 0;

export function noteLegacySecretaryCalendarMutationWithoutKey(operation: 'update' | 'delete'): void {
  legacyMissingKeyCount += 1;
  logger.warn({
    event: 'secretary.calendar_mutation.legacy_missing_idempotency_key',
    operation,
    legacyMissingKeyCount,
  }, 'Calendar mutation used the one-release missing Idempotency-Key compatibility path');
}

export function getSecretaryCalendarMutationMetrics(): { legacyMissingKeyCount: number } {
  return { legacyMissingKeyCount };
}

export function resetSecretaryCalendarMutationMetricsForTests(): void {
  legacyMissingKeyCount = 0;
}

export interface SecretaryCalendarMutationReplayProbe {
  /** Terminal replay result, or null when the durable receipt still needs reconciliation. */
  result: SecretaryCalendarMutationResult | null;
}

/**
 * Read-only receipt inspection for transport capability gates. The probe is
 * non-null for every matching, unexpired receipt, including nonterminal rows,
 * so a same-key retry can reach the service after provider disconnection.
 */
export function inspectSecretaryCalendarMutationReplay(
  rawInput: SecretaryCalendarMutationInput,
): SecretaryCalendarMutationReplayProbe | null {
  const input = normalizeInput(rawInput);
  const receipt = getSecretaryCalendarMutationReceipt({
    userId: input.userId,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
  });
  if (!receipt || Date.parse(receipt.expiresAt) <= resolveNow(input.nowIso).toMillis()) return null;
  assertMatchingReceipt(receipt, requestHash(input));
  return { result: replayReceipt(receipt) };
}

export async function executeSecretaryCalendarMutation(
  rawInput: SecretaryCalendarMutationInput,
  options: SecretaryCalendarMutationOptions = {},
): Promise<SecretaryCalendarMutationResult> {
  let input = normalizeInput(rawInput);
  const hash = requestHash(input);
  const now = resolveNow(input.nowIso);
  const scope = {
    userId: input.userId,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    requestHash: hash,
  };
  const claimed = claimSecretaryCalendarMutation({
    ...scope,
    operation: input.operation,
    providerSource: input.source,
    providerEventId: input.eventId,
    command: commandPayload(input),
    nowIso: now.toISO()!,
    expiresAt: now.plus({ days: RECEIPT_RETENTION_DAYS }).toISO()!,
  });
  assertMatchingReceipt(claimed.receipt, hash);
  const receiptTimezone = claimed.receipt.command.timezone;
  if (!claimed.created
    && typeof receiptTimezone === 'string'
    && IANAZone.isValidZone(receiptTimezone)) {
    input = { ...input, timezone: receiptTimezone };
  }
  const replay = replayReceipt(claimed.receipt);
  if (replay) return replay;
  const leaseToken = claimed.leaseToken;
  if (!claimed.acquired || !leaseToken) {
    throw new SecretaryCalendarMutationError(
      'CALENDAR_SYNC_PENDING',
      'This calendar mutation is already being processed; no duplicate write was issued.',
      409,
      ['CALENDAR_SYNC_PENDING', 'CALENDAR_MUTATION_LEASE_HELD'],
    );
  }
  const leasedScope = { ...scope, leaseToken };
  try {
    const recoveringWrite = claimed.receipt.state === 'write_pending';

  const io = options.calendarIo ?? defaultCalendarIo;
  const ledgerTarget = resolveLedgerTarget(input);
  const current = await readExactEvent(input, io);
  if (input.operation === 'delete' && !current) {
    if (!ledgerTarget) {
      return completeMutation(input, leasedScope, { deleted: true }, !claimed.created, recoveringWrite);
    }
    const staged = stageLedgerDelete(input, ledgerTarget, now.toISO()!);
    settleLedgerDelete(input, staged.agendaItem.agendaItemId, now.toISO()!);
    return completeMutation(input, leasedScope, { deleted: true }, !claimed.created, true);
  }
  if (!current) {
    throw new SecretaryCalendarMutationError(
      'CALENDAR_EVENT_NOT_FOUND',
      'The calendar event could not be found, so nothing was changed.',
      404,
    );
  }

  if (input.operation === 'update') {
    const desired = desiredEventState(input, current);
    if (eventMatchesDesiredState(current, desired)) {
      if (!ledgerTarget) {
        return completeMutation(input, leasedScope, { event: current }, !claimed.created, recoveringWrite);
      }
      const staged = stageLedgerUpdate(input, ledgerTarget, desired, hash, now.toISO()!);
      settleLedgerUpdate(input, staged.agendaItem.agendaItemId, now.toISO()!);
      return completeMutation(
        input,
        leasedScope,
        { event: current },
        !claimed.created,
        staged.changed || recoveringWrite,
      );
    }
    if (input.start && input.end) {
      const snapshot = await readConflictSnapshot(input, io, options.configuredSources);
      const localSnapshot = readSecretaryLocalCalendarConflicts({
        userId: input.userId,
        tenantId: input.tenantId,
        start: input.start,
        end: input.end,
        excludeAgendaItemId: ledgerTarget?.agendaItem.agendaItemId,
      });
      if (localSnapshot.status !== 'ready') throw conflictUnknown(localSnapshot.warningCodes);
      const conflicts = dedupeConflictEvents([
        ...snapshot.events,
        ...localSnapshot.conflicts.map((conflict) =>
          localConflictAsUnifiedCalendarEvent(conflict, input.source)),
      ])
        .filter((event) => !representsCurrentProviderEvent(event, current, input.source, input.eventId))
        .filter((event) => event.blocksTime !== false)
        .filter((event) => overlaps(input.start!, input.end!, event.start, event.end));
      if (conflicts.length > 0) {
        await ensureMutationConflictReview(input, hash, conflicts, now.toISO()!);
        const response = { status: 'review_required', warningCodes: ['CALENDAR_CONFLICT_REVIEW_REQUIRED'] };
        // Terminal receipt publication follows cache invalidation. This makes
        // a replayable review receipt proof that planning readers cannot still
        // observe the pre-review state after a process crash.
        invalidateCalendarCaches(input.userId);
        updateSecretaryCalendarMutationReceipt(leasedScope, {
          state: 'review_required',
          response,
          updatedAt: DateTime.utc().toISO()!,
        });
        return {
          status: 'review_required',
          replayed: false,
          warningCodes: ['CALENDAR_CONFLICT_REVIEW_REQUIRED'],
        };
      }
    }
  }

  updateSecretaryCalendarMutationReceipt(leasedScope, {
    state: 'write_pending',
    updatedAt: DateTime.utc().toISO()!,
  });
  if (ledgerTarget) {
    const agendaItemId = input.operation === 'update'
      ? stageLedgerUpdate(
          input,
          ledgerTarget,
          desiredEventState(input, current),
          hash,
          now.toISO()!,
        ).agendaItem.agendaItemId
      : stageLedgerDelete(input, ledgerTarget, now.toISO()!).agendaItem.agendaItemId;
    await syncLedgerMutation(
      input,
      agendaItemId,
      options.calendarIo ? io : null,
      options.providerAdapter,
    );
  } else {
    try {
      if (input.operation === 'update') {
        await io.updateEvent({
          event_id: input.eventId,
          new_title: input.title,
          new_start: input.start,
          new_end: input.end,
          new_description: input.description,
        }, input.source, input.userId);
      } else {
        await io.deleteEvent(input.eventId, input.source, input.userId);
      }
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
        userId: input.userId,
        source: input.source,
        operation: input.operation,
      }, 'Secretary calendar mutation provider write did not complete cleanly');
      throw new SecretaryCalendarMutationError(
        'CALENDAR_PROVIDER_WRITE_FAILED',
        'The calendar provider did not confirm the mutation. Retry with the same Idempotency-Key.',
        502,
        ['CALENDAR_PROVIDER_WRITE_FAILED'],
      );
    }
  }

  let readback: UnifiedCalendarEvent | null;
  try {
    readback = await readExactEvent(input, io);
  } catch (error) {
    if (error instanceof SecretaryCalendarMutationError
      && error.code === 'CALENDAR_CONFLICT_STATE_UNKNOWN') {
      throw syncPending();
    }
    throw error;
  }
  if (input.operation === 'delete') {
    if (readback) throw syncPending();
    if (ledgerTarget) settleLedgerDelete(input, ledgerTarget.agendaItem.agendaItemId, DateTime.utc().toISO()!);
    return completeMutation(input, leasedScope, { deleted: true }, false);
  }
  const desired = desiredEventState(input, current);
  if (!readback || !eventMatchesDesiredState(readback, desired)) throw syncPending();
  if (ledgerTarget) settleLedgerUpdate(input, ledgerTarget.agendaItem.agendaItemId, DateTime.utc().toISO()!);
    return completeMutation(input, leasedScope, { event: readback }, false);
  } finally {
    try {
      releaseSecretaryCalendarMutationProcessingLease({
        userId: input.userId,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        leaseToken,
      });
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
        userId: input.userId,
      }, 'Secretary calendar mutation lease release failed; expiry will recover it');
    }
  }
}

const defaultCalendarIo: SecretaryCalendarMutationIo = {
  getEventById: (eventId, source, userId) => getEventById(eventId, source, userId),
  getEventsWithDiagnostics: (start, end, userId, options) =>
    getEventsWithDiagnostics(start, end, userId, options),
  updateEvent: (data, source, userId, options) => updateEvent(data, source, userId, options),
  deleteEvent: (eventId, source, userId, options) => deleteEvent(eventId, source, userId, options),
};

function resolveLedgerTarget(
  input: ReturnType<typeof normalizeInput>,
): SecretaryCalendarLedgerMutationTarget | null {
  try {
    return findSecretaryCalendarLedgerMutationTarget({
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerSource: input.source,
      providerEventId: input.eventId,
    });
  } catch (error) {
    throw ledgerMutationError(error);
  }
}

function stageLedgerUpdate(
  input: ReturnType<typeof normalizeInput>,
  target: SecretaryCalendarLedgerMutationTarget,
  desired: ReturnType<typeof desiredEventState>,
  hash: string,
  nowIso: string,
): ReturnType<typeof stageSecretaryCalendarLedgerUpdate> {
  try {
    return stageSecretaryCalendarLedgerUpdate({
      target,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerSource: input.source,
      providerEventId: input.eventId,
      requestHash: hash,
      title: desired.title,
      start: desired.start,
      end: desired.end,
      description: input.description,
      nowIso,
    });
  } catch (error) {
    throw ledgerMutationError(error);
  }
}

function stageLedgerDelete(
  input: ReturnType<typeof normalizeInput>,
  target: SecretaryCalendarLedgerMutationTarget,
  nowIso: string,
): ReturnType<typeof stageSecretaryCalendarLedgerDelete> {
  try {
    return stageSecretaryCalendarLedgerDelete({
      target,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerSource: input.source,
      providerEventId: input.eventId,
      nowIso,
    });
  } catch (error) {
    throw ledgerMutationError(error);
  }
}

function settleLedgerUpdate(
  input: ReturnType<typeof normalizeInput>,
  agendaItemId: string,
  nowIso: string,
): void {
  try {
    settleSecretaryCalendarLedgerUpdate({
      agendaItemId,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerSource: input.source,
      providerEventId: input.eventId,
      feedbackKey: requestHash(input),
      nowIso,
    });
  } catch {
    throw syncPending();
  }
}

function settleLedgerDelete(
  input: ReturnType<typeof normalizeInput>,
  agendaItemId: string,
  nowIso: string,
): void {
  try {
    settleSecretaryCalendarLedgerDelete({
      agendaItemId,
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      providerSource: input.source,
      providerEventId: input.eventId,
      feedbackKey: requestHash(input),
      nowIso,
    });
  } catch {
    throw syncPending();
  }
}

async function syncLedgerMutation(
  input: ReturnType<typeof normalizeInput>,
  agendaItemId: string,
  injectedIo: SecretaryCalendarMutationIo | null,
  providerAdapter: SecretaryAgendaProviderAdapter | undefined,
): Promise<void> {
  const adapter = providerAdapter
    ?? (injectedIo
      ? createInjectedLedgerProviderAdapter(input.source, injectedIo)
      : createUnifiedCalendarSecretaryProviderAdapter(input.source));
  let results: Awaited<ReturnType<typeof syncSecretaryAgendaItemsToProvider>>;
  try {
    results = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      includeInactive: true,
    }, adapter, { agendaItemId });
  } catch (error) {
    logger.warn({
      errorName: error instanceof Error ? error.name : typeof error,
      userId: input.userId,
      source: input.source,
      operation: input.operation,
    }, 'Secretary agenda provider mutation did not complete cleanly');
    throw new SecretaryCalendarMutationError(
      'CALENDAR_PROVIDER_WRITE_FAILED',
      'The calendar provider did not confirm the mutation. Retry with the same Idempotency-Key.',
      502,
      ['CALENDAR_PROVIDER_WRITE_FAILED'],
    );
  }
  const result = results.find((entry) => entry.agendaItemId === agendaItemId);
  if (!result) throw syncPending();
  if (input.operation === 'update' && result.providerSyncState === 'synced') return;
  if (input.operation === 'delete' && result.providerSyncState === 'deleted') return;
  if (result.providerSyncState === 'readback_failed') throw syncPending();
  throw new SecretaryCalendarMutationError(
    'CALENDAR_PROVIDER_WRITE_FAILED',
    'The calendar provider did not confirm the mutation. Retry with the same Idempotency-Key.',
    502,
    ['CALENDAR_PROVIDER_WRITE_FAILED'],
  );
}

function createInjectedLedgerProviderAdapter(
  source: CalendarSource,
  io: SecretaryCalendarMutationIo,
): SecretaryAgendaProviderAdapter {
  const providerEvent = (event: UnifiedCalendarEvent, input: SecretaryProviderEventInput) => ({
    eventId: event.id,
    source,
    agendaItemId: input.agendaItemId,
    title: event.summary,
    startAt: event.start,
    endAt: event.end,
    version: input.version,
  });
  return {
    source,
    createEvent: async () => {
      throw Object.assign(new Error('CALENDAR_MUTATION_CANNOT_RECREATE_EVENT'), {
        code: 'PROVIDER_VALIDATION_FAILED',
      });
    },
    updateEvent: async (eventId, input) => providerEvent(await io.updateEvent({
      event_id: eventId,
      new_title: input.title,
      new_start: input.startAt,
      new_end: input.endAt,
      new_description: input.description,
    }, source, input.ownerUserId), input),
    deleteEvent: (eventId, input) => {
      if (!input) throw new Error('CALENDAR_MUTATION_DELETE_SCOPE_MISSING');
      return io.deleteEvent(eventId, source, input.ownerUserId);
    },
    getEvent: async (eventId, input) => {
      if (!input) return { status: 'unknown', reasonCode: 'provider_exact_read_scope_missing' };
      try {
        const event = await io.getEventById(eventId, source, input.ownerUserId);
        return event
          ? { status: 'found', event: providerEvent(event, input) }
          : { status: 'not_found' };
      } catch {
        return { status: 'unknown', reasonCode: 'provider_exact_read_failed' };
      }
    },
  };
}

function ledgerMutationError(error: unknown): SecretaryCalendarMutationError {
  if (error instanceof SecretaryCalendarLedgerMutationError
    && error.code === 'TITLE_NOT_OWNED') {
    return new SecretaryCalendarMutationError(
      'INVALID_INPUT',
      error.message,
      422,
      ['CALENDAR_TITLE_SOURCE_OWNED'],
    );
  }
  if (error instanceof SecretaryCalendarLedgerMutationError
    && error.code === 'DESCRIPTION_NOT_OWNED') {
    return new SecretaryCalendarMutationError(
      'INVALID_INPUT',
      error.message,
      422,
      ['CALENDAR_DESCRIPTION_SOURCE_OWNED'],
    );
  }
  return conflictUnknown([
    'CALENDAR_CONFLICT_STATE_UNKNOWN',
    error instanceof SecretaryCalendarLedgerMutationError
      ? `CALENDAR_LEDGER_${error.code}`
      : 'CALENDAR_LEDGER_RECONCILIATION_FAILED',
  ]);
}

function normalizeInput(input: SecretaryCalendarMutationInput): SecretaryCalendarMutationInput & { tenantId: string } {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) invalid('userId must be a positive integer.');
  const tenantId = String(input.tenantId ?? '').trim();
  if (!tenantId || tenantId !== String(input.userId)) {
    throw new SecretaryCalendarMutationError(
      'TENANT_SCOPE_MISMATCH',
      'The active tenant does not match the authenticated user.',
      403,
    );
  }
  if (typeof input.idempotencyKey !== 'string') invalid('Idempotency-Key must be a string.');
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey || idempotencyKey.length > MAX_KEY_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    invalid(`Idempotency-Key must contain 1-${MAX_KEY_LENGTH} characters.`);
  }
  if (input.operation !== 'update' && input.operation !== 'delete') invalid('operation must be update or delete.');
  if (input.source !== 'google' && input.source !== 'outlook') invalid('source must be google or outlook.');
  if (typeof input.eventId !== 'string') invalid('eventId must be a string.');
  const eventId = input.eventId.trim();
  if (!eventId || eventId.length > MAX_EVENT_ID_LENGTH) {
    invalid(`eventId must contain 1-${MAX_EVENT_ID_LENGTH} characters.`);
  }
  if (typeof input.timezone !== 'string' || !IANAZone.isValidZone(input.timezone.trim())) {
    invalid('timezone must be a valid IANA zone.');
  }
  if (!['rest', 'ios', 'chat'].includes(input.channel)) invalid('channel must be rest, ios, or chat.');
  const title = cleanOptional(input.title, 'title', MAX_TITLE_LENGTH);
  const description = cleanOptional(input.description, 'description', MAX_DESCRIPTION_LENGTH, true);
  const hasStart = input.start != null;
  const hasEnd = input.end != null;
  if (hasStart !== hasEnd) invalid('start and end must be supplied together.');
  const range = hasStart && hasEnd ? normalizeRange(input.start, input.end) : null;
  if (input.operation === 'delete' && (title != null || description != null || range != null)) {
    invalid('delete does not accept title, description, start, or end changes.');
  }
  if (input.operation === 'update' && title == null && description == null && range == null) {
    invalid('update requires title, description, or a complete start/end range.');
  }
  const normalized = {
    ...input,
    tenantId,
    idempotencyKey,
    source: input.source,
    eventId,
    timezone: input.timezone.trim(),
    title,
    description,
    start: range?.start,
    end: range?.end,
  };
  const bytes = Buffer.byteLength(stableStringify(commandPayload(normalized)), 'utf8');
  if (bytes > 16 * 1024) invalid('calendar mutation payload must be 16 KiB or less.');
  return normalized;
}

function cleanOptional(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  const clean = value.trim();
  if (!clean && !allowEmpty) invalid(`${label} must not be empty.`);
  if (clean.length > maxLength) invalid(`${label} must contain at most ${maxLength} characters.`);
  return clean;
}

function normalizeRange(start: unknown, end: unknown): { start: string; end: string } {
  if (typeof start !== 'string' || typeof end !== 'string' || !start.includes('T') || !end.includes('T')) {
    invalid('start and end must be ISO 8601 timestamp strings.');
  }
  const startDate = DateTime.fromISO(start, { setZone: true });
  const endDate = DateTime.fromISO(end, { setZone: true });
  if (!startDate.isValid || !endDate.isValid || endDate.toMillis() <= startDate.toMillis()) {
    invalid('start and end must be valid timestamps with end after start.');
  }
  if (endDate.toMillis() - startDate.toMillis() > 24 * 60 * 60 * 1_000) {
    invalid('event duration must be 24 hours or less.');
  }
  return { start: startDate.toUTC().toISO()!, end: endDate.toUTC().toISO()! };
}

function invalid(message: string): never {
  throw new SecretaryCalendarMutationError('INVALID_INPUT', message, 400);
}

function commandPayload(input: SecretaryCalendarMutationInput): Record<string, unknown> {
  return {
    operation: input.operation,
    source: input.source,
    eventId: input.eventId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.start !== undefined ? { start: input.start } : {}),
    ...(input.end !== undefined ? { end: input.end } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    timezone: input.timezone,
    channel: input.channel,
  };
}

function requestHash(input: SecretaryCalendarMutationInput): string {
  const {
    channel: _transportChannel,
    timezone: _serverResolvedTimezone,
    ...logicalCommand
  } = commandPayload(input);
  return createHash('sha256').update(stableStringify(logicalCommand)).digest('hex');
}

function assertMatchingReceipt(receipt: SecretaryCalendarMutationReceipt, hash: string): void {
  if (receipt.requestHash === hash) return;
  throw new SecretaryCalendarMutationError(
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used for different calendar content.',
    409,
  );
}

function replayReceipt(receipt: SecretaryCalendarMutationReceipt): SecretaryCalendarMutationResult | null {
  if ((receipt.state !== 'succeeded' && receipt.state !== 'review_required') || !receipt.response) return null;
  return {
    status: receipt.state === 'review_required' ? 'review_required' : 'succeeded',
    replayed: true,
    event: isEvent(receipt.response.event) ? receipt.response.event : undefined,
    deleted: receipt.response.deleted === true ? true : undefined,
    warningCodes: Array.isArray(receipt.response.warningCodes)
      ? receipt.response.warningCodes.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

function completeMutation(
  input: ReturnType<typeof normalizeInput>,
  scope: {
    userId: number;
    tenantId: string;
    idempotencyKey: string;
    requestHash: string;
    leaseToken: string;
  },
  result: { event?: UnifiedCalendarEvent; deleted?: boolean },
  replayed: boolean,
  invalidate = true,
): SecretaryCalendarMutationResult {
  const safeResult = {
    ...(result.event ? { event: publicMutationEvent(result.event) } : {}),
    ...(result.deleted === true ? { deleted: true } : {}),
  };
  const response = { status: 'succeeded', ...safeResult, warningCodes: [] };
  if (invalidate) invalidateCalendarCaches(input.userId);
  updateSecretaryCalendarMutationReceipt(scope, {
    state: 'succeeded',
    response,
    updatedAt: DateTime.utc().toISO()!,
  });
  return { status: 'succeeded', replayed, ...safeResult, warningCodes: [] };
}

function publicMutationEvent(event: UnifiedCalendarEvent): UnifiedCalendarEvent {
  const syncedSources = [...new Set(
    (event.syncedSources ?? [event.source])
      .filter((source): source is CalendarSource => source === 'google' || source === 'outlook'),
  )];
  return {
    id: event.id,
    source: event.source,
    syncedSources: syncedSources.length > 0 ? syncedSources : [event.source],
    summary: event.summary,
    start: event.start,
    end: event.end,
    ...(event.description ? { description: event.description } : {}),
    ...(event.location ? { location: event.location } : {}),
    ...(event.categories?.length ? { categories: event.categories } : {}),
    ...(event.color ? { color: event.color } : {}),
    ...(event.isAllDay !== undefined ? { isAllDay: event.isAllDay } : {}),
    ...(event.timeZone ? { timeZone: event.timeZone } : {}),
    ...(event.blocksTime !== undefined ? { blocksTime: event.blocksTime } : {}),
  };
}

async function readExactEvent(
  input: ReturnType<typeof normalizeInput>,
  io: SecretaryCalendarMutationIo,
): Promise<UnifiedCalendarEvent | null> {
  try {
    return await io.getEventById(input.eventId, input.source, input.userId);
  } catch {
    throw new SecretaryCalendarMutationError(
      'CALENDAR_CONFLICT_STATE_UNKNOWN',
      'The current provider event state could not be verified, so nothing was written.',
      409,
      ['CALENDAR_CONFLICT_STATE_UNKNOWN'],
    );
  }
}

async function readConflictSnapshot(
  input: ReturnType<typeof normalizeInput>,
  io: SecretaryCalendarMutationIo,
  configuredSources: CalendarSource[] | undefined,
): Promise<UnifiedCalendarFetchResult> {
  let snapshot: UnifiedCalendarFetchResult;
  try {
    snapshot = await io.getEventsWithDiagnostics(
      input.start!,
      input.end!,
      input.userId,
      configuredSources?.length ? { sources: configuredSources } : undefined,
    );
  } catch {
    throw conflictUnknown(['CALENDAR_CONFLICT_STATE_UNKNOWN']);
  }
  const expected = new Set<CalendarSource>([
    input.source,
    ...(configuredSources ?? []),
    ...snapshot.sources.configured,
  ]);
  const fulfilled = new Set(snapshot.sources.fulfilled);
  if (snapshot.status !== 'ready'
    || snapshot.sources.failed.length > 0
    || [...expected].some((source) => !fulfilled.has(source))) {
    throw conflictUnknown([
      'CALENDAR_CONFLICT_STATE_UNKNOWN',
      'CALENDAR_SOURCE_COVERAGE_INCOMPLETE',
      ...snapshot.warningCodes,
    ]);
  }
  return snapshot;
}

function conflictUnknown(warningCodes: string[]): SecretaryCalendarMutationError {
  return new SecretaryCalendarMutationError(
    'CALENDAR_CONFLICT_STATE_UNKNOWN',
    'Calendar availability could not be verified, so nothing was written.',
    409,
    [...new Set(warningCodes)],
  );
}

function desiredEventState(
  input: ReturnType<typeof normalizeInput>,
  current: UnifiedCalendarEvent,
): { title: string; start: string; end: string; description?: string } {
  return {
    title: input.title ?? current.summary,
    start: input.start ?? current.start,
    end: input.end ?? current.end,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
}

function eventMatchesDesiredState(
  event: UnifiedCalendarEvent,
  desired: { title: string; start: string; end: string; description?: string },
): boolean {
  return event.summary.trim() === desired.title.trim()
    && Date.parse(event.start) === Date.parse(desired.start)
    && Date.parse(event.end) === Date.parse(desired.end)
    && (desired.description === undefined || (event.description ?? '').trim() === desired.description.trim());
}

async function ensureMutationConflictReview(
  input: ReturnType<typeof normalizeInput>,
  hash: string,
  conflicts: UnifiedCalendarEvent[],
  observedAt: string,
): Promise<void> {
  const localDay = DateTime.fromISO(input.start!, { zone: input.timezone }).toISODate() ?? input.start!.slice(0, 10);
  const eventRef = createHash('sha256').update(`${input.source}:${input.eventId}`).digest('hex').slice(0, 32);
  const normalizedAction = buildNormalizedDecisionAction({
    intent: 'review_calendar_event_move_conflict',
    targetEntities: [{ type: 'calendar_event', id: eventRef }],
    affectedResources: [{ type: 'calendar_day', id: `${input.tenantId}:${localDay}` }],
    requestedWindow: { start: input.start!, end: input.end!, timezone: input.timezone },
    preconditions: [{ type: 'provider_event_state', ref: eventRef, expectedVersion: hash.slice(0, 32), required: true }],
    expectedEffects: [{ type: 'review_required', targetRef: `calendar_event:${eventRef}` }],
    prohibitedEffects: [{ type: 'provider_calendar_write', targetRef: `calendar_event:${eventRef}` }],
    dependencies: [],
    exclusivityKeys: [`calendar_timeline:${input.tenantId}:${localDay}`],
    authorizationScope: ['decision_center:read'],
    risk: 'medium',
    reversibility: 'reversible',
    contextVersion: hash.slice(0, 32),
  });
  const comparisons: ConflictComparisonAction[] = conflicts.slice(0, 23).map((event, index) => {
    const ref = createHash('sha256').update(stableStringify({
      source: event.source,
      id: event.id,
      providerUid: event.providerUid ?? null,
      occurrence: event.providerOccurrenceStart ?? null,
      start: event.start,
      end: event.end,
    })).digest('hex').slice(0, 32);
    return {
      action: buildNormalizedDecisionAction({
        intent: 'preserve_confirmed_calendar_commitment',
        targetEntities: [{ type: 'calendar_event', id: ref }],
        affectedResources: [{ type: 'calendar_day', id: `${input.tenantId}:${localDay}` }],
        requestedWindow: { start: event.start, end: event.end, timezone: input.timezone },
        preconditions: [],
        expectedEffects: [{ type: 'preserve_commitment', targetRef: `calendar_event:${ref}` }],
        prohibitedEffects: [],
        dependencies: [],
        exclusivityKeys: [`calendar_timeline:${input.tenantId}:${localDay}`],
        authorizationScope: ['calendar:read'],
        risk: 'medium',
        reversibility: 'reversible',
        contextVersion: `${hash.slice(0, 24)}:${index}`,
      }),
      authority: 'approved_commitment' as const,
      approved: true,
      createdAt: observedAt,
    };
  });
  const conflictEvaluation = evaluateDecisionConflicts({
    candidate: normalizedAction,
    existing: comparisons,
    now: new Date(observedAt),
  });
  try {
    const created = await createDecisionIntent({
      userId: input.userId,
      tenantId: Number(input.tenantId),
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'active',
      relatedEntityId: eventRef,
      relatedEntityType: 'calendar_event',
      title: 'Review this calendar move',
      body: 'The requested time overlaps an existing commitment. Nothing was written to the calendar.',
      actionButtons: [{ id: 'open_detail', label: 'Review commitments', style: 'primary' }],
      deeplink: `nexus://secretary/calendar-review/${eventRef}`,
      dedupeKey: `secretary:calendar-mutation-conflict:${hash}`,
      requiresUserAction: true,
      decisionDeadline: input.start!,
      expiresAt: input.end!,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'sensitive',
      visibilityScope: 'user_private',
      decisionContext: {
        entityTitle: 'Secretary calendar move',
        currentStartAt: input.start!,
        currentEndAt: input.end!,
        reasonCodes: ['calendar_time_overlap', 'provider_write_withheld', 'review_required'],
        sourceState: 'conflict_detected',
        providerName: input.source,
        contextObservedAt: observedAt,
        contextExpiresAt: input.end!,
        timezone: input.timezone,
        recipe: 'calendar_mutation_conflict_v1',
        normalizedAction,
        conflictEvaluation,
        conflictComparisons: comparisons,
      },
    });
    const duplicate = (created.eligibility.reasons ?? []).includes('conflict_policy:duplicate');
    if (!created.item && !duplicate) throw new Error('SECRETARY_CALENDAR_MUTATION_REVIEW_NOT_PERSISTED');
  } catch (error) {
    logger.warn({
      errorName: error instanceof Error ? error.name : typeof error,
      userId: input.userId,
      tenantId: input.tenantId,
    }, 'Calendar move remained blocked but Decision Center projection failed');
    throw new SecretaryCalendarMutationError(
      'CALENDAR_DECISION_REVIEW_PENDING',
      'The conflict is blocked, but its Decision Center review could not be persisted yet.',
      503,
      ['CALENDAR_DECISION_REVIEW_PENDING'],
    );
  }
}

function overlaps(start: string, end: string, otherStart: string, otherEnd: string): boolean {
  return Date.parse(start) < Date.parse(otherEnd) && Date.parse(end) > Date.parse(otherStart);
}

/**
 * A unified row may keep the richer provider copy while `syncedSources`
 * records that it also represents the exact event being changed. Exclude that
 * logical self-copy without hiding another occurrence from the same recurring
 * series. Stable UIDs therefore still require occurrence identity; the
 * organizer/title fallback remains the existing minute-level fingerprint.
 */
function representsCurrentProviderEvent(
  candidate: UnifiedCalendarEvent,
  current: UnifiedCalendarEvent,
  source: CalendarSource,
  eventId: string,
): boolean {
  if (candidate.source === source && candidate.id === eventId) return true;
  if (!(candidate.syncedSources ?? []).includes(source)) return false;
  if (eventFingerprint(candidate) !== eventFingerprint(current)) return false;

  const candidateUid = normalizeProviderIdentity(candidate.providerUid);
  const currentUid = normalizeProviderIdentity(current.providerUid);
  if (!candidateUid || !currentUid) return true;
  if (candidateUid !== currentUid) return false;

  const candidateOccurrence = normalizeOccurrenceIdentity(candidate);
  const currentOccurrence = normalizeOccurrenceIdentity(current);
  if (candidate.providerOccurrenceStart || current.providerOccurrenceStart) {
    return candidateOccurrence != null
      && currentOccurrence != null
      && candidateOccurrence === currentOccurrence;
  }

  const candidateStart = Date.parse(candidate.start);
  const currentStart = Date.parse(current.start);
  return Number.isFinite(candidateStart)
    && Number.isFinite(currentStart)
    && Math.abs(candidateStart - currentStart) <= 15 * 60_000;
}

function normalizeProviderIdentity(value: string | null | undefined): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || null;
}

function normalizeOccurrenceIdentity(event: UnifiedCalendarEvent): string | null {
  const value = String(event.providerOccurrenceStart ?? event.start ?? '').trim();
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|T00:00:00(?:\.000)?(?:Z|[+-]00:?00)?)$/);
  if (dateOnly && event.isAllDay) return `day:${dateOnly[1]}`;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? `minute:${Math.round(millis / 60_000)}` : null;
}

function dedupeConflictEvents(events: UnifiedCalendarEvent[]): UnifiedCalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = stableStringify({
      source: event.source,
      providerUid: event.providerUid ?? null,
      providerOccurrenceStart: event.providerOccurrenceStart ?? null,
      providerEventId: event.id,
      start: event.start,
      end: event.end,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveNow(value: string | undefined): DateTime {
  const parsed = DateTime.fromISO(value ?? '', { setZone: true });
  return (parsed.isValid ? parsed : DateTime.utc()).toUTC();
}

function syncPending(): SecretaryCalendarMutationError {
  return new SecretaryCalendarMutationError(
    'CALENDAR_SYNC_PENDING',
    'The provider mutation is pending read-back; retry with the same Idempotency-Key.',
    409,
    ['CALENDAR_SYNC_PENDING'],
  );
}

function isEvent(value: unknown): value is UnifiedCalendarEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string'
    && typeof event.summary === 'string'
    && typeof event.start === 'string'
    && typeof event.end === 'string'
    && (event.source === 'google' || event.source === 'outlook');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
