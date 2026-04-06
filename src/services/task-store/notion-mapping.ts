// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Notion Database Mapping (TASK-16b)
 *
 * Notion databases are user-defined: every user models tasks differently.
 * One person has "Task Name" + "Status" + "Due", another has "Title" +
 * "State" + "Deadline" + "Priority". The Notion adapter can't sync until
 * the user tells us which property is which.
 *
 * This module owns the mapping records — they live in `kv_store` keyed by
 * `notion_mapping:<userId>:<databaseId>` so we don't need a new SQL table.
 * One user can map multiple databases (e.g., "Work Tasks" and "Personal").
 */

import { getDb } from '../database';
import { logger } from '../../utils/logger';
import { NormalizedStatus } from './types';

export interface NotionDatabaseMapping {
  userId: number;
  databaseId: string;
  databaseName: string;
  /** The Notion property holding the page title (always title-type). */
  titleProperty: string;
  /** Property holding the status (select OR status type, configurable). */
  statusProperty: string;
  /** How each Notion status value maps to a NormalizedStatus. */
  statusMapping: Record<string, NormalizedStatus>;
  dueDateProperty?: string;
  priorityProperty?: string;
  tagsProperty?: string;
}

const KEY_PREFIX = 'notion_mapping:';
const ACTIVE_KEY_PREFIX = 'notion_active_db:';

function key(userId: number, databaseId: string): string {
  return `${KEY_PREFIX}${userId}:${databaseId}`;
}

/**
 * Save (or upsert) a database mapping. Stored as JSON in kv_store so we
 * can serve it without a schema migration.
 */
export function saveDatabaseMapping(mapping: NotionDatabaseMapping): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run(key(mapping.userId, mapping.databaseId), JSON.stringify(mapping));
    logger.info({ userId: mapping.userId, databaseId: mapping.databaseId }, 'Notion mapping saved');
  } catch (err) {
    logger.warn({ err }, 'Failed to save Notion mapping');
    throw err;
  }
}

/** Get all mappings for a user (one user can map multiple databases). */
export function getDatabaseMappings(userId: number): NotionDatabaseMapping[] {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT value FROM kv_store WHERE key LIKE ?`,
    ).all(`${KEY_PREFIX}${userId}:%`) as { value: string }[];
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.value) as NotionDatabaseMapping;
        } catch {
          return null;
        }
      })
      .filter((m): m is NotionDatabaseMapping => m !== null);
  } catch (err) {
    logger.debug({ err, userId }, 'getDatabaseMappings failed');
    return [];
  }
}

/** Look up a single mapping by id. */
export function getDatabaseMapping(userId: number, databaseId: string): NotionDatabaseMapping | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key(userId, databaseId)) as
      | { value: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as NotionDatabaseMapping;
  } catch {
    return null;
  }
}

/** Delete a mapping (e.g., user disconnects a database). */
export function deleteDatabaseMapping(userId: number, databaseId: string): void {
  try {
    const db = getDb();
    db.prepare('DELETE FROM kv_store WHERE key = ?').run(key(userId, databaseId));
  } catch (err) {
    logger.debug({ err }, 'deleteDatabaseMapping failed');
  }
}

/**
 * Track which database is the user's "active" / default for new task writes
 * (the one createTask targets). Stored separately because it's a single
 * value per user, not per-mapping.
 */
export function setActiveDatabase(userId: number, databaseId: string): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO kv_store (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    ).run(`${ACTIVE_KEY_PREFIX}${userId}`, databaseId);
  } catch (err) {
    logger.debug({ err }, 'setActiveDatabase failed');
  }
}

export function getActiveDatabase(userId: number): string | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(
      `${ACTIVE_KEY_PREFIX}${userId}`,
    ) as { value: string } | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}

// ─── Heuristic mapping inference ──────────────────────────────────

/**
 * Given a Notion database schema (the `properties` object from the API),
 * return a "best guess" mapping the user can review and confirm.
 *
 * The heuristics are intentionally simple and locale-aware: anything matching
 * common English/Portuguese task field names wins. The user always gets to
 * override during the confirmation flow.
 */
export function inferMapping(
  userId: number,
  databaseId: string,
  databaseName: string,
  schema: Record<string, NotionPropertySchema>,
): NotionDatabaseMapping {
  const propsByType = (type: string) =>
    Object.entries(schema)
      .filter(([, def]) => def.type === type)
      .map(([name]) => name);

  // Title is mandatory in Notion — there's exactly one title property per DB.
  const titles = propsByType('title');
  const titleProperty = titles[0] || 'Name';

  // Status: prefer a 'status'-type property, fall back to a 'select' named
  // something status-y. Property names are checked case-insensitively.
  const statusCandidates = [...propsByType('status'), ...propsByType('select')];
  const statusProperty =
    statusCandidates.find((n) => /status|state|estado/i.test(n)) ||
    statusCandidates[0] ||
    '';

  // Build the status value mapping from the DB's actual options
  let statusMapping: Record<string, NormalizedStatus> = {};
  if (statusProperty) {
    const def = schema[statusProperty];
    const options = def?.options || [];
    for (const opt of options) {
      const lower = opt.toLowerCase();
      if (/done|completo|conclu/.test(lower)) statusMapping[opt] = 'completed';
      else if (/progress|doing|fazendo|andamento/.test(lower)) statusMapping[opt] = 'in_progress';
      else if (/cancel/.test(lower)) statusMapping[opt] = 'cancelled';
      else statusMapping[opt] = 'pending';
    }
  }

  // Date: prefer a property whose name screams "due"
  const dueDateProperty =
    propsByType('date').find((n) => /due|deadline|vencimento|prazo/i.test(n)) ||
    propsByType('date')[0];

  // Priority: any property named priority/prioridade
  const priorityProperty =
    [...propsByType('select'), ...propsByType('number')].find((n) =>
      /priority|prioridade/i.test(n),
    ) || undefined;

  // Tags: prefer multi_select named tags/labels
  const tagsProperty =
    propsByType('multi_select').find((n) => /tag|label|categ/i.test(n)) ||
    propsByType('multi_select')[0];

  return {
    userId,
    databaseId,
    databaseName,
    titleProperty,
    statusProperty,
    statusMapping,
    dueDateProperty,
    priorityProperty,
    tagsProperty,
  };
}

/** Property metadata extracted from Notion's database schema response. */
export interface NotionPropertySchema {
  type: string;
  /** For select/multi_select/status types — the option labels. */
  options?: string[];
}

/**
 * Convert a raw Notion `database.properties` object into the simplified
 * schema we use for mapping inference. Drops properties we don't care about
 * (formula, rollup, relation, etc.) and unwraps the option arrays.
 */
export function extractSchema(
  notionProperties: Record<string, any>,
): Record<string, NotionPropertySchema> {
  const out: Record<string, NotionPropertySchema> = {};
  for (const [name, def] of Object.entries(notionProperties)) {
    const type = (def as any)?.type;
    if (!type) continue;
    const schema: NotionPropertySchema = { type };
    if (type === 'select' || type === 'status') {
      schema.options = ((def as any)[type]?.options || []).map((o: any) => o.name);
    } else if (type === 'multi_select') {
      schema.options = ((def as any).multi_select?.options || []).map((o: any) => o.name);
    }
    out[name] = schema;
  }
  return out;
}
