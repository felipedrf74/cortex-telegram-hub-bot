/**
 * Voice Evolution provenance schema guards.
 *
 * Voice learning is grounded in immutable canonical agent-to-user revision
 * pairs. The generic video transcript cache is intentionally not creator or
 * publication evidence.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('Voice Evolution Agent — canonical edit evidence schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('provides immutable revision lineage and actor markers for direct creator edits', () => {
    const columns = db.prepare('PRAGMA table_info(content_revisions)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toEqual(expect.arrayContaining([
      'tenant_id',
      'owner_user_id',
      'artifact_id',
      'parent_revision_id',
      'content_text',
      'content_hash',
      'actor_type',
      'actor_id',
      'created_at',
    ]));
  });

  it('keeps transcript acquisition metadata distinct from creator/publication proof', () => {
    const columns = db.prepare('PRAGMA table_info(video_transcripts)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('source');
    expect(names).toContain('ref_channel_id');
    expect(names).not.toContain('creator_owned');
    expect(names).not.toContain('publication_receipt');
  });
});
