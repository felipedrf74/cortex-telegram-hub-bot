import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/database', () => ({
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
  buildRoutingCorpus,
  ensureRoutingCorpusTables,
  getNextPendingRoutingCorpusItem,
  getRoutingCorpusProgress,
  hashRoutingUtterance,
  labelRoutingCorpusItem,
  listLabeledRoutingCorpusItems,
} from '../../src/services/routing-corpus';

const SECRET = 'routing-corpus-test-secret';

// "Apaga todas as minhas tarefas" is also a bilingual fixture prompt — used
// below to prove first-source-wins dedupe between shadow rows and fixtures.
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

  it('applies migration 255 and its down counterpart cleanly', () => {
    const root = path.resolve(__dirname, '..', '..');
    const up = fs.readFileSync(path.join(root, 'migrations', '255_routing_corpus.sql'), 'utf8');
    const down = fs.readFileSync(path.join(root, 'migrations', 'down', '255_routing_corpus.sql'), 'utf8');
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

  it('dedupes by utterance hash with first source winning', () => {
    // SHADOW_TEXT is also a bilingual fixture prompt; the shadow source runs
    // first, so the fixture insert must be counted as a duplicate.
    seedUserTurn(db, { tenantId: 1, userId: 2, uuid: 'turn-dupe', text: SHADOW_TEXT, domain: 'secretary' });
    db.prepare(`
      INSERT INTO classify_shadow_runs (tenant_id, user_id, message_hash, gemini_domain, ollama_domain, agree)
      VALUES (1, 2, ?, 'secretary', 'cooking', 0)
    `).run(hashRoutingUtterance(SECRET, SHADOW_TEXT));

    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    const rows = db.prepare('SELECT source FROM routing_corpus_items WHERE utterance_hash = ?')
      .all(hashRoutingUtterance(SECRET, SHADOW_TEXT));
    expect(rows).toHaveLength(1);
    expect((rows[0] as { source: string }).source).toBe('classify_shadow_disagreement');
    expect(summary.duplicates).toBeGreaterThanOrEqual(1);

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

  it('imports every synthetic fixture prompt as pending with null user', () => {
    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: SYNTHETIC_VOCABULARY });

    // pt + en per bilingual fixture, one prompt per confusable fixture,
    // minus hash-level duplicates across fixture prompts.
    const maxExpected = CHAT_BILINGUAL_EVAL_FIXTURES.length * 2 + CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES.length;
    expect(summary.perSource.bilingual_fixture).toBeGreaterThan(0);
    expect(summary.perSource.bilingual_fixture).toBeLessThanOrEqual(maxExpected);

    const fixturePrompt = CHAT_BILINGUAL_EVAL_FIXTURES[0];
    const item = db.prepare('SELECT * FROM routing_corpus_items WHERE utterance_hash = ?')
      .get(hashRoutingUtterance(SECRET, fixturePrompt.pt)) as Record<string, unknown>;
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

    expect(listLabeledRoutingCorpusItems(db)).toHaveLength(1);
    expect(labelRoutingCorpusItem({ id: 999, action: 'skip' }, db)).toBeNull();
    expect(() => labelRoutingCorpusItem({ id: first.id, action: 'label' }, db)).toThrow(/labelDomain/);
  });
});
