// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { invalidateCalendarCaches } from './cache-coherence-registry';
import { buildNormalizedDecisionAction } from './decision-action-contract';
import {
  evaluateDecisionConflicts,
  type ConflictComparisonAction,
} from './decision-conflict-evaluator';
import { createDecisionIntent } from './decision-center';
import { secretaryAgendaStateRevision } from './secretary-agenda-state-revision';
import {
  syncSecretaryAgendaItemsToProvider,
  toProviderEventInput,
  type SecretaryAgendaProviderAdapter,
  type SecretaryProviderEvent,
  type SecretaryProviderEventInput,
} from './secretary-agenda-provider-sync';
import {
  getSecretaryAgendaItemById,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingDecision,
  type SecretaryTimeWindow,
} from './secretary-scheduling-arbitrator';
import {
  localConflictAsUnifiedCalendarEvent,
  readSecretaryLocalCalendarConflicts,
} from './secretary-local-calendar-conflicts';
import {
  claimSecretaryCalendarCommand,
  getSecretaryCalendarCommandReceipt,
  getSecretaryCalendarCommandPayloadForAgendaItem,
  releaseSecretaryCalendarCommandProcessingLease,
  updateSecretaryCalendarCommandReceipt,
  type SecretaryCalendarCommandPayload,
  type SecretaryCalendarCommandReceipt,
} from './secretary-calendar-command-store';
import { createUnifiedCalendarSecretaryProviderAdapter } from './secretary-unified-calendar-provider-adapter';
import {
  deduplicateEvents,
  getEventsWithDiagnostics,
  type CalendarSource,
  type UnifiedCalendarEvent,
  type UnifiedCalendarFetchResult,
} from './unified-calendar';
import { logger } from '../utils/logger';

// Public calendar-write facade. Update/delete keep their implementation in a
// focused module, but runtime callers import every confirmed Secretary calendar
// command from this service so REST, iOS, and chat cannot drift onto separate
// authorization, idempotency, conflict, or reconciliation entry points.
export {
  executeSecretaryCalendarMutation,
  inspectSecretaryCalendarMutationReplay,
  noteLegacySecretaryCalendarMutationWithoutKey,
  SecretaryCalendarMutationError,
  type SecretaryCalendarMutationInput,
  type SecretaryCalendarMutationIo,
  type SecretaryCalendarMutationResult,
} from './secretary-calendar-mutation-service';

const RECEIPT_RETENTION_DAYS = 30;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const IDEMPOTENCY_KEY_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const ATTENDEE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NEXUS_CALENDAR_CATEGORIES = new Set(['focus', 'pomodoro', 'training', 'meal', 'meeting']);

/**
 * Calendar commands are durable: the idempotency receipt is written before
 * conflict reads, and successful commands keep a provider payload beside the
 * agenda item. Keep the budget here (rather than only in one HTTP route) so
 * REST, iOS, and confirmed chat commands all reject the same oversized input
 * before their first database or provider operation.
 */
export const SECRETARY_CALENDAR_COMMAND_LIMITS = Object.freeze({
  titleCharacters: 300,
  descriptionCharacters: 10_000,
  locationCharacters: 500,
  attendees: 100,
  attendeeCharacters: 320,
  categories: 20,
  categoryCharacters: 100,
  recurrenceBytes: 4 * 1024,
  recurrenceDepth: 5,
  recurrenceNodes: 100,
  recurrenceObjectKeys: 32,
  recurrenceArrayItems: 32,
  recurrenceStringCharacters: 500,
  serializedPayloadBytes: 32 * 1024,
});

export type SecretaryCalendarCommandStatus =
  | 'succeeded'
  | 'review_required';

export interface SecretaryCalendarCommandInput {
  userId: number;
  tenantId: string | number;
  idempotencyKey: string;
  source: CalendarSource;
  title: string;
  start: string;
  end: string;
  timezone: string;
  description?: string;
  location?: string;
  attendees?: string[];
  categories?: string[];
  recurrence?: unknown;
  channel: 'rest' | 'ios' | 'chat';
  nowIso?: string;
}

export interface SecretaryCalendarCommandResult {
  status: SecretaryCalendarCommandStatus;
  replayed: boolean;
  event?: UnifiedCalendarEvent;
  warningCodes: string[];
}

export interface SecretaryCalendarCommandCalendarIo {
  getEventsWithDiagnostics?(
    start: string,
    end: string,
    userId: number,
    options?: { sources?: CalendarSource[] },
  ): Promise<UnifiedCalendarFetchResult>;
  getEventsForSources(
    start: string,
    end: string,
    userId: number,
    sources: CalendarSource[],
  ): Promise<UnifiedCalendarEvent[]>;
  createEvent(
    data: {
      title: string;
      start: string;
      end: string;
      description?: string;
      categories?: string[];
      attendees?: string[];
      location?: string;
      recurrence?: unknown;
    },
    source: CalendarSource,
    userId: number,
    options?: { signal?: AbortSignal; tenantId?: number },
  ): Promise<UnifiedCalendarEvent>;
}

export interface SecretaryCalendarCommandOptions {
  calendarIo?: SecretaryCalendarCommandCalendarIo;
  configuredSources?: CalendarSource[];
  providerAdapter?: SecretaryAgendaProviderAdapter;
  /**
   * Read-only commitments observed by a caller-specific precheck (for
   * example Apple Health sleep blocks used by the Focus quick action). They
   * participate in the same Decision Center review without changing provider
   * source-health coverage or authorizing a write.
   */
  additionalConflicts?: Array<{
    id: string;
    title: string;
    start: string;
    end: string;
    sourceLabel?: string | null;
  }>;
}

export type SecretaryCalendarCommandReplayProbeInput =
  Omit<SecretaryCalendarCommandInput, 'source'> & { source?: CalendarSource };

export interface SecretaryCalendarCommandReplayProbe {
  source: CalendarSource;
  result: SecretaryCalendarCommandResult | null;
}

export class SecretaryCalendarCommandError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INPUT'
      | 'TENANT_SCOPE_MISMATCH'
      | 'IDEMPOTENCY_KEY_REUSED'
      | 'CALENDAR_CONFLICT_STATE_UNKNOWN'
      | 'CALENDAR_DECISION_REVIEW_PENDING'
      | 'CALENDAR_PROVIDER_WRITE_FAILED'
      | 'CALENDAR_SYNC_PENDING',
    message: string,
    readonly status: number,
    readonly warningCodes: string[] = [],
  ) {
    super(message);
    this.name = 'SecretaryCalendarCommandError';
  }
}

let legacyMissingKeyCount = 0;

export function resolveSecretaryCalendarIdempotencyKey(value: unknown): {
  idempotencyKey: string;
  legacyMissingKey: boolean;
} {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (normalized) return { idempotencyKey: normalized, legacyMissingKey: false };
  legacyMissingKeyCount += 1;
  logger.warn({
    event: 'secretary.calendar_command.legacy_missing_idempotency_key',
    legacyMissingKeyCount,
  }, 'Calendar create used the one-release missing Idempotency-Key compatibility path');
  return {
    idempotencyKey: `legacy-${randomUUID()}`,
    legacyMissingKey: true,
  };
}

export function getSecretaryCalendarCommandMetrics(): { legacyMissingKeyCount: number } {
  return { legacyMissingKeyCount };
}

export function resetSecretaryCalendarCommandMetricsForTests(): void {
  legacyMissingKeyCount = 0;
}

/**
 * Read-only replay inspection for transport capability gates. A terminal,
 * unexpired receipt can be returned without touching OAuth/provider state;
 * nonterminal commands are returned as a null-result probe so transports can
 * bypass only their new-command capability gate and let this service safely
 * reconcile or fail closed without issuing an untracked duplicate write.
 */
export function inspectSecretaryCalendarCommandReplay(
  rawInput: SecretaryCalendarCommandReplayProbeInput,
): SecretaryCalendarCommandReplayProbe | null {
  // Validate scope and public fields before the first database read. The
  // placeholder source is replaced by the receipt source only when the caller
  // originally omitted it.
  const prevalidated = normalizeInput({
    ...rawInput,
    source: rawInput.source ?? 'google',
  });
  const receipt = getSecretaryCalendarCommandReceipt({
    userId: prevalidated.userId,
    tenantId: prevalidated.tenantId,
    idempotencyKey: prevalidated.idempotencyKey,
  });
  if (!receipt) return null;

  const now = DateTime.fromISO(prevalidated.nowIso ?? '', { setZone: true });
  const nowUtc = (now.isValid ? now : DateTime.utc()).toUTC();
  if (Date.parse(receipt.expiresAt) <= nowUtc.toMillis()) return null;

  const normalized = rawInput.source == null && receipt.providerSource !== prevalidated.source
    ? normalizeInput({ ...rawInput, source: receipt.providerSource })
    : prevalidated;
  const requestHash = calendarCommandRequestHash(normalized);
  if (receipt.requestHash !== requestHash) {
    throw new SecretaryCalendarCommandError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for different calendar content.',
      409,
    );
  }
  return {
    source: receipt.providerSource,
    result: replayReceipt(receipt),
  };
}

export async function executeSecretaryCalendarCommand(
  rawInput: SecretaryCalendarCommandInput,
  options: SecretaryCalendarCommandOptions = {},
): Promise<SecretaryCalendarCommandResult> {
  let input = normalizeInput(rawInput);
  const requestHash = calendarCommandRequestHash(input);
  const now = DateTime.fromISO(input.nowIso ?? '', { setZone: true });
  const nowUtc = (now.isValid ? now : DateTime.utc()).toUTC();
  const scope = {
    userId: input.userId,
    tenantId: input.tenantId,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  };
  const claimed = claimSecretaryCalendarCommand({
    ...scope,
    providerSource: input.source,
    command: commandPayload(input),
    nowIso: nowUtc.toISO()!,
    expiresAt: nowUtc.plus({ days: RECEIPT_RETENTION_DAYS }).toISO()!,
  });

  if (claimed.receipt.requestHash !== requestHash) {
    throw new SecretaryCalendarCommandError(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for different calendar content.',
      409,
    );
  }

  // Timezone is authoritative account context resolved by the server, not a
  // client-controlled calendar body field. An ambiguous retry after the user
  // changes routine timezone must remain the same logical command. Resume any
  // nonterminal receipt with the timezone captured by its first attempt so
  // conflict-day projection cannot drift while provider reconciliation runs.
  if (!claimed.created && IANAZone.isValidZone(claimed.receipt.command.timezone)) {
    input = { ...input, timezone: claimed.receipt.command.timezone };
  }

  const replay = replayReceipt(claimed.receipt);
  if (replay) return replay;
  const leaseToken = claimed.leaseToken;
  if (!claimed.acquired || !leaseToken) {
    throw new SecretaryCalendarCommandError(
      'CALENDAR_SYNC_PENDING',
      'This command is already being processed; no duplicate write was issued.',
      409,
      ['CALENDAR_SYNC_PENDING', 'CALENDAR_COMMAND_LEASE_HELD'],
    );
  }
  const leasedScope = { ...scope, leaseToken };

  try {
    let agendaDecision: SecretarySchedulingDecision | null = null;
    if (claimed.receipt.state === 'sync_pending' && claimed.receipt.agendaItemId) {
      agendaDecision = null;
    } else {
    const calendarSnapshot = await readConflictSnapshot(
      input,
      options.calendarIo,
      options.configuredSources,
    );
    const expectedSources = new Set<CalendarSource>([
      input.source,
      ...(options.configuredSources ?? []),
      ...calendarSnapshot.sources.configured,
    ]);
    const fulfilledSources = new Set(calendarSnapshot.sources.fulfilled);
    const hasCompleteSourceCoverage = calendarSnapshot.status === 'ready'
      && calendarSnapshot.sources.failed.length === 0
      && [...expectedSources].every((source) => fulfilledSources.has(source));
    if (!hasCompleteSourceCoverage) {
      updateSecretaryCalendarCommandReceipt(leasedScope, {
        state: 'conflict_unknown',
        updatedAt: DateTime.utc().toISO()!,
      });
      throw new SecretaryCalendarCommandError(
        'CALENDAR_CONFLICT_STATE_UNKNOWN',
        'Calendar availability could not be verified, so nothing was written.',
        409,
        [...new Set([
          'CALENDAR_CONFLICT_STATE_UNKNOWN',
          ...([...expectedSources].some((source) => !fulfilledSources.has(source))
            ? ['CALENDAR_SOURCE_COVERAGE_INCOMPLETE']
            : []),
          ...calendarSnapshot.warningCodes,
        ])],
      );
    }

    const localSnapshot = readSecretaryLocalCalendarConflicts({
      userId: input.userId,
      tenantId: input.tenantId,
      start: input.start,
      end: input.end,
      excludeSourceIntentId: `calendar-command:${claimed.receipt.commandInstanceId}`,
    });
    if (localSnapshot.status !== 'ready') {
      updateSecretaryCalendarCommandReceipt(leasedScope, {
        state: 'conflict_unknown',
        updatedAt: DateTime.utc().toISO()!,
      });
      throw new SecretaryCalendarCommandError(
        'CALENDAR_CONFLICT_STATE_UNKNOWN',
        'Local agenda and protected-routine availability could not be verified, so nothing was written.',
        409,
        localSnapshot.warningCodes,
      );
    }

    const calendarConflicts = dedupeConflictEvents([
      ...calendarSnapshot.events,
      ...localSnapshot.conflicts.map((conflict) =>
        localConflictAsUnifiedCalendarEvent(conflict, input.source)),
      ...(options.additionalConflicts ?? []).map((event) => {
        const providerSource = event.sourceLabel === 'google' || event.sourceLabel === 'outlook'
          ? event.sourceLabel
          : input.source;
        return {
          id: providerSource === event.sourceLabel
            ? event.id
            : `${event.sourceLabel ?? 'local'}:${event.id}`,
          summary: event.title,
          start: event.start,
          end: event.end,
          source: providerSource,
          blocksTime: true,
        } satisfies UnifiedCalendarEvent;
      }),
    ])
      .filter((event) => event.blocksTime !== false)
      .filter((event) => overlaps(input.start, input.end, event.start, event.end));
    agendaDecision = submitSecretarySchedulingIntent(
      buildSchedulingIntent(
        input,
        claimed.receipt.commandInstanceId,
        requestHash,
        calendarConflicts,
      ),
      { now: nowUtc.toISO()! },
    );

    const schedulable = ['scheduled', 'reflowed', 'compressed'].includes(agendaDecision.status)
      && agendaDecision.selectedSlot != null;
    if (!schedulable) {
      const decisionItemId = await ensureConflictReviewWork(
        input,
        requestHash,
        agendaDecision,
        calendarConflicts,
      );
      const response: Record<string, unknown> = {
        status: 'review_required',
        warningCodes: ['CALENDAR_CONFLICT_REVIEW_REQUIRED'],
      };
      // Invalidate before terminalizing the receipt. A crash after a terminal
      // receipt must never leave an old Today/Week cache that every later
      // replay would trust. If receipt persistence fails, the durable agenda
      // and Decision identities make the next attempt safe to resume.
      invalidateCalendarCaches(input.userId);
      updateSecretaryCalendarCommandReceipt(leasedScope, {
        state: 'review_required',
        agendaItemId: agendaDecision.agendaItem.agendaItemId,
        decisionItemId,
        response,
        updatedAt: DateTime.utc().toISO()!,
      });
      // The agenda row and Decision projection are now durable even though no
      // provider write occurred. Rejected/unknown mutations never reach this
      // terminalization path and deliberately leave caches intact.
      return {
        status: 'review_required',
        replayed: false,
        warningCodes: ['CALENDAR_CONFLICT_REVIEW_REQUIRED'],
      };
    }

    updateSecretaryCalendarCommandReceipt(leasedScope, {
      state: 'sync_pending',
      agendaItemId: agendaDecision.agendaItem.agendaItemId,
      updatedAt: DateTime.utc().toISO()!,
    });
    }

    const receipt = claimed.receipt.state === 'sync_pending' && claimed.receipt.agendaItemId
      ? claimed.receipt
      : (() => {
        const agendaItemId = agendaDecision?.agendaItem.agendaItemId;
        if (!agendaItemId) throw new Error('SECRETARY_CALENDAR_COMMAND_AGENDA_MISSING');
        return { ...claimed.receipt, agendaItemId };
      })();
    const adapter = options.providerAdapter
      ?? (options.calendarIo
        ? createInjectedProviderAdapter(input.source, options.calendarIo)
        : createUnifiedCalendarSecretaryProviderAdapter(input.source));
    const existingMapping = claimed.receipt.state === 'sync_pending'
      ? getSecretaryAgendaItemById({
          agendaItemId: receipt.agendaItemId!,
          ownerUserId: input.userId,
          tenantId: input.tenantId,
        })
      : null;
    if (
      existingMapping?.lifecycleState === 'synced'
      && existingMapping.providerSyncState === 'synced'
      && existingMapping.providerEventId
      && existingMapping.providerSource === input.source
    ) {
    // A prior attempt already committed the provider mapping and only its
    // command-level readback remained ambiguous. Verify that exact mapping
    // before re-entering the generic drift worker: an expired fingerprint
    // must not turn a readback retry into a second provider mutation.
      return await completeSuccessfulCalendarCommand({
        input,
        scope: leasedScope,
        receipt,
        providerEventId: existingMapping.providerEventId,
        calendarIo: options.calendarIo,
        providerAdapter: adapter,
      });
    }
    const syncResults = await syncSecretaryAgendaItemsToProvider({
      ownerUserId: input.userId,
      tenantId: input.tenantId,
      includeInactive: true,
    }, adapter, {
      agendaItemId: receipt.agendaItemId!,
    });
    const sync = syncResults.find((entry) => entry.agendaItemId === receipt.agendaItemId);

    if (!sync) {
      throw new SecretaryCalendarCommandError(
        'CALENDAR_SYNC_PENDING',
        'This command is already being reconciled by another worker; no duplicate write was issued.',
        409,
        ['CALENDAR_SYNC_PENDING', 'CALENDAR_SYNC_LEASE_HELD'],
      );
    }

    if (sync.providerSyncState === 'create_failed' && !sync.providerEventId) {
      throw new SecretaryCalendarCommandError(
        'CALENDAR_PROVIDER_WRITE_FAILED',
        'The calendar provider rejected the command and no event was created.',
        502,
        ['CALENDAR_PROVIDER_WRITE_FAILED'],
      );
    }
    if (sync.providerSyncState !== 'synced' || !sync.providerEventId) {
      throw new SecretaryCalendarCommandError(
        'CALENDAR_SYNC_PENDING',
        'The calendar provider result is not yet safely reconciled; no retry write was issued.',
        409,
        ['CALENDAR_SYNC_PENDING'],
      );
    }

    return await completeSuccessfulCalendarCommand({
      input,
      scope: leasedScope,
      receipt,
      providerEventId: sync.providerEventId,
      calendarIo: options.calendarIo,
      providerAdapter: adapter,
    });
  } finally {
    try {
      releaseSecretaryCalendarCommandProcessingLease({
        userId: input.userId,
        tenantId: input.tenantId,
        idempotencyKey: input.idempotencyKey,
        leaseToken,
      });
    } catch (error) {
      logger.warn({
        errorName: error instanceof Error ? error.name : typeof error,
        userId: input.userId,
      }, 'Secretary calendar command lease release failed; expiry will recover it');
    }
  }
}

async function completeSuccessfulCalendarCommand(input: {
  input: ReturnType<typeof normalizeInput>;
  scope: {
    userId: number;
    tenantId: string;
    idempotencyKey: string;
    requestHash: string;
    leaseToken: string;
  };
  receipt: SecretaryCalendarCommandReceipt;
  providerEventId: string;
  calendarIo?: SecretaryCalendarCommandCalendarIo;
  providerAdapter: SecretaryAgendaProviderAdapter;
}): Promise<SecretaryCalendarCommandResult> {
  const event = input.providerAdapter.getEvent
    ? await verifyProviderAdapterReadback(
        input.input,
        input.receipt.agendaItemId,
        input.providerEventId,
        input.providerAdapter,
      )
    : input.calendarIo
      ? await verifyInjectedProviderReadback(input.input, input.providerEventId, input.calendarIo)
      : failCalendarCommandReadbackUnavailable();
  const response: Record<string, unknown> = {
    status: 'succeeded',
    warningCodes: [],
    event,
  };
  // Terminal receipt publication follows invalidation so a replayable
  // `succeeded` receipt cannot coexist with pre-mutation planning caches.
  invalidateCalendarCaches(input.input.userId);
  updateSecretaryCalendarCommandReceipt(input.scope, {
    state: 'succeeded',
    agendaItemId: input.receipt.agendaItemId,
    response,
    updatedAt: DateTime.utc().toISO()!,
  });
  return { status: 'succeeded', replayed: false, event, warningCodes: [] };
}

function normalizeInput(input: SecretaryCalendarCommandInput): SecretaryCalendarCommandInput & { tenantId: string } {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) invalid('userId must be a positive integer.');
  const tenantId = String(input.tenantId ?? '').trim();
  if (!tenantId) invalid('tenantId is required.');
  if (tenantId !== String(input.userId)) {
    throw new SecretaryCalendarCommandError(
      'TENANT_SCOPE_MISMATCH',
      'The active tenant does not match the authenticated user.',
      403,
    );
  }
  if (typeof input.idempotencyKey !== 'string') invalid('Idempotency-Key must be a string.');
  const idempotencyKey = input.idempotencyKey.trim();
  if (
    !idempotencyKey
    || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)
  ) {
    invalid(`Idempotency-Key must contain 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`);
  }
  if (typeof input.title !== 'string') invalid('title must be a string.');
  const title = input.title.trim();
  if (!title) invalid('title is required.');
  if (title.length > SECRETARY_CALENDAR_COMMAND_LIMITS.titleCharacters) {
    invalid(`title must contain at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.titleCharacters} characters.`);
  }
  if (typeof input.start !== 'string' || typeof input.end !== 'string') {
    invalid('start and end must be ISO 8601 timestamp strings.');
  }
  const startDateTime = DateTime.fromISO(input.start, { setZone: true });
  const endDateTime = DateTime.fromISO(input.end, { setZone: true });
  const startMs = startDateTime.toMillis();
  const endMs = endDateTime.toMillis();
  if (!input.start.includes('T') || !input.end.includes('T')
    || !startDateTime.isValid || !endDateTime.isValid || endMs <= startMs) {
    invalid('start and end must be valid timestamps with end after start.');
  }
  if (endMs - startMs > 24 * 60 * 60 * 1000) invalid('event duration must be 24 hours or less.');
  if (typeof input.timezone !== 'string') invalid('timezone must be a valid IANA zone.');
  const timezone = input.timezone.trim();
  if (!IANAZone.isValidZone(timezone)) invalid('timezone must be a valid IANA zone.');
  if (input.source !== 'google' && input.source !== 'outlook') invalid('source must be google or outlook.');
  if (!['rest', 'ios', 'chat'].includes(input.channel)) invalid('channel must be rest, ios, or chat.');

  const normalized: SecretaryCalendarCommandInput & { tenantId: string } = {
    ...input,
    tenantId,
    idempotencyKey,
    title,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    timezone,
    description: cleanOptional(
      input.description,
      'description',
      SECRETARY_CALENDAR_COMMAND_LIMITS.descriptionCharacters,
    ),
    location: cleanOptional(
      input.location,
      'location',
      SECRETARY_CALENDAR_COMMAND_LIMITS.locationCharacters,
    ),
    attendees: normalizeStrings(input.attendees, {
      label: 'attendees',
      maxItems: SECRETARY_CALENDAR_COMMAND_LIMITS.attendees,
      maxCharacters: SECRETARY_CALENDAR_COMMAND_LIMITS.attendeeCharacters,
      validate: (value) => ATTENDEE_EMAIL_PATTERN.test(value),
      validationMessage: 'attendees must contain valid email addresses.',
    }),
    categories: normalizeStrings(input.categories, {
      label: 'categories',
      maxItems: SECRETARY_CALENDAR_COMMAND_LIMITS.categories,
      maxCharacters: SECRETARY_CALENDAR_COMMAND_LIMITS.categoryCharacters,
      validate: (value) => NEXUS_CALENDAR_CATEGORIES.has(value.toLowerCase()),
      validationMessage: 'categories must contain supported Nexus calendar categories.',
      transform: (value) => value.toLowerCase(),
    }),
    recurrence: normalizeRecurrencePayload(input.recurrence),
  };
  assertCalendarCommandPayloadBudget(commandPayload(normalized));
  return normalized;
}

function invalid(message: string): never {
  throw new SecretaryCalendarCommandError('INVALID_INPUT', message, 400);
}

function cleanOptional(
  value: unknown,
  label: string,
  maxCharacters: number,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') invalid(`${label} must be a string.`);
  const clean = value.trim();
  if (clean.length > maxCharacters) {
    invalid(`${label} must contain at most ${maxCharacters} characters.`);
  }
  return clean || undefined;
}

function normalizeStrings(values: unknown, limits: {
  label: string;
  maxItems: number;
  maxCharacters: number;
  validate?: (value: string) => boolean;
  validationMessage?: string;
  transform?: (value: string) => string;
}): string[] | undefined {
  if (values == null) return undefined;
  if (!Array.isArray(values)) invalid(`${limits.label} must be an array.`);
  if (values.length > limits.maxItems) {
    invalid(`${limits.label} must contain at most ${limits.maxItems} items.`);
  }
  if (values.some((value) => typeof value !== 'string')) {
    invalid(`${limits.label} must contain only strings.`);
  }
  const clean = [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => limits.transform?.(value) ?? value))].sort();
  if (clean.some((value) => value.length > limits.maxCharacters)) {
    invalid(`${limits.label} items must contain at most ${limits.maxCharacters} characters.`);
  }
  if (limits.validate && clean.some((value) => !limits.validate!(value))) {
    invalid(limits.validationMessage ?? `${limits.label} contains an invalid value.`);
  }
  return clean.length > 0 ? clean : undefined;
}

function normalizeRecurrencePayload(value: unknown): unknown | undefined {
  if (value == null) return undefined;
  if (!isPlainRecord(value)) invalid('recurrence must be a JSON object.');

  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceNodes) {
      invalid(`recurrence must contain at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceNodes} values.`);
    }
    if (depth > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceDepth) {
      invalid(`recurrence must be at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceDepth} levels deep.`);
    }
    if (typeof entry === 'string') {
      if (entry.length > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceStringCharacters) {
        invalid(`recurrence strings must contain at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceStringCharacters} characters.`);
      }
      return;
    }
    if (entry === null || typeof entry === 'boolean') return;
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) invalid('recurrence numbers must be finite.');
      return;
    }
    if (Array.isArray(entry)) {
      if (entry.length > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceArrayItems) {
        invalid(`recurrence arrays must contain at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceArrayItems} items.`);
      }
      entry.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!isPlainRecord(entry)) invalid('recurrence must contain only JSON values.');
    const entries = Object.entries(entry);
    if (entries.length > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceObjectKeys) {
      invalid(`recurrence objects must contain at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceObjectKeys} keys.`);
    }
    entries.forEach(([key, item]) => {
      if (key.length > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceStringCharacters) {
        invalid(`recurrence keys must contain at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceStringCharacters} characters.`);
      }
      visit(item, depth + 1);
    });
  };

  visit(value, 1);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceBytes) {
    invalid(`recurrence must serialize to at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.recurrenceBytes} bytes.`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
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

function assertCalendarCommandPayloadBudget(payload: SecretaryCalendarCommandPayload): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > SECRETARY_CALENDAR_COMMAND_LIMITS.serializedPayloadBytes) {
    invalid(`calendar command payload must serialize to at most ${SECRETARY_CALENDAR_COMMAND_LIMITS.serializedPayloadBytes} bytes.`);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function calendarCommandRequestHash(input: ReturnType<typeof normalizeInput>): string {
  return createHash('sha256').update(stableStringify({
    source: input.source,
    title: input.title,
    start: input.start,
    end: input.end,
    description: input.description ?? null,
    location: input.location ?? null,
    attendees: input.attendees ?? [],
    categories: input.categories ?? [],
    recurrence: input.recurrence ?? null,
  })).digest('hex');
}

function commandPayload(input: ReturnType<typeof normalizeInput>): SecretaryCalendarCommandPayload {
  return {
    title: input.title,
    start: input.start,
    end: input.end,
    timezone: input.timezone,
    channel: input.channel,
    ...(input.description ? { description: input.description } : {}),
    ...(input.location ? { location: input.location } : {}),
    ...(input.attendees ? { attendees: input.attendees } : {}),
    ...(input.categories ? { categories: input.categories } : {}),
    ...(input.recurrence != null ? { recurrence: input.recurrence } : {}),
  };
}

async function readConflictSnapshot(
  input: ReturnType<typeof normalizeInput>,
  io?: SecretaryCalendarCommandCalendarIo,
  configuredSources?: CalendarSource[],
): Promise<UnifiedCalendarFetchResult> {
  if (!io) {
    return getEventsWithDiagnostics(input.start, input.end, input.userId);
  }
  // An explicitly supplied inventory is authoritative. A retry whose receipt
  // is still before the provider-write boundary must not turn a disconnected
  // target into an apparently empty/healthy calendar. `sync_pending`
  // recoveries skip this precheck above and can still reconcile a write that
  // may already have reached the provider.
  if (configuredSources && !configuredSources.includes(input.source)) {
    return {
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_TARGET_SOURCE_NOT_CONFIGURED'],
      warnings: ['The target calendar provider is not currently connected.'],
      sources: { configured: [...new Set(configuredSources)], fulfilled: [], failed: [input.source] },
    };
  }
  const sources = [...new Set([input.source, ...(configuredSources ?? [])])];
  try {
    if (io.getEventsWithDiagnostics) {
      return await io.getEventsWithDiagnostics(input.start, input.end, input.userId, { sources });
    }
    // The compatibility read API returns only events, so a single combined
    // call cannot distinguish "all configured providers were empty" from
    // "one provider failed while another returned an empty result". Probe
    // every configured source independently and preserve that coverage in the
    // same diagnostic shape used by the modern adapter. This keeps confirmed
    // chat writes fail-closed even when an older CalendarProviderDeps does not
    // expose getEventsWithDiagnostics yet.
    const settled = await Promise.allSettled(sources.map(async (source) => ({
      source,
      events: await io.getEventsForSources(input.start, input.end, input.userId, [source]),
    })));
    const fulfilled: CalendarSource[] = [];
    const failed: CalendarSource[] = [];
    const events: UnifiedCalendarEvent[] = [];
    for (const [index, result] of settled.entries()) {
      if (result.status === 'fulfilled') {
        fulfilled.push(result.value.source);
        events.push(...result.value.events);
      } else {
        failed.push(sources[index]!);
      }
    }
    return {
      // Legacy adapters expose only per-source arrays. Rejoin them through
      // the same stable-UID/organizer fallback used by the canonical unified
      // reader so Decision review receives one logical commitment with its
      // complete `syncedSources` projection.
      events: deduplicateEvents(events),
      status: failed.length === 0
        ? 'ready'
        : fulfilled.length > 0
          ? 'degraded'
          : 'unavailable',
      warningCodes: failed.map((source) => `${source.toUpperCase()}_CALENDAR_UNAVAILABLE`),
      warnings: failed.map((source) => `${source === 'google' ? 'Google' : 'Outlook'} Calendar is unavailable right now.`),
      sources: { configured: sources, fulfilled, failed },
    };
  } catch {
    return {
      events: [],
      status: 'unavailable',
      warningCodes: ['CALENDAR_CONFLICT_STATE_UNKNOWN'],
      warnings: ['Calendar availability could not be verified.'],
      sources: { configured: sources, fulfilled: [], failed: sources },
    };
  }
}

function buildSchedulingIntent(
  input: ReturnType<typeof normalizeInput>,
  commandInstanceId: string,
  requestHash: string,
  conflicts: UnifiedCalendarEvent[],
) {
  const duration = Math.round((Date.parse(input.end) - Date.parse(input.start)) / 60_000);
  const hardCommitments: SecretaryTimeWindow[] = conflicts.map((event) => ({
    start: event.start,
    end: event.end,
  }));
  return {
    // Idempotency keys are reusable after the 30-day receipt horizon. Keep the
    // internal logical agenda identity tied to this receipt generation so a
    // later command cannot supersede or adopt the old provider-backed item.
    intentId: `calendar-command:${commandInstanceId}`,
    action: 'schedule_this' as const,
    sourceSkill: 'secretary' as const,
    sourceAction: 'calendar_command_create',
    sourceEntityId: requestHash.slice(0, 32),
    sourceEntityType: 'calendar_command',
    ownerUserId: input.userId,
    tenantId: input.tenantId,
    providerTarget: input.source,
    title: input.title,
    requestedDurationMinutes: duration,
    preferredWindows: [{ start: input.start, end: input.end }],
    hardConstraints: hardCommitments.length > 0 ? { hardCommitments } : undefined,
    priority: 'normal' as const,
    flexibility: 'fixed' as const,
    recurrence: input.recurrence,
    idempotencyPayloadHash: requestHash,
  };
}

async function ensureConflictReviewWork(
  input: ReturnType<typeof normalizeInput>,
  requestHash: string,
  decision: SecretarySchedulingDecision,
  providerConflicts: UnifiedCalendarEvent[],
): Promise<string | null> {
  const agenda = decision.agendaItem;
  const localDay = DateTime.fromISO(input.start, { zone: input.timezone }).toISODate() ?? input.start.slice(0, 10);
  const contextVersion = requestHash.slice(0, 32);
  const normalizedAction = buildNormalizedDecisionAction({
    intent: 'review_calendar_command_conflict',
    targetEntities: [{
      type: 'secretary_agenda_item',
      id: agenda.agendaItemId,
      version: String(agenda.version),
    }],
    affectedResources: [{ type: 'calendar_day', id: `${input.tenantId}:${localDay}` }],
    requestedWindow: { start: input.start, end: input.end, timezone: input.timezone },
    preconditions: [{
      type: 'agenda_state',
      ref: agenda.agendaItemId,
      expectedVersion: secretaryAgendaStateRevision(agenda),
      required: true,
    }],
    expectedEffects: [{ type: 'review_required', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
    prohibitedEffects: [{ type: 'provider_calendar_write', targetRef: `secretary_agenda_item:${agenda.agendaItemId}` }],
    dependencies: [],
    exclusivityKeys: [`calendar_timeline:${input.tenantId}:${localDay}`],
    authorizationScope: ['decision_center:read'],
    risk: 'medium',
    reversibility: 'reversible',
    contextVersion,
  });
  const observedAt = DateTime.fromISO(input.nowIso ?? '', { setZone: true });
  const observedAtIso = (observedAt.isValid ? observedAt : DateTime.utc()).toUTC().toISO()!;
  const conflictComparisons: ConflictComparisonAction[] = providerConflicts
    .slice(0, 23)
    .map((event, index) => {
      const opaqueEventId = createHash('sha256').update(stableStringify({
        source: event.source,
        providerUid: event.providerUid ?? null,
        providerOccurrenceStart: event.providerOccurrenceStart ?? null,
        providerEventId: event.id,
        start: event.start,
        end: event.end,
      })).digest('hex').slice(0, 32);
      return {
        action: buildNormalizedDecisionAction({
          intent: 'preserve_confirmed_calendar_commitment',
          targetEntities: [{ type: 'calendar_event', id: opaqueEventId }],
          affectedResources: [{ type: 'calendar_day', id: `${input.tenantId}:${localDay}` }],
          requestedWindow: { start: event.start, end: event.end, timezone: input.timezone },
          preconditions: [],
          expectedEffects: [{ type: 'preserve_commitment', targetRef: `calendar_event:${opaqueEventId}` }],
          prohibitedEffects: [],
          dependencies: [],
          exclusivityKeys: [`calendar_timeline:${input.tenantId}:${localDay}`],
          authorizationScope: ['calendar:read'],
          risk: 'medium',
          reversibility: 'reversible',
          contextVersion: `${contextVersion}:${index}`,
        }),
        authority: 'approved_commitment' as const,
        approved: true,
        createdAt: observedAtIso,
      };
    });
  const conflictEvaluation = evaluateDecisionConflicts({
    candidate: normalizedAction,
    existing: conflictComparisons,
    now: new Date(observedAtIso),
  });
  try {
    const created = await createDecisionIntent({
      userId: input.userId,
      tenantId: Number(input.tenantId),
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      priority: 'active',
      relatedEntityId: agenda.agendaItemId,
      relatedEntityType: 'secretary_agenda_item',
      title: 'Review this calendar conflict',
      body: 'The requested time overlaps an existing commitment. Nothing was written to the calendar.',
      actionButtons: [{ id: 'open_detail', label: 'Review commitments', style: 'primary' }],
      deeplink: `nexus://secretary/conflict/${agenda.agendaItemId}`,
      dedupeKey: `secretary:calendar-command-conflict:${requestHash}`,
      requiresUserAction: true,
      decisionDeadline: input.start,
      expiresAt: input.end,
      deliveryPolicy: 'in_app_only',
      privacyPolicy: 'sensitive',
      visibilityScope: 'user_private',
      decisionContext: {
        entityTitle: 'Secretary calendar request',
        currentStartAt: input.start,
        currentEndAt: input.end,
        reasonCodes: ['calendar_time_overlap', 'provider_write_withheld', 'review_required'],
        sourceState: 'conflict_detected',
        providerName: input.source,
        providerSyncState: agenda.providerSyncState,
        providerSyncUpdatedAt: agenda.updatedAt,
        contextObservedAt: observedAtIso,
        contextExpiresAt: input.end,
        timezone: input.timezone,
        recipe: 'calendar_command_conflict_v1',
        normalizedAction,
        conflictEvaluation,
        conflictComparisons,
      },
    });
    if (created.item) return created.item.itemId;
    // An exact duplicate points at an already-open canonical decision. A
    // rejection cooldown does not: it means the earlier candidate was closed,
    // so treating it as represented would strand this conflict behind a
    // terminal receipt with no review item.
    const safelyRepresented = (created.eligibility.reasons ?? []).some((reason) =>
      reason === 'conflict_policy:duplicate');
    if (safelyRepresented) return null;
    throw new Error('SECRETARY_CALENDAR_DECISION_REVIEW_NOT_PERSISTED');
  } catch (error) {
    logger.warn({
      errorName: error instanceof Error ? error.name : typeof error,
      userId: input.userId,
      tenantId: input.tenantId,
    }, 'Calendar conflict remained blocked but Decision Center projection failed');
    throw new SecretaryCalendarCommandError(
      'CALENDAR_DECISION_REVIEW_PENDING',
      'The conflict is blocked, but its Decision Center review could not be persisted yet.',
      503,
      ['CALENDAR_DECISION_REVIEW_PENDING'],
    );
  }
}

function createInjectedProviderAdapter(
  source: CalendarSource,
  io: SecretaryCalendarCommandCalendarIo,
): SecretaryAgendaProviderAdapter {
  return {
    source,
    async createEvent(input) {
      const command = getSecretaryCalendarCommandPayloadForAgendaItem(input.agendaItemId);
      const marker = `NEXUS_SECRETARY_AGENDA_ITEM:${input.agendaItemId}`;
      const event = await io.createEvent({
        title: input.title,
        start: input.startAt,
        end: input.endAt,
        description: [command?.description, marker].filter(Boolean).join('\n\n'),
        categories: command?.categories,
        attendees: command?.attendees,
        location: command?.location,
        recurrence: command?.recurrence,
      }, source, input.ownerUserId, { tenantId: Number(input.tenantId) });
      return toProviderEvent(event, input);
    },
    async updateEvent() {
      throw new Error('SECRETARY_CALENDAR_INJECTED_ADAPTER_UPDATE_UNAVAILABLE');
    },
    async deleteEvent() {
      throw new Error('SECRETARY_CALENDAR_INJECTED_ADAPTER_DELETE_UNAVAILABLE');
    },
  };
}

async function verifyInjectedProviderReadback(
  input: ReturnType<typeof normalizeInput>,
  providerEventId: string,
  io: SecretaryCalendarCommandCalendarIo,
): Promise<UnifiedCalendarEvent> {
  let events: UnifiedCalendarEvent[];
  try {
    events = await io.getEventsForSources(input.start, input.end, input.userId, [input.source]);
  } catch {
    throw new SecretaryCalendarCommandError(
      'CALENDAR_SYNC_PENDING',
      'The provider accepted the command but read-back is not yet available.',
      409,
      ['CALENDAR_SYNC_PENDING', 'CALENDAR_READBACK_UNAVAILABLE'],
    );
  }
  // The provider ID returned by the write is the only authoritative identity.
  // A title/time fallback can bind an older recurring or duplicated event to
  // this receipt while provider indexing is still catching up.
  const matched = events.find((event) => event.source === input.source
    && event.id === providerEventId);
  if (!matched) {
    throw new SecretaryCalendarCommandError(
      'CALENDAR_SYNC_PENDING',
      'The provider accepted the command but read-back could not verify it yet.',
      409,
      ['CALENDAR_SYNC_PENDING', 'CALENDAR_READBACK_MISMATCH'],
    );
  }
  return { ...matched, syncedSources: matched.syncedSources ?? [matched.source] };
}

async function verifyProviderAdapterReadback(
  input: ReturnType<typeof normalizeInput>,
  agendaItemId: string | null,
  providerEventId: string,
  adapter: SecretaryAgendaProviderAdapter,
): Promise<UnifiedCalendarEvent> {
  if (!agendaItemId || !adapter.getEvent) {
    return failCalendarCommandReadbackUnavailable();
  }
  const agendaItem = getSecretaryAgendaItemById({
    agendaItemId,
    ownerUserId: input.userId,
    tenantId: input.tenantId,
  });
  if (!agendaItem) return failCalendarCommandReadbackUnavailable();

  let readback: Awaited<ReturnType<NonNullable<SecretaryAgendaProviderAdapter['getEvent']>>>;
  try {
    readback = await adapter.getEvent(providerEventId, toProviderEventInput(agendaItem));
  } catch {
    return failCalendarCommandReadbackUnavailable();
  }
  if (readback.status === 'unknown') return failCalendarCommandReadbackUnavailable();
  if (readback.status !== 'found'
    || readback.event.eventId !== providerEventId
    || readback.event.source !== input.source
    || typeof readback.event.title !== 'string'
    || !readback.event.title.trim()
    || typeof readback.event.startAt !== 'string'
    || !Number.isFinite(Date.parse(readback.event.startAt))
    || typeof readback.event.endAt !== 'string'
    || !Number.isFinite(Date.parse(readback.event.endAt))) {
    throw new SecretaryCalendarCommandError(
      'CALENDAR_SYNC_PENDING',
      'The provider accepted the command but exact read-back could not verify it yet.',
      409,
      ['CALENDAR_SYNC_PENDING', 'CALENDAR_READBACK_MISMATCH'],
    );
  }
  return {
    id: readback.event.eventId,
    source: readback.event.source,
    syncedSources: [readback.event.source],
    summary: readback.event.title,
    start: readback.event.startAt,
    end: readback.event.endAt,
  };
}

function failCalendarCommandReadbackUnavailable(): never {
  throw new SecretaryCalendarCommandError(
    'CALENDAR_SYNC_PENDING',
    'The provider accepted the command but exact read-back is not yet available.',
    409,
    ['CALENDAR_SYNC_PENDING', 'CALENDAR_READBACK_UNAVAILABLE'],
  );
}

function toProviderEvent(
  event: UnifiedCalendarEvent,
  input: SecretaryProviderEventInput,
): SecretaryProviderEvent {
  return {
    eventId: event.id,
    source: event.source,
    agendaItemId: input.agendaItemId,
    title: event.summary,
    startAt: event.start,
    endAt: event.end,
    version: input.version,
  };
}

function replayReceipt(receipt: SecretaryCalendarCommandReceipt): SecretaryCalendarCommandResult | null {
  if (receipt.state !== 'succeeded' && receipt.state !== 'review_required') return null;
  const status = receipt.state === 'succeeded' ? 'succeeded' : 'review_required';
  const event = receipt.response?.event as UnifiedCalendarEvent | undefined;
  const warningCodes = Array.isArray(receipt.response?.warningCodes)
    ? receipt.response!.warningCodes.filter((value): value is string => typeof value === 'string')
    : status === 'review_required' ? ['CALENDAR_CONFLICT_REVIEW_REQUIRED'] : [];
  return { status, replayed: true, ...(event ? { event } : {}), warningCodes };
}

function overlaps(start: string, end: string, otherStart: string, otherEnd: string): boolean {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const otherStartMs = Date.parse(otherStart);
  const otherEndMs = Date.parse(otherEnd);
  return Number.isFinite(otherStartMs)
    && Number.isFinite(otherEndMs)
    && startMs < otherEndMs
    && otherStartMs < endMs;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}
