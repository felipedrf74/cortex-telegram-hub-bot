/**
 * Lock-screen copy localization.
 *
 * `users.language` defaults to pt-BR and every lock-screen string was hardcoded
 * English, so the product was trilingual in-app and monolingual on the one
 * surface a user sees without unlocking their phone.
 *
 * The decision these tests pin: copy is resolved server-side FROM A STABLE KEY
 * using the account language, and those keys are the exact names a future
 * `aps.alert.title-loc-key` / `loc-key` payload will carry. That keeps the
 * eventual move to bundle-side strings a payload-layer change rather than a
 * producer rewrite — which matters because loc-keys cannot ship until the
 * installed app has the strings, and the backend deploys independently of the
 * App Store.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
let userLanguage: Record<number, string> = {};

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/user-service', () => ({
  getUserLanguageById: (userId: number) => userLanguage[userId] ?? 'pt-BR',
  getUserTimezoneById: () => 'Europe/Lisbon',
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => [{ token: 'tok', environment: 'production' }]),
  isApnsConfigured: vi.fn(() => true),
  sendPushNotification: vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] })),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  NOTIFICATION_TITLE_KEYS,
  assembleDailyDigest,
  createNotificationIntent,
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  notificationCopyLanguage,
  notificationTitleKey,
} from '../../src/services/notification-orchestrator';
import { hasTranslation, messageKeysWithPrefix, normalizeSupportedLang, t, type Lang } from '../../src/utils/i18n';

const LANGS: Lang[] = ['pt-BR', 'pt-PT', 'en-US'];

function intentFor(userId: number, over: Record<string, unknown> = {}) {
  return {
    userId,
    tenantId: userId,
    sourceSkill: 'finance' as const,
    type: 'decision_required' as const,
    priority: 'active' as const,
    relatedEntityId: `e-${userId}`,
    relatedEntityType: 'finance_tax_event',
    title: 'IVA due',
    body: 'Amount 1234.56 reference 0190',
    deeplink: 'nexus://notifications',
    dedupeKey: `loc:${userId}`,
    privacyPolicy: 'financial' as const,
    ...over,
  };
}

describe('lock-screen copy localization', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    userLanguage = {};
    ensureNotificationTables();
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    testDb?.close();
  });

  it('defaults to the account language, not English', () => {
    // The whole reason this work exists: users.language defaults to pt-BR.
    expect(notificationCopyLanguage(1)).toBe('pt-BR');
  });

  it('renders the lock-screen body in the user’s language', async () => {
    userLanguage[200] = 'pt-BR';
    getOrCreateNotificationProfile(200, 200);
    const result = await createNotificationIntent(intentFor(200));

    expect(result.pushPayload?.body).toBe('Um lembrete financeiro precisa de revisão.');
    // Still redacted: no amount, no reference.
    expect(result.pushPayload?.body).not.toMatch(/1234|0190/);
  });

  it('renders the same notification differently per language', async () => {
    const bodies = new Set<string>();
    let userId = 210;
    for (const lang of LANGS) {
      userLanguage[userId] = lang;
      getOrCreateNotificationProfile(userId, userId);
      const result = await createNotificationIntent(intentFor(userId));
      bodies.add(result.pushPayload!.body);
      userId += 1;
    }
    // pt-BR and pt-PT share this string, so three supported languages yield two variants.
    expect(bodies.size).toBe(2);
    expect([...bodies]).toContain('Finance reminder needs review.');
  });

  it('localizes the title too', async () => {
    userLanguage[220] = 'en-US';
    getOrCreateNotificationProfile(220, 220);
    const result = await createNotificationIntent(intentFor(220));
    expect(result.pushPayload?.title).toBe('Finance reminder');
  });

  it('keeps retired Spanish locale signals on the English compatibility fallback', () => {
    expect(normalizeSupportedLang('es-ES', 'pt-BR')).toBe('en-US');
  });

  it('interpolates the localized title into the composite review body', async () => {
    userLanguage[230] = 'pt-PT';
    getOrCreateNotificationProfile(230, 230);
    const result = await createNotificationIntent(intentFor(230, {
      sourceSkill: 'secretary', privacyPolicy: 'sensitive', relatedEntityType: 'reminder',
    }));
    // pt-PT uses the "tu" form, and the title is the localized one.
    expect(result.pushPayload?.body).toBe('Decisão pendente — abre o Nexus para rever.');
  });

  it('uses the schedule-specific title for conflicts', () => {
    expect(notificationTitleKey({ sourceSkill: 'secretary', type: 'conflict_detected' } as any))
      .toBe('notif.title.secretary.schedule');
    expect(notificationTitleKey({ sourceSkill: 'secretary', type: 'reminder' } as any))
      .toBe('notif.title.secretary');
  });

  it('falls back to English rather than showing a raw key', () => {
    // t() degrades exact-language -> pt-BR (for pt-PT) -> en-US -> the key. A
    // user must never see "notif.body.finance" on their lock screen.
    for (const key of Object.values(NOTIFICATION_TITLE_KEYS)) {
      for (const lang of LANGS) {
        const rendered = t(key, lang);
        expect(rendered, `${key}/${lang}`).not.toBe(key);
        expect(rendered.length).toBeGreaterThan(0);
      }
    }
  });

  it('localizes the digest, including inflected slot labels', () => {
    userLanguage[240] = 'pt-BR';
    const digest = assembleDailyDigest(240, 240, 0);
    expect(digest.title).toBe('O seu resumo');
    // Empty state still sends — a silent brief is indistinguishable from a
    // broken one.
    expect(digest.body).toBe('Nada precisa de você agora.');
  });

  it('inflects digest slot nouns instead of concatenating a count', () => {
    // English can build "3 decisions waiting" from a number and a word;
    // Portuguese cannot ("1 decisão" vs "3 decisões"), which is why singular
    // and plural are separate entries.
    expect(t('notif.digest.slot.decision_required.one', 'pt-BR', { count: '1' }))
      .toBe('1 decisão pendente');
    expect(t('notif.digest.slot.decision_required.other', 'pt-BR', { count: '3' }))
      .toBe('3 decisões pendentes');
  });
});

describe('loc-key readiness (cross-repo contract)', () => {
  it('keeps every title key namespaced and bundle-safe', () => {
    // These strings become iOS Localizable.strings keys verbatim when the
    // payload switches to loc-key. Renaming one is a cross-repo contract
    // change, so the shape is pinned here.
    for (const key of Object.values(NOTIFICATION_TITLE_KEYS)) {
      expect(key).toMatch(/^notif\.[a-z.]+$/);
    }
    expect(new Set(Object.values(NOTIFICATION_TITLE_KEYS)).size)
      .toBe(Object.values(NOTIFICATION_TITLE_KEYS).length);
  });

  it('covers every source skill, so no skill silently falls back to producer text', () => {
    const skills = ['secretary', 'training', 'content', 'cooking', 'finance', 'chat', 'system', 'security'];
    for (const skill of skills) {
      expect(NOTIFICATION_TITLE_KEYS, skill).toHaveProperty(skill);
    }
  });

  it('has a translation for every language on every notification key', () => {
    // Swept from the message table itself, not a hand-maintained list. The
    // previous list omitted all 22 `notif.digest.slot.*` keys, which are built
    // by string template and so never appear literally in any source array.
    const keys = messageKeysWithPrefix('notif.');
    expect(keys.length).toBeGreaterThanOrEqual(37);
    expect(keys.filter((k) => k.startsWith('notif.digest.slot.'))).toHaveLength(22);

    // Asserted WITHOUT the fallback, which is the whole point: `t()` resolves
    // pt-PT -> pt-BR -> en-US before returning the key, so a key translated
    // only into English passed the old `not.toBe(key)` check in all four
    // languages. That check could not fail.
    //
    // pt-PT is excluded from the strict requirement BY DESIGN: it inherits
    // pt-BR and carries its own entry only where European Portuguese actually
    // differs (`ligação` vs `conexão`). Duplicating 20 identical strings to
    // satisfy a guard would be noise. It still must resolve to real copy.
    const strict: Lang[] = ['pt-BR', 'en-US'];
    const missing: string[] = [];
    for (const key of keys) {
      for (const lang of strict) {
        if (!hasTranslation(key, lang)) missing.push(`${key}/${lang}`);
      }
      if (t(key, 'pt-PT') === key) missing.push(`${key}/pt-PT`);
    }
    expect(missing).toEqual([]);
  });
});
