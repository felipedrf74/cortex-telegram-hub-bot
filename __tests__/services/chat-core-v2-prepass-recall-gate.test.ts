import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import {
  evaluateGoldenCorpusPrepassRecallAtK,
} from '../../src/services/chat-core-v2/prepass-recall-eval';
import { selectPrepassCandidateCapabilities } from '../../src/services/chat-core-v2/prepass-candidate-selection';
import { auditPrepassSourceForDeterminism } from '../../src/services/chat-core-v2/prepass-contract';
import {
  validateGoldenCorpus,
  countRealEvidenceItems,
  DEFAULT_MIN_REAL_EVIDENCE_ITEMS,
  type ChatCoreV2GoldenCorpus,
} from '../../src/services/chat-core-v2/golden-corpus';
import { CHAT_CORE_V2_GOLDEN_CORPUS_SEED } from '../../src/services/chat-core-v2/golden-corpus-seed';
import { CHAT_CORE_V2_SYNTHETIC_CORPUS } from '../../src/services/chat-core-v2/golden-corpus-synthetic';
import { CHAT_CORE_V2_CAPABILITIES } from '../../src/services/chat-core-v2/capability-registry';

/**
 * WP-09 — Recall@8 corpus CI assertion (B4 engineering half).
 *
 * This test ASSERTS the Layer-1 prepass recall@8 harness runs and reports a
 * per-corpus recall@8 BASELINE. It is deliberately NOT the Phase 2 promotion
 * gate:
 *
 *   - The promotion gate requires a peer-reviewed, predominantly-real >=200-turn
 *     corpus (a data/process gate, out of scope for this WP). The synthetic seed
 *     is a baseline only — `validateGoldenCorpus` flags it `synthetic_only`.
 *   - WP-09 only asserts recall in CI; it does NOT persist. The persisted
 *     `recall_at_8_latest` that opens `gateCanPromote` is written by WP-13's
 *     `upsertRecallAt8()`, first called by WP-19-seed (neither exists yet). This
 *     test must never import or call a persistence writer.
 *
 * The selector is a determinism-audited Layer-1 file (WP-03). WP-09 mutates it,
 * so this test also re-runs the determinism audit and a capability-whitelist
 * check (every emitted candidate must exist in the registry).
 */

// PEER_REVIEW_SIGN_OFF: <PENDING>
// A real (peer-reviewed) recall@8 gate corpus + sign-off hash is required before
// recall@8 can authorize promotion. Until then this remains a baseline measurement.

const REGISTRY_IDS = new Set(CHAT_CORE_V2_CAPABILITIES.map((c) => c.capabilityId));
// Sentinels/fallback markers are intentional non-registry routing markers emitted
// by the selector (clarify/unsupported/help). They are NOT registry capabilities
// and are excluded from the candidate-whitelist check by design.
const SENTINEL_MARKERS = new Set(['clarify_reference', 'unsupported', 'general.help']);

const SELECTOR_SOURCE = readFileSync(
  'src/services/chat-core-v2/prepass-candidate-selection.ts',
  'utf8',
);

function emittedCandidatesOver(corpus: ChatCoreV2GoldenCorpus): Set<string> {
  const emitted = new Set<string>();
  for (const item of corpus.items) {
    for (const id of selectPrepassCandidateCapabilities({ message: item.message }).candidateCapabilityIds) {
      emitted.add(id);
    }
  }
  return emitted;
}

describe('Chat Core v2 prepass recall@8 CI assertion (WP-09 / B4)', () => {
  it('runs the harness and reports a BASELINE recall@8 over the seed corpus (NOT the promotion gate)', () => {
    const result = evaluateGoldenCorpusPrepassRecallAtK(CHAT_CORE_V2_GOLDEN_CORPUS_SEED, 8);

    // The harness runs and reports a coherent per-corpus recall@8 number.
    expect(result.k).toBe(8);
    expect(result.total).toBe(CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items.length);
    expect(result.scored).toBeGreaterThan(0);
    expect(result.recallAtK).toBeGreaterThanOrEqual(0);
    expect(result.recallAtK).toBeLessThanOrEqual(1);

    // Engineering floor: after the WP-09 capability-coverage pass the selector
    // covers the previously-uncovered cooking/content/finance/write classes, so
    // the BASELINE recall is comfortably high. This is a regression floor on the
    // selector's coverage, NOT a claim that the gate is met.
    expect(result.recallAtK).toBeGreaterThanOrEqual(0.95);

    // Surface the baseline for CI logs (visible in vitest stdout on failure/run).
    // eslint-disable-next-line no-console
    console.log(
      `[WP-09 BASELINE] synthetic seed recall@8 = ${result.recallAtK.toFixed(4)} ` +
        `(${result.hits}/${result.scored}) — BASELINE, NOT the promotion gate`,
    );
  });

  it('reports a baseline for the synthetic corpus too (second corpus, same harness)', () => {
    const result = evaluateGoldenCorpusPrepassRecallAtK(CHAT_CORE_V2_SYNTHETIC_CORPUS, 8);
    expect(result.k).toBe(8);
    expect(result.total).toBe(CHAT_CORE_V2_SYNTHETIC_CORPUS.items.length);
    expect(result.recallAtK).toBeGreaterThanOrEqual(0);
    expect(result.recallAtK).toBeLessThanOrEqual(1);
  });

  it('EXPLICITLY asserts the synthetic seed is a baseline, not a real gate corpus', () => {
    // The honest contract of this WP: the synthetic seed does NOT clear the gate.
    // The strengthened validator (WP-09) flags it `synthetic_only` because its
    // real-evidence content is far below the floor, so a high baseline recall@8
    // can never be mistaken for "the gate is met".
    const issues = validateGoldenCorpus(CHAT_CORE_V2_GOLDEN_CORPUS_SEED);
    expect(issues).toContain('synthetic_only');

    // Concretely below the real-evidence floor (proves the flag is earned, not
    // accidental): the seed carries far fewer real-evidence items than required.
    expect(countRealEvidenceItems(CHAT_CORE_V2_GOLDEN_CORPUS_SEED)).toBeLessThan(
      DEFAULT_MIN_REAL_EVIDENCE_ITEMS,
    );
  });

  it('does NOT persist recall (WP-19 owns the writer, which does not exist yet)', () => {
    // Guard against a future edit accidentally wiring persistence into the CI
    // assertion. The persisted recall writer is WP-13/WP-19 territory; this WP
    // only asserts. If a gate-metrics store ever ships, persistence belongs in
    // WP-19-seed, not here — so this module must contain no `import ... from`
    // statement that pulls in a gate-metrics writer/store. (We check imports, not
    // any mention, so this self-documenting comment cannot trip the guard.)
    const moduleSource = readFileSync(
      '__tests__/services/chat-core-v2-prepass-recall-gate.test.ts',
      'utf8',
    );
    const persistenceImports = moduleSource
      .split('\n')
      .filter((line) => /^\s*import\s.+from\s/.test(line))
      .filter((line) => /gate-metrics-store|upsert[A-Za-z]*Recall|getLatest[A-Za-z]*Recall/.test(line));
    expect(persistenceImports).toEqual([]);
  });

  it('capability whitelist: every emitted candidate exists in capability-registry.ts (excl. sentinels)', () => {
    const offenders = [...emittedCandidatesOver(CHAT_CORE_V2_GOLDEN_CORPUS_SEED)]
      .filter((id) => !SENTINEL_MARKERS.has(id))
      .filter((id) => !REGISTRY_IDS.has(id));
    expect(offenders).toEqual([]);

    // The remap targets WP-09 introduced must be real registry capabilities.
    for (const target of [
      'cooking.meal_plan_summary',
      'content.brief_draft_preview',
      'finance.summary',
      'training.session_explain',
      'tasks.create',
      'tasks.complete',
    ]) {
      expect(REGISTRY_IDS.has(target)).toBe(true);
    }
  });

  it('keeps the selector deterministic (no model/network/cloud references after WP-09 edit)', () => {
    expect(auditPrepassSourceForDeterminism(SELECTOR_SOURCE)).toEqual([]);
  });

  it('holds the 8-candidate cap over the whole seed corpus', () => {
    for (const item of CHAT_CORE_V2_GOLDEN_CORPUS_SEED.items) {
      const candidates = selectPrepassCandidateCapabilities({ message: item.message }).candidateCapabilityIds;
      expect(candidates.length).toBeLessThanOrEqual(8);
    }
  });
});
