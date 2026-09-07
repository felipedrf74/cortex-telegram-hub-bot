// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Thin internal product-analytics facade for the locked Architecture
 * RETUNE v1.1 event contract. Vendor SDKs stay deferred. This is not
 * api_usage (cost/enforcement truth) and not usage_metering.
 *
 * Event names are a closed set. Properties are enums, ids, and versions
 * only — never email, name, chat/decision body, calendar titles, or
 * other PII.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { getCurrentContext } from '../utils/request-context';
import { getEffectiveEntitlement } from './entitlement';

export const PRODUCT_ANALYTICS_EVENTS = [
  'app_open',
  'onboarding_completed',
  'skill_first_success',
  'decision_center_acted',
  'paywall_viewed',
  'purchase_completed',
  'model_access_denied',
  'day7_retained',
] as const;

export type ProductAnalyticsEventName = (typeof PRODUCT_ANALYTICS_EVENTS)[number];

export const CLIENT_INGEST_EVENTS = [
  'app_open',
  'onboarding_completed',
  'paywall_viewed',
] as const;

export type ClientIngestEventName = (typeof CLIENT_INGEST_EVENTS)[number];

export const PRODUCT_ANALYTICS_SKILLS = [
  'secretary',
  'training',
  'content',
  'cooking',
  'finance',
] as const;

export type ProductAnalyticsSkill = (typeof PRODUCT_ANALYTICS_SKILLS)[number];

export const MODEL_ACCESS_DENIED_CODES = [
  'AI_PLAN_REQUIRED',
  'AI_DAILY_LIMIT_REACHED',
  'AI_MONTHLY_LIMIT_REACHED',
  'SERVICE_DEGRADED',
] as const;

export type ModelAccessDeniedCode = (typeof MODEL_ACCESS_DENIED_CODES)[number];

export const PRODUCT_ANALYTICS_SURFACES = ['ios', 'portal', 'web'] as const;
export type ProductAnalyticsSurface = (typeof PRODUCT_ANALYTICS_SURFACES)[number];

export const PRODUCT_ANALYTICS_PLANS = ['free', 'pro', 'max'] as const;
export const PRODUCT_ANALYTICS_PURCHASE_PROVIDERS = ['apple', 'stripe'] as const;
export const DECISION_CENTER_RESULTS = ['success', 'failure'] as const;
export const PRODUCT_ANALYTICS_LOCALES = ['en', 'en-US', 'pt-BR', 'pt-PT'] as const;

const EVENT_NAME_SET = new Set<string>(PRODUCT_ANALYTICS_EVENTS);
const CLIENT_INGEST_SET = new Set<string>(CLIENT_INGEST_EVENTS);
const SKILL_SET = new Set<string>(PRODUCT_ANALYTICS_SKILLS);
const DENIAL_CODE_SET = new Set<string>(MODEL_ACCESS_DENIED_CODES);
const SURFACE_SET = new Set<string>(PRODUCT_ANALYTICS_SURFACES);
const PLAN_SET = new Set<string>(PRODUCT_ANALYTICS_PLANS);
const PROVIDER_SET = new Set<string>(PRODUCT_ANALYTICS_PURCHASE_PROVIDERS);
const RESULT_SET = new Set<string>(DECISION_CENTER_RESULTS);
const LOCALE_SET = new Set<string>(PRODUCT_ANALYTICS_LOCALES);

const PII_KEY_PATTERN =
  /email|name|chat|body|title|message|prompt|content|calendar|description|notes|phone|address|transcript/i;

const DAY7_MS = 7 * 24 * 60 * 60 * 1000;

export class ProductAnalyticsValidationError extends Error {
  readonly code = 'PRODUCT_ANALYTICS_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'ProductAnalyticsValidationError';
  }
}

export interface ProductAnalyticsEmitInput {
  userId: number;
  tenantId?: number;
  event: ProductAnalyticsEventName;
  properties?: Record<string, unknown>;
  source?: 'ios' | 'portal' | 'web' | 'server';
  idempotencyKey?: string | null;
}

export interface ProductAnalyticsRecord {
  eventId: string;
  userId: number;
  tenantId: number;
  eventName: ProductAnalyticsEventName;
  properties: Record<string, unknown>;
  source: string;
  createdAt: string;
}

export function isProductAnalyticsEventName(value: unknown): value is ProductAnalyticsEventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value);
}

export function isClientIngestEventName(value: unknown): value is ClientIngestEventName {
  return typeof value === 'string' && CLIENT_INGEST_SET.has(value);
}

export function ensureProductAnalyticsTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_analytics_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      event_name TEXT NOT NULL CHECK (event_name IN (
        'app_open',
        'onboarding_completed',
        'skill_first_success',
        'decision_center_acted',
        'paywall_viewed',
        'purchase_completed',
        'model_access_denied',
        'day7_retained'
      )),
      properties_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'server',
      idempotency_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, event_name, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_product_analytics_user_event
      ON product_analytics_events(user_id, event_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_product_analytics_event_created
      ON product_analytics_events(event_name, created_at);
  `);
}

export function validateProductAnalyticsEvent(
  event: unknown,
  properties: unknown,
): { event: ProductAnalyticsEventName; properties: Record<string, unknown> } {
  if (!isProductAnalyticsEventName(event)) {
    throw new ProductAnalyticsValidationError('Unknown analytics event');
  }
  if (properties == null) {
    if (event === 'day7_retained') return { event, properties: {} };
    throw new ProductAnalyticsValidationError('Analytics properties are required');
  }
  if (typeof properties !== 'object' || Array.isArray(properties)) {
    throw new ProductAnalyticsValidationError('Analytics properties must be an object');
  }
  const raw = properties as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (PII_KEY_PATTERN.test(key)) {
      throw new ProductAnalyticsValidationError('Analytics properties must not include PII keys');
    }
  }
  return { event, properties: normalizeProperties(event, raw) };
}

export function emitProductAnalyticsEvent(input: ProductAnalyticsEmitInput): ProductAnalyticsRecord | null {
  try {
    if (!Number.isInteger(input.userId) || input.userId <= 0) return null;
    const validated = validateProductAnalyticsEvent(input.event, input.properties ?? {});
    const tenantId = resolveTenantId(input.tenantId, input.userId);
    const source = input.source ?? 'server';
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
      ?? defaultIdempotencyKey(validated.event, validated.properties);
    const eventId = randomUUID();
    const createdAt = new Date().toISOString();
    const inserted = persistEvent({
      eventId,
      userId: input.userId,
      tenantId,
      eventName: validated.event,
      properties: validated.properties,
      source,
      idempotencyKey,
      createdAt,
    });
    if (!inserted) return null;
    logger.debug(
      {
        event: 'product.analytics',
        analyticsEvent: validated.event,
        userId: input.userId,
        tenantId,
        source,
      },
      'product.analytics',
    );
    const record: ProductAnalyticsRecord = {
      eventId,
      userId: input.userId,
      tenantId,
      eventName: validated.event,
      properties: validated.properties,
      source,
      createdAt,
    };
    if (validated.event === 'app_open') {
      deriveDay7Retained(input.userId, tenantId, createdAt);
    }
    return record;
  } catch (err) {
    if (err instanceof ProductAnalyticsValidationError) throw err;
    logger.debug({ err, event: input.event }, 'product analytics persist skipped');
    return null;
  }
}

export function emitSkillFirstSuccess(userId: number, skill: ProductAnalyticsSkill): void {
  if (!SKILL_SET.has(skill)) return;
  emitProductAnalyticsEvent({
    userId,
    event: 'skill_first_success',
    properties: { skill },
    idempotencyKey: `skill_first_success:${skill}`,
  });
}

export function emitDecisionCenterActed(
  userId: number,
  actionKind: string,
  readBackOk: boolean,
): void {
  if (typeof actionKind !== 'string' || !actionKind.trim()) return;
  emitProductAnalyticsEvent({
    userId,
    event: 'decision_center_acted',
    properties: {
      action_kind: actionKind.trim().slice(0, 64),
      result: readBackOk ? 'success' : 'failure',
    },
  });
}

export function emitModelAccessDenied(userId: number, code: string): void {
  if (!DENIAL_CODE_SET.has(code)) return;
  emitProductAnalyticsEvent({
    userId,
    event: 'model_access_denied',
    properties: { code },
  });
}

export function emitPurchaseCompletedIfEntitled(
  userId: number,
  provider: 'apple' | 'stripe',
): void {
  try {
    const entitlement = getEffectiveEntitlement(userId);
    if (entitlement.plan !== 'pro' && entitlement.plan !== 'max') return;
    if (entitlement.status !== 'active' && entitlement.status !== 'trialing') return;
    const period = entitlement.billingPeriodStart ?? entitlement.subscriptionExpiresAt ?? 'open';
    emitProductAnalyticsEvent({
      userId,
      event: 'purchase_completed',
      properties: {
        plan: entitlement.plan,
        provider,
      },
      idempotencyKey: `purchase_completed:${provider}:${entitlement.plan}:${period}`,
    });
  } catch (err) {
    logger.debug({ err, userId }, 'product analytics purchase emit skipped');
  }
}

export function listProductAnalyticsEvents(
  userId: number,
  eventName?: ProductAnalyticsEventName,
): ProductAnalyticsRecord[] {
  try {
    ensureProductAnalyticsTables();
    const rows = eventName
      ? getDb().prepare(`
          SELECT event_id, user_id, tenant_id, event_name, properties_json, source, created_at
          FROM product_analytics_events
          WHERE user_id = ? AND event_name = ?
          ORDER BY id ASC
        `).all(userId, eventName) as Array<AnalyticsRow>
      : getDb().prepare(`
          SELECT event_id, user_id, tenant_id, event_name, properties_json, source, created_at
          FROM product_analytics_events
          WHERE user_id = ?
          ORDER BY id ASC
        `).all(userId) as Array<AnalyticsRow>;
    return rows.map(mapRow);
  } catch {
    return [];
  }
}

interface AnalyticsRow {
  event_id: string;
  user_id: number;
  tenant_id: number;
  event_name: ProductAnalyticsEventName;
  properties_json: string;
  source: string;
  created_at: string;
}

function mapRow(row: AnalyticsRow): ProductAnalyticsRecord {
  let properties: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.properties_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      properties = parsed as Record<string, unknown>;
    }
  } catch {
    properties = {};
  }
  return {
    eventId: row.event_id,
    userId: row.user_id,
    tenantId: row.tenant_id,
    eventName: row.event_name,
    properties,
    source: row.source,
    createdAt: row.created_at,
  };
}

function persistEvent(input: {
  eventId: string;
  userId: number;
  tenantId: number;
  eventName: ProductAnalyticsEventName;
  properties: Record<string, unknown>;
  source: string;
  idempotencyKey: string | null;
  createdAt: string;
}): boolean {
  const db = getDb();
  ensureProductAnalyticsTables(db);
  const result = db.prepare(`
    INSERT OR IGNORE INTO product_analytics_events (
      event_id, user_id, tenant_id, event_name, properties_json, source, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventId,
    input.userId,
    input.tenantId,
    input.eventName,
    JSON.stringify(input.properties),
    input.source,
    input.idempotencyKey,
    input.createdAt,
  );
  return result.changes > 0;
}

function deriveDay7Retained(userId: number, tenantId: number, openedAtIso: string): void {
  try {
    ensureProductAnalyticsTables();
    const existing = getDb().prepare(`
      SELECT 1 FROM product_analytics_events
      WHERE user_id = ? AND event_name = 'day7_retained'
      LIMIT 1
    `).get(userId);
    if (existing) return;

    const first = getDb().prepare(`
      SELECT created_at FROM product_analytics_events
      WHERE user_id = ? AND event_name = 'app_open'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(userId) as { created_at?: string } | undefined;
    if (!first?.created_at) return;

    const firstMs = Date.parse(toIsoTimestamp(first.created_at));
    const openedMs = Date.parse(openedAtIso);
    if (!Number.isFinite(firstMs) || !Number.isFinite(openedMs)) return;
    if (openedMs - firstMs < DAY7_MS) return;

    emitProductAnalyticsEvent({
      userId,
      tenantId,
      event: 'day7_retained',
      properties: {},
      source: 'server',
      idempotencyKey: 'day7_retained',
    });
  } catch (err) {
    logger.debug({ err, userId }, 'product analytics day7 derivation skipped');
  }
}

function toIsoTimestamp(value: string): string {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
    return `${value.replace(' ', 'T')}Z`;
  }
  return value;
}

function resolveTenantId(tenantId: number | undefined, userId: number): number {
  if (typeof tenantId === 'number' && tenantId > 0) return tenantId;
  const fromContext = getCurrentContext()?.tenantId;
  if (typeof fromContext === 'number' && fromContext > 0) return fromContext;
  return userId;
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, 180);
  return trimmed.length > 0 ? trimmed : null;
}

function defaultIdempotencyKey(
  event: ProductAnalyticsEventName,
  properties: Record<string, unknown>,
): string | null {
  if (event === 'skill_first_success' && typeof properties.skill === 'string') {
    return `skill_first_success:${properties.skill}`;
  }
  if (event === 'onboarding_completed') return 'onboarding_completed';
  if (event === 'day7_retained') return 'day7_retained';
  return null;
}

function normalizeProperties(
  event: ProductAnalyticsEventName,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  switch (event) {
    case 'app_open':
      return {
        app_version: requiredBoundedString(raw.app_version, 'app_version', 64),
        build: requiredBoundedString(raw.build, 'build', 64),
        surface: requiredEnum(raw.surface, SURFACE_SET, 'surface'),
      };
    case 'onboarding_completed':
      return {
        locale: normalizeLocale(raw.locale),
        skipped: requiredBoolean(raw.skipped, 'skipped'),
      };
    case 'skill_first_success': {
      if (raw.skill === 'decision_center') {
        throw new ProductAnalyticsValidationError('skill_first_success must not use decision_center');
      }
      return { skill: requiredEnum(raw.skill, SKILL_SET, 'skill') };
    }
    case 'decision_center_acted':
      return {
        action_kind: requiredBoundedString(raw.action_kind, 'action_kind', 64),
        result: requiredEnum(raw.result, RESULT_SET, 'result'),
      };
    case 'paywall_viewed':
      return {
        plan_shown: requiredBoundedString(raw.plan_shown, 'plan_shown', 32).toLowerCase(),
        trigger: requiredBoundedString(raw.trigger, 'trigger', 32).toLowerCase(),
      };
    case 'purchase_completed':
      return {
        plan: requiredEnum(raw.plan, PLAN_SET, 'plan'),
        provider: requiredEnum(raw.provider, PROVIDER_SET, 'provider'),
      };
    case 'model_access_denied':
      return {
        code: requiredEnum(raw.code, DENIAL_CODE_SET, 'code'),
      };
    case 'day7_retained':
      return {};
    default: {
      const exhaustive: never = event;
      throw new ProductAnalyticsValidationError(`Unsupported analytics event: ${String(exhaustive)}`);
    }
  }
}

function requiredBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ProductAnalyticsValidationError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProductAnalyticsValidationError(`${field} is required`);
  }
  return trimmed.slice(0, max);
}

function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ProductAnalyticsValidationError(`${field} must be a boolean`);
}

function requiredEnum(value: unknown, allowed: Set<string>, field: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ProductAnalyticsValidationError(`${field} is not an allowed value`);
  }
  return value;
}

function normalizeLocale(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProductAnalyticsValidationError('locale must be a string');
  }
  const trimmed = value.trim();
  if (LOCALE_SET.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (lower === 'en' || lower.startsWith('en-')) return 'en';
  if (lower === 'pt-pt' || lower.startsWith('pt-pt')) return 'pt-PT';
  if (lower === 'pt-br' || lower.startsWith('pt-br') || lower === 'pt') return 'pt-BR';
  throw new ProductAnalyticsValidationError('locale is not an allowed value');
}
