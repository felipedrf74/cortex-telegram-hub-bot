import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

import {
  assessContentNovelty,
  listContentReuseHistory,
  recordContentNoveltyCandidate,
  recordContentRepurpose,
} from '../../src/services/content-novelty-reuse';

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

describe('Content novelty, duplicate, and reuse controls', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('detects exact duplicate ideas inside the active tenant/user scope', () => {
    const first = recordContentNoveltyCandidate({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'Creator operating systems for founders',
      topic: 'Creator operating systems for founders',
      angle: 'practical operating rhythm',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
    });

    const duplicate = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'Creator operating systems for founders',
      topic: 'Creator operating systems for founders',
      angle: 'practical operating rhythm',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
    });

    expect(first.candidateId).toContain('content_candidate_');
    expect(duplicate.status).toBe('duplicate');
    expect(duplicate.duplicationRisk).toBeGreaterThanOrEqual(0.9);
    expect(duplicate.reasonCodes).toEqual(expect.arrayContaining(['exact_or_high_confidence_duplicate']));
  });

  it('detects near-duplicate hooks without relying on exact string matching', () => {
    recordContentNoveltyCandidate({
      userId: 501,
      tenantId: 101,
      artifactType: 'hook',
      hook: 'Stop making content nobody remembers',
      topic: 'content retention mistakes',
      platformId: 'linkedin',
      formatId: 'linkedin_post',
    });

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'hook',
      hook: 'Stop creating content nobody remembers',
      topic: 'content retention mistakes',
      platformId: 'linkedin',
      formatId: 'linkedin_post',
    });

    expect(decision.status).toBe('near_duplicate');
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(['near_duplicate_hook']));
    expect(decision.reviewWarnings.join('\n')).toContain('new angle');
  });

  it('allows intentional repurposing and records reuse provenance', () => {
    const original = recordContentNoveltyCandidate({
      userId: 501,
      tenantId: 101,
      artifactType: 'script',
      title: 'The founder creator operating system',
      body: 'A long-form YouTube script about founder creator operating systems.',
      topic: 'creator operating systems',
      angle: 'long-form educational walkthrough',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
      referenceIds: ['book:creator-system'],
    });

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'script',
      title: 'One creator operating system mistake',
      body: 'A 45-second short adapted from the operating system script.',
      topic: 'creator operating systems',
      angle: 'one mistake short-form angle',
      platformId: 'youtube_shorts',
      formatId: 'youtube_shorts',
      referenceIds: ['book:creator-system'],
      reuseIntent: 'repurpose',
      originalContentId: original.candidateId,
      transformationType: 'youtube_to_shorts',
    });

    const repurpose = recordContentRepurpose({
      userId: 501,
      tenantId: 101,
      originalContentId: original.candidateId,
      reusedContentId: 'short-1',
      originalArtifactType: 'script',
      reusedArtifactType: 'script',
      transformationType: 'youtube_to_shorts',
      fromPlatformId: 'youtube',
      toPlatformId: 'youtube_shorts',
      referencesPreserved: ['book:creator-system'],
      noveltyScore: decision.noveltyScore,
      reasonCodes: decision.reasonCodes,
    });

    expect(decision.status).toBe('allowed_reuse');
    expect(decision.reuseAllowed).toBe(true);
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(['intentional_repurpose_allowed']));
    expect(repurpose.originalContentId).toBe(original.candidateId);
    expect(listContentReuseHistory({ userId: 501, tenantId: 101, originalContentId: original.candidateId })).toHaveLength(1);
  });

  it('does not compare against unauthorized tenant content', () => {
    recordContentNoveltyCandidate({
      userId: 601,
      tenantId: 202,
      artifactType: 'idea',
      title: 'Confidential Tenant B launch narrative',
      topic: 'confidential tenant launch',
      platformId: 'linkedin',
      formatId: 'linkedin_post',
    });

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'Confidential Tenant B launch narrative',
      topic: 'confidential tenant launch',
      platformId: 'linkedin',
      formatId: 'linkedin_post',
    });

    expect(decision.status).toBe('novel');
    expect(decision.matchedCandidates).toHaveLength(0);
    expect(decision.reasonCodes).toContain('no_recent_scoped_duplicate_found');
  });

  it('suppresses repeated stale radar signals unless reuse is explicit', () => {
    recordContentNoveltyCandidate({
      userId: 501,
      tenantId: 101,
      artifactType: 'radar_signal',
      title: 'Old creator economy signal',
      topic: 'creator economy signal',
      sourceRadarSignalId: 'radar-old-1',
    });

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'Another take from the old creator economy signal',
      topic: 'creator economy signal',
      sourceRadarSignalId: 'radar-old-1',
    });

    expect(decision.status).toBe('stale_repetition');
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(['repeated_stale_radar_signal']));
  });

  it('allows successful content patterns to be reused with a new angle', () => {
    recordContentNoveltyCandidate({
      userId: 501,
      tenantId: 101,
      artifactType: 'script',
      title: 'Why creator systems beat motivation',
      topic: 'creator systems',
      angle: 'motivation is unreliable',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
      referenceIds: ['book:systems'],
    });

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'caption',
      title: 'Creator systems for chaotic weeks',
      topic: 'creator systems',
      angle: 'chaotic-week survival pattern',
      platformId: 'linkedin',
      formatId: 'linkedin_post',
      referenceIds: ['note:chaotic-week'],
      reuseIntent: 'reuse_successful_pattern',
      transformationType: 'successful_pattern_variation',
    });

    expect(decision.status).toBe('allowed_reuse');
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(['successful_pattern_variation_allowed']));
    expect(decision.noveltyScore).toBeGreaterThanOrEqual(0.62);
  });

  it('allows content series members to stay related without becoming blocked duplicates', () => {
    recordContentNoveltyCandidate({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'Creator operating system part 1',
      topic: 'creator operating system',
      angle: 'capture system',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
      seriesId: 'series-creator-os',
    });

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'Creator operating system part 2',
      topic: 'creator operating system',
      angle: 'selection system',
      platformId: 'youtube',
      formatId: 'youtube_long_form',
      seriesId: 'series-creator-os',
      reuseIntent: 'series',
      transformationType: 'series_continuation',
    });

    expect(decision.status).toBe('series_related');
    expect(decision.reuseAllowed).toBe(true);
    expect(decision.reasonCodes).toEqual(expect.arrayContaining(['content_series_related_idea_allowed']));
  });

  it('warns when a scoped reference is being overused', () => {
    for (let i = 0; i < 3; i += 1) {
      recordContentNoveltyCandidate({
        userId: 501,
        tenantId: 101,
        artifactType: 'idea',
        title: `Creator systems reference angle ${i}`,
        topic: `creator systems angle ${i}`,
        referenceIds: ['book:creator-system'],
      });
    }

    const decision = assessContentNovelty({
      userId: 501,
      tenantId: 101,
      artifactType: 'idea',
      title: 'A fresh creator systems idea',
      topic: 'creator systems with a new production angle',
      referenceIds: ['book:creator-system'],
    });

    expect(decision.reasonCodes).toContain('overused_reference');
    expect(decision.reviewWarnings.join('\n')).toContain('book:creator-system');
  });
});
