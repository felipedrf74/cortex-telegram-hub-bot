import Database from 'better-sqlite3';
import * as ts from 'typescript';
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
import {
  ensureRoutingCorpusTables,
  getRoutingLabelCandidates,
  hashRoutingUtterance,
} from '../../src/services/routing-corpus';
import {
  acceptRoutingAccuracySnapshotAtomically,
  assessRoutingCorpusSnapshotReadiness,
  buildRoutingAccuracySnapshotCandidate,
  canAcceptAccuracySnapshot,
  compareRoutingAccuracySnapshots,
  computeRoutingAccuracyReport,
  getLatestAcceptedAccuracySnapshot,
  predictRoutingSurfaces,
  recommendClarifyThreshold,
  runRoutingAccuracy,
  type LabeledPredictionRow,
  type RoutingAccuracyReport,
  type RoutingSurfacePrediction,
} from '../../src/services/routing-accuracy';

const SECRET = 'routing-accuracy-test-secret';

function dynamicImportStandaloneScopes(raw: string, modulePath: string): boolean[] {
  const source = ts.createSourceFile(
    'standalone-tool.ts',
    raw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const scopes: boolean[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === modulePath
    ) {
      let current: ts.Node | undefined = node.parent;
      let insideStandaloneCallback = false;
      while (current) {
        if (
          (ts.isArrowFunction(current) || ts.isFunctionExpression(current))
          && ts.isCallExpression(current.parent)
          && ts.isIdentifier(current.parent.expression)
          && current.parent.expression.text === 'withStandaloneToolDatabaseAsync'
          && current.parent.arguments[1] === current
        ) {
          insideStandaloneCallback = true;
          break;
        }
        current = current.parent;
      }
      scopes.push(insideStandaloneCallback);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return scopes;
}

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

    expect(report.version).toBe('routing-accuracy@1.1.0');
    expect(report.evaluationScope).toEqual({
      domainRoutingScored: true,
      actionSkillRoutingScored: false,
      actionSkillGate: 'phase7_classifier_manifest_prompt',
    });
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

  it('fails on any accepted surface coverage decrease, not only a drop to zero', () => {
    const accepted = reportWith(1);
    accepted.surfaces[0].covered = 300;
    accepted.surfaces[0].uncovered = 0;
    accepted.itemCount = 300;
    const current = reportWith(1);
    current.surfaces[0].covered = 299;
    current.surfaces[0].uncovered = 1;
    current.itemCount = 300;

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual([
      expect.stringContaining('classifier_keyword: coverage decreased from 300 to 299'),
    ]);
  });

  it('fails when surface coverage ratio drops even if absolute coverage does not', () => {
    const accepted = reportWith(1);
    accepted.surfaces[0].covered = 300;
    accepted.surfaces[0].uncovered = 0;
    accepted.itemCount = 300;
    const current = reportWith(1);
    current.surfaces[0].covered = 300;
    current.surfaces[0].uncovered = 300;
    current.itemCount = 600;

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual([
      expect.stringContaining('classifier_keyword: coverage ratio decreased from 1 to 0.5'),
    ]);
  });

  it('fails when an accepted domain loses absolute support', () => {
    const accepted = reportWith(1);
    const current = reportWith(1);
    current.surfaces[0].perDomain[0].support = 4;
    current.surfaces[0].perDomain[0].truePositives = 4;

    const result = compareRoutingAccuracySnapshots(current, accepted);

    expect(result.passed).toBe(false);
    expect(result.reasons).toEqual([
      expect.stringContaining('classifier_keyword: domain secretary support decreased from 5 to 4'),
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

  it('requires --gate and refuses --accept-snapshot after a FAILED gate', () => {
    expect(canAcceptAccuracySnapshot(true, { passed: false })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('lower the ratchet'),
    });
    expect(canAcceptAccuracySnapshot(true, { passed: true })).toEqual({ allowed: true });
    // --gate with no accepted snapshot (gate skipped) may still bootstrap one.
    expect(canAcceptAccuracySnapshot(true, null)).toEqual({ allowed: true });
    expect(canAcceptAccuracySnapshot(false, null)).toEqual({
      allowed: false,
      reason: 'refusing --accept-snapshot: --gate is required so the accepted ratchet cannot be bypassed',
    });
  });

  it('refuses snapshot acceptance when the corpus coverage contract is incomplete', () => {
    const readiness = {
      allowed: false,
      totalLabeled: 224,
      byDomain: {},
      bySkill: {},
      reasons: ['requires at least 300 labeled items'],
    };
    expect(canAcceptAccuracySnapshot(true, null, readiness)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('at least 300'),
    });
  });

  it('wires the ratchet guard into the run-routing-accuracy CLI accept path', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'run-routing-accuracy.ts'),
      'utf8',
    );
    expect(raw).toContain('acceptRoutingAccuracySnapshotAtomically(snapshotCandidate');
    expect(raw).toContain("process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1'");
    expect(raw).toContain('acceptSnapshotRefused');
  });

  it('binds the explicit CLI database before loading the routing and provider graph', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'run-routing-accuracy.ts'),
      'utf8',
    );
    expect(raw).toContain(
      "await import('../src/services/standalone-tool-database')",
    );
    expect(dynamicImportStandaloneScopes(
      raw,
      '../src/services/routing-accuracy',
    )).toEqual([true]);
    expect(raw).not.toContain('initDatabase(');
  });
});

describe('routing corpus snapshot readiness', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRoutingCorpusTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('requires >=300 labels, every domain, every action skill, and clarify/none coverage', () => {
    const empty = assessRoutingCorpusSnapshotReadiness(db);
    expect(empty.allowed).toBe(false);
    expect(empty.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('at least 300'),
      expect.stringContaining('domain secretary'),
      expect.stringContaining('skill mail'),
      expect.stringContaining('special label clarify'),
      expect.stringContaining('special label none'),
    ]));

    const candidates = getRoutingLabelCandidates();
    const insert = db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source,
        label_domain, label_skill, label_status, labeled_at
      ) VALUES (0, NULL, ?, ?, 'manual', ?, ?, 'labeled', datetime('now'))
    `);
    let sequence = 0;
    for (const [domain, skills] of Object.entries(candidates.skillsByDomain)) {
      for (const skill of skills) {
        for (let index = 0; index < 20; index += 1) {
          const text = `${domain}:${skill}:${index}`;
          insert.run(hashRoutingUtterance(SECRET, text), text, domain, skill);
          sequence += 1;
        }
      }
    }
    for (const special of candidates.specialLabels) {
      for (let index = 0; index < 8; index += 1) {
        const text = `${special}:${index}`;
        insert.run(hashRoutingUtterance(SECRET, text), text, special, null);
        sequence += 1;
      }
    }
    while (sequence < 300) {
      const text = `secretary:domain-only:${sequence}`;
      insert.run(hashRoutingUtterance(SECRET, text), text, 'secretary', null);
      sequence += 1;
    }

    const ready = assessRoutingCorpusSnapshotReadiness(db);
    expect(ready.allowed).toBe(true);
    expect(ready.totalLabeled).toBe(300);
    expect(ready.reasons).toEqual([]);
    expect(Object.values(ready.bySkill).every((count) => count >= 20)).toBe(true);
    expect(ready.byDomain.clarify).toBe(8);
    expect(ready.byDomain.none).toBe(8);

    db.prepare(`
      UPDATE routing_corpus_items
      SET utterance_text = NULL
      WHERE id = (
        SELECT id FROM routing_corpus_items
        WHERE label_skill = 'mail'
        ORDER BY id ASC
        LIMIT 1
      )
    `).run();
    const replayableOnly = assessRoutingCorpusSnapshotReadiness(db);
    expect(replayableOnly.allowed).toBe(false);
    expect(replayableOnly.totalLabeled).toBe(299);
    expect(replayableOnly.reasons).toContain(
      'skill mail requires at least 20 labels; found 19',
    );
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

  it('fails closed when the latest accepted snapshot is corrupt', () => {
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES ('{not-json', 1)
    `).run();

    expect(() => getLatestAcceptedAccuracySnapshot(db))
      .toThrow(/accepted routing accuracy snapshot.*invalid json/i);

    const candidate = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: SYNTHETIC_VOCABULARY,
      generatedAt: '2026-07-29T00:00:00.000Z',
    });
    expect(() => acceptRoutingAccuracySnapshotAtomically(candidate, {
      gateMode: true,
      ownerAuthorized: true,
      vocabulary: SYNTHETIC_VOCABULARY,
    }, db)).toThrow(/accepted routing accuracy snapshot.*invalid json/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM accepted_accuracy_snapshots').get())
      .toEqual({ count: 1 });
  });

  it('rejects a structurally empty accepted report instead of passing zero comparisons', () => {
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES (?, 1)
    `).run(JSON.stringify({
      version: 'routing-accuracy@1.1.0',
      generatedAt: '2026-07-29T00:00:00.000Z',
      itemCount: 300,
      clarifyAccuracyTarget: 0.85,
      surfaces: [],
    }));

    expect(() => getLatestAcceptedAccuracySnapshot(db))
      .toThrow(/accepted routing accuracy snapshot.*invalid report schema/i);
  });

  it('rejects internally inconsistent accepted surface counts and metrics', () => {
    const valid = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: SYNTHETIC_VOCABULARY,
      generatedAt: '2026-07-29T00:00:00.000Z',
    }).report;
    valid.itemCount = 300;
    for (const surface of valid.surfaces) {
      surface.covered = 300;
      surface.uncovered = 0;
      surface.correct = 299;
      surface.accuracy = 0.9967;
      surface.perDomain = [{
        domain: 'secretary',
        support: 300,
        truePositives: 299,
        falsePositives: 0,
        falseNegatives: 1,
        precision: 1,
        recall: 0.9967,
      }];
    }
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES (?, 1)
    `).run(JSON.stringify(valid));

    expect(() => getLatestAcceptedAccuracySnapshot(db))
      .toThrow(/accepted routing accuracy snapshot.*invalid report schema/i);
  });

  it('rejects malformed accepted calibration buckets', () => {
    const valid = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: SYNTHETIC_VOCABULARY,
      generatedAt: '2026-07-29T00:00:00.000Z',
    }).report;
    valid.itemCount = 300;
    for (const surface of valid.surfaces) {
      surface.covered = 300;
      surface.uncovered = 0;
      surface.correct = 300;
      surface.accuracy = 1;
      surface.perDomain = [{
        domain: 'secretary',
        support: 300,
        truePositives: 300,
        falsePositives: 0,
        falseNegatives: 0,
        precision: 1,
        recall: 1,
      }];
      surface.calibration = Array.from({ length: 5 }, () => ({})) as never;
    }
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES (?, 1)
    `).run(JSON.stringify(valid));

    expect(() => getLatestAcceptedAccuracySnapshot(db))
      .toThrow(/accepted routing accuracy snapshot.*invalid report schema/i);
  });

  it('rejects calibration totals that contradict the surface confusion totals', () => {
    const valid = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: SYNTHETIC_VOCABULARY,
      generatedAt: '2026-07-29T00:00:00.000Z',
    }).report;
    valid.itemCount = 300;
    for (const surface of valid.surfaces) {
      surface.covered = 300;
      surface.uncovered = 0;
      surface.correct = 0;
      surface.accuracy = 0;
      surface.perDomain = [
        {
          domain: 'secretary',
          support: 300,
          truePositives: 0,
          falsePositives: 0,
          falseNegatives: 300,
          precision: null,
          recall: 0,
        },
        {
          domain: 'finance',
          support: 0,
          truePositives: 0,
          falsePositives: 300,
          falseNegatives: 0,
          precision: 0,
          recall: null,
        },
      ];
      surface.calibration[4] = {
        bucket: '0.8-1.0',
        lowerBound: 0.8,
        upperBound: 1,
        count: 300,
        correct: 300,
        empiricalAccuracy: 1,
        averageStatedConfidence: 0.9,
      };
    }
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES (?, 1)
    `).run(JSON.stringify(valid));

    expect(() => getLatestAcceptedAccuracySnapshot(db))
      .toThrow(/accepted routing accuracy snapshot.*invalid report schema/i);
  });

  it('accepts snapshots only through the owner-authorized atomic gate and rejects label drift', () => {
    const candidates = getRoutingLabelCandidates();
    const insert = db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source,
        label_domain, label_skill, label_status, labeled_at
      ) VALUES (0, NULL, ?, ?, 'manual', ?, ?, 'labeled', datetime('now'))
    `);
    let sequence = 0;
    for (const [domain, skills] of Object.entries(candidates.skillsByDomain)) {
      for (const skill of skills) {
        for (let index = 0; index < 20; index += 1) {
          const text = `atomic:${domain}:${skill}:${index}`;
          insert.run(hashRoutingUtterance(SECRET, text), text, domain, skill);
          sequence += 1;
        }
      }
    }
    for (const special of candidates.specialLabels) {
      for (let index = 0; index < 8; index += 1) {
        const text = `atomic:${special}:${index}`;
        insert.run(hashRoutingUtterance(SECRET, text), text, special, null);
        sequence += 1;
      }
    }
    while (sequence < 300) {
      const text = `atomic:secretary:domain-only:${sequence}`;
      insert.run(hashRoutingUtterance(SECRET, text), text, 'secretary', null);
      sequence += 1;
    }

    const candidate = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: SYNTHETIC_VOCABULARY,
      generatedAt: '2026-07-29T00:00:00.000Z',
    });
    expect(() => acceptRoutingAccuracySnapshotAtomically(candidate, {
      gateMode: true,
      ownerAuthorized: false,
      vocabulary: SYNTHETIC_VOCABULARY,
    }, db)).toThrow(/owner authorization/i);
    expect(() => acceptRoutingAccuracySnapshotAtomically(candidate, {
      gateMode: false,
      ownerAuthorized: true,
      vocabulary: SYNTHETIC_VOCABULARY,
    }, db)).toThrow(/--gate/i);
    expect(getLatestAcceptedAccuracySnapshot(db)).toBeNull();

    const secretaryRows = db.prepare(`
      SELECT id, label_skill AS labelSkill
      FROM routing_corpus_items
      WHERE label_domain = 'secretary' AND label_skill IN ('tasks', 'mail')
      ORDER BY id ASC
    `).all() as Array<{ id: number; labelSkill: string }>;
    const tasks = secretaryRows.find((row) => row.labelSkill === 'tasks')!;
    const mail = secretaryRows.find((row) => row.labelSkill === 'mail')!;
    db.prepare('UPDATE routing_corpus_items SET label_skill = ? WHERE id = ?').run('mail', tasks.id);
    db.prepare('UPDATE routing_corpus_items SET label_skill = ? WHERE id = ?').run('tasks', mail.id);
    expect(() => acceptRoutingAccuracySnapshotAtomically(candidate, {
      gateMode: true,
      ownerAuthorized: true,
      vocabulary: SYNTHETIC_VOCABULARY,
    }, db)).toThrow(/corpus identity changed/i);
    expect(getLatestAcceptedAccuracySnapshot(db)).toBeNull();

    const current = buildRoutingAccuracySnapshotCandidate({
      db,
      vocabulary: SYNTHETIC_VOCABULARY,
      generatedAt: '2026-07-29T00:00:00.000Z',
    });
    const acceptance = acceptRoutingAccuracySnapshotAtomically(current, {
      gateMode: true,
      ownerAuthorized: true,
      vocabulary: SYNTHETIC_VOCABULARY,
    }, db);
    const snapshotId = acceptance.snapshotId;
    expect(snapshotId).toBeGreaterThan(0);
    const accepted = getLatestAcceptedAccuracySnapshot(db);
    expect(accepted?.itemCount).toBe(300);
    expect(acceptance.corpusReadiness.allowed).toBe(true);
    expect(acceptance.gate).toBeNull();
    expect(accepted).toMatchObject({
      itemCount: 300,
      corpusIdentityDigest: current.corpusIdentityDigest,
    });
  });
});
