/**
 * POST /api/v1/ai-reports — in-app reporting of objectionable AI output
 * (App Review guideline 1.2).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';
import Database from 'better-sqlite3';
import type { Request } from 'express';

let testDb: Database.Database;

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
  send(body?: any): MockRes;
  setHeader(name: string, value: unknown): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
    send(body?: any) { res.body = body ?? null; return res; },
    setHeader() { return res; },
  };
  return res;
}

function mockReq(userId: number | undefined, body: any, tenantId = userId): Request {
  return {
    userId,
    tenantId,
    deviceId: 'test-device-id',
    ip: '203.0.113.10',
    body,
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchReport(
  userId: number | undefined,
  body: any,
  tenantId = userId,
  routerOverride?: any,
): Promise<MockRes> {
  const { aiReportsRoutes } = await import('../../src/api/routes/ai-reports');
  const router = routerOverride ?? aiReportsRoutes();
  const req = mockReq(userId, body, tenantId);
  (req as any).method = 'POST';
  (req as any).url = '/';
  (req as any).originalUrl = '/';
  (req as any).baseUrl = '';
  (req as any).path = '/';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

function seedUser(userId: number): void {
  testDb.prepare(`
    INSERT OR IGNORE INTO users (id, first_name, language, status, auth_provider)
    VALUES (?, ?, 'en-US', 'active', 'invite_code')
  `).run(userId, `Tester ${userId}`);
}

beforeEach(async () => {
  testDb = createMigratedTestDatabase();
  seedUser(1);
  seedUser(2);

  vi.resetModules();
  vi.doMock('../../src/services/database', () => ({
    getDb: () => testDb,
  }));
  vi.doMock('../../src/utils/logger', () => ({
    logger: {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      trace: vi.fn(), child: vi.fn().mockReturnThis(),
    },
    LOGGER_REDACTION_PATHS: [],
  }));

  const { clearTenantScopeAnomaliesForTests } = await import('../../src/services/tenant-scope-observability');
  clearTenantScopeAnomaliesForTests();
});

afterEach(() => {
  vi.doUnmock('../../src/services/database');
  vi.doUnmock('../../src/utils/logger');
  testDb?.close();
});

describe('POST /api/v1/ai-reports', () => {
  it('rate-limits repeated database-write attempts per authenticated user', async () => {
    const { aiReportsRoutes } = await import('../../src/api/routes/ai-reports');
    const { config } = await import('../../src/config');
    const router = aiReportsRoutes();
    const limit = config.ios?.rateLimit ?? 60;

    for (let index = 0; index < limit; index += 1) {
      const res = await dispatchReport(1, {
        messageId: `rate-limit-${index}`,
        reason: 'other',
        content: 'Bounded report.',
      }, 1, router);
      expect(res.statusCode).toBe(200);
    }

    const limited = await dispatchReport(1, {
      messageId: 'rate-limit-rejected',
      reason: 'other',
      content: 'This report must not reach the database.',
    }, 1, router);

    expect(limited.statusCode).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(testDb.prepare(
      'SELECT COUNT(*) AS n FROM ai_output_reports WHERE message_id = ?',
    ).get('rate-limit-rejected')).toEqual({ n: 0 });
  });

  it('persists a report and returns { reported, reportId }', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-42',
      conversationId: 'conv-9',
      reason: 'harmful',
      content: 'The coach told me to train through chest pain.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.reported).toBe(true);
    expect(typeof res.body.data.reportId).toBe('string');
    expect(res.body.data.reportId.length).toBeGreaterThan(0);

    const row = testDb.prepare(
      'SELECT user_id, tenant_id, message_id, conversation_id, reason, content FROM ai_output_reports WHERE report_id = ?',
    ).get(res.body.data.reportId) as any;

    expect(row.user_id).toBe(1);
    expect(row.tenant_id).toBe(1);
    expect(row.message_id).toBe('msg-42');
    expect(row.conversation_id).toBe('conv-9');
    expect(row.reason).toBe('harmful');
    expect(row.content).toBe('The coach told me to train through chest pain.');
  });

  it('accepts a report without a conversationId', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-43',
      reason: 'inaccurate',
      content: 'Wrong race date.',
    });

    expect(res.statusCode).toBe(200);
    const row = testDb.prepare(
      'SELECT conversation_id FROM ai_output_reports WHERE message_id = ?',
    ).get('msg-43') as any;
    expect(row.conversation_id).toBeNull();
  });

  it('accepts explicit null for conversationId', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-44',
      conversationId: null,
      reason: 'other',
      content: 'Something else.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.reported).toBe(true);
  });

  it('writes an audit_trail row for the report', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-45',
      reason: 'offensive',
      content: 'Rude phrasing.',
    });

    const audit = testDb.prepare(
      "SELECT user_id, actor_id, action, resource, details FROM audit_trail WHERE resource = 'ai_report'",
    ).get() as any;

    expect(audit.user_id).toBe(1);
    expect(audit.actor_id).toBe(1);
    expect(audit.action).toBe('create');
    const details = JSON.parse(audit.details);
    expect(details.reportId).toBe(res.body.data.reportId);
    expect(details.reason).toBe('offensive');
    expect(details.messageId).toBe('msg-45');
    // The reported text lives in ai_output_reports, not in the audit row.
    expect(details.content).toBeUndefined();
    expect(details.contentLength).toBe('Rude phrasing.'.length);
  });

  it('rejects an unknown reason', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-46',
      reason: 'spam',
      content: 'Nope.',
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM ai_output_reports').get()).toEqual({ n: 0 });
  });

  it('rejects a missing messageId', async () => {
    const res = await dispatchReport(1, { reason: 'other', content: 'Missing id.' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toMatch(/messageId/);
  });

  it('rejects empty content', async () => {
    const res = await dispatchReport(1, { messageId: 'msg-47', reason: 'other', content: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toMatch(/content/);
  });

  it('rejects oversized content instead of truncating it', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-48',
      reason: 'harmful',
      content: 'x'.repeat(8_001),
    });

    expect(res.statusCode).toBe(400);
    expect(res.body.error.message).toMatch(/8000/);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM ai_output_reports').get()).toEqual({ n: 0 });
  });

  it('rejects an oversized messageId', async () => {
    const res = await dispatchReport(1, {
      messageId: 'm'.repeat(201),
      reason: 'other',
      content: 'Bounded id check.',
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-string content payload', async () => {
    const res = await dispatchReport(1, {
      messageId: 'msg-49',
      reason: 'other',
      content: { nested: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await dispatchReport(undefined, {
      messageId: 'msg-50',
      reason: 'other',
      content: 'No JWT scope.',
    });

    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM ai_output_reports').get()).toEqual({ n: 0 });
  });

  it('scopes the row to the authenticated user, not a body-supplied one', async () => {
    await dispatchReport(2, {
      messageId: 'msg-51',
      reason: 'other',
      content: 'Scoped to caller.',
      userId: 1,
    } as any);

    const row = testDb.prepare('SELECT user_id FROM ai_output_reports WHERE message_id = ?').get('msg-51') as any;
    expect(row.user_id).toBe(2);
  });
});

describe('account lifecycle coverage', () => {
  it('is discovered as a user-owned table by the deletion/export cascade', async () => {
    await dispatchReport(1, { messageId: 'msg-60', reason: 'harmful', content: 'Sweep me.' });
    await dispatchReport(2, { messageId: 'msg-61', reason: 'other', content: 'Keep me.' });

    const { getAccountDeletionInventoryForUser, deleteAllUserDataForAccountDeletion } =
      await import('../../src/services/user-data-export');

    const inventory = getAccountDeletionInventoryForUser(1);
    expect(inventory.deletableTables.ai_output_reports).toBe(1);

    await deleteAllUserDataForAccountDeletion(1);

    const remaining = testDb.prepare('SELECT user_id FROM ai_output_reports').all() as any[];
    expect(remaining).toEqual([{ user_id: 2 }]);
  });
});
