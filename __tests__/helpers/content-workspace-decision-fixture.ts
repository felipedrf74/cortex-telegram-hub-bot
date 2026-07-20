import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  transitionContentWorkspaceItem,
} from '../../src/services/content-workspace';
import {
  getContentDecisionWorkspaceObject,
  type ContentDecisionWorkspaceObject,
} from '../../src/services/content-workspace-decision-adapter';

const WORKSPACE_MIGRATIONS = [
  '240_content_workspace_domain.sql',
  '241_content_workspace_library.sql',
  '243_content_artifact_relationships.sql',
].map((name) => readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));

let fixtureSequence = 0;

/**
 * Decision Center's focused tests use intentionally small in-memory schemas.
 * This seeds the pre-workspace roots before applying the real additive
 * canonical migrations, so fixtures exercise the same item/revision contracts
 * as production without recreating the retired editorial writer.
 */
export function ensureCanonicalContentDecisionFixtureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_domain_objects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      object_type TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL DEFAULT 'captured',
      title TEXT NOT NULL,
      summary TEXT,
      platform_id TEXT,
      format_id TEXT,
      ontology_metadata_json TEXT NOT NULL DEFAULT '{}',
      ontology_schema_version TEXT NOT NULL DEFAULT 'content-ontology-v1',
      editorial_state TEXT DEFAULT 'idea',
      approval_state TEXT DEFAULT 'not_required',
      review_required INTEGER NOT NULL DEFAULT 0,
      review_reason_codes_json TEXT DEFAULT '[]',
      approved_by INTEGER,
      approved_at TEXT,
      archived_at TEXT,
      workflow_version INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS content_workflow_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL,
      scope_status TEXT NOT NULL,
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT,
      approval_state TEXT NOT NULL,
      review_required INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      actor_user_id INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS content_output_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      scope_status TEXT NOT NULL DEFAULT 'active',
      output_object_type TEXT NOT NULL,
      output_id TEXT NOT NULL,
      grounding_status TEXT NOT NULL DEFAULT 'ungrounded',
      references_used_json TEXT NOT NULL DEFAULT '[]',
      claims_json TEXT NOT NULL DEFAULT '[]',
      unsupported_claims_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id, output_object_type, output_id)
    );
  `);
  for (const migration of WORKSPACE_MIGRATIONS) db.exec(migration);
}

export function createCanonicalContentDecisionFixture(
  db: Database.Database,
  input: {
    userId: number;
    tenantId: number;
    title: string;
    objectType?: string;
    visibilityScope?: string;
    inReview?: boolean;
    /** Accepted only so older Decision test names can describe the candidate; canonical state is derived from the saved artifact. */
    editorialState?: 'drafted';
  },
): ContentDecisionWorkspaceObject {
  const schemaReady = db.prepare(`
    SELECT 1
      FROM sqlite_master
     WHERE type = 'table' AND name = 'content_mutation_receipts'
     LIMIT 1
  `).get();
  if (!schemaReady) ensureCanonicalContentDecisionFixtureSchema(db);
  if (input.visibilityScope && input.visibilityScope !== 'user_private') {
    throw new Error('Canonical Content decision fixtures are private-owner scoped.');
  }
  const suffix = ++fixtureSequence;
  const scope = { tenantId: input.tenantId, userId: input.userId };
  const item = createContentWorkspaceItem({
    scope,
    itemType: 'content_item',
    title: input.title,
    idempotencyKey: `decision-fixture:item:${suffix}`,
  }, db).value;
  createContentArtifact({
    scope,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    title: input.title,
    initialContent: {
      format: 'plain_text',
      text: `Saved user-authored decision fixture for ${input.title}.`,
    },
    actorType: 'user',
    metadata: { legacyObjectType: input.objectType ?? 'script' },
    idempotencyKey: `decision-fixture:artifact:${suffix}`,
  }, db);
  if (input.inReview) {
    const saved = getContentDecisionWorkspaceObject(input.userId, item.id, input.tenantId, db);
    if (!saved) throw new Error('Canonical Content decision fixture was not readable before review.');
    transitionContentWorkspaceItem({
      scope,
      itemId: item.id,
      targetState: 'review',
      expectedWorkflowVersion: saved.workflowVersion,
      idempotencyKey: `decision-fixture:review:${suffix}`,
    }, db);
  }
  const object = getContentDecisionWorkspaceObject(input.userId, item.id, input.tenantId, db);
  if (!object) throw new Error('Canonical Content decision fixture was not readable after creation.');
  return object;
}
