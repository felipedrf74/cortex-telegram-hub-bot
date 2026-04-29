import { describe, expect, it } from 'vitest';

import {
  sanitizeLogText,
  sanitizeLogValue,
  stringifySanitizedLogContext,
} from '../../src/utils/log-sanitizer';

describe('log sanitizer', () => {
  it('redacts provider tokens and inline secret assignments in text', () => {
    const text = sanitizeLogText(
      'request failed Authorization: Bearer abcdefghijklmnop token=secret-token sk-proj-supersecretkey123',
    );

    expect(text).toContain('Bearer [Redacted]');
    expect(text).toContain('token=[Redacted]');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).not.toContain('supersecretkey123');
  });

  it('redacts prompt, memory, reference, draft, and voice fields while preserving operational metadata', () => {
    const sanitized = sanitizeLogValue({
      endpoint: '/api/v1/content/script',
      tenantId: 12,
      prompt: 'write from private strategy',
      memory: { voice: 'private founder voice' },
      references: [{ title: 'Tenant-private book' }],
      draft: 'private draft',
      voiceProfile: { tone: 'direct' },
      nested: {
        script: 'private script',
        retryAttempt: 1,
      },
    }) as Record<string, unknown>;

    expect(sanitized.endpoint).toBe('/api/v1/content/script');
    expect(sanitized.tenantId).toBe(12);
    expect(sanitized.prompt).toBe('[Redacted]');
    expect(sanitized.memory).toBe('[Redacted]');
    expect(sanitized.references).toBe('[Redacted]');
    expect(sanitized.draft).toBe('[Redacted]');
    expect(sanitized.voiceProfile).toBe('[Redacted]');
    expect((sanitized.nested as any).script).toBe('[Redacted]');
    expect((sanitized.nested as any).retryAttempt).toBe(1);
  });

  it('stringifies sanitized context with optional length cap', () => {
    const json = stringifySanitizedLogContext({
      endpoint: '/api/v1/chat',
      rawPrompt: 'private prompt',
      access_token: 'private-token',
    }, 10_000);

    expect(json).toContain('/api/v1/chat');
    expect(json).toContain('[Redacted]');
    expect(json).not.toContain('private prompt');
    expect(json).not.toContain('private-token');
  });
});
