// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
  type ComposedAnswerDraft,
} from '../../src/services/chat-core-v2/answer-composition';
import {
  ensureChatCoreV2AnswerAcceptanceCounterTable,
  incrementAnswerAcceptance,
} from '../../src/services/chat-core-v2/answer-acceptance-counter';
import {
  CHAT_CORE_V2_ANSWER_CANARY_EXIT_VERSION,
  CHAT_CORE_V2_UNSUPPORTED_CLAIM_CRITIC_MIN_COVERAGE,
  evaluateAnswerCanaryExit,
  evaluateUnsupportedClaimCriticCoverage,
  type UnsupportedClaimCriticFixture,
} from '../../src/services/chat-core-v2/answer-canary-exit';

const NOW = new Date('2026-05-30T12:00:00.000Z');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureChatCoreV2AnswerAcceptanceCounterTable(db);
  return db;
}

function unsupportedDraft(id: string): UnsupportedClaimCriticFixture {
  return {
    id,
    draft: {
      schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
      mode: 'model_constrained',
      locale: 'en',
      text: 'You have two tasks due today.',
      factualClaims: [
        {
          claimId: `${id}:claim`,
          text: 'Two tasks are due today.',
          evidenceIds: [],
          support: 'supported',
        },
      ],
      reasonCodes: ['test_fixture'],
    },
  };
}

function missedUnsupportedDraft(id: string): UnsupportedClaimCriticFixture {
  const draft: ComposedAnswerDraft = {
    schemaVersion: COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION,
    mode: 'model_constrained',
    locale: 'en',
    text: 'You have two tasks due today.',
    factualClaims: [
      {
        claimId: `${id}:claim`,
        text: 'Two tasks are due today.',
        evidenceIds: ['evidence:bound'],
        support: 'supported',
      },
    ],
    reasonCodes: ['test_fixture'],
  };
  return { id, draft };
}

function seedPassingAcceptance(db: Database.Database, tenantId = 'tenant-a'): void {
  for (let i = 0; i < 9; i += 1) incrementAnswerAcceptance(db, tenantId, 'en', { accepted: true }, NOW);
  incrementAnswerAcceptance(db, tenantId, 'en', { accepted: false }, NOW);

  for (let i = 0; i < 17; i += 1) incrementAnswerAcceptance(db, tenantId, 'pt-BR', { accepted: true }, NOW);
  for (let i = 0; i < 3; i += 1) incrementAnswerAcceptance(db, tenantId, 'pt-BR', { accepted: false }, NOW);

  for (let i = 0; i < 4; i += 1) incrementAnswerAcceptance(db, tenantId, 'pt-PT', { accepted: true }, NOW);
  incrementAnswerAcceptance(db, tenantId, 'pt-PT', { accepted: false }, NOW);

  for (let i = 0; i < 3; i += 1) incrementAnswerAcceptance(db, tenantId, 'mixed', { accepted: true }, NOW);
  incrementAnswerAcceptance(db, tenantId, 'mixed', { accepted: false }, NOW);
}

function passingCriticFixtures(count = 20): UnsupportedClaimCriticFixture[] {
  return Array.from({ length: count }, (_, index) => unsupportedDraft(`unsupported-${index + 1}`));
}

describe('ChatCoreV2 answer canary exit evaluator', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
  });

  it('passes only when every locale threshold and unsupported-claim critic coverage pass', () => {
    seedPassingAcceptance(db);

    const verdict = evaluateAnswerCanaryExit({
      db,
      tenantId: 'tenant-a',
      unsupportedClaimFixtures: passingCriticFixtures(),
    });

    expect(verdict.schemaVersion).toBe(CHAT_CORE_V2_ANSWER_CANARY_EXIT_VERSION);
    expect(verdict.pass).toBe(true);
    expect(verdict.reasons).toEqual(['ok']);
    expect(verdict.localeResults.en.rate).toBeCloseTo(0.9, 10);
    expect(verdict.localeResults['pt-BR'].rate).toBeCloseTo(0.85, 10);
    expect(verdict.localeResults['pt-PT'].rate).toBeCloseTo(0.8, 10);
    expect(verdict.localeResults.mixed.rate).toBeCloseTo(0.75, 10);
    expect(verdict.unsupportedClaimCritic.coverage).toBe(1);
  });

  it('blocks exit when tenant-scoped acceptance data is missing', () => {
    seedPassingAcceptance(db, 'tenant-b');

    const verdict = evaluateAnswerCanaryExit({
      db,
      tenantId: 'tenant-a',
      unsupportedClaimFixtures: passingCriticFixtures(),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('acceptance_no_data');
    expect(verdict.localeResults.en.rate).toBeNull();
    expect(verdict.localeResults.en.total).toBe(0);
  });

  it('blocks exit when any required locale falls below its threshold', () => {
    seedPassingAcceptance(db);
    incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: false }, NOW);

    const verdict = evaluateAnswerCanaryExit({
      db,
      tenantId: 'tenant-a',
      unsupportedClaimFixtures: passingCriticFixtures(),
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('acceptance_below_threshold');
    expect(verdict.localeResults.en.rate).toBeCloseTo(9 / 11, 10);
    expect(verdict.localeResults.en.pass).toBe(false);
  });

  it('blocks exit when unsupported-claim critic coverage is below the 95 percent floor', () => {
    seedPassingAcceptance(db);
    const fixtures = [
      ...passingCriticFixtures(18),
      missedUnsupportedDraft('unsupported-missed'),
      missedUnsupportedDraft('unsupported-missed-2'),
    ];

    const verdict = evaluateAnswerCanaryExit({
      db,
      tenantId: 'tenant-a',
      unsupportedClaimFixtures: fixtures,
    });

    expect(CHAT_CORE_V2_UNSUPPORTED_CLAIM_CRITIC_MIN_COVERAGE).toBe(0.95);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('unsupported_claim_critic_below_threshold');
    expect(verdict.unsupportedClaimCritic.coverage).toBeCloseTo(18 / 20, 10);
    expect(verdict.unsupportedClaimCritic.failedFixtureIds).toEqual(['unsupported-missed', 'unsupported-missed-2']);
  });

  it('treats an empty unsupported-claim fixture set as no-sample, not success', () => {
    seedPassingAcceptance(db);

    const verdict = evaluateAnswerCanaryExit({
      db,
      tenantId: 'tenant-a',
      unsupportedClaimFixtures: [],
    });

    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toContain('unsupported_claim_critic_no_samples');
    expect(verdict.unsupportedClaimCritic.coverage).toBeNull();
  });

  it('exposes the pure unsupported-claim critic coverage helper', () => {
    const coverage = evaluateUnsupportedClaimCriticCoverage([
      unsupportedDraft('caught'),
      missedUnsupportedDraft('missed'),
    ], 0.5);

    expect(coverage.pass).toBe(true);
    expect(coverage.total).toBe(2);
    expect(coverage.caught).toBe(1);
    expect(coverage.coverage).toBe(0.5);
    expect(coverage.failedFixtureIds).toEqual(['missed']);
  });
});
