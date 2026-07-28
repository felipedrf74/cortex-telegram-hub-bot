import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const providerMocks = vi.hoisted(() => ({
  getActiveProvider: vi.fn(),
  getProvider: vi.fn(),
  classifyMessage: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: vi.fn(() => {
    throw new Error('tests must pass an explicit db');
  }),
  withDatabaseForTestAsync: vi.fn(),
}));

// The accuracy replay must NEVER touch a live provider: the LLM surface is
// replayed exclusively from the SQLite cache. These mocks make any live call
// observable (and would explode if invoked for classification).
vi.mock('../../src/services/provider-registry', async () => ({
  ...(await vi.importActual('../../src/services/provider-registry')),
  getActiveProvider: providerMocks.getActiveProvider,
  getProvider: providerMocks.getProvider,
}));

vi.mock('../../src/services/anthropic', async () => ({
  ...(await vi.importActual('../../src/services/anthropic')),
  classifyMessage: providerMocks.classifyMessage,
}));

import { compileIntentVocabulary } from '../../src/services/intent-resolution/vocabulary';
import { ensureRoutingCorpusTables, hashRoutingUtterance } from '../../src/services/routing-corpus';
import {
  canAcceptAccuracySnapshot,
  compareRoutingAccuracySnapshots,
  computeRoutingAccuracyReport,
  getLatestAcceptedAccuracySnapshot,
  predictRoutingSurfaces,
  recommendClarifyThreshold,
  runRoutingAccuracy,
  storeAcceptedAccuracySnapshot,
  type LabeledPredictionRow,
  type RoutingAccuracyReport,
  type RoutingSurfacePrediction,
} from '../../src/services/routing-accuracy';

const SECRET = 'routing-accuracy-test-secret';

const SYNTHETIC_VOCABULARY = compileIntentVocabulary([
  {
    id: 'secretary',
    runtimeRouting: { domain: 'secretary', chatOwnerSkill: 'secretary' },
    chatOwnerSkills: ['secretary', 'tasks'],
    routingVocabulary: { locales: { pt: ['tarefas?'] } },
  },
  {
    id: 'finance',
    runtimeRouting: { domain: 'finance', chatOwnerSkill: 'finance' },
    chatOwnerSkills: ['finance'],
    routingVocabulary: { locales: { pt: ['gastei'] } },
  },
] as never[]);

function prediction(
  surface: RoutingSurfacePrediction['surface'],
  domain: string,
  confidence?: number,
  covered = true,
): RoutingSurfacePrediction {
  return { surface, domain, confidence, covered };
}

function keywordRow(labelDomain: string, predicted: string): LabeledPredictionRow {
  return { labelDomain, predictions: [prediction('classifier_keyword', predicted)] };
}

describe('routing accuracy report math', () => {
  it('computes per-domain precision and recall per surface', () => {
    const rows: LabeledPredictionRow[] = [
      keywordRow('secretary', 'secretary'),
      keywordRow('secretary', 'secretary'),
      keywordRow('secretary', 'finance'),   // secretary FN, finance FP
      keywordRow('finance', 'finance'),
      keywordRow('cooking', 'none'),        // abstain — cooking FN, none FP
    ];

    const report = computeRoutingAccuracyReport(rows, { generatedAt: '2026-07-21T00:00:00.000Z' });
    const surface = report.surfaces.find((candidate) => candidate.surface === 'classifier_keyword')!;

    expect(surface.covered).toBe(5);
    expect(surface.accuracy).toBe(0.6);
    const secretary = surface.perDomain.find((domain) => domain.domain === 'secretary')!;
    expect(secretary).toMatchObject({ support: 3, truePositives: 2, falsePositives: 0, falseNegatives: 1 });
    expect(secretary.precision).toBe(1);
    expect(secretary.recall).toBe(0.6667);
    const finance = surface.perDomain.find((domain) => domain.domain === 'finance')!;
    expect(finance.precision).toBe(0.5);
    expect(finance.recall).toBe(1);
    const cooking = surface.perDomain.find((domain) => domain.domain === 'cooking')!;
    expect(cooking.precision).toBeNull(); // never predicted
    expect(cooking.recall).toBe(0);
  });

  it('buckets stated confidence against empirical accuracy', () => {
    const rows: LabeledPredictionRow[] = [
      { labelDomain: 'secretary', predictions: [prediction('shadow_route_guess', 'secretary', 0.95)] },
      { labelDomain: 'secretary', predictions: [prediction('shadow_route_guess', 'secretary', 0.9)] },
      { labelDomain: 'secretary', predictions: [prediction('shadow_route_guess', 'finance', 0.85)] },
      { labelDomain: 'finance', predictions: [prediction('shadow_route_guess', 'secretary', 0.3)] },
    ];

    const report = computeRoutingAccuracyReport(rows);
    const surface = report.surfaces.find((candidate) => candidate.surface === 'shadow_route_guess')!;
    const highBucket = surface.calibration.find((bucket) => bucket.bucket === '0.8-1.0')!;
    expect(highBucket.count).toBe(3);
    expect(highBucket.correct).toBe(2);
    expect(highBucket.empiricalAccuracy).toBe(0.6667);
    expect(highBucket.averageStatedConfidence).toBe(0.9);
    const lowBucket = surface.calibration.find((bucket) => bucket.bucket === '0.2-0.4')!;
    expect(lowBucket).toMatchObject({ count: 1, correct: 0, empiricalAccuracy: 0 });
    // Surfaces without stated confidence produce empty calibration buckets.
    const keyword = report.surfaces.find((candidate) => candidate.surface === 'classifier_keyword')!;
    expect(keyword.calibration.every((bucket) => bucket.count === 0)).toBe(true);
    expect(keyword.recommendedClarifyThreshold).toBeNull();
  });

  it('recommends the lowest clarify threshold that meets the accuracy target', () => {
    const observations = [
      { confidence: 0.95, correct: true },
      { confidence: 0.9, correct: true },
      { confidence: 0.85, correct: true },
      { confidence: 0.7, correct: false },
      { confidence: 0.6, correct: false },
    ];
    // Above 0.75 → 3/3 correct (first 0.05 step past the 0.7 miss);
    // at 0.7 and below → 3/4 = 0.75 < 0.9.
    expect(recommendClarifyThreshold(observations, 0.9)).toBe(0.75);
    // A 0.5 target is already met with everything included.
    expect(recommendClarifyThreshold(observations, 0.5)).toBe(0);
    // Unreachable target → null.
    expect(recommendClarifyThreshold([{ confidence: 0.99, correct: false }], 0.9)).toBeNull();
    expect(recommendClarifyThreshold([{ correct: true }], 0.9)).toBeNull();
  });
});

describe('routing accuracy gate', () => {
  function reportWith(recall: number, precision = 1): RoutingAccuracyReport {
    return {
      version: 'routing-accuracy@1.0.0',
      generatedAt: '2026-07-21T00:00:00.000Z',
      itemCount: 10,
      clarifyAccuracyTarget: 0.85,
      surfaces: [{
        surface: 'classifier_keyword',
        covered: 10,
        uncovered: 0,
        correct: 8,
        accuracy: 0.8,
        perDomain: [{
          domain: 'secretary',
          support: 5,
          truePositives: 4,
          falsePositives: 0,
          falseNegatives: 1,
          precision,
          recall,
        }],
        calibration: [],
        recommendedClarifyThreshold: null,
      }],
    };
  }

  it('fails when a domain drops more than 2pts and passes within tolerance', () => {
    const accepted = reportWith(0.9);
    const within = compareRoutingAccuracySnapshots(reportWith(0.88), accepted);
    expect(within.passed).toBe(true);

    const regressed = compareRoutingAccuracySnapshots(reportWith(0.87), accepted);
    expect(regressed.passed).toBe(false);
    expect(regressed.regressions).toEqual([
      expect.objectContaining({ surface: 'classifier_keyword', domain: 'secretary', metric: 'recall', dropPoints: 0.03 }),
    ]);

    const precisionDrop = compareRoutingAccuracySnapshots(reportWith(0.9, 0.9), accepted);
    expect(precisionDrop.passed).toBe(false);
    expect(precisionDrop.regressions[0]?.metric).toBe('precision');
  });

  it('FAILS when an accepted surface with coverage collapses to covered=0', () => {
    // Wiping routing_llm_classify_cache (or rotating CLASSIFY_SHADOW_HASH_SECRET)
    // makes a surface report covered=0 — the gate must fail loudly, not pass
    // vacuously with nothing to compare.
    const accepted = reportWith(0.9);
    const current = reportWith(0.9);
    current.surfaces[0].covered = 0;
    current.surfaces[0].perDomain = [];

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual([
      expect.stringContaining('classifier_keyword: coverage collapsed from 10 to 0'),
    ]);
  });

  it('FAILS when a domain with accepted support>0 is absent from the current report', () => {
    const accepted = reportWith(0.9);
    const current = reportWith(0.5);
    current.surfaces[0].perDomain[0].domain = 'finance'; // secretary (support 5) vanished

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(false);
    expect(result.comparedSurfaces).toBe(1);
    expect(result.reasons).toEqual([
      expect.stringContaining('domain secretary (accepted support 5) is absent from the current report'),
    ]);
  });

  it('FAILS when an accepted surface with coverage is entirely absent from the current report', () => {
    const accepted = reportWith(0.9);
    const current = reportWith(0.9);
    current.surfaces = [];

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(false);
    expect(result.comparedSurfaces).toBe(0);
    expect(result.reasons).toEqual([
      expect.stringContaining('the surface is absent from the current report'),
    ]);
  });

  it('legitimately skips accepted domains with support=0', () => {
    const accepted = reportWith(0.9);
    accepted.surfaces[0].perDomain[0].support = 0;
    const current = reportWith(0.9);
    current.surfaces[0].perDomain[0].domain = 'finance'; // absent, but accepted support was 0

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('refuses --accept-snapshot after a FAILED gate but allows it standalone or on pass', () => {
    expect(canAcceptAccuracySnapshot(true, { passed: false })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('lower the ratchet'),
    });
    expect(canAcceptAccuracySnapshot(true, { passed: true })).toEqual({ allowed: true });
    // --gate with no accepted snapshot (gate skipped) may still bootstrap one.
    expect(canAcceptAccuracySnapshot(true, null)).toEqual({ allowed: true });
    // Standalone --accept-snapshot without --gate stays allowed.
    expect(canAcceptAccuracySnapshot(false, null)).toEqual({ allowed: true });
  });

  it('wires the ratchet guard into the run-routing-accuracy CLI accept path', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'run-routing-accuracy.ts'),
      'utf8',
    );
    expect(raw).toContain('canAcceptAccuracySnapshot(gateMode, gateResult)');
    expect(raw).toContain('acceptSnapshotRefused');
  });
});

describe('routing accuracy replay (cache-only, zero live calls)', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    providerMocks.getActiveProvider.mockImplementation(() => {
      throw new Error('live provider must never be touched by the accuracy replay');
    });
    providerMocks.classifyMessage.mockImplementation(() => {
      throw new Error('live classify must never be touched by the accuracy replay');
    });
    db = new Database(':memory:');
    ensureRoutingCorpusTables(db);
  });

  afterEach(() => {
    db.close();
  });

  function insertLabeledItem(text: string, labelDomain: string): string {
    const hash = hashRoutingUtterance(SECRET, text);
    db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source,
        label_domain, label_skill, label_status, labeled_at
      ) VALUES (0, NULL, ?, ?, 'manual', ?, NULL, 'labeled', datetime('now'))
    `).run(hash, text, labelDomain);
    return hash;
  }

  it('replays labeled items through all surfaces using only the SQLite LLM cache', () => {
    const cachedHash = insertLabeledItem('Cria uma tarefa para comprar leite amanhã', 'secretary');
    insertLabeledItem('Quanto gastei este mês?', 'finance');
    db.prepare(`
      INSERT INTO routing_llm_classify_cache (utterance_hash, domain, confidence, model)
      VALUES (?, 'secretary', 0.92, 'gemini-2.5-flash-lite')
    `).run(cachedHash);

    const report = runRoutingAccuracy({ db, vocabulary: SYNTHETIC_VOCABULARY });

    expect(report.itemCount).toBe(2);
    const llmSurface = report.surfaces.find((surface) => surface.surface === 'llm_classify_cache')!;
    expect(llmSurface.covered).toBe(1);
    expect(llmSurface.uncovered).toBe(1); // cache miss is excluded, never fetched live
    expect(llmSurface.correct).toBe(1);
    expect(llmSurface.accuracy).toBe(1);

    const resolverSurface = report.surfaces.find((surface) => surface.surface === 'intent_resolver')!;
    expect(resolverSurface.covered).toBe(2);
    expect(resolverSurface.accuracy).toBe(1); // tarefa → secretary, gastei → finance

    // Deterministic surfaces all produced an answer.
    for (const surfaceId of ['classifier_keyword', 'shadow_route_guess', 'orchestrator_analyze'] as const) {
      const surface = report.surfaces.find((candidate) => candidate.surface === surfaceId)!;
      expect(surface.covered).toBe(2);
    }

    // Zero live provider interaction of any kind.
    expect(providerMocks.getActiveProvider).not.toHaveBeenCalled();
    expect(providerMocks.getProvider).not.toHaveBeenCalled();
    expect(providerMocks.classifyMessage).not.toHaveBeenCalled();
  });

  it('maps chat-core-v2 domains into the legacy label space', () => {
    const hash = hashRoutingUtterance(SECRET, 'cria uma tarefa nova');
    db.prepare(`
      INSERT INTO routing_llm_classify_cache (utterance_hash, domain, confidence, model)
      VALUES (?, 'tasks', 0.8, 'gemini-2.5-flash-lite')
    `).run(hash);

    const predictions = predictRoutingSurfaces(
      { utteranceText: 'cria uma tarefa nova', utteranceHash: hash },
      { db, vocabulary: SYNTHETIC_VOCABULARY },
    );

    const llm = predictions.find((candidate) => candidate.surface === 'llm_classify_cache')!;
    expect(llm.domain).toBe('secretary'); // tasks → secretary
    const shadow = predictions.find((candidate) => candidate.surface === 'shadow_route_guess')!;
    expect(shadow.domain).toBe('secretary'); // v2 'tasks' guess mapped
    expect(shadow.confidence).toBeGreaterThan(0);
  });

  it('stores and gates against accepted snapshots', () => {
    insertLabeledItem('Quanto gastei este mês?', 'finance');
    const report = runRoutingAccuracy({ db, vocabulary: SYNTHETIC_VOCABULARY });

    expect(getLatestAcceptedAccuracySnapshot(db)).toBeNull();
    const snapshotId = storeAcceptedAccuracySnapshot(report, db);
    expect(snapshotId).toBeGreaterThan(0);

    const accepted = getLatestAcceptedAccuracySnapshot(db);
    expect(accepted?.itemCount).toBe(1);

    const gate = compareRoutingAccuracySnapshots(runRoutingAccuracy({ db, vocabulary: SYNTHETIC_VOCABULARY }), accepted!);
    expect(gate.passed).toBe(true);
  });
});
