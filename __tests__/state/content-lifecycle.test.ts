/**
 * CONTENT-UI-O4 (2026-05-04): Canonical 12-stage Content lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import {
  mapContentTopicStatusToCanonical,
  mapSavedIdeaStatusToCanonical,
  mapContentWorkspaceStateToCanonical,
  summarizeCanonicalLifecycle,
  CANONICAL_LIFECYCLE_STAGES,
} from '../../src/state/content-lifecycle';
import { recordRadarFeedback } from '../../src/state/content-radar-feedback';


const USER = 4001;

describe('content-lifecycle (CONTENT-UI-O4)', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('canonical stage list has 12 entries in expected order', () => {
    expect(CANONICAL_LIFECYCLE_STAGES).toHaveLength(12);
    expect(CANONICAL_LIFECYCLE_STAGES[0]).toBe('discovered');
    expect(CANONICAL_LIFECYCLE_STAGES[11]).toBe('rejected');
  });

  // ──────── topic status mapping ────────

  it('maps topic status idea → suggested', () => {
    expect(mapContentTopicStatusToCanonical('idea')).toBe('suggested');
  });
  it('maps topic status planned → suggested', () => {
    expect(mapContentTopicStatusToCanonical('planned')).toBe('suggested');
  });
  it('maps topic status outlined → briefing', () => {
    expect(mapContentTopicStatusToCanonical('outlined')).toBe('briefing');
  });
  it('maps topic status drafting and drafted → drafting', () => {
    expect(mapContentTopicStatusToCanonical('drafting')).toBe('drafting');
    expect(mapContentTopicStatusToCanonical('drafted')).toBe('drafting');
  });
  it('maps topic status reviewed and revised → review', () => {
    expect(mapContentTopicStatusToCanonical('reviewed')).toBe('review');
    expect(mapContentTopicStatusToCanonical('revised')).toBe('review');
  });
  it('maps topic status approved/ready → approved', () => {
    expect(mapContentTopicStatusToCanonical('approved')).toBe('approved');
    expect(mapContentTopicStatusToCanonical('ready')).toBe('approved');
  });
  it('maps topic status scheduled → scheduled', () => {
    expect(mapContentTopicStatusToCanonical('scheduled')).toBe('scheduled');
  });
  it('maps topic status published/repurposed → published', () => {
    expect(mapContentTopicStatusToCanonical('published')).toBe('published');
    expect(mapContentTopicStatusToCanonical('repurposed')).toBe('published');
  });
  it('maps topic status cancelled/rejected → rejected', () => {
    expect(mapContentTopicStatusToCanonical('cancelled')).toBe('rejected');
    expect(mapContentTopicStatusToCanonical('rejected')).toBe('rejected');
  });
  it('maps topic status archived/stale/deferred → archived', () => {
    expect(mapContentTopicStatusToCanonical('archived')).toBe('archived');
    expect(mapContentTopicStatusToCanonical('stale')).toBe('archived');
    expect(mapContentTopicStatusToCanonical('deferred')).toBe('archived');
  });
  it('maps topic status unknown/null → discovered', () => {
    expect(mapContentTopicStatusToCanonical('not-a-known-status')).toBe('discovered');
    expect(mapContentTopicStatusToCanonical(null)).toBe('discovered');
    expect(mapContentTopicStatusToCanonical(undefined)).toBe('discovered');
  });
  it('mapping is case-insensitive', () => {
    expect(mapContentTopicStatusToCanonical('PUBLISHED')).toBe('published');
    expect(mapContentTopicStatusToCanonical('Drafting')).toBe('drafting');
  });

  // ──────── saved_idea mapping ────────

  it('maps saved_idea idea → suggested', () => {
    expect(mapSavedIdeaStatusToCanonical('idea')).toBe('suggested');
  });
  it('maps saved_idea scripted → drafting', () => {
    expect(mapSavedIdeaStatusToCanonical('scripted')).toBe('drafting');
  });
  it('maps saved_idea filmed/editing → review', () => {
    expect(mapSavedIdeaStatusToCanonical('filmed')).toBe('review');
    expect(mapSavedIdeaStatusToCanonical('editing')).toBe('review');
  });

  it('maps canonical workspace state and artifact phase without legacy status reconstruction', () => {
    expect(mapContentWorkspaceStateToCanonical('inbox', 'idea')).toBe('suggested');
    expect(mapContentWorkspaceStateToCanonical('active', 'brief')).toBe('briefing');
    expect(mapContentWorkspaceStateToCanonical('active', 'draft')).toBe('drafting');
    expect(mapContentWorkspaceStateToCanonical('review', 'final')).toBe('review');
    expect(mapContentWorkspaceStateToCanonical('published', 'final')).toBe('published');
  });

  // ──────── summary integration ────────

  it('returns 12 buckets with zero counts for empty user', () => {
    const summary = summarizeCanonicalLifecycle(USER, USER);
    expect(summary.buckets).toHaveLength(12);
    expect(summary.total).toBe(0);
    expect(summary.hasData).toBe(false);
    expect(summary.availability).toBe('available');
    expect(summary.unavailableSections).toEqual([]);
    expect(summary.buckets.every(b => b.count === 0)).toBe(true);
  });

  it('aggregates canonical workspace items + radar feedback into lifecycle buckets', () => {
    seedWorkspaceLifecycleItem('T1', 'active', 'draft');
    seedWorkspaceLifecycleItem('T2', 'published', 'final');

    // 1 accepted + 2 rejected radar feedback (distinct signals)
    recordRadarFeedback(USER, USER, { signalId: 'sig-acc-1', action: 'accept' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-rej-1', action: 'reject' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-rej-2', action: 'reject' });

    const summary = summarizeCanonicalLifecycle(USER, USER);
    const byStage = Object.fromEntries(summary.buckets.map(b => [b.stage, b.count]));
    expect(byStage.drafting).toBe(1);
    expect(byStage.published).toBe(1);
    expect(byStage.accepted).toBe(1);
    expect(byStage.rejected).toBe(2);
    expect(summary.hasData).toBe(true);
    expect(summary.availability).toBe('available');
  });

  it('does not count accepted radar signals that were converted or already have a topic', () => {
    seedWorkspaceLifecycleItem('Already a topic', 'inbox', 'idea');

    recordRadarFeedback(USER, USER, { signalId: 'sig-active', action: 'accept', signalTopic: 'Still only accepted' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-topic', action: 'accept', signalTopic: 'Already a topic' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-converted', action: 'accept', signalTopic: 'Converted signal' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-converted', action: 'create_brief', signalTopic: 'Converted signal' });

    const summary = summarizeCanonicalLifecycle(USER, USER);
    const byStage = Object.fromEntries(summary.buckets.map(b => [b.stage, b.count]));
    expect(byStage.accepted).toBe(1);
    expect(byStage.suggested).toBe(1);
  });

  it('returns empty summary for invalid userId', () => {
    const summary = summarizeCanonicalLifecycle(0);
    expect(summary.total).toBe(0);
    expect(summary.tenantId).toBe(0);
    expect(summary.buckets).toHaveLength(12);
    expect(summary.availability).toBe('unavailable');
    expect(summary.unavailableSections).toEqual(['workspace', 'radar_feedback']);
  });

  it('marks a failed lifecycle source unavailable instead of treating its zeros as complete', () => {
    testDb.exec('DROP TABLE content_radar_feedback');

    const summary = summarizeCanonicalLifecycle(USER, USER);

    expect(summary.availability).toBe('partial');
    expect(summary.unavailableSections).toEqual(['radar_feedback']);
  });
});

function seedWorkspaceLifecycleItem(
  title: string,
  productionState: string,
  artifactPhase: string,
): number {
  return Number(testDb.prepare(`
    INSERT INTO content_domain_objects (
      tenant_id, owner_user_id, visibility_scope, scope_status,
      object_type, lifecycle_state, title, production_state, artifact_phase,
      created_by, updated_by
    ) VALUES (?, ?, 'user_private', 'active', 'content_item', ?, ?, ?, ?, ?, ?)
  `).run(
    USER,
    USER,
    productionState,
    title,
    productionState,
    artifactPhase,
    USER,
    USER,
  ).lastInsertRowid);
}
