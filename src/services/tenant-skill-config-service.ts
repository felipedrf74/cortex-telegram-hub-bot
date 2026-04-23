// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant-scoped, skill-scoped configuration.
 *
 * Added 2026-04-22 as part of OI-DATA-003 on branch
 * feature/nexus-hub-portal-uiux-admin-user-console.
 *
 * ## Purpose
 *
 * Each skill (content / secretary / training / finance / cooking)
 * can carry tenant-level preferences. Example: the Content skill's
 * voice guidelines, default target platform, whether to auto-publish
 * vs keep as draft. Before this service shipped, these edits lived
 * only in iOS; the Configuration tab on each skill page in the
 * User Console was an empty-state link-out.
 *
 * ## Schema contract
 *
 * Per-skill schema is declared here as a TypeScript validator
 * (CONTENT_SCHEMA / SECRETARY_SCHEMA / ...). The storage is
 * generic JSON (see migration 080) but this service refuses to
 * persist any key the skill hasn't declared. This prevents:
 *   - schema drift (a UI bug writing { foo: 'bar' } into config)
 *   - namespace collisions (two skills writing the same key)
 *   - unvalidated types reaching the pipeline layer that reads
 *     the config downstream
 *
 * ## Authz
 *
 * This service does NOT enforce auth — callers do.
 *   - Routes (/workspace/skills/:id/config) use `requireTenantAdmin`
 *     on PUT and plain member auth on GET.
 *   - Service methods take `actorUserId` only to stamp
 *     `updated_by` on writes.
 *
 * ## Scope cut (v1)
 *
 * Only the Content skill has a real schema in this pass. Secretary
 * / Training / Finance / Cooking have placeholder empty schemas —
 * they read and write fine but reject any field (so the service is
 * a safe no-op for those until we design their schemas). This is
 * deliberate: wiring 5 skill UIs in one commit bloats review.
 */

import { getDb } from './database';
import { logger } from '../utils/logger';

// ── Per-skill schema registry ──────────────────────────────────────

/** Recognised skill ids. Matches domains + skills directories. */
export type SkillId =
  | 'content'
  | 'secretary'
  | 'training'
  | 'finance'
  | 'cooking';

const ALLOWED_SKILLS: readonly SkillId[] = ['content', 'secretary', 'training', 'finance', 'cooking'];

export function isSkillId(x: unknown): x is SkillId {
  return typeof x === 'string' && (ALLOWED_SKILLS as readonly string[]).includes(x);
}

/**
 * A per-field validator. `parse` returns the cleaned value or throws.
 * Returning `undefined` means "caller didn't supply; omit from saved
 * blob" — distinct from null which means "explicitly clear".
 */
interface FieldValidator {
  parse(raw: unknown): unknown;   // cleaned value or throws on bad input
  defaultValue(): unknown;        // rendered for a fresh tenant
}

// ── Generic helpers used by multiple schemas ──────────────────────

function stringField(opts: { maxLength?: number; enumValues?: readonly string[]; default?: string } = {}): FieldValidator {
  const maxLength = opts.maxLength ?? 1024;
  const enumValues = opts.enumValues;
  const def = opts.default ?? '';
  return {
    parse(raw: unknown): unknown {
      if (raw === null || raw === undefined || raw === '') return null;
      if (typeof raw !== 'string') throw new SkillConfigError('BAD_REQUEST', 'field must be a string or null');
      const trimmed = raw.trim();
      if (trimmed.length > maxLength) {
        throw new SkillConfigError('BAD_REQUEST', `field too long (max ${maxLength} chars)`);
      }
      if (enumValues && !enumValues.includes(trimmed)) {
        throw new SkillConfigError('BAD_REQUEST', `field must be one of: ${enumValues.join(', ')}`);
      }
      return trimmed;
    },
    defaultValue(): unknown { return def; },
  };
}

function booleanField(defaultValue = false): FieldValidator {
  return {
    parse(raw: unknown): unknown {
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== 'boolean') throw new SkillConfigError('BAD_REQUEST', 'field must be a boolean or null');
      return raw;
    },
    defaultValue(): unknown { return defaultValue; },
  };
}

// ── Content skill schema (real in v1) ──────────────────────────────

const CONTENT_PLATFORMS = ['general', 'blog', 'twitter', 'linkedin', 'youtube', 'newsletter'] as const;
const CONTENT_LENGTHS = ['concise', 'balanced', 'detailed'] as const;
const CONTENT_REFERENCE_POLICIES = ['always', 'when_relevant', 'never'] as const;

const CONTENT_SCHEMA: Record<string, FieldValidator> = {
  voice_guidelines:            stringField({ maxLength: 4000 }),
  default_platform:            stringField({ enumValues: CONTENT_PLATFORMS, default: 'general' }),
  output_length:               stringField({ enumValues: CONTENT_LENGTHS, default: 'balanced' }),
  include_references_policy:   stringField({ enumValues: CONTENT_REFERENCE_POLICIES, default: 'when_relevant' }),
  auto_publish:                booleanField(false),
  extra_notes:                 stringField({ maxLength: 2000 }),
};

// ── Secretary skill schema (OI-DATA-003a, 2026-04-23) ─────────────
//
// Secretary is the background operator of the user's day — reads
// calendars, applies priority rules, protects focus blocks, hands
// context to other skills. The schema mirrors Content's 6-field
// shape for consistency: one free-text (daily_routines, 4000), one
// more free-text (priority_rules, 2000), 3 enums, one extra_notes.

const SECRETARY_FOCUS_POLICIES = ['none', 'mornings', 'afternoons', 'all_day', 'custom'] as const;
const SECRETARY_CALENDARS = ['google', 'outlook', 'icloud', 'none'] as const;
const SECRETARY_INTERRUPTION = ['low', 'medium', 'high'] as const;

const SECRETARY_SCHEMA: Record<string, FieldValidator> = {
  daily_routines:          stringField({ maxLength: 4000 }),
  priority_rules:          stringField({ maxLength: 2000 }),
  focus_block_policy:      stringField({ enumValues: SECRETARY_FOCUS_POLICIES, default: 'none' }),
  primary_calendar:        stringField({ enumValues: SECRETARY_CALENDARS, default: 'none' }),
  interruption_tolerance:  stringField({ enumValues: SECRETARY_INTERRUPTION, default: 'medium' }),
  extra_notes:             stringField({ maxLength: 2000 }),
};

// ── Training skill schema (OI-DATA-003b, 2026-04-23) ──────────────
//
// Training merges Garmin/Strava/Whoop telemetry with schedule
// awareness from Secretary. Per CLAUDE.md the legacy 'triathlon'
// skill is being split into gym/running/cycle/swim in Phase 1; this
// single-skill schema serves today and is forward-compatible —
// sub-skills will carry their own tenant_skill_config rows under
// new skill ids and inherit this shape.

const TRAINING_DAYS_POLICIES = ['daily', 'six_days', 'five_days', 'four_days', 'three_days'] as const;
const TRAINING_RECOVERY_PRIORITY = ['maximum', 'balanced', 'push_hard'] as const;

const TRAINING_SCHEMA: Record<string, FieldValidator> = {
  goals:                     stringField({ maxLength: 2000 }),
  equipment_available:       stringField({ maxLength: 2000 }),
  constraints_and_injuries:  stringField({ maxLength: 2000 }),
  preferred_training_days:   stringField({ enumValues: TRAINING_DAYS_POLICIES, default: 'four_days' }),
  recovery_priority:         stringField({ enumValues: TRAINING_RECOVERY_PRIORITY, default: 'balanced' }),
  extra_notes:               stringField({ maxLength: 2000 }),
};

// ── Finance skill schema (OI-DATA-003c, 2026-04-23) ───────────────
//
// Finance keeps a lightweight model of budget + categories + rules
// and answers "can I afford this?" for other skills (Cooking meal
// cost, Training gear purchases). Same 6-field shape as Training:
// 3 free-text + 2 enums + extra_notes.
//
// Currency note: this is NOT an ISO-4217 authority — it's a display-
// context hint to downstream skills. 6 common codes + 'other' escape
// hatch. Full ISO handling would be a downstream feature.

const FINANCE_CURRENCIES = ['USD', 'EUR', 'BRL', 'GBP', 'JPY', 'other'] as const;
const FINANCE_DECISION_STYLES = ['conservative', 'balanced', 'risk_tolerant'] as const;

const FINANCE_SCHEMA: Record<string, FieldValidator> = {
  budget_monthly:        stringField({ maxLength: 2000 }),
  saving_goals:          stringField({ maxLength: 2000 }),
  affordability_rules:   stringField({ maxLength: 2000 }),
  primary_currency:      stringField({ enumValues: FINANCE_CURRENCIES, default: 'USD' }),
  decision_style:        stringField({ enumValues: FINANCE_DECISION_STYLES, default: 'balanced' }),
  extra_notes:           stringField({ maxLength: 2000 }),
};

// ── Cooking skill schema (OI-DATA-003d, 2026-04-23) ───────────────
//
// Cooking plans meals against dietary constraints, available
// equipment, and budget. Cross-skill consumer of Finance (cost
// context) and Training (nutrition sync when active).
//
// Note: dietary_restrictions is the HARD constraint (allergies can
// be dangerous); preferences is SOFT. Home dependency gates on
// restrictions, not preferences — Cooking can't safely plan
// anything without knowing what the user can't eat.

const COOKING_SERVING_SIZES = ['1', '2', '3', '4', '5_plus'] as const;
const COOKING_COST_CEILINGS = ['budget', 'moderate', 'premium', 'no_limit'] as const;

const COOKING_SCHEMA: Record<string, FieldValidator> = {
  dietary_restrictions:  stringField({ maxLength: 2000 }),
  preferences:           stringField({ maxLength: 2000 }),
  kitchen_inventory:     stringField({ maxLength: 2000 }),
  serving_size:          stringField({ enumValues: COOKING_SERVING_SIZES, default: '2' }),
  meal_cost_ceiling:     stringField({ enumValues: COOKING_COST_CEILINGS, default: 'moderate' }),
  extra_notes:           stringField({ maxLength: 2000 }),
};

// ── Schema registry ──────────────────────────────────────────────
// All 5 skills now have real schemas (the OI-DATA-003* arc).
// If a new skill is ever added to SkillId, the TypeScript compiler
// will force an entry here via Record<SkillId, ...>.
const SCHEMAS: Record<SkillId, Record<string, FieldValidator>> = {
  content: CONTENT_SCHEMA,
  secretary: SECRETARY_SCHEMA,
  training: TRAINING_SCHEMA,
  finance: FINANCE_SCHEMA,
  cooking: COOKING_SCHEMA,
};

// Export for UI introspection / tests.
export function getSkillSchemaKeys(skillId: SkillId): string[] {
  return Object.keys(SCHEMAS[skillId] || {});
}

export function isKnownField(skillId: SkillId, key: string): boolean {
  const schema = SCHEMAS[skillId];
  return schema ? Object.prototype.hasOwnProperty.call(schema, key) : false;
}

// ── Error type ─────────────────────────────────────────────────────

export type SkillConfigErrorCode = 'NOT_FOUND' | 'BAD_REQUEST' | 'DB_ERROR' | 'UNKNOWN_SKILL';

export class SkillConfigError extends Error {
  readonly code: SkillConfigErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: SkillConfigErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'SkillConfigError';
    this.code = code;
    this.details = details;
  }
}

// ── Row shape ─────────────────────────────────────────────────────

export interface SkillConfigRow {
  tenantId: number;
  skillId: SkillId;
  config: Record<string, unknown>;
  updatedBy: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  tenant_id: number;
  skill_id: string;
  config_json: string;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
}

function parseConfigJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapRow(r: RawRow): SkillConfigRow {
  return {
    tenantId: r.tenant_id,
    skillId: r.skill_id as SkillId,
    config: parseConfigJson(r.config_json),
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ── Read ──────────────────────────────────────────────────────────

/**
 * Returns the stored config merged with schema defaults — callers
 * always see a fully-populated object, never need to null-check
 * individual fields. If no row exists yet, returns an empty
 * `config` that still has the default structure.
 */
export function getSkillConfig(tenantId: number, skillId: SkillId): SkillConfigRow {
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new SkillConfigError('BAD_REQUEST', 'tenantId must be a positive integer');
  }
  if (!isSkillId(skillId)) {
    throw new SkillConfigError('UNKNOWN_SKILL', 'unknown skill', { skillId });
  }

  let row: RawRow | undefined;
  try {
    row = getDb()
      .prepare('SELECT * FROM tenant_skill_config WHERE tenant_id = ? AND skill_id = ?')
      .get(tenantId, skillId) as RawRow | undefined;
  } catch (err) {
    logger.error({ err, tenantId, skillId }, 'tenant-skill-config-service: getSkillConfig failed');
    throw new SkillConfigError('DB_ERROR', 'Failed to load skill config');
  }

  const stored = row ? mapRow(row) : {
    tenantId, skillId, config: {}, updatedBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Merge stored values over schema defaults. Keys the stored blob
  // doesn't carry fall back to the schema's defaultValue(). This
  // means the UI can render a form that's always populated, even
  // for a fresh tenant that never saved config.
  const schema = SCHEMAS[skillId];
  const merged: Record<string, unknown> = {};
  for (const [key, validator] of Object.entries(schema)) {
    merged[key] = Object.prototype.hasOwnProperty.call(stored.config, key)
      ? stored.config[key]
      : validator.defaultValue();
  }
  return { ...stored, config: merged };
}

// ── Write ─────────────────────────────────────────────────────────

/**
 * Saves (upserts) a skill config. `patch` is a subset of the schema
 * keys — any keys the patch doesn't mention are left unchanged.
 * Unknown keys throw BAD_REQUEST.
 *
 * Caller is responsible for role check (route uses requireTenantAdmin).
 */
export function putSkillConfig(
  tenantId: number,
  skillId: SkillId,
  actorUserId: number,
  patch: Record<string, unknown>,
): SkillConfigRow {
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    throw new SkillConfigError('BAD_REQUEST', 'tenantId must be a positive integer');
  }
  if (!isSkillId(skillId)) {
    throw new SkillConfigError('UNKNOWN_SKILL', 'unknown skill', { skillId });
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new SkillConfigError('BAD_REQUEST', 'patch must be a plain object');
  }

  const schema = SCHEMAS[skillId];
  const schemaKeys = Object.keys(schema);
  // Reject unknown keys up front so callers see the list of accepted
  // keys rather than having fields silently dropped.
  const unknownKeys = Object.keys(patch).filter((k) => !schemaKeys.includes(k));
  if (unknownKeys.length > 0) {
    throw new SkillConfigError(
      'BAD_REQUEST',
      `Unknown fields for skill '${skillId}': ${unknownKeys.join(', ')}`,
      { skillId, unknownKeys, allowed: schemaKeys },
    );
  }

  // For skills with an empty schema (v1 scope cut), patch must be empty.
  if (schemaKeys.length === 0 && Object.keys(patch).length > 0) {
    throw new SkillConfigError(
      'BAD_REQUEST',
      `Skill '${skillId}' has no configurable fields yet — edit in iOS for now`,
      { skillId },
    );
  }

  // Validate every supplied key.
  const cleaned: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    cleaned[key] = schema[key].parse(raw);
  }

  // Merge patch over existing stored config so unspecified fields
  // keep their value.
  const existing = getSkillConfig(tenantId, skillId);
  const merged: Record<string, unknown> = { ...existing.config, ...cleaned };

  try {
    getDb()
      .prepare(
        `INSERT INTO tenant_skill_config (tenant_id, skill_id, config_json, updated_by, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT (tenant_id, skill_id) DO UPDATE SET
           config_json = excluded.config_json,
           updated_by  = excluded.updated_by,
           updated_at  = excluded.updated_at`,
      )
      .run(tenantId, skillId, JSON.stringify(merged), actorUserId);
  } catch (err) {
    logger.error({ err, tenantId, skillId, actorUserId }, 'tenant-skill-config-service: putSkillConfig failed');
    throw new SkillConfigError('DB_ERROR', 'Failed to save skill config');
  }

  return getSkillConfig(tenantId, skillId);
}
