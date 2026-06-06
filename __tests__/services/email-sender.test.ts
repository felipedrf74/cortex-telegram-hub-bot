import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  send: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn(function ResendMock() {
    return {
      emails: {
        send: (...args: unknown[]) => hoisted.send(...args),
      },
    };
  }),
}));

vi.mock('../../src/config', () => ({
  config: { isStaging: false },
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => hoisted.loggerInfo(...args),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

describe('email sender hardening', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('RESEND_API_KEY', 're_test');
    vi.stubEnv('RESEND_FROM', 'Nexus Hub <welcome@nexushub.me>');
    hoisted.send.mockReset();
    hoisted.send.mockResolvedValue({ id: 'email_123' });
    hoisted.loggerInfo.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('escapes firstName in verification email HTML and keeps raw names out of logs', async () => {
    const { sendVerificationCode } = await import('../../src/services/email-sender');

    await expect(
      sendVerificationCode('user@example.com', '123456', '<img src=x>'),
    ).resolves.toBe(true);

    const payload = hoisted.send.mock.calls[0][0] as { html: string };
    expect(payload.html).toContain('&lt;img src=x&gt;');
    expect(payload.html).not.toContain('<img src=x>');
    expect(JSON.stringify(hoisted.loggerInfo.mock.calls)).not.toContain('<img src=x>');
  });

  it('escapes firstName and reset URLs in password reset email HTML', async () => {
    const { sendPasswordResetEmail } = await import('../../src/services/email-sender');

    await expect(
      sendPasswordResetEmail('user@example.com', 'https://nexushub.me/reset?token="<bad>"', '<b>Felipe</b>'),
    ).resolves.toBe(true);

    const payload = hoisted.send.mock.calls[0][0] as { html: string };
    expect(payload.html).toContain('&lt;b&gt;Felipe&lt;/b&gt;');
    expect(payload.html).not.toContain('<b>Felipe</b>');
    expect(payload.html).toContain('token=&quot;&lt;bad&gt;&quot;');
  });
});
