import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updateRun: vi.fn(),
  reply: vi.fn(async () => undefined),
  writeGovernedSignal: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      if (sql.includes('config_seed_books')) return { all: () => [] };
      if (sql.includes('SELECT id, title, author, personal_notes')) {
        return {
          get: () => ({
            id: 7,
            title: 'The Law',
            author: 'Frédéric Bastiat',
            personal_notes: '[]',
          }),
        };
      }
      if (sql.includes('UPDATE book_library SET personal_notes')) {
        return { run: mocks.updateRun };
      }
      throw new Error(`Unexpected SQL in personal-note test: ${sql}`);
    },
  }),
}));

vi.mock('../../src/services/intelligence-bus', () => ({
  writeGovernedSignal: mocks.writeGovernedSignal,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/utils/request-context', () => ({
  getCurrentRequestId: vi.fn(),
  generateRequestId: vi.fn(() => 'request-id'),
}));
vi.mock('../../src/config', () => ({ config: {} }));
vi.mock('../../src/services/content-engine', () => ({
  contentEngineApiBaseUrl: () => 'http://content-engine.test',
  parseForwardedAiBudgetError: vi.fn(),
}));
vi.mock('../../src/services/cost-guardrail', () => ({
  AiBudgetError: class AiBudgetError extends Error {},
  withAiBudgetReservation: vi.fn(),
}));
vi.mock('../../src/services/internal-attribution', () => ({
  createInternalAttributionToken: vi.fn(),
}));
vi.mock('../../src/state/content-creator-profile', () => ({
  getContentCreatorProfile: vi.fn(),
}));
vi.mock('../../src/services/content-tenant-scope', () => ({
  contentScopeForInsert: vi.fn(),
  contentScopeParams: vi.fn(),
  contentScopePredicate: vi.fn(),
  ensureContentTenantScopeColumns: vi.fn(),
}));

import { handleBookNote } from '../../src/commands/books';

describe('legacy book note privacy boundary', () => {
  beforeEach(() => {
    mocks.updateRun.mockReset();
    mocks.reply.mockClear();
    mocks.writeGovernedSignal.mockReset();
  });

  it('saves the note without publishing private text to the global signal mesh', async () => {
    await handleBookNote({
      match: { toString: () => 'The Law | private tax analogy' },
      reply: mocks.reply,
      replyWithChatAction: vi.fn(async () => undefined),
    });

    expect(mocks.updateRun).toHaveBeenCalledWith('["private tax analogy"]', 7);
    expect(mocks.writeGovernedSignal).not.toHaveBeenCalled();
    const replyText = String(mocks.reply.mock.calls[0]?.[0] ?? '');
    expect(replyText).toContain('Note saved to this book');
    expect(replyText).not.toContain('prioritized in future script generation');
  });
});
