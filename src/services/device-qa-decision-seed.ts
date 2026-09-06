// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash, randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { getDb } from './database';
import {
  getUserById,
  getUserLanguageById,
  getUserTimezoneById,
  isOwnerUserRef,
  type User,
} from './user-service';
import {
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  getDecisionItem,
  type DecisionApiItem,
} from './decision-center';
import type { DecisionEligibilityResult } from './decision-center/types';
import { getSecretaryAgendaItemById } from './secretary-scheduling-arbitrator';

export const DEVICE_QA_DISPLAY_NAME = 'DeviceQA';
export const DEVICE_QA_SEED_DEDUPE_PREFIX = 'device-qa:dc-seed:secretary:';
export const DEVICE_QA_EMAILS_ENV = 'NEXUS_DEVICE_QA_EMAILS';

export interface DeviceQaSeedPrincipalInput {
  userId: number;
  tenantId: number;
  user?: Pick<User, 'id' | 'first_name' | 'email' | 'status' | 'tier'> | null;
  env?: NodeJS.ProcessEnv;
}

export interface DeviceQaApproveGatedSeedInput {
  userId: number;
  tenantId: number;
  idempotencyKey: string;
  proposalRequestFingerprint: string;
}

const AGENDA_TITLE = 'QA focus block';
const WINDOW_MINUTES = 45;

export function parseDeviceQaAllowedEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[DEVICE_QA_EMAILS_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return [...new Set(
    raw.split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.includes('@') && !value.includes(' ')),
  )];
}

export function isDeviceQaSeedPrincipal(input: DeviceQaSeedPrincipalInput): boolean {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) return false;
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId !== input.userId) return false;
  if (isOwnerUserRef(input.userId)) return false;
  const user = input.user === undefined ? getUserById(input.userId) : input.user;
  if (!user || user.id !== input.userId) return false;
  if (user.status && user.status !== 'active') return false;
  if (user.tier === 'owner') return false;
  const firstName = (user.first_name ?? '').trim().toLowerCase();
  if (firstName !== DEVICE_QA_DISPLAY_NAME.toLowerCase()) return false;
  const allowedEmails = parseDeviceQaAllowedEmails(input.env ?? process.env);
  if (allowedEmails.length > 0) {
    const email = (user.email ?? '').trim().toLowerCase();
    if (!email || !allowedEmails.includes(email)) return false;
  }
  return true;
}

export async function seedDeviceQaApproveGatedDecision(
  input: DeviceQaApproveGatedSeedInput,
): Promise<{
  item: DecisionApiItem | null;
  eligibility: DecisionEligibilityResult;
}> {
  if (!isDeviceQaSeedPrincipal({ userId: input.userId, tenantId: input.tenantId })) {
    throw new DeviceQaDecisionSeedError('DEVICE_QA_SEED_FORBIDDEN', 'Decision fixtures are internal service events');
  }

  const existing = findOpenDeviceQaSeed(input.userId, input.tenantId);
  if (existing) return existing;

  const timezone = getUserTimezoneById(input.userId);
  const locale = getUserLanguageById(input.userId);
  const now = DateTime.now().setZone(timezone);
  const currentStart = now.plus({ hours: 2 }).startOf('minute');
  const currentEnd = currentStart.plus({ minutes: WINDOW_MINUTES });
  const recommendedStart = currentStart.plus({ hours: 2 });
  const recommendedEnd = recommendedStart.plus({ minutes: WINDOW_MINUTES });
  const currentStartAt = currentStart.toISO()!;
  const currentEndAt = currentEnd.toISO()!;
  const recommendedStartAt = recommendedStart.toISO()!;
  const recommendedEndAt = recommendedEnd.toISO()!;
  const seedId = randomUUID();
  const agendaItemId = `dqa_${input.userId}_${seedId.slice(0, 12)}`;
  persistProposedSecretaryAgenda({
    agendaItemId,
    sourceIntentId: `${DEVICE_QA_SEED_DEDUPE_PREFIX}${input.userId}:${seedId}`,
    userId: input.userId,
    tenantId: input.tenantId,
    startAt: currentStartAt,
    endAt: currentEndAt,
    nowIso: now.toUTC().toISO()!,
  });
  const agenda = getSecretaryAgendaItemById({
    agendaItemId,
    ownerUserId: input.userId,
    tenantId: input.tenantId,
  });
  if (!agenda) {
    throw new DeviceQaDecisionSeedError(
      'DEVICE_QA_SEED_AGENDA_MISSING',
      'DeviceQA Decision Center seed could not persist a local Secretary agenda item',
    );
  }

  const fixture = buildSkillDecisionFixtureIntent('secretary', input.userId, {
    tenantId: input.tenantId,
    type: 'conflict_detected',
    priority: 'time_sensitive',
    relatedEntityId: agenda.agendaItemId,
    relatedEntityType: 'secretary_agenda_item',
    title: 'Schedule conflict needs review',
    body: 'A schedule conflict needs your decision.',
    actionButtons: [
      { id: 'accept_reflow', label: 'Aprovar', style: 'primary', mutating: true },
      { id: 'open_detail', label: 'Review', style: 'secondary' },
    ],
    requiresUserAction: true,
    deliveryPolicy: 'in_app_only',
    privacyPolicy: 'standard',
    visibilityScope: 'user_private',
    dedupeKey: `${DEVICE_QA_SEED_DEDUPE_PREFIX}${input.userId}`,
    decisionDeadline: recommendedStartAt,
    expiresAt: now.plus({ days: 1 }).toUTC().toISO()!,
    decisionContext: {
      entityTitle: AGENDA_TITLE,
      currentStartAt,
      currentEndAt,
      recommendedStartAt,
      recommendedEndAt,
      candidateSlots: [{
        startAt: recommendedStartAt,
        endAt: recommendedEndAt,
        label: 'Later today',
        classification: 'available',
      }],
      reasonCodes: ['calendar_time_overlap', 'device_qa_seed'],
      sourceState: 'conflict_detected',
      recipe: 'device_qa_secretary_seed_v1',
      timezone,
      locale,
      contextObservedAt: now.toUTC().toISO()!,
      providerSyncState: agenda.providerSyncState,
    },
  });

  return createDecisionIntent({
    ...fixture,
    idempotencyKey: input.idempotencyKey,
    channel: 'rest',
    proposalRequestFingerprint: input.proposalRequestFingerprint,
  });
}

export class DeviceQaDecisionSeedError extends Error {
  constructor(
    readonly code: 'DEVICE_QA_SEED_FORBIDDEN' | 'DEVICE_QA_SEED_AGENDA_MISSING',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceQaDecisionSeedError';
  }
}

function findOpenDeviceQaSeed(
  userId: number,
  tenantId: number,
): { item: DecisionApiItem; eligibility: DecisionEligibilityResult } | null {
  let row: { itemId: string } | undefined;
  try {
    row = getDb().prepare(`
      SELECT item_id AS itemId
        FROM notification_center_items
       WHERE user_id = ?
         AND tenant_id = ?
         AND source_skill = 'secretary'
         AND dedupe_key = ?
         AND status IN ('unread', 'read', 'failed', 'snoozed')
       ORDER BY created_at DESC
       LIMIT 1
    `).get(userId, tenantId, `${DEVICE_QA_SEED_DEDUPE_PREFIX}${userId}`) as { itemId: string } | undefined;
  } catch {
    return null;
  }
  if (!row?.itemId) return null;
  const item = getDecisionItem(row.itemId, userId, tenantId);
  if (!item) return null;
  return {
    item,
    eligibility: {
      classification: 'decision',
      reasons: ['device_qa_seed_existing_open'],
      apnsEligible: false,
      urgency: item.urgency,
    },
  };
}

function persistProposedSecretaryAgenda(input: {
  agendaItemId: string;
  sourceIntentId: string;
  userId: number;
  tenantId: number;
  startAt: string;
  endAt: string;
  nowIso: string;
}): void {
  const sourceShapeHash = createHash('sha256')
    .update(JSON.stringify({
      seed: 'device_qa_secretary_seed_v1',
      userId: input.userId,
      tenantId: input.tenantId,
      sourceIntentId: input.sourceIntentId,
      startAt: input.startAt,
      endAt: input.endAt,
    }))
    .digest('hex')
    .slice(0, 32);
  getDb().prepare(`
    INSERT INTO secretary_agenda_items (
      agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
      source_entity_id, source_entity_type, owner_user_id, tenant_id,
      lifecycle_state, provider_sync_state, version, title, start_at, end_at,
      duration_minutes, decision_action, decision_reason_codes_json, decision_explanation,
      source_shape_hash, scheduled_segments_json, created_at, updated_at
    ) VALUES (
      ?, ?, 'secretary', 'device_qa_seed', 'protect_time_for_this',
      ?, 'device_qa_seed', ?, ?,
      'proposed', 'not_synced', 1, ?, ?, ?,
      ?, 'deferred', '[]', 'DeviceQA Decision Center seed',
      ?, '[]', ?, ?
    )
  `).run(
    input.agendaItemId,
    input.sourceIntentId,
    input.agendaItemId,
    input.userId,
    String(input.tenantId),
    AGENDA_TITLE,
    input.startAt,
    input.endAt,
    WINDOW_MINUTES,
    sourceShapeHash,
    input.nowIso,
    input.nowIso,
  );
}
