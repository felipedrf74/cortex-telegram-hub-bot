import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: vi.fn(() => {
    throw new Error('tests must pass an explicit db');
  }),
  withDatabaseForTestAsync: vi.fn(),
}));

import {
  CHAT_BILINGUAL_EVAL_FIXTURES,
  CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES,
} from '../../src/services/chat-bilingual-eval-fixtures';
import { compileIntentVocabulary } from '../../src/services/intent-resolution/vocabulary';
import {
  ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES,
  projectBilingualFixturePromptForRoutingCorpus,
} from '../../src/services/routing-corpus-product-profile-fixtures';
import {
  buildRoutingCorpus,
  ensureRoutingCorpusTables,
  getNextPendingRoutingCorpusItem,
  getRoutingLabelCandidates,
  getRoutingCorpusProgress,
  hashRoutingCorpusSyntheticControl,
  hashRoutingUtterance,
  isCheckedInSyntheticRoutingCorpusItem,
  labelRoutingCorpusItem,
  listLabeledRoutingCorpusItems,
  pruneSpanishSyntheticRoutingCorpusFixtures,
} from '../../src/services/routing-corpus';

const SECRET = 'routing-corpus-test-secret';

// "Apaga todas as minhas tarefas" is also a bilingual fixture prompt. It
// proves that private and synthetic identity namespaces cannot displace one
// another even when their raw text is identical.
const SHADOW_TEXT = 'Apaga todas as minhas tarefas';
const SAMPLER_TEXT = 'Quanto gastei este mês?';

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

function createSourceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL,
      message_uuid TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      domain TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE classify_shadow_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER NOT NULL DEFAULT 0,
      message_hash TEXT NOT NULL,
      gemini_domain TEXT,
      ollama_domain TEXT,
      agree INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE chat_v2_online_eval_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      domain TEXT,
      status TEXT NOT NULL
    );
  `);
}

function seedUserTurn(
  db: Database.Database,
  input: { tenantId: number; userId: number; uuid: string; text: string; domain?: string | null },
): void {
  db.prepare(`
    INSERT INTO messages (tenant_id, user_id, message_uuid, role, text, domain)
    VALUES (?, ?, ?, 'user', ?, ?)
  `).run(input.tenantId, input.userId, input.uuid, input.text, input.domain ?? null);
}

describe('routing corpus builder', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSourceTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('applies migration 256 and its down counterpart cleanly', () => {
    const root = path.resolve(__dirname, '..', '..');
    const up = fs.readFileSync(path.join(root, 'migrations', '256_routing_corpus.sql'), 'utf8');
    const down = fs.readFileSync(path.join(root, 'migrations', 'down', '256_routing_corpus.sql'), 'utf8');
    const migrated = new Database(':memory:');
    migrated.exec(up);
    // Re-applying must be a no-op (IF NOT EXISTS discipline).
    migrated.exec(up);
    const tables = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('routing_corpus_items', 'routing_llm_classify_cache', 'accepted_accuracy_snapshots')",
    ).all();
    expect(tables).toHaveLength(3);
    migrated.exec(down);
    const remaining = migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('routing_corpus_items', 'routing_llm_classify_cache', 'accepted_accuracy_snapshots')",
    ).all();
    expect(remaining).toHaveLength(0);
    migrated.close();
  });

  it('requires the HMAC secret', () => {
    expect(() => buildRoutingCorpus({ db, secret: '', vocabulary: SYNTHETIC_VOCABULARY })).toThrow(/HMAC secret/);
  });

  it('recovers shadow disagreement text from history and records provenance', () => {
    seedUserTurn(db, { tenantId: 3, userId: 7, uuid: 'turn-shadow', text: SHADOW_TEXT, domain: 'secretary' });
    db.prepare(`
      INSERT INTO classify_shadow_runs (tenant_id, user_id, message_hash, gemini_domain, ollama_domain, agree)
      VALUES (?, ?, ?, 'secretary', 'cooking', 0)
    `).run(3, 7, hashRoutingUtterance(SECRET, SHADOW_TEXT));
    // Disagreement whose text is not in local history must be skipped.
    db.prepare(`
      INSERT INTO classify_shadow_runs (tenant_id, user_id, message_hash, gemini_domain, ollama_domain, agree)
      VALUES (1, 1, ?, 'finance', 'cooking', 0)
    `).run('a'.repeat(64));
    // Agreements are never corpus candidates.
    db.prepare(`
      INSERT INTO classify_shadow_runs (tenant_id, user_id, message_hash, gemini_domain, ollama_domain, agree)
      VALUES (3, 7, ?, 'secretary', 'secretary', 1)
    `).run(hashRoutingUtterance(SECRET, SHADOW_TEXT));

    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    expect(summary.perSource.classify_shadow_disagreement).toBe(1);
    expect(summary.unrecoverableText).toBe(1);
    const item = db.prepare('SELECT * FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingUtterance(SECRET, SHADOW_TEXT)) as Record<string, unknown>;
    expect(item.source).toBe('classify_shadow_disagreement');
    expect(item.utterance_text).toBe(SHADOW_TEXT);
    expect(item.suggested_domain).toBe('secretary');
    expect(item.tenant_id).toBe(3);
    expect(item.user_id).toBe(7);
    expect(item.label_status).toBe('pending');
  });

  it('keeps a private shadow row separate from an identical synthetic fixture', () => {
    // SHADOW_TEXT is also a bilingual fixture prompt. The private observation
    // retains the classify-shadow hash while the checked-in fixture uses the
    // domain-separated synthetic identity.
    seedUserTurn(db, { tenantId: 1, userId: 2, uuid: 'turn-dupe', text: SHADOW_TEXT, domain: 'secretary' });
    db.prepare(`
      INSERT INTO classify_shadow_runs (tenant_id, user_id, message_hash, gemini_domain, ollama_domain, agree)
      VALUES (1, 2, ?, 'secretary', 'cooking', 0)
    `).run(hashRoutingUtterance(SECRET, SHADOW_TEXT));

    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    expect(db.prepare('SELECT source FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingUtterance(SECRET, SHADOW_TEXT))).toEqual({
      source: 'classify_shadow_disagreement',
    });
    expect(db.prepare('SELECT source FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingCorpusSyntheticControl(SECRET, SHADOW_TEXT))).toEqual({
      source: 'bilingual_fixture',
    });
    const rows = db.prepare(`
      SELECT source
      FROM routing_corpus_items
      WHERE utterance_hash IN (?, ?)
      ORDER BY source ASC
    `).all(
      hashRoutingUtterance(SECRET, SHADOW_TEXT),
      hashRoutingCorpusSyntheticControl(SECRET, SHADOW_TEXT),
    );
    expect(rows).toHaveLength(2);
    expect((rows[0] as { source: string }).source).toBe('bilingual_fixture');
    expect(summary.duplicates).toBeGreaterThanOrEqual(2);
    expect(summary.perSource.classify_shadow_disagreement).toBe(1);
    expect(summary.perSource.bilingual_fixture).toBe(224);

    // Rebuilding is idempotent: nothing new inserted for identical sources.
    const rebuild = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });
    expect(rebuild.inserted).toBe(0);
  });

  it('imports online eval sampler captures via turn_id text recovery', () => {
    seedUserTurn(db, { tenantId: 4, userId: 9, uuid: 'turn-sample', text: SAMPLER_TEXT, domain: 'finance' });
    db.prepare(`
      INSERT INTO chat_v2_online_eval_samples (tenant_id, user_id, turn_id, domain, status)
      VALUES ('4', '9', 'turn-sample', 'finance', 'sampled')
    `).run();
    db.prepare(`
      INSERT INTO chat_v2_online_eval_samples (tenant_id, user_id, turn_id, domain, status)
      VALUES ('4', '9', 'turn-unsampled', 'finance', 'not_sampled')
    `).run();

    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    expect(summary.perSource.online_eval_sampler).toBe(1);
    const item = db.prepare('SELECT * FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingUtterance(SECRET, SAMPLER_TEXT)) as Record<string, unknown>;
    expect(item.source).toBe('online_eval_sampler');
    expect(item.suggested_domain).toBe('finance');
    expect(item.tenant_id).toBe(4);
  });

  it('imports exactly the 224 supported English and Portuguese synthetic prompts', () => {
    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    const englishPrompts = CHAT_BILINGUAL_EVAL_FIXTURES.map((fixture) =>
      projectBilingualFixturePromptForRoutingCorpus(fixture.scenario, 'en', fixture.en));
    const portuguesePrompts = [
      ...CHAT_BILINGUAL_EVAL_FIXTURES.map((fixture) =>
        projectBilingualFixturePromptForRoutingCorpus(fixture.scenario, 'pt', fixture.pt)),
      ...CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
        .filter((fixture) => fixture.promptLocale === 'pt-BR')
        .map((fixture) => fixture.prompt),
    ];
    const supportedPrompts = [...englishPrompts, ...portuguesePrompts];
    expect(new Set(englishPrompts.map((prompt) => prompt.trim().toLowerCase())).size).toBe(109);
    expect(new Set(portuguesePrompts.map((prompt) => prompt.trim().toLowerCase())).size).toBe(115);
    const uniqueSupportedPrompts = new Set(
      supportedPrompts.map((prompt) => prompt.trim().toLowerCase()),
    );
    expect(uniqueSupportedPrompts.size).toBe(224);
    expect(summary.perSource.bilingual_fixture).toBe(224);

    for (const prompt of supportedPrompts) {
      const row = db.prepare(
        'SELECT source FROM routing_corpus_items WHERE utterance_hash = ?',
      ).get(hashRoutingCorpusSyntheticControl(SECRET, prompt)) as { source: string } | undefined;
      expect(row?.source, prompt).toBe('bilingual_fixture');
    }
    for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
      if (fixture.promptLocale !== 'es-419') continue;
      const row = db.prepare(
        'SELECT 1 FROM routing_corpus_items WHERE utterance_hash = ?',
      ).get(hashRoutingUtterance(SECRET, fixture.prompt));
      expect(row, fixture.scenario).toBeUndefined();
    }

    const fixturePrompt = CHAT_BILINGUAL_EVAL_FIXTURES[0];
    const item = db.prepare('SELECT * FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingCorpusSyntheticControl(SECRET, fixturePrompt.pt)) as Record<string, unknown>;
    expect(item.source).toBe('bilingual_fixture');
    expect(item.user_id).toBeNull();
    expect(item.tenant_id).toBe(0);
    expect(item.suggested_skill).toBe(fixturePrompt.expectedOwnerSkill);
    expect(item.label_status).toBe('pending');
  });

  it('captures history turns whose routed domain has no vocabulary support', () => {
    // Routed to cooking but the synthetic vocabulary only knows secretary +
    // finance and neither matches — a suspicious route.
    seedUserTurn(db, { tenantId: 2, userId: 5, uuid: 'turn-odd', text: 'xyzzy plugh sem sentido', domain: 'cooking' });
    // Routed to secretary and the utterance matches secretary vocabulary —
    // supported, must NOT become a candidate.
    seedUserTurn(db, { tenantId: 2, userId: 5, uuid: 'turn-ok', text: 'minhas tarefas de hoje', domain: 'secretary' });

    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    expect(summary.perSource.history_unmatched).toBe(1);
    const item = db.prepare('SELECT * FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingUtterance(SECRET, 'xyzzy plugh sem sentido')) as Record<string, unknown>;
    expect(item.source).toBe('history_unmatched');
    expect(item.suggested_domain).toBeNull();
    const supported = db.prepare('SELECT * FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingUtterance(SECRET, 'minhas tarefas de hoje'));
    expect(supported).toBeUndefined();
  });
});

describe('routing corpus unsupported Spanish synthetic cleanup', () => {
  let db: Database.Database;

  const spanishFixtures = CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
    .filter((fixture) => fixture.promptLocale === 'es-419');

  function seedSpanishFixtures(limit = spanishFixtures.length): void {
    const insert = db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source, label_status
      ) VALUES (0, NULL, ?, ?, 'bilingual_fixture', 'pending')
    `);
    for (const fixture of spanishFixtures.slice(0, limit)) {
      insert.run(hashRoutingUtterance(SECRET, fixture.prompt), fixture.prompt);
    }
  }

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRoutingCorpusTables(db);
  });

  afterEach(() => {
    db.close();
  });

  it('prunes exactly eight pending synthetic rows and is idempotent at zero', () => {
    expect(spanishFixtures).toHaveLength(8);
    seedSpanishFixtures();

    const first = pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET });
    expect(first).toEqual({
      status: 'pruned',
      expectedFixtures: 8,
      deletedItems: 8,
      deletedCacheEntries: 0,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 0 });

    const second = pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET });
    expect(second).toEqual({
      status: 'already_absent',
      expectedFixtures: 8,
      deletedItems: 0,
      deletedCacheEntries: 0,
    });
  });

  it('preserves user, manual, and history rows that merely look Spanish', () => {
    seedSpanishFixtures();
    const insert = db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source, label_status
      ) VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    const preserved = [
      { tenantId: 7, userId: 11, text: 'Muéstrame mis proyectos activos', source: 'history_unmatched' },
      { tenantId: 0, userId: null, text: 'Crea una nota manual', source: 'manual' },
      { tenantId: 9, userId: 12, text: 'Agenda una llamada para mañana', source: 'classify_shadow_disagreement' },
    ] as const;
    for (const row of preserved) {
      insert.run(
        row.tenantId,
        row.userId,
        hashRoutingUtterance(SECRET, row.text),
        row.text,
        row.source,
      );
    }

    pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET });

    const remaining = db.prepare(
      'SELECT utterance_text AS text, source FROM routing_corpus_items ORDER BY id',
    ).all();
    expect(remaining).toEqual(preserved.map(({ text, source }) => ({ text, source })));
  });

  it('refuses partial or labeled fixture sets without deleting anything', () => {
    seedSpanishFixtures(7);
    expect(() => pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET }))
      .toThrow(/partial Spanish synthetic fixture set/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 7 });

    db.exec('DELETE FROM routing_corpus_items');
    seedSpanishFixtures();
    const firstHash = hashRoutingUtterance(SECRET, spanishFixtures[0].prompt);
    db.prepare(`
      UPDATE routing_corpus_items
      SET label_status = 'labeled', label_domain = 'secretary', labeled_at = datetime('now')
      WHERE utterance_hash = ?
    `).run(firstHash);

    expect(() => pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET }))
      .toThrow(/pending and unlabeled/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 8 });
  });

  it('refuses an accepted snapshot and deletes only matching cache rows otherwise', () => {
    seedSpanishFixtures();
    db.prepare(`
      INSERT INTO accepted_accuracy_snapshots (snapshot_json, accepted)
      VALUES ('{}', 1)
    `).run();
    expect(() => pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET }))
      .toThrow(/accepted routing accuracy snapshot/i);
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 8 });

    db.exec('DELETE FROM accepted_accuracy_snapshots');
    const insertCache = db.prepare(`
      INSERT INTO routing_llm_classify_cache (utterance_hash, domain, confidence)
      VALUES (?, 'secretary', 0.9)
    `);
    for (const fixture of spanishFixtures) {
      insertCache.run(hashRoutingUtterance(SECRET, fixture.prompt));
    }
    const unrelatedHash = hashRoutingUtterance(SECRET, 'Show my tasks');
    insertCache.run(unrelatedHash);

    const result = pruneSpanishSyntheticRoutingCorpusFixtures({ db, secret: SECRET });
    expect(result.deletedCacheEntries).toBe(8);
    expect(db.prepare(
      'SELECT utterance_hash AS hash FROM routing_llm_classify_cache',
    ).all()).toEqual([{ hash: unrelatedHash }]);
  });
});

describe('routing corpus labeling store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureRoutingCorpusTables(db);
    db.prepare(`
      INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source)
      VALUES (1, 10, ?, 'primeiro item', 'manual')
    `).run('1'.repeat(64));
    db.prepare(`
      INSERT INTO routing_corpus_items (tenant_id, user_id, utterance_hash, utterance_text, source)
      VALUES (2, 11, ?, 'segundo item', 'manual')
    `).run('2'.repeat(64));
  });

  afterEach(() => {
    db.close();
  });

  it('serves the oldest pending item and honors tenant scoping', () => {
    const next = getNextPendingRoutingCorpusItem(db);
    expect(next?.utteranceText).toBe('primeiro item');
    const scoped = getNextPendingRoutingCorpusItem(db, { tenantId: 2 });
    expect(scoped?.utteranceText).toBe('segundo item');
    expect(getNextPendingRoutingCorpusItem(db, { tenantId: 99 })).toBeNull();
  });

  it('serves and counts only exact checked-in controls in synthetic-only scope', () => {
    const priorSecret = process.env.CLASSIFY_SHADOW_HASH_SECRET;
    process.env.CLASSIFY_SHADOW_HASH_SECRET = SECRET;
    try {
      const fixture = ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES[0]!;
      db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source
        ) VALUES (0, 77, ?, 'private tenant-zero row', 'history_unmatched')
      `).run('3'.repeat(64));
      db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source
        ) VALUES (0, NULL, ?, ?, 'manual')
      `).run(hashRoutingCorpusSyntheticControl(SECRET, fixture.prompt), fixture.prompt);
      db.prepare(`
        INSERT INTO routing_corpus_items (
          tenant_id, user_id, utterance_hash, utterance_text, source
        ) VALUES (0, NULL, ?, 'forged manual row', 'manual')
      `).run('4'.repeat(64));

      const next = getNextPendingRoutingCorpusItem(db, {
        tenantId: 0,
        syntheticOnly: true,
      });
      const progress = getRoutingCorpusProgress(db, {
        tenantId: 0,
        syntheticOnly: true,
      });

      expect(next?.utteranceText).toBe(fixture.prompt);
      expect(progress).toMatchObject({ total: 1, pending: 1 });
      expect(isCheckedInSyntheticRoutingCorpusItem(next!, SECRET)).toBe(true);
      expect(isCheckedInSyntheticRoutingCorpusItem({
        tenantId: 0,
        userId: 77,
        utteranceHash: '3'.repeat(64),
        utteranceText: 'private tenant-zero row',
        source: 'history_unmatched',
      }, SECRET)).toBe(false);
    } finally {
      if (priorSecret === undefined) delete process.env.CLASSIFY_SHADOW_HASH_SECRET;
      else process.env.CLASSIFY_SHADOW_HASH_SECRET = priorSecret;
    }
  });

  it('labels, skips, and reports progress', () => {
    const first = getNextPendingRoutingCorpusItem(db)!;
    const labeled = labelRoutingCorpusItem({ id: first.id, action: 'label', labelDomain: 'secretary', labelSkill: 'tasks' }, db)!;
    expect(labeled.labelStatus).toBe('labeled');
    expect(labeled.labelDomain).toBe('secretary');
    expect(labeled.labelSkill).toBe('tasks');
    expect(labeled.labeledAt).not.toBeNull();

    const second = getNextPendingRoutingCorpusItem(db)!;
    const skipped = labelRoutingCorpusItem({ id: second.id, action: 'skip' }, db)!;
    expect(skipped.labelStatus).toBe('skipped');
    expect(skipped.labelDomain).toBeNull();

    const progress = getRoutingCorpusProgress(db);
    expect(progress).toMatchObject({ total: 2, pending: 0, labeled: 1, skipped: 1 });
    expect(progress.bySource.manual).toEqual({ total: 2, labeled: 1 });
    expect(progress.byDomain).toEqual({ secretary: 1 });
    expect(progress.bySkill).toEqual({ tasks: 1 });

    expect(listLabeledRoutingCorpusItems(db)).toHaveLength(1);
    expect(labelRoutingCorpusItem({ id: 999, action: 'skip' }, db)).toBeNull();
    expect(() => labelRoutingCorpusItem({ id: first.id, action: 'label' }, db)).toThrow(/labelDomain/);
  });

  it('supports a read-only listing seam without creating or changing schema', () => {
    const first = getNextPendingRoutingCorpusItem(db)!;
    labelRoutingCorpusItem({
      id: first.id,
      action: 'label',
      labelDomain: 'secretary',
    }, db);
    const schemaBefore = db.prepare(`
      SELECT type, name, sql FROM sqlite_master ORDER BY type, name
    `).all();

    expect(listLabeledRoutingCorpusItems(db, { ensureTables: false }))
      .toHaveLength(1);
    expect(db.prepare(`
      SELECT type, name, sql FROM sqlite_master ORDER BY type, name
    `).all()).toEqual(schemaBefore);

    const blank = new Database(':memory:');
    try {
      expect(() => listLabeledRoutingCorpusItems(blank, { ensureTables: false }))
        .toThrow(/no such table: routing_corpus_items/);
      expect(blank.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).all()).toEqual([]);
      expect(listLabeledRoutingCorpusItems(blank)).toEqual([]);
    } finally {
      blank.close();
    }
  });

  it('uses manifest action skills as candidates and validates optional skill ownership', () => {
    const candidates = getRoutingLabelCandidates();
    expect(candidates.skills).toEqual([
      'secretary_calendar',
      'secretary_reminders',
      'mail',
      'tasks',
      'training',
      'content',
      'finance',
      'cooking',
      'connections',
      'notifications',
      'decision_center',
    ]);
    expect(candidates.skillsByDomain.secretary).toEqual([
      'secretary_calendar',
      'secretary_reminders',
      'mail',
      'tasks',
    ]);
    expect(candidates.skillsByDomain.triathlon).toEqual(['training']);

    const first = getNextPendingRoutingCorpusItem(db)!;
    expect(() => labelRoutingCorpusItem({
      id: first.id,
      action: 'label',
      labelDomain: 'secretary',
      labelSkill: 'finance',
    }, db)).toThrow(/skill.*domain/i);

    const domainOnly = labelRoutingCorpusItem({
      id: first.id,
      action: 'label',
      labelDomain: 'secretary',
    }, db)!;
    expect(domainOnly.labelSkill).toBeNull();

    const second = getNextPendingRoutingCorpusItem(db)!;
    expect(() => labelRoutingCorpusItem({
      id: second.id,
      action: 'label',
      labelDomain: 'clarify',
      labelSkill: 'tasks',
    }, db)).toThrow(/special.*skill/i);
  });

  it('rejects stale label and skip mutations after an item leaves pending', () => {
    const first = getNextPendingRoutingCorpusItem(db)!;
    labelRoutingCorpusItem({
      id: first.id,
      action: 'label',
      labelDomain: 'secretary',
      labelSkill: 'tasks',
    }, db);

    expect(() => labelRoutingCorpusItem({ id: first.id, action: 'skip' }, db))
      .toThrow(/not pending/i);
    expect(() => labelRoutingCorpusItem({
      id: first.id,
      action: 'label',
      labelDomain: 'secretary',
      labelSkill: 'tasks',
    }, db)).toThrow(/not pending/i);
    const unchanged = db.prepare(
      'SELECT label_status AS labelStatus, label_domain AS labelDomain, label_skill AS labelSkill FROM routing_corpus_items WHERE id = ?',
    ).get(first.id);
    expect(unchanged).toEqual({
      labelStatus: 'labeled',
      labelDomain: 'secretary',
      labelSkill: 'tasks',
    });
  });
});
