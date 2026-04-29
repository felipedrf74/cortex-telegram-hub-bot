import { describe, expect, it, vi } from 'vitest';
import {
  buildPortalChatDiagnostics,
  buildPortalUserChatDiagnostics,
  type PortalChatDiagnosticsDb,
} from '../../src/portal/chat-diagnostics';

function makeDb(): PortalChatDiagnosticsDb {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => {
        if (sql.includes('COUNT(*) as messages')) {
          return {
            messages: 12,
            activeUsers: 2,
            activeTenants: 2,
            assistantMessages: 6,
            failedMessages: 1,
            streamingMessages: 1,
            pendingConfirmations: 1,
            clarificationPrompts: 1,
          };
        }
        return null;
      }),
      all: vi.fn(() => {
        if (sql.includes('SELECT') && sql.includes('message_uuid') && sql.includes('text')) {
          return [{
            message_uuid: 'msg-1',
            tenant_id: 7,
            user_id: 42,
            role: 'assistant',
            domain: 'secretary',
            route_method: 'tool',
            lifecycle_state: 'failed',
            error_code: 'TOOL_TIMEOUT',
            text: 'raw private schedule details must not leave diagnostics',
            buttons_json: '[["retry"]]',
            metadata_json: JSON.stringify({
              type: 'skill_result',
              privateDetails: 'do not return this',
              sourceSkills: [{ id: 'secretary', name: 'Secretary' }, { id: 'training' }],
              toolCalls: [{ name: 'calendar.sync', output: 'private raw output' }],
              actionConfirmation: { message: 'private destructive detail' },
              clarification: { question: 'private question' },
            }),
            created_at: '2026-04-29T03:00:00Z',
          }];
        }
        if (sql.includes('GROUP BY tenant_id')) {
          return [{
            tenantId: 7,
            activeUsers: 2,
            messages: 12,
            failedMessages: 1,
            pendingConfirmations: 1,
            lastMessageAt: '2026-04-29T03:00:00Z',
          }];
        }
        if (sql.includes('COALESCE(lifecycle_state')) {
          return [
            { key: 'completed', messages: 10, failedMessages: 0 },
            { key: 'failed', messages: 1, failedMessages: 1 },
          ];
        }
        if (sql.includes('COALESCE(domain')) {
          return [{ key: 'secretary', messages: 8, failedMessages: 1, avgConfidence: 0.82 }];
        }
        if (sql.includes('COALESCE(route_method')) {
          return [{ key: 'fast-path', messages: 7, failedMessages: 0 }];
        }
        if (sql.includes('FROM api_usage')) {
          return [{
            provider: 'gemini',
            model: 'gemini-2.5-flash',
            category: 'chat',
            calls: 3,
            costUsd: 0.004,
            tokens: 1200,
            avgLatencyMs: 450,
          }];
        }
        return [];
      }),
    })),
  };
}

describe('portal chat diagnostics', () => {
  it('builds aggregate chat diagnostics without raw message content', () => {
    const diagnostics = buildPortalChatDiagnostics(makeDb(), { windowDays: 14, limit: 5 });

    expect(diagnostics).toMatchObject({
      ok: true,
      privacyMode: 'metadata_only',
      windowDays: 14,
      totals: {
        messages: 12,
        activeUsers: 2,
        activeTenants: 2,
        assistantMessages: 6,
        failedMessages: 1,
        streamingMessages: 1,
        pendingConfirmations: 1,
        clarificationPrompts: 1,
      },
      byTenant: [{
        tenantId: 7,
        activeUsers: 2,
        messages: 12,
        failedMessages: 1,
        pendingConfirmations: 1,
        lastMessageAt: '2026-04-29T03:00:00Z',
      }],
      providerUsage: [{
        provider: 'gemini',
        model: 'gemini-2.5-flash',
        category: 'chat',
        calls: 3,
        costUsd: 0.004,
        tokens: 1200,
        avgLatencyMs: 450,
      }],
    });

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('raw private schedule');
    expect(serialized).not.toContain('private raw output');
  });

  it('builds user diagnostics with metadata-only recent message rows', () => {
    const diagnostics = buildPortalUserChatDiagnostics(makeDb(), 42, { windowDays: 7, limit: 10 });

    expect(diagnostics.userId).toBe(42);
    expect(diagnostics.recentMessages).toEqual([{
      id: 'msg-1',
      tenantId: 7,
      userId: 42,
      role: 'assistant',
      domain: 'secretary',
      routeMethod: 'tool',
      lifecycleState: 'failed',
      errorCode: 'TOOL_TIMEOUT',
      textLength: 55,
      hasButtons: true,
      hasMetadata: true,
      metadataType: 'skill_result',
      sourceSkills: ['secretary', 'training'],
      toolCallCount: 1,
      hasActionConfirmation: true,
      hasClarificationPrompt: true,
      createdAt: '2026-04-29T03:00:00Z',
    }]);

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('raw private schedule');
    expect(serialized).not.toContain('do not return this');
    expect(serialized).not.toContain('private destructive detail');
  });

  it('degrades to empty diagnostics when tables are unavailable', () => {
    const db: PortalChatDiagnosticsDb = {
      prepare: vi.fn(() => {
        throw new Error('missing messages table');
      }),
    };

    expect(buildPortalChatDiagnostics(db)).toMatchObject({
      ok: true,
      privacyMode: 'metadata_only',
      totals: {
        messages: 0,
        activeUsers: 0,
        activeTenants: 0,
      },
      byTenant: [],
      providerUsage: [],
    });
  });
});
