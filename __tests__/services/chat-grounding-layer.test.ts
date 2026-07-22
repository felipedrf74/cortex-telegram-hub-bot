/**
 * Mirror test for chat-grounding-layer (M6 reliability backfill).
 * Pins grounding-fact assembly, staleness aggregation, and the
 * scoped-read/mutating-intent missing-fact shapes — plus the turn-scoped
 * token-zero write-claim verification (adversarial-review fix, 2026-07).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database | null = null;

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: () => {
    if (!testDb) throw new Error('testDb not initialized');
    return testDb;
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  buildChatGroundingEnvelope,
  verifyWriteClaimAgainstLocalState,
} from '../../src/services/chat-grounding-layer';
import { upsertTask } from '../../src/services/task-store/unified-task-store';

const BASE = {
  userId: 4242,
  tenantId: 4242,
};

describe('chat-grounding-layer', () => {
  describe('fact assembly', () => {
    it('always emits the auth-scope and owner-skill base facts', () => {
      const envelope = buildChatGroundingEnvelope({ ...BASE, message: 'hello there' });

      expect(envelope.groundingFacts).toHaveLength(2);
      expect(envelope.groundingFacts[0]).toMatchObject({
        statement: 'Authenticated user and tenant scope are present for this chat turn.',
        source: 'auth.scope',
        field: 'userId,tenantId',
        freshness: 'fresh',
        confidence: 1,
        safeForUser: true,
      });
      expect(envelope.groundingFacts[1]).toMatchObject({
        source: 'chat.skill_capability_registry',
        field: 'ownerSkill',
        freshness: 'fresh',
        confidence: 0.9,
      });
      expect(envelope.capability.ownerSkill).toBe('chat');
      expect(envelope.staleness).toBe('fresh');
      expect(envelope.missingFacts).toEqual([]);
    });

    it('adds a router fact carrying the route confidence', () => {
      const envelope = buildChatGroundingEnvelope({
        ...BASE,
        message: 'what is on my calendar',
        route: { domain: 'secretary', method: 'keyword', confidence: 0.73 },
      });

      const routeFact = envelope.groundingFacts.find((fact) => fact.source === 'chat.router');
      expect(routeFact).toMatchObject({
        statement: 'Router selected secretary with keyword.',
        field: 'route',
        freshness: 'fresh',
        confidence: 0.73,
      });
    });

    it('adds a recent-context fact and downgrades staleness to recent', () => {
      const envelope = buildChatGroundingEnvelope({
        ...BASE,
        message: 'hello',
        activeContextDomain: 'triathlon',
      });

      const contextFact = envelope.groundingFacts.find((fact) => fact.source === 'chat.active_context');
      expect(contextFact).toMatchObject({
        statement: 'Recent chat context was in triathlon.',
        freshness: 'recent',
        confidence: 0.65,
      });
      expect(envelope.staleness).toBe('recent');
    });

    it('maps context sources with freshness normalization and confidence defaults', () => {
      const envelope = buildChatGroundingEnvelope({
        ...BASE,
        message: 'hello',
        contextSources: [
          { source: 'metadata.tasks', freshness: 'stale', confidence: 0.4, reason: 'Task metadata attached.' },
          { source: 'metadata.other', freshness: 'not-a-freshness' },
        ],
      });

      const staleFact = envelope.groundingFacts.find((fact) => fact.source === 'chat.context.metadata.tasks');
      expect(staleFact).toMatchObject({
        statement: 'Task metadata attached.',
        freshness: 'stale',
        confidence: 0.4,
      });
      const unknownFact = envelope.groundingFacts.find((fact) => fact.source === 'chat.context.metadata.other');
      expect(unknownFact).toMatchObject({
        statement: 'Context source metadata.other was available.',
        freshness: 'unknown',
        confidence: 0.6,
      });
      // Any stale fact wins the staleness aggregation.
      expect(envelope.staleness).toBe('stale');
    });

    it('clamps fact confidence to [0,1] and truncates statements to 240 chars', () => {
      const envelope = buildChatGroundingEnvelope({
        ...BASE,
        message: 'hello',
        contextSources: [
          { source: 'over', freshness: 'fresh', confidence: 4.2, reason: 'r'.repeat(500) },
          { source: 'under', freshness: 'fresh', confidence: -1 },
        ],
      });

      const over = envelope.groundingFacts.find((fact) => fact.source === 'chat.context.over');
      expect(over?.confidence).toBe(1);
      expect(over?.statement.length).toBe(240);
      const under = envelope.groundingFacts.find((fact) => fact.source === 'chat.context.under');
      expect(under?.confidence).toBe(0);
    });
  });

  describe('missing-fact inference (scoped verification shapes)', () => {
    it('read intents never report missing facts', () => {
      const envelope = buildChatGroundingEnvelope({ ...BASE, message: 'show my task list for today' });

      expect(envelope.capability.intent).toBe('tasks.read');
      expect(envelope.missingFacts).toEqual([]);
    });

    it('a bare task-create asks for date and title', () => {
      const envelope = buildChatGroundingEnvelope({ ...BASE, message: 'create a task' });

      expect(envelope.capability.ownerSkill).toBe('tasks');
      expect(envelope.capability.intent).toBe('tasks.create');
      expect([...envelope.missingFacts].sort()).toEqual(['date', 'title']);
    });

    it('secretary scheduling additionally requires a time signal', () => {
      const missingTime = buildChatGroundingEnvelope({
        ...BASE,
        message: 'schedule meeting tomorrow',
      });
      expect(missingTime.capability.ownerSkill).toBe('secretary');
      expect(missingTime.missingFacts).toEqual(['time']);

      const complete = buildChatGroundingEnvelope({
        ...BASE,
        message: 'schedule meeting tomorrow at 3pm',
      });
      expect(complete.missingFacts).toEqual([]);
    });

    it('reference-shaped required fields need an anaphor to resolve', () => {
      const missingReference = buildChatGroundingEnvelope({
        ...BASE,
        message: 'add a new recipe',
      });
      expect(missingReference.capability.ownerSkill).toBe('cooking');
      expect(missingReference.missingFacts).toEqual(['mealOrSessionReference']);

      const withAnaphor = buildChatGroundingEnvelope({
        ...BASE,
        message: 'add this recipe',
      });
      expect(withAnaphor.missingFacts).toEqual([]);
    });

    it('destructive intents are treated as mutating', () => {
      const envelope = buildChatGroundingEnvelope({ ...BASE, message: 'delete a task' });

      expect(envelope.capability.intent).toBe('tasks.destructive');
      expect(envelope.missingFacts).toContain('title');
    });
  });

  describe('verifyWriteClaimAgainstLocalState — turn-scoped recency', () => {
    const USER_ID = 4242;
    const TENANT_ID = 4242;

    beforeEach(() => {
      testDb = createMigratedTestDatabase();
      testDb.prepare(`
        INSERT INTO users (
          id, telegram_id, first_name, language, timezone, tier, status,
          auth_provider, daily_message_limit, daily_token_limit, daily_cost_limit_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(USER_ID, USER_ID, 'Test', 'en', 'Europe/Lisbon', 'pro', 'active', 'telegram', 40, 100000, 1);
    });

    afterEach(() => {
      testDb?.close();
      testDb = null;
    });

    function seedTask(title: string): void {
      upsertTask(USER_ID, {
        provider: 'nexus',
        externalId: `ext-${title}`,
        title,
        status: 'pending',
        priority: 0,
      }, TENANT_ID);
    }

    it('does NOT verify an exact-title creation claim against a week-old row', () => {
      seedTask('Email Maria');
      testDb!.prepare(
        "UPDATE unified_tasks SET created_at = datetime('now', '-7 days'), updated_at = datetime('now', '-7 days') WHERE user_id = ?",
      ).run(USER_ID);

      const result = verifyWriteClaimAgainstLocalState({
        text: 'I created the task "Email Maria" for you.',
        userId: USER_ID,
        tenantId: TENANT_ID,
        requestStartedAt: Date.now(),
      });

      expect(result.verified).toBe(false);
      expect(result.reason).toBe('no_confirming_local_state');
    });

    it('verifies an exact-title creation claim when the row was written this turn', () => {
      seedTask('Email Maria');

      const result = verifyWriteClaimAgainstLocalState({
        text: 'I created the task "Email Maria" for you.',
        userId: USER_ID,
        tenantId: TENANT_ID,
        requestStartedAt: Date.now(),
      });

      expect(result.verified).toBe(true);
      expect(result.reason).toBe('task_exact_title_match');
      expect(result.entity?.title).toBe('Email Maria');
    });

    it('id-claims ("task #N") also require recency — stale rows never verify', () => {
      seedTask('Email Maria');
      const row = testDb!.prepare('SELECT id FROM unified_tasks WHERE user_id = ? LIMIT 1').get(USER_ID) as { id: number };
      testDb!.prepare(
        "UPDATE unified_tasks SET created_at = datetime('now', '-7 days'), updated_at = datetime('now', '-7 days') WHERE user_id = ?",
      ).run(USER_ID);

      const result = verifyWriteClaimAgainstLocalState({
        text: `I updated task #${row.id} with a new due date.`,
        userId: USER_ID,
        tenantId: TENANT_ID,
        requestStartedAt: Date.now(),
      });

      expect(result.verified).toBe(false);
    });
  });

  describe('owner-skill resolution inputs', () => {
    it('prefers text inference, then routed domain, then involved skills', () => {
      const fromText = buildChatGroundingEnvelope({
        ...BASE,
        message: 'how is my training going',
        routedDomain: 'finance',
      });
      expect(fromText.capability.ownerSkill).toBe('training');
      expect(fromText.capability.involvedSkills).toContain('finance');

      const fromDomain = buildChatGroundingEnvelope({
        ...BASE,
        message: 'hello',
        routedDomain: 'cooking',
      });
      expect(fromDomain.capability.ownerSkill).toBe('cooking');

      const fromInvolved = buildChatGroundingEnvelope({
        ...BASE,
        message: 'hello',
        involvedSkills: ['finance'],
      });
      expect(fromInvolved.capability.ownerSkill).toBe('finance');
    });
  });
});
