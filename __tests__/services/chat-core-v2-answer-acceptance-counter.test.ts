// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-3 rank 8 — Chat Core v2 answer-acceptance counter (INERT, canary-only
 * EXIT-metric scaffold, per-tenant per-locale).
 *
 * DMV invariants proven here:
 *  - LOCALE BUCKETS: en / pt-BR / pt-PT / mixed; unknown/empty/unset → 'mixed';
 *  - per-bucket rollup + acceptance-rate computation are REAL (not placeholders);
 *  - REVERT-SAFE DEFAULT: an empty (tenant, locale) scope ⇒ rate === null
 *    (no data), never a misleading 0;
 *  - TENANT isolation: one tenant's counts never roll into another's;
 *  - FIRE-AND-FORGET: increment never throws on a closed db.
 *
 * These EXIT thresholds (en>=90%, pt-BR>=85%, pt-PT>=80%, mixed>=75%) are DISTINCT
 * from WP-13 recall@8 and the composer-mode counter — a separate measurement axis.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  ensureChatCoreV2AnswerAcceptanceCounterTable,
  incrementAnswerAcceptance,
  computeAnswerAcceptanceRate,
  normalizeChatCoreV2AcceptanceLocaleBucket,
  CHAT_CORE_V2_ACCEPTANCE_LOCALE_BUCKETS,
  CHAT_CORE_V2_ACCEPTANCE_EXIT_THRESHOLDS,
  CHAT_CORE_V2_ANSWER_ACCEPTANCE_COUNTER_VERSION,
} from '../../src/services/chat-core-v2/answer-acceptance-counter';

const NOW = new Date('2026-05-30T12:00:00.000Z');

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureChatCoreV2AnswerAcceptanceCounterTable(db);
  return db;
}

function rowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_v2_answer_acceptance_counter').get() as { n: number }).n;
}

describe('answer-acceptance-counter — locale bucket normalization', () => {
  it('maps known/variant locales to the four canary buckets', () => {
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('en')).toBe('en');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('en-US')).toBe('en');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('pt-BR')).toBe('pt-BR');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('pt_br')).toBe('pt-BR');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('pt-PT')).toBe('pt-PT');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('pt')).toBe('pt-PT');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('mixed')).toBe('mixed');
  });

  it('normalizes unknown/empty/null/unset locales to the catch-all mixed bucket', () => {
    // Distinct from response-contracts normalizeChatCoreV2Locale (which folds
    // unknowns into 'en'); for an EXIT metric the strict 'en' bucket must never
    // be inflated by unclassifiable turns.
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('fr')).toBe('mixed');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('es')).toBe('mixed');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('')).toBe('mixed');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket('   ')).toBe('mixed');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket(null)).toBe('mixed');
    expect(normalizeChatCoreV2AcceptanceLocaleBucket(undefined)).toBe('mixed');
  });

  it('exposes the four buckets and their EXIT thresholds', () => {
    expect([...CHAT_CORE_V2_ACCEPTANCE_LOCALE_BUCKETS].sort()).toEqual(['en', 'mixed', 'pt-BR', 'pt-PT'].sort());
    expect(CHAT_CORE_V2_ACCEPTANCE_EXIT_THRESHOLDS).toEqual({
      en: 0.9,
      'pt-BR': 0.85,
      'pt-PT': 0.8,
      mixed: 0.75,
    });
    expect(CHAT_CORE_V2_ANSWER_ACCEPTANCE_COUNTER_VERSION).toMatch(/^chat_core_v2_answer_acceptance_counter@/);
  });
});

describe('answer-acceptance-counter — REVERT-SAFE empty default (load-bearing)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('EMPTY (tenant, locale) ⇒ rate === null (no data), NOT a misleading 0', () => {
    expect(rowCount(db)).toBe(0);
    const result = computeAnswerAcceptanceRate(db, 'en', { tenantId: 'tenant-a' });
    expect(result.rate).toBeNull();
    expect(result.accepted).toBe(0);
    expect(result.total).toBe(0);
    expect(result.bucket).toBe('en');
  });

  it('MISSING table (bare db) ⇒ rate === null (fail-safe, no throw)', () => {
    const bare = new Database(':memory:');
    const result = computeAnswerAcceptanceRate(bare, 'en', { tenantId: 'tenant-a' });
    expect(result.rate).toBeNull();
    expect(result.total).toBe(0);
    bare.close();
  });

  it('the "all" rollup is also null on an empty tenant', () => {
    const result = computeAnswerAcceptanceRate(db, 'all', { tenantId: 'tenant-a' });
    expect(result.bucket).toBe('all');
    expect(result.rate).toBeNull();
  });
});

describe('answer-acceptance-counter — per-locale bucket rollup + rate', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('rolls accepted/total into the correct (tenant, locale-bucket) row', () => {
    incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: false }, NOW);

    // ONE bucket row for (tenant-a, en): accepted=2, total=3.
    expect(rowCount(db)).toBe(1);
    const result = computeAnswerAcceptanceRate(db, 'en', { tenantId: 'tenant-a' });
    expect(result.accepted).toBe(2);
    expect(result.total).toBe(3);
    expect(result.rate).toBeCloseTo(2 / 3, 10);
  });

  it('separates the four locale buckets and computes each rate independently', () => {
    // en: 9/10 = 0.90 (meets >=0.90)
    for (let i = 0; i < 9; i += 1) incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: false }, NOW);
    // pt-BR: 17/20 = 0.85
    for (let i = 0; i < 17; i += 1) incrementAnswerAcceptance(db, 'tenant-a', 'pt-BR', { accepted: true }, NOW);
    for (let i = 0; i < 3; i += 1) incrementAnswerAcceptance(db, 'tenant-a', 'pt-BR', { accepted: false }, NOW);
    // pt-PT: 4/5 = 0.80 (variant input 'pt' folds into pt-PT)
    for (let i = 0; i < 4; i += 1) incrementAnswerAcceptance(db, 'tenant-a', 'pt', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', 'pt-PT', { accepted: false }, NOW);
    // mixed: unknown locale 'fr' + empty + 'mixed' all fold into mixed → 3/4 = 0.75
    incrementAnswerAcceptance(db, 'tenant-a', 'fr', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', '', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', 'mixed', { accepted: true }, NOW);
    incrementAnswerAcceptance(db, 'tenant-a', undefined, { accepted: false }, NOW);

    // Exactly four bucket rows.
    expect(rowCount(db)).toBe(4);

    expect(computeAnswerAcceptanceRate(db, 'en', { tenantId: 'tenant-a' }).rate).toBeCloseTo(0.9, 10);
    expect(computeAnswerAcceptanceRate(db, 'pt-BR', { tenantId: 'tenant-a' }).rate).toBeCloseTo(0.85, 10);
    expect(computeAnswerAcceptanceRate(db, 'pt-PT', { tenantId: 'tenant-a' }).rate).toBeCloseTo(0.8, 10);

    const mixed = computeAnswerAcceptanceRate(db, 'mixed', { tenantId: 'tenant-a' });
    expect(mixed.total).toBe(4);
    expect(mixed.accepted).toBe(3);
    expect(mixed.rate).toBeCloseTo(0.75, 10);

    // The "all" rollup sums every bucket: (9+17+4+3) accepted / (10+20+5+4) total.
    const all = computeAnswerAcceptanceRate(db, 'all', { tenantId: 'tenant-a' });
    expect(all.accepted).toBe(33);
    expect(all.total).toBe(39);
    expect(all.rate).toBeCloseTo(33 / 39, 10);
  });

  it('TENANT isolation: tenant-a counts never roll into tenant-b', () => {
    incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: false }, NOW); // a: 0/1 → 0.0
    incrementAnswerAcceptance(db, 'tenant-b', 'en', { accepted: true }, NOW); // b: 1/1 → 1.0

    expect(computeAnswerAcceptanceRate(db, 'en', { tenantId: 'tenant-a' }).rate).toBe(0);
    expect(computeAnswerAcceptanceRate(db, 'en', { tenantId: 'tenant-b' }).rate).toBe(1);
    // tenant-a's "all" rollup must not see tenant-b's accepted row.
    const allA = computeAnswerAcceptanceRate(db, 'all', { tenantId: 'tenant-a' });
    expect(allA.accepted).toBe(0);
    expect(allA.total).toBe(1);
  });
});

describe('answer-acceptance-counter — fire-and-forget (never throws)', () => {
  it('incrementAnswerAcceptance returns false (does NOT throw) on a closed db', () => {
    const db = new Database(':memory:');
    ensureChatCoreV2AnswerAcceptanceCounterTable(db);
    db.close();
    let result: boolean | undefined;
    expect(() => {
      result = incrementAnswerAcceptance(db, 'tenant-a', 'en', { accepted: true }, NOW);
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
