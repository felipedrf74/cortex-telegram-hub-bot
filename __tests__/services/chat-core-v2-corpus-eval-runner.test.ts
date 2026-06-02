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
  isPeerReviewedCorpusContentHash,
  rawCorpusContentHashFromGateBinding,
} from '../../src/services/chat-core-v2/gate-metrics-store';
import { runChatCoreV2ShadowRouteHook } from '../../src/services/chat-core-v2/shadow-route-hook';
import { ensureChatCoreV2AuditTables } from '../../src/services/chat-core-v2/model-run-audit';
import type { ChatCoreV2CorpusLanguage, ChatCoreV2GoldenCorpus } from '../../src/services/chat-core-v2/golden-corpus';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION } from '../../src/services/chat-core-v2/golden-corpus';

let db: Database.Database;

const HMAC_SECRET = 'corpus-eval-runner-test-secret';
const PEER_REVIEW_SIGNOFF_HASH = 'c'.repeat(64);
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

function reviewedGoldenCorpus(count = 200): ChatCoreV2GoldenCorpus {
  const languages: ChatCoreV2CorpusLanguage[] = ['en', 'pt-BR', 'pt-PT', 'mixed'];
  return {
    schemaVersion: CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION,
    items: Array.from({ length: count }, (_, index) => {
      const language = languages[index % languages.length];
      const message = language === 'en'
        ? `Create a task to review the corpus item ${index}`
        : language === 'pt-BR'
          ? `Crie uma tarefa para revisar o item ${index}`
          : language === 'pt-PT'
            ? `Criar uma tarefa para rever o item ${index}`
            : `Create uma tarefa mixed corpus item ${index}`;
      return {
        id: `reviewed-${index}`,
        language,
        message,
        expectedDomainIds: ['tasks'],
        expectedCapabilityIds: ['tasks.create'],
        forbiddenClaims: [],
        evidenceRequirements: ['read_model'],
        source: 'operator_labeled',
      };
    }),
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
    it('GATE_FAIL when recall meets the target over a NON-synthetic corpus without peer-review signoff', () => {
      const result = runCorpusEval(db, {
        goldenCorpus: reviewedGoldenCorpus(),
        includeShadowCorpus: false,
      });
      expect(result.recallAtK).toBeGreaterThanOrEqual(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(result.corpusIsSyntheticSeed).toBe(false);
      expect(result.corpusIsPromotionEligible).toBe(true);
      expect(result.corpusHasPeerReviewSignoff).toBe(false);
      expect(result.gatePass).toBe(false);
      expect(result.notes).toContain('peer-review signoff');
    });

    it('GATE_PASS when recall meets the target over a peer-reviewed promotion-eligible NON-synthetic corpus', () => {
      const result = runCorpusEval(db, {
        goldenCorpus: reviewedGoldenCorpus(),
        includeShadowCorpus: false,
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      });
      expect(result.recallAtK).toBeGreaterThanOrEqual(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(result.corpusIsSyntheticSeed).toBe(false);
      expect(result.corpusValidationIssues).toEqual([]);
      expect(result.corpusIsPromotionEligible).toBe(true);
      expect(result.corpusHasPeerReviewSignoff).toBe(true);
      expect(result.corpusPeerReviewBindingAccepted).toBe(true);
      expect(isPeerReviewedCorpusContentHash(result.corpusContentHash)).toBe(true);
      expect(rawCorpusContentHashFromGateBinding(result.corpusContentHash)).toMatch(/^[a-f0-9]{64}$/);
      expect(result.gatePass).toBe(true);
      expect(result.notes).toContain('GATE_PASS');
    });

    it('GATE_FAIL when aggregate recall passes but a required language bucket misses its floor', () => {
      const corpus = reviewedGoldenCorpus();
      let ptPtMisses = 0;
      corpus.items = corpus.items.map((item) =>
        item.language === 'pt-PT' && ptPtMisses++ < 5
          ? { ...item, expectedCapabilityIds: ['capability.that.never.gets.selected'] }
          : item,
      );

      const result = runCorpusEval(db, {
        goldenCorpus: corpus,
        includeShadowCorpus: false,
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      });

      expect(result.recallAtK).toBeGreaterThanOrEqual(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(result.languageGatePass).toBe(false);
      expect(result.languageGateFailures).toEqual(expect.arrayContaining([expect.stringMatching(/^pt-PT:/)]));
      expect(result.gatePass).toBe(false);
      expect(result.notes).toContain('per-language recall floors');
      expect(gateCanPromote(db)).toBe(false);
    });

    it('GATE_FAIL and persists a non-promotion binding for an invalid tiny corpus even with peer-review signoff', () => {
      const result = runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: false,
        peerReviewSignoffHash: PEER_REVIEW_SIGNOFF_HASH,
      });

      expect(result.recallAtK).toBeGreaterThanOrEqual(CHAT_CORE_V2_GATE_RECALL_AT_8_TARGET);
      expect(result.corpusHasPeerReviewSignoff).toBe(true);
      expect(result.corpusPeerReviewBindingAccepted).toBe(false);
      expect(result.corpusIsPromotionEligible).toBe(false);
      expect(result.corpusValidationIssues).toEqual(expect.arrayContaining([
        'too_few_items',
        'missing_language',
        'synthetic_only',
      ]));
      expect(isPeerReviewedCorpusContentHash(result.corpusContentHash)).toBe(false);
      expect(result.gatePass).toBe(false);
      expect(result.notes).toContain('not promotion-eligible');

      const persisted = getLatestRecallAt8(db);
      expect(persisted).not.toBeNull();
      expect(persisted!.corpusContentHash).toBe(result.corpusContentHash);
      expect(gateCanPromote(db)).toBe(false);
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

    it('binds the corpus hash to shadow candidate ids, not only message token and expected ids', () => {
      insertCraftedShadowRow(db, 'candidate-hit', {
        contextPack: {
          messageHash: 'a'.repeat(64),
          locale: 'en',
          guessedCapabilities: ['tasks.complete'],
        },
        response: { selectedCapabilityIds: ['tasks.complete'] },
      });
      const hit = runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: true,
        shadow: { hmacSecret: HMAC_SECRET },
        persist: false,
      });

      db.prepare('DELETE FROM chat_v2_replay_bundles').run();
      insertCraftedShadowRow(db, 'candidate-miss', {
        contextPack: {
          messageHash: 'a'.repeat(64),
          locale: 'en',
          guessedCapabilities: ['tasks.complete'],
        },
        response: { selectedCapabilityIds: ['general.help'] },
      });
      const miss = runCorpusEval(db, {
        goldenCorpus: perfectGoldenCorpus(),
        includeShadowCorpus: true,
        shadow: { hmacSecret: HMAC_SECRET },
        persist: false,
      });

      expect(hit.corpusContentHash).not.toBe(miss.corpusContentHash);
      expect(hit.recallAtK).toBeGreaterThan(miss.recallAtK);
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

function insertCraftedShadowRow(
  database: Database.Database,
  suffix: string,
  bundle: { contextPack: Record<string, unknown>; response: Record<string, unknown> },
  createdAt = new Date().toISOString(),
): void {
  ensureChatCoreV2AuditTables(database);
  database
    .prepare(
      `INSERT INTO chat_v2_replay_bundles
        (replay_bundle_id, turn_id, sensitivity, retention_policy, redacted_bundle_json, created_at)
       VALUES (?, ?, 'normal', '90d', ?, ?)`,
    )
    .run(
      `chatv2-shadow-replay:${suffix}`,
      `turn-${suffix}`,
      JSON.stringify({ turnId: `turn-${suffix}`, ...bundle }),
      createdAt,
    );
}
