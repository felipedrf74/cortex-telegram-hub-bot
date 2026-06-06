import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  loadShadowReplayCorpusItems,
  computeTenantUserSaltedMessageToken,
  assertNoRawTextInLoadedItem,
  ShadowCorpusHmacSecretRequiredError,
  type ShadowReplayCorpusItem,
} from '../../src/services/chat-core-v2/shadow-corpus-loader';
import { runChatCoreV2ShadowRouteHook } from '../../src/services/chat-core-v2/shadow-route-hook';
import { ensureChatCoreV2AuditTables } from '../../src/services/chat-core-v2/model-run-audit';

let db: Database.Database;

const HMAC_SECRET = 'shadow-corpus-loader-test-secret';
const ENABLED_ENV = {
  CHAT_CORE_V2_SHADOW_ROUTE_HOOK_ENABLED: 'true',
  CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: HMAC_SECRET,
};

/**
 * Seed one real shadow row through the production writer (`runChatCoreV2ShadowRouteHook`),
 * which already drops raw text and stores only a salted messageHash + capability labels.
 */
function seedShadowTurn(input: {
  text: string;
  userId: number;
  tenantId: number;
  id: string;
  locale?: string;
}): void {
  const result = runChatCoreV2ShadowRouteHook({
    normalizedText: input.text,
    userId: input.userId,
    tenantId: input.tenantId,
    chatRequestId: input.id,
    userMessageId: `${input.id}-msg`,
    clientMessageId: `${input.id}-client`,
    locale: input.locale ?? 'en',
    env: ENABLED_ENV,
    db,
  });
  expect(result.recorded).toBe(true);
}

describe('Chat Core v2 shadow corpus loader (WP-19)', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatCoreV2AuditTables(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  describe('HMAC secret is MANDATORY (hard-fail) on a real DB', () => {
    it('THROWS when no hmacSecret is given against a real (non-:memory:) DB', () => {
      // A real on-disk DB handle. `.name` is the file path, not ':memory:'.
      const realDb = new Database('/tmp/wp19-loader-mandatory-secret.sqlite');
      try {
        ensureChatCoreV2AuditTables(realDb);
        expect(() => loadShadowReplayCorpusItems(realDb, {})).toThrow(ShadowCorpusHmacSecretRequiredError);
        expect(() => loadShadowReplayCorpusItems(realDb, { hmacSecret: '   ' })).toThrow(
          ShadowCorpusHmacSecretRequiredError,
        );
      } finally {
        realDb.close();
        // best-effort cleanup
        try {
          require('fs').unlinkSync('/tmp/wp19-loader-mandatory-secret.sqlite');
        } catch {
          /* ignore */
        }
      }
    });

    it('does NOT throw against an in-memory fixture without a secret (tests are allowed)', () => {
      seedShadowTurn({ text: 'Create a task to buy supplements', userId: 7, tenantId: 7, id: 'mem-1' });
      expect(() => loadShadowReplayCorpusItems(db, {})).not.toThrow();
    });

    it('does NOT throw against a real DB WHEN a secret is provided', () => {
      const realDb = new Database('/tmp/wp19-loader-with-secret.sqlite');
      try {
        ensureChatCoreV2AuditTables(realDb);
        expect(() => loadShadowReplayCorpusItems(realDb, { hmacSecret: HMAC_SECRET })).not.toThrow();
      } finally {
        realDb.close();
        try {
          require('fs').unlinkSync('/tmp/wp19-loader-with-secret.sqlite');
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe('tenant+user-salted token (NEVER global-unsalted)', () => {
    it('identical text but DIFFERENT tenant => DIFFERENT token', () => {
      const a = computeTenantUserSaltedMessageToken({ hmacSecret: HMAC_SECRET, tenantId: 1, userId: 9, message: 'pay the rent' });
      const b = computeTenantUserSaltedMessageToken({ hmacSecret: HMAC_SECRET, tenantId: 2, userId: 9, message: 'pay the rent' });
      expect(a).not.toBe(b);
    });

    it('identical text but DIFFERENT user => DIFFERENT token', () => {
      const a = computeTenantUserSaltedMessageToken({ hmacSecret: HMAC_SECRET, tenantId: 1, userId: 9, message: 'pay the rent' });
      const b = computeTenantUserSaltedMessageToken({ hmacSecret: HMAC_SECRET, tenantId: 1, userId: 10, message: 'pay the rent' });
      expect(a).not.toBe(b);
    });

    it('a global-UNSALTED HMAC(text) is NOT what the writer/loader produce (the salted token differs from it)', () => {
      const { createHmac } = require('crypto');
      const globalUnsalted = createHmac('sha256', HMAC_SECRET).update('pay the rent').digest('hex');
      const salted = computeTenantUserSaltedMessageToken({ hmacSecret: HMAC_SECRET, tenantId: 1, userId: 9, message: 'pay the rent' });
      expect(salted).not.toBe(globalUnsalted);
    });

    it('the loaded item carries the writer\'s salted messageHash, and two tenants produce DIFFERENT loaded tokens for identical text', () => {
      seedShadowTurn({ text: 'Create a task to buy supplements', userId: 9, tenantId: 1, id: 'salt-t1' });
      seedShadowTurn({ text: 'Create a task to buy supplements', userId: 9, tenantId: 2, id: 'salt-t2' });

      const loaded = loadShadowReplayCorpusItems(db, {}).items;
      const tokens = loaded.map((item) => item.messageToken);
      expect(tokens.length).toBe(2);
      expect(tokens[0]).not.toBe(tokens[1]); // salting proof: same text, different tenant => different token
      for (const token of tokens) {
        expect(token).toMatch(/^[a-f0-9]{64}$/); // a salted HMAC, not raw text
      }
    });
  });

  describe('DROP-TEXT: no raw message text survives into the loaded corpus item', () => {
    it('a loaded item contains NO raw message text — only labels + salted token + locale + turnId', () => {
      // A message the classifier guesses a capability for (so it is NOT skipped),
      // carrying distinctive raw-text tokens we then prove are absent from the item.
      const rawMessage = 'Create a task with passphrase hunter2 and account 12345';
      seedShadowTurn({ text: rawMessage, userId: 7, tenantId: 7, id: 'drop-1' });

      const loaded = loadShadowReplayCorpusItems(db, {}).items;
      expect(loaded.length).toBe(1);
      const item = loaded[0];

      // Exhaustively assert the item's shape carries no raw-text fields.
      expect(Object.keys(item).sort()).toEqual(
        ['candidateCapabilityIds', 'expectedCapabilityIds', 'locale', 'messageToken', 'turnId'].sort(),
      );
      const serialized = JSON.stringify(item);
      // No substring of the raw message (or any distinctive token from it) is present.
      expect(serialized).not.toContain('passphrase');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('12345');
      expect(serialized).not.toContain(rawMessage);
      expect(serialized.toLowerCase()).not.toContain('remember');

      // And the structural guard agrees.
      expect(() => assertNoRawTextInLoadedItem(item)).not.toThrow();
    });

    it('the underlying persisted shadow row also stored NO raw message (writer-side invariant)', () => {
      const rawMessage = 'Mark comprar suplementos QA task as done';
      seedShadowTurn({ text: rawMessage, userId: 7, tenantId: 7, id: 'drop-2' });

      const row = db
        .prepare("SELECT redacted_bundle_json FROM chat_v2_replay_bundles WHERE replay_bundle_id LIKE 'chatv2-shadow-replay:%' LIMIT 1")
        .get() as { redacted_bundle_json: string };
      expect(row.redacted_bundle_json).not.toContain(rawMessage);
      expect(row.redacted_bundle_json).not.toContain('comprar suplementos');
      const parsed = JSON.parse(row.redacted_bundle_json);
      expect('message' in parsed.contextPack).toBe(false);
      expect('messagePreview' in parsed.contextPack).toBe(false);
      expect(String(parsed.contextPack.messageHash)).toMatch(/^[a-f0-9]{64}$/);
    });

    it('assertNoRawTextInLoadedItem THROWS if a non-identifier (raw-text-like) capability id is injected', () => {
      const leaky: ShadowReplayCorpusItem = {
        turnId: 't1',
        expectedCapabilityIds: ['this is a raw sentence not a capability id'],
        candidateCapabilityIds: ['tasks.create'],
        messageToken: 'a'.repeat(64),
        locale: 'en',
      };
      expect(() => assertNoRawTextInLoadedItem(leaky)).toThrow(/raw-text leak/);
    });
  });

  describe('loader filtering: labels / token / window', () => {
    it('skips a shadow row with no usable labels (counts it, does not emit it)', () => {
      // Craft a shadow-prefixed row whose contextPack has an empty guessedCapabilities.
      insertCraftedShadowRow(db, 'crafted-nolabels', {
        contextPack: { messageHash: 'b'.repeat(64), locale: 'en', guessedCapabilities: [] },
        response: { selectedCapabilityIds: [] },
      });
      const result = loadShadowReplayCorpusItems(db, {});
      expect(result.items.length).toBe(0);
      expect(result.skippedNoLabels).toBe(1);
    });

    it('skips a shadow row with labels but no selected candidates instead of self-labeling it as a hit', () => {
      insertCraftedShadowRow(db, 'crafted-nocandidates', {
        contextPack: { messageHash: 'd'.repeat(64), locale: 'en', guessedCapabilities: ['tasks.create'] },
        response: {},
      });
      const result = loadShadowReplayCorpusItems(db, {});
      expect(result.items.length).toBe(0);
      expect(result.skippedNoCandidates).toBe(1);
    });

    it('skips a shadow row whose token is not a 64-hex salted HMAC (never substitutes raw text)', () => {
      insertCraftedShadowRow(db, 'crafted-notoken', {
        contextPack: { messageHash: 'not-a-valid-hmac', locale: 'en', guessedCapabilities: ['tasks.create'] },
        response: { selectedCapabilityIds: ['tasks.create'] },
      });
      const result = loadShadowReplayCorpusItems(db, {});
      expect(result.items.length).toBe(0);
      expect(result.skippedNoToken).toBe(1);
    });

    it('honors the window cutoff (a row older than windowDays is excluded)', () => {
      // One fresh row + one old row (created 100 days ago).
      seedShadowTurn({ text: 'Create a task to buy supplements', userId: 7, tenantId: 7, id: 'fresh-1' });
      insertCraftedShadowRow(
        db,
        'old-1',
        {
          contextPack: { messageHash: 'c'.repeat(64), locale: 'en', guessedCapabilities: ['tasks.create'] },
          response: { selectedCapabilityIds: ['tasks.create'] },
        },
        new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString(),
      );

      const within = loadShadowReplayCorpusItems(db, { windowDays: 30 });
      expect(within.items.length).toBe(1); // only the fresh row

      const wide = loadShadowReplayCorpusItems(db, { windowDays: 365 });
      expect(wide.items.length).toBe(2); // both rows
    });

    it('respects the limit cap', () => {
      for (let i = 0; i < 5; i += 1) {
        seedShadowTurn({ text: `Create a task number ${i}`, userId: 7, tenantId: 7, id: `lim-${i}` });
      }
      const result = loadShadowReplayCorpusItems(db, { limit: 2 });
      expect(result.items.length).toBeLessThanOrEqual(2);
    });
  });

  describe('no network', () => {
    it('the loader never calls fetch', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch' as never);
      seedShadowTurn({ text: 'Create a task to buy supplements', userId: 7, tenantId: 7, id: 'nonet-1' });
      loadShadowReplayCorpusItems(db, {});
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});

/** Insert a raw shadow-prefixed replay row with a crafted bundle (for filter tests). */
function insertCraftedShadowRow(
  database: Database.Database,
  suffix: string,
  bundle: { contextPack: Record<string, unknown>; response: Record<string, unknown> },
  createdAt: string = new Date().toISOString(),
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
