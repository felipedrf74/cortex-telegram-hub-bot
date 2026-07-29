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
import { loadCapabilityManifest } from '../../src/services/capability-manifest';
import {
  ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES,
  isRoutingCorpusSecretaryCalendarScenario,
  projectBilingualFixturePromptForRoutingCorpus,
} from '../../src/services/routing-corpus-product-profile-fixtures';
import {
  buildRoutingCorpus,
  ensureRoutingCorpusTables,
  hashRoutingCorpusSyntheticControl,
  hashRoutingUtterance,
} from '../../src/services/routing-corpus';

const SECRET = 'routing-product-profile-test-secret';

const FIXTURE_ACTION_SKILL: Partial<Record<
  (typeof CHAT_BILINGUAL_EVAL_FIXTURES)[number]['skill'],
  string
>> = {
  calendar: 'secretary_calendar',
  tasks: 'tasks',
  training: 'training',
  content: 'content',
  finance: 'finance',
  cooking: 'cooking',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

function normalized(prompt: string): string {
  return prompt.trim().toLowerCase();
}

describe('routing corpus product-profile fixtures', () => {
  it('contains exactly 76 unique English and Portuguese prompts without overlap', () => {
    expect(ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES).toHaveLength(76);
    expect(
      ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES.filter((fixture) => fixture.locale === 'en'),
    ).toHaveLength(38);
    expect(
      ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES.filter((fixture) => fixture.locale === 'pt'),
    ).toHaveLength(38);

    const prompts = ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES.map((fixture) => normalized(fixture.prompt));
    expect(new Set(prompts).size).toBe(76);

    const supportedPrompts = new Set([
      ...CHAT_BILINGUAL_EVAL_FIXTURES.flatMap((fixture) => [
        projectBilingualFixturePromptForRoutingCorpus(fixture.scenario, 'en', fixture.en),
        projectBilingualFixturePromptForRoutingCorpus(fixture.scenario, 'pt', fixture.pt),
      ]),
      ...CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
        .filter((fixture) => fixture.promptLocale === 'pt-BR')
        .map((fixture) => fixture.prompt),
    ].map(normalized));
    for (const prompt of prompts) {
      expect(supportedPrompts.has(prompt), prompt).toBe(false);
    }

    const retiredSpanishPrompts = new Set(
      CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
        .filter((fixture) => fixture.promptLocale === 'es-419')
        .map((fixture) => normalized(fixture.prompt)),
    );
    for (const prompt of prompts) {
      expect(retiredSpanishPrompts.has(prompt), prompt).toBe(false);
    }
  });

  it('uses the reviewed special-label balance and manifest-valid domain/skill pairs', () => {
    expect(
      ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES.filter((fixture) => fixture.labelDomain === 'clarify'),
    ).toHaveLength(8);
    expect(
      ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES.filter((fixture) => fixture.labelDomain === 'none'),
    ).toHaveLength(8);

    const manifest = loadCapabilityManifest();
    for (const fixture of ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES) {
      if (fixture.labelDomain === 'clarify' || fixture.labelDomain === 'none') {
        expect(fixture.labelSkill, fixture.prompt).toBeNull();
        continue;
      }

      const capability = manifest.capabilities.find(
        (entry) => entry.runtimeRouting.domain === fixture.labelDomain,
      );
      expect(capability, fixture.prompt).toBeDefined();
      expect(capability?.chatActionSkills, fixture.prompt).toContain(fixture.labelSkill);
    }
  });

  it('gives every manifest action skill at least 20 unique supported prompts', () => {
    const skillByPrompt = new Map<string, string>();
    for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
      const actionSkill = fixture.skill === 'secretary'
        && isRoutingCorpusSecretaryCalendarScenario(fixture.scenario)
        ? 'secretary_calendar'
        : FIXTURE_ACTION_SKILL[fixture.skill];
      if (!actionSkill) continue;
      for (const [locale, original] of [['en', fixture.en], ['pt', fixture.pt]] as const) {
        const prompt = projectBilingualFixturePromptForRoutingCorpus(
          fixture.scenario,
          locale,
          original,
        );
        skillByPrompt.set(normalized(prompt), actionSkill);
      }
    }
    for (const fixture of ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES) {
      if (fixture.labelSkill) {
        skillByPrompt.set(normalized(fixture.prompt), fixture.labelSkill);
      }
    }

    const counts = new Map<string, number>();
    for (const actionSkill of skillByPrompt.values()) {
      counts.set(actionSkill, (counts.get(actionSkill) ?? 0) + 1);
    }

    const manifestActionSkills = [
      ...new Set(loadCapabilityManifest().capabilities.flatMap((entry) => entry.chatActionSkills)),
    ];
    expect(manifestActionSkills).toHaveLength(11);
    for (const actionSkill of manifestActionSkills) {
      expect(counts.get(actionSkill) ?? 0, actionSkill).toBeGreaterThanOrEqual(20);
    }
  });
});

describe('routing corpus product-profile fixture import', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('builds the deterministic 300-item supported queue with manual rows pending', () => {
    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: [] });

    expect(summary.inserted).toBe(300);
    expect(summary.perSource.bilingual_fixture).toBe(224);
    expect(summary.perSource.manual).toBe(76);
    expect(summary.duplicates).toBe(2);

    const counts = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) AS manual,
        SUM(CASE WHEN label_status = 'pending' THEN 1 ELSE 0 END) AS pending
      FROM routing_corpus_items
    `).get() as { total: number; manual: number; pending: number };
    expect(counts).toEqual({ total: 300, manual: 76, pending: 300 });

    for (const fixture of ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES) {
      const row = db.prepare(`
        SELECT
          source,
          suggested_domain AS suggestedDomain,
          suggested_skill AS suggestedSkill,
          label_domain AS labelDomain,
          label_skill AS labelSkill,
          label_status AS labelStatus
        FROM routing_corpus_items
        WHERE utterance_hash = ?
      `).get(hashRoutingCorpusSyntheticControl(SECRET, fixture.prompt)) as Record<string, unknown> | undefined;
      expect(row, fixture.prompt).toEqual({
        source: 'manual',
        suggestedDomain: fixture.labelDomain,
        suggestedSkill: fixture.labelSkill,
        labelDomain: null,
        labelSkill: null,
        labelStatus: 'pending',
      });
    }
  });

  it('keeps an identical private utterance separate from the synthetic control identity', () => {
    ensureRoutingCorpusTables(db);
    const fixture = ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES[0];
    db.prepare(`
      INSERT INTO routing_corpus_items (
        tenant_id, user_id, utterance_hash, utterance_text, source, label_status
      ) VALUES (7, 41, ?, ?, 'history_unmatched', 'pending')
    `).run(hashRoutingUtterance(SECRET, fixture.prompt), fixture.prompt);

    const summary = buildRoutingCorpus({ db, secret: SECRET, vocabulary: [] });

    expect(summary.perSource.manual).toBe(76);
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_corpus_items').get())
      .toEqual({ count: 301 });
    expect(db.prepare(`
      SELECT tenant_id AS tenantId, user_id AS userId, source
      FROM routing_corpus_items
      WHERE utterance_hash = ?
    `).get(hashRoutingUtterance(SECRET, fixture.prompt))).toEqual({
      tenantId: 7,
      userId: 41,
      source: 'history_unmatched',
    });
    expect(db.prepare(`
      SELECT tenant_id AS tenantId, user_id AS userId, source, label_status AS labelStatus
      FROM routing_corpus_items
      WHERE utterance_hash = ?
    `).get(hashRoutingCorpusSyntheticControl(SECRET, fixture.prompt))).toEqual({
      tenantId: 0,
      userId: null,
      source: 'manual',
      labelStatus: 'pending',
    });
  });
});
