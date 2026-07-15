/**
 * Voice Evolution Agent Tests
 *
 * Regression tests for the "no such column: transcript" bug.
 * The video_transcripts table uses `full_text`, not `transcript`.
 * These tests ensure the agent query matches the actual schema.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

// ═══════════════════════════════════════════════════════════════════
// SCHEMA VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('Voice Evolution Agent — Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });
  afterEach(() => { db.close(); });

  it('video_transcripts table has full_text column', () => {
    const columns = db.prepare('PRAGMA table_info(video_transcripts)').all() as any[];
    const colNames = columns.map((c: any) => c.name);
    expect(colNames).toContain('full_text');
  });

  it('video_transcripts table does NOT have a "transcript" column', () => {
    const columns = db.prepare('PRAGMA table_info(video_transcripts)').all() as any[];
    const colNames = columns.map((c: any) => c.name);
    expect(colNames).not.toContain('transcript');
  });

});

// ═══════════════════════════════════════════════════════════════════
// QUERY REGRESSION — reproduces the exact production bug
// ═══════════════════════════════════════════════════════════════════

describe('Voice Evolution Agent — Transcript Query', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();

    // Seed test data
    db.prepare(`
      INSERT INTO video_transcripts (video_id, title, full_text, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run('vid_001', 'Test Video', 'This is the full transcript text for testing.');
  });
  afterEach(() => { db.close(); });

  it('SELECT title, full_text FROM video_transcripts succeeds', () => {
    const rows = db.prepare(
      'SELECT title, full_text FROM video_transcripts ORDER BY created_at DESC LIMIT 10'
    ).all() as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Test Video');
    expect(rows[0].full_text).toContain('full transcript text');
  });

  it('SELECT title, transcript FROM video_transcripts fails (regression guard)', () => {
    expect(() => {
      db.prepare('SELECT title, transcript FROM video_transcripts').all();
    }).toThrow(/no such column/);
  });

  it('query returns multiple transcripts ordered by created_at DESC', () => {
    db.prepare(`
      INSERT INTO video_transcripts (video_id, title, full_text, created_at)
      VALUES (?, ?, ?, datetime('now', '-1 day'))
    `).run('vid_002', 'Older Video', 'Older transcript content.');

    const rows = db.prepare(`
      SELECT title, full_text FROM video_transcripts
      ORDER BY created_at DESC LIMIT 10
    `).all() as any[];

    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('Test Video');   // newer first
    expect(rows[1].title).toBe('Older Video');
  });

  it('query respects date filter (last 30 days)', () => {
    // Insert an old transcript (> 30 days)
    db.prepare(`
      INSERT INTO video_transcripts (video_id, title, full_text, created_at)
      VALUES (?, ?, ?, datetime('now', '-60 days'))
    `).run('vid_old', 'Ancient Video', 'Very old transcript.');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT title, full_text FROM video_transcripts
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(thirtyDaysAgo) as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Test Video');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTENT PIPELINE QUERY (also used by voice-evolution-agent)
// ═══════════════════════════════════════════════════════════════════

describe('Voice Evolution Agent — Content Pipeline Query', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
  });
  afterEach(() => { db.close(); });

  it('content_pipeline query for scripts succeeds', () => {
    db.prepare(`
      INSERT INTO content_pipeline (topic_title, niche, stage, script_path, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run('AI Tools Review', 'tech', 'scripted', '/tmp/script.txt');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
      SELECT topic_title, script_path FROM content_pipeline
      WHERE stage IN ('scripted', 'filming', 'editing', 'published')
        AND created_at > ?
      ORDER BY created_at DESC
      LIMIT 10
    `).all(thirtyDaysAgo) as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].topic_title).toBe('AI Tools Review');
  });
});
