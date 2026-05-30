import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  runCorpusEval,
  ensureChatCoreV2GateEvalRunsTable,
  listChatCoreV2GateEvalRuns,
} from '../../src/services/chat-core-v2/corpus-eval-runner';
import {
  getLatestRecallAt8,
  gateCanPromote,
  getSyntheticSeedCorpusContentHash,
  CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET,
} from '../../src/services/chat-core-v2/gate-metrics-store';
import { runChatCoreV2ShadowRouteHook } from '../../src/services/chat-core-v2/shadow-route-hook';
import { ensureChatCoreV2AuditTables } from '../../src/services/chat-core-v2/model-run-audit';
import type { ChatCoreV2GoldenCorpus } from '../../src/services/chat-core-v2/golden-corpus';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION } from '../../src/services/chat-core-v2/golden-corpus';

let db: Database.Database;

const HMAC_SECRET = 'corpus-eval-runner-test-secret';
const ENABLED_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: HMAC_SECRET,
};

function seedShadowTurn(text: string, id: string): void {
  const result = runChatCoreV2ShadowRouteHook({
    normalizedText: text,
    userId: 7,
    tenantId: 7,
    chatRequestId: id,
    userMessageId: `${id}-msg`,
    clientMessageId: `${id}-client`,
    locale: 'en',
    env: ENABLED_ENV,
    db,
  });
  expect(result.recorded).toBe(true);
}

/** A tiny golden corpus with a known recall outcome (every item is trivially covered). */
function perfectGoldenCorpus(): ChatCoreV2GoldenCorpus {
  return {
    schemaVersion: CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
    items: [
      {
        id: 'g1',
        language: 'en',
        message: 'Create a task to buy groceries',
        expectedDomainIds: ['tasks'],
        // 'tasks.create' is what the prepass selector yields for "create" phrasing.
        expectedCapabilityIds: ['tasks.create'],
        forbiddenClaims: [],
        evidenceRequirements: ['x'],
        source: 'operator_labeled',
      },
    ],
  };
}

/** A golden corpus whose ground truth the selector can never hit (forces GATE_FAIL). */
function impossibleGoldenCorpus(): ChatCoreV2GoldenCorpus {
  return {
    schemaVersion: CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
    items: [
      {
        id: 'imp1',
        language: 'en',
        message: 'Create a task to buy groceries',
        expectedDomainIds: ['tasks'],
        expectedCapabilityIds: ['capability.that.never.gets.selected'],
        forbiddenClaims: [],
        evidenceRequirements: ['x'],
        source: 'operator_labeled',
      },
    ],
  };
}

describe('Chat Core v2 corpus eval runner (WP-19)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatCoreV2AuditTables(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('eval => upsertRecallAt8 round-trip (bound to a content-hash)', () => {
    it('persists the measured recall bound to the corpus content-hash and records a run-history row', () => {
      const result = runCorpusEval(db, {
        evalType: 'weekly',
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: false,
        recordedAt: '2026-05-30T00:00:00.000Z',
      });

      // WP-13's keyed store now has the recall, bound to the SAME content-hash.
      const persisted = getLatestRecallAt8(db);
      expect(persisted).not.toBeNull();
      expect(persisted!.recallAt8).toBeCloseTo(result.recallAtK, 10);
      expect(persisted!.corpusContentHash).toBe(result.corpusContentHash);

      // And a run-history row exists with the safe scalars.
      const runs = listChatCoreV2GateEvalRuns(db);
      expect(runs.length).toBe(1);
      expect(runs[0].evalType).toBe('weekly');
      expect(runs[0].recallAtK).toBeCloseTo(result.recallAtK, 10);
      expect(runs[0].corpusContentHash).toBe(result.corpusContentHash);
      expect(runs[0].wrotePersistedRecall).toBe(true);
    });

    it('persist:false does NOT write the keyed recall or a run-history row', () => {
      runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: false,
        persist: false,
      });
      expect(getLatestRecallAt8(db)).toBeNull();
      ensureChatCoreV2GateEvalRunsTable(db);
      expect(listChatCoreV2GateEvalRuns(db).length).toBe(0);
    });
  });

  describe('HONESTY: the synthetic seed run does NOT open the gate', () => {
    it('a synthetic-seed run binds to the REJECTED hash and gateCanPromote stays FALSE even though recall >= target', () => {
      const result = runCorpusEval(db, {
        evalType: 'seed',
        includeShadowCorpus: false, // golden seed only => binds to the synthetic hash
        recordedAt: '2026-05-30T00:00:00.000Z',
      });

      // The seed recall is high (≈0.977 > 0.90 target) ...
      expect(result.recallAtK).toBeGreaterThan(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      // ... but it is bound to the REJECTED synthetic-seed content-hash ...
      expect(result.corpusIsSyntheticSeed).toBe(true);
      expect(result.corpusContentHash).toBe(getSyntheticSeedCorpusContentHash());
      // ... so the run's own verdict is GATE_FAIL ...
      expect(result.gatePass).toBe(false);
      expect(result.notes).toContain('SYNTHETIC seed');
      // ... and WP-13's composed gate STILL cannot promote (the recall is persisted
      // but synthetic-bound; shadow readiness is also unmet on a fresh db).
      expect(gateCanPromote(db)).toBe(false);
    });

    it('the first persisted recall exists after the seed run (resolves the inverted dependency) but is synthetic-bound', () => {
      expect(getLatestRecallAt8(db)).toBeNull(); // nothing before the seed run
      runCorpusEval(db, { evalType: 'seed', includeShadowCorpus: false });
      const persisted = getLatestRecallAt8(db);
      expect(persisted).not.toBeNull();
      expect(persisted!.corpusContentHash).toBe(getSyntheticSeedCorpusContentHash());
      expect(gateCanPromote(db)).toBe(false); // synthetic can never open the gate
    });
  });

  describe('GATE_PASS / GATE_FAIL verdict', () => {
    it('GATE_PASS when recall meets the target over a NON-synthetic corpus', () => {
      const result = runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: false,
      });
      expect(result.recallAtK).toBeGreaterThanOrEqual(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(result.corpusIsSyntheticSeed).toBe(false);
      expect(result.gatePass).toBe(true);
      expect(result.notes).toContain('GATE_PASS');
    });

    it('GATE_FAIL when recall is below the target', () => {
      const result = runCorpusEval(db, {
        goldenCorpus: impossibleGoldenCorpus(),
        includeShadowCorpus: false,
      });
      expect(result.recallAtK).toBeLessThan(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(result.gatePass).toBe(false);
      expect(result.notes).toContain('GATE_FAIL');
    });
  });

  describe('merged golden + shadow corpus (drop-text shadow items)', () => {
    it('merges shadow items and the run-history records the shadow count', () => {
      seedShadowTurn('Create a task to buy supplements', 'sh-1');
      seedShadowTurn('Mark the supplements task as done', 'sh-2');

      const result = runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: true,
        shadow: { hmacSecret: HMAC_SECRET },
      });

      expect(result.shadowItemCount).toBeGreaterThan(0);
      expect(result.goldenItemCount).toBe(1);
      expect(result.corpusItemCount).toBe(result.goldenItemCount + result.shadowItemCount);
      // Merged corpus is NOT the synthetic seed.
      expect(result.corpusIsSyntheticSeed).toBe(false);

      const runs = listChatCoreV2GateEvalRuns(db);
      expect(runs[0].shadowItemCount).toBe(result.shadowItemCount);
    });

    it('the persisted run-history row carries NO raw text — only safe scalars + a content-hash', () => {
      seedShadowTurn('Create a task with passphrase hunter2 and account 12345', 'sh-raw');
      runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: true,
        shadow: { hmacSecret: HMAC_SECRET },
      });
      const raw = db.prepare('SELECT * FROM chat_v2_gate_eval_runs').all();
      const serialized = JSON.stringify(raw);
      expect(serialized).not.toContain('passphrase');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('12345');
      // The content-hash is a 64-hex digest, not text.
      expect(JSON.stringify(raw)).toMatch(/[a-f0-9]{64}/);
    });
  });

  describe('no network', () => {
    it('the runner never calls fetch', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
      seedShadowTurn('Create a task to buy supplements', 'nn-1');
      runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: true,
        shadow: { hmacSecret: HMAC_SECRET },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
