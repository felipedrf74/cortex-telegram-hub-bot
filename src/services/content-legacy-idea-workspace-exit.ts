// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Runtime authority for migration 253.
 *
 * The migration retires `notes.domain = content_idea` and `saved_ideas` as
 * writable idea roots. Startup pins the reviewed SQLite object definitions and
 * then evaluates both migration-owned parity views. A same-name no-op trigger
 * or forged `readiness_status = ready` view therefore cannot bypass the gate.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';

type SchemaObjectType = 'table' | 'view' | 'trigger';

interface SchemaObjectIdentity {
  type: SchemaObjectType;
  sha256: string;
}

const CONTENT_LEGACY_IDEA_SCHEMA_OBJECTS: Readonly<Record<string, SchemaObjectIdentity>> = Object.freeze({
  content_legacy_idea_note_ingress_bindings: {
    type: 'table',
    sha256: 'ff7f25ebf9db716d74ca865fd893633698d7962f7d14af18f870b3862bb88f6e',
  },
  content_legacy_idea_note_quarantine: {
    type: 'table',
    sha256: 'f79983e977ea3149761b5d3cc277acd68da47482f6837a90a85dae6cef3200dc',
  },
  content_legacy_saved_idea_ingress_bindings: {
    type: 'table',
    sha256: 'ce494cb5f8605566caf2da2ee76b210f4a3bfd880266a0a8bf1e649208561794',
  },
  content_legacy_saved_idea_quarantine: {
    type: 'table',
    sha256: '9ecbd678c9d281c84e784cc75c79e23a9fdc28ab8eb4d5169cfd4bde2b54ffe0',
  },
  content_legacy_saved_idea_source_state: {
    type: 'view',
    sha256: '90fdd1abc6974e6ad4e59b302161f866b6d49068720272a80daa1d10db586480',
  },
  content_legacy_idea_note_workspace_readiness: {
    type: 'view',
    sha256: 'a3f7bd4a46c224a2e9b10330407076b6ea14710b5044ad68a0210715cdf1eda4',
  },
  content_legacy_saved_idea_workspace_readiness: {
    type: 'view',
    sha256: '6ae9a43ad527113a2823b847af986635db42c36d7daff67862692a14f3a7d1ac',
  },
  trg_content_legacy_idea_note_ingress_scope_insert: {
    type: 'trigger',
    sha256: '8bc249ca325b990891e382b0da7ffa5cb1c2a1b7490867f4f1d53f738802937c',
  },
  trg_content_legacy_idea_note_ingress_immutable_update: {
    type: 'trigger',
    sha256: '0b20394ac4fa7d7328eb1e9e3de2f8402b7712f17913af3dca15a48df2c55c47',
  },
  trg_content_legacy_idea_note_ingress_immutable_delete: {
    type: 'trigger',
    sha256: '9a8a8c8e07ad7a37961065b70f738cdbd77eef1f63f775ba5d9baa9295c1891e',
  },
  trg_content_legacy_idea_note_quarantine_immutable: {
    type: 'trigger',
    sha256: 'c3c1f97cfcaad06eeda3e394bc11536ba8223aa85c43da2fea0d5dbbee5017cb',
  },
  trg_content_legacy_saved_idea_ingress_scope_insert: {
    type: 'trigger',
    sha256: '245f5ce83c103402a7e0e0cb6d2af1dace6a391d4a8f3e2bd6077c928184a9ad',
  },
  trg_content_legacy_saved_idea_ingress_immutable_update: {
    type: 'trigger',
    sha256: 'bc8652bee3b84d3bc9d3c5c81b7e494620a77e8a31382eed3d272c37b816d359',
  },
  trg_content_legacy_saved_idea_ingress_immutable_delete: {
    type: 'trigger',
    sha256: '710d56963ef075cbcecd4d906cfc3c487517b0555fdc8a08102b4134b16129d4',
  },
  trg_content_legacy_saved_idea_quarantine_immutable: {
    type: 'trigger',
    sha256: 'fc8de54485280ea1a85ccc3874fc5fb604e217a52329a6ab450e92012fce69d6',
  },
  trg_notes_content_idea_insert_blocked: {
    type: 'trigger',
    sha256: '73390b52d3161ec63da850cc9dffdca7e3ba2dbfe94589fbe51f0570c4b4aad4',
  },
  trg_notes_content_idea_update_blocked: {
    type: 'trigger',
    sha256: '3527dd039443f234c8049f7fd41c394a4e4411f5b421a5afd3c27b9a1da54592',
  },
  trg_notes_bound_content_idea_delete_blocked: {
    type: 'trigger',
    sha256: 'fe2bf5178c62bedf3f29f675898984cb63012c13e01dc33097a01baa70e39646',
  },
  trg_saved_ideas_legacy_user_insert_blocked: {
    type: 'trigger',
    sha256: 'c487db58090d907c408fa7019d765042fb5a4b5b76ea388caaf41c0632cd86b5',
  },
  trg_saved_ideas_legacy_user_update_blocked: {
    type: 'trigger',
    sha256: 'ea5a5107ce1422fbe6e7cf4c1752a867fd3e86da825559bf8d1da2af98b83522',
  },
  trg_saved_ideas_bound_source_delete_blocked: {
    type: 'trigger',
    sha256: '226c05baf538b703a84c676d92a2db831228f501412986a3e5291758d24b12a1',
  },
});

const CRITICAL_FOREIGN_KEY_TABLES = new Set([
  'content_legacy_idea_note_ingress_bindings',
  'content_legacy_idea_note_quarantine',
  'content_legacy_saved_idea_ingress_bindings',
  'content_legacy_saved_idea_quarantine',
]);

export const CONTENT_LEGACY_IDEA_WORKSPACE_EXIT = Object.freeze({
  migration: '253_content_legacy_idea_note_workspace_parity.sql',
  canonicalRoot: 'content_domain_objects',
  legacyRoots: ['notes.content_idea', 'saved_ideas'],
  legacyMode: 'read_only',
  rollbackMode: 'exact_pre_253_database_snapshot',
  readinessViews: [
    'content_legacy_idea_note_workspace_readiness',
    'content_legacy_saved_idea_workspace_readiness',
  ],
} as const);

export function assertContentLegacyIdeaWorkspaceExitReady(
  db: Database.Database = getDb(),
): void {
  assertReviewedSchemaIdentity(db);

  let noteReadiness: Record<string, unknown>;
  let savedIdeaReadiness: Record<string, unknown>;
  try {
    noteReadiness = requireReadinessRow(
      db,
      'content_legacy_idea_note_workspace_readiness',
    );
    savedIdeaReadiness = requireReadinessRow(
      db,
      'content_legacy_saved_idea_workspace_readiness',
    );
  } catch (error) {
    throw readinessError(
      'content_legacy_idea_workspace_exit_schema_not_ready',
      error,
    );
  }

  const notesReady = validateReadiness(noteReadiness, {
    eligible: 'nonblank_eligible_source_count',
    bound: 'bound_source_count',
    unbound: 'unbound_eligible_source_count',
    mismatch: 'exact_byte_hash_mismatch_count',
    orphan: 'orphan_or_changed_binding_count',
    quarantinable: 'quarantinable_source_count',
    quarantined: 'quarantined_source_count',
    unquarantined: 'unquarantined_ineligible_source_count',
    expectedWriterGuards: 2,
    expectedDeleteGuards: 1,
    expectedBindingGuards: 3,
    expectedQuarantineGuards: 1,
  });
  const savedIdeasReady = validateReadiness(savedIdeaReadiness, {
    eligible: 'eligible_source_count',
    bound: 'bound_source_count',
    unbound: 'unbound_eligible_source_count',
    mismatch: 'exact_metadata_hash_mismatch_count',
    orphan: 'orphan_or_changed_binding_count',
    quarantinable: 'quarantinable_source_count',
    quarantined: 'quarantined_source_count',
    unquarantined: 'unquarantined_ineligible_source_count',
    expectedWriterGuards: 2,
    expectedDeleteGuards: 1,
    expectedBindingGuards: 3,
    expectedQuarantineGuards: 1,
  });
  const foreignKeyBroken = (db.pragma('foreign_key_check') as Array<{ table?: unknown }>)
    .some((row) => typeof row.table === 'string' && CRITICAL_FOREIGN_KEY_TABLES.has(row.table));

  if (!notesReady || !savedIdeasReady || foreignKeyBroken) {
    throw new Error('content_legacy_idea_workspace_exit_integrity_failed');
  }
}

function assertReviewedSchemaIdentity(db: Database.Database): void {
  const names = Object.keys(CONTENT_LEGACY_IDEA_SCHEMA_OBJECTS);
  const placeholders = names.map(() => '?').join(', ');
  let rows: Array<{ name: string; type: string; sql: string | null }>;
  try {
    rows = db.prepare(`
      SELECT name, type, sql
        FROM sqlite_master
       WHERE name IN (${placeholders})
    `).all(...names) as Array<{ name: string; type: string; sql: string | null }>;
  } catch (error) {
    throw readinessError(
      'content_legacy_idea_workspace_exit_schema_not_ready',
      error,
    );
  }
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const [name, expected] of Object.entries(CONTENT_LEGACY_IDEA_SCHEMA_OBJECTS)) {
    const actual = byName.get(name);
    if (
      !actual
      || actual.type !== expected.type
      || typeof actual.sql !== 'string'
      || sha256(actual.sql) !== expected.sha256
    ) {
      throw new Error('content_legacy_idea_workspace_exit_schema_not_ready');
    }
  }
}

interface ReadinessContract {
  eligible: string;
  bound: string;
  unbound: string;
  mismatch: string;
  orphan: string;
  quarantinable: string;
  quarantined: string;
  unquarantined: string;
  expectedWriterGuards: number;
  expectedDeleteGuards: number;
  expectedBindingGuards: number;
  expectedQuarantineGuards: number;
}

function validateReadiness(
  row: Record<string, unknown>,
  contract: ReadinessContract,
): boolean {
  const eligible = nonnegativeInteger(row[contract.eligible]);
  const bound = nonnegativeInteger(row[contract.bound]);
  const unbound = nonnegativeInteger(row[contract.unbound]);
  const mismatch = nonnegativeInteger(row[contract.mismatch]);
  const orphan = nonnegativeInteger(row[contract.orphan]);
  const quarantinable = nonnegativeInteger(row[contract.quarantinable]);
  const quarantined = nonnegativeInteger(row[contract.quarantined]);
  const unquarantined = nonnegativeInteger(row[contract.unquarantined]);
  const writerGuards = nonnegativeInteger(row.writer_guard_count);
  const deleteGuards = nonnegativeInteger(row.source_delete_guard_count);
  const bindingGuards = nonnegativeInteger(row.binding_guard_count);
  const quarantineGuards = nonnegativeInteger(row.quarantine_guard_count);
  if (
    eligible == null
    || bound == null
    || unbound == null
    || mismatch == null
    || orphan == null
    || quarantinable == null
    || quarantined == null
    || unquarantined == null
    || writerGuards == null
    || deleteGuards == null
    || bindingGuards == null
    || quarantineGuards == null
  ) return false;

  return row.readiness_status === 'ready'
    && bound === eligible
    && unbound === 0
    && mismatch === 0
    && orphan === 0
    && quarantined === quarantinable
    && unquarantined === 0
    && writerGuards === contract.expectedWriterGuards
    && deleteGuards === contract.expectedDeleteGuards
    && bindingGuards === contract.expectedBindingGuards
    && quarantineGuards === contract.expectedQuarantineGuards;
}

function requireReadinessRow(
  db: Database.Database,
  view: string,
): Record<string, unknown> {
  const row = db.prepare(`SELECT * FROM ${view}`).get() as Record<string, unknown> | undefined;
  if (!row) throw new Error(`${view}_missing_row`);
  return row;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function readinessError(message: string, cause: unknown): Error {
  const error = new Error(message);
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}
