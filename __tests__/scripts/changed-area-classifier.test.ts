import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

describe('changed-area-classifier closed-beta content-agent routing', () => {
  it('routes src/agents changes into content-agent neutrality and cross-agent tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/agents/reaction-radar-agent.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.content).toBe(true);
    expect(result.flags.contentAgent).toBe(true);
    expect(result.cannotSkip).toContain('content-agent-neutrality');
    expect(result.vitest.globs).toContain('__tests__/security/content-agent-neutrality.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/cross-agent-learning*.test.ts');
  });

  it('routes backend auth/OAuth changes into auth, OAuth, and security tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'src/api/routes/auth.ts',
          'src/services/google-sign-in.ts',
          'src/services/apple-sign-in-nonce.ts',
          'src/services/oauth-flow.ts',
          'src/portal/oauth-routes.ts',
        ].join(','),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.authOrTenant).toBe(true);
    expect(result.flags.portal).toBe(true);
    expect(result.cannotSkip).toContain('tenant-auth-security');
    expect(result.vitest.globs).toContain('__tests__/api/auth-*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/google-sign-in.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/apple-sign-in-nonce.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/oauth*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/portal/portal-oauth-routes.test.ts');
  });

  it('routes iOS auth changes into auth-focused XCTest classes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'Nexus Hub/Core/AuthManager.swift',
          'Nexus Hub/Core/KeychainHelper.swift',
          'Nexus Hub/Views/Auth/AuthenticationView.swift',
        ].join(','),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      xctest: { classes: string[] };
    };

    expect(result.flags.iosSrc).toBe(true);
    expect(result.flags.iosAuth).toBe(true);
    expect(result.flags.authOrTenant).toBe(true);
    expect(result.cannotSkip).toContain('tenant-auth-security');
    expect(result.xctest.classes).toContain('Nexus HubTests/AppleSignInNonceTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/KeychainHelperTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/AuthManagerPersistenceTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/GoogleAuthCallbackResolverTests');
  });
});

describe('changed-area-classifier engineering-excellence enrichments (2026-05-04)', () => {
  it('routes logger / redaction changes into logger + secret-guards tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/utils/logger.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.logger).toBe(true);
    expect(result.cannotSkip).toContain('logger-redaction-pii-scan');
    expect(result.vitest.globs).toContain('__tests__/utils/logger-*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/api/secret-guards.test.ts');
  });

  it('routes scheduler / cron changes into scheduler tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/scheduler.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.scheduler).toBe(true);
    expect(result.cannotSkip).toContain('scheduler-tenant-scope-and-failure');
    expect(result.vitest.globs).toContain('__tests__/services/scheduler-*.test.ts');
  });

  it('routes APNs / notification changes into APNs + notification routes tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'src/services/apns-sender.ts',
          'src/api/routes/notifications.ts',
        ].join(','),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.notification).toBe(true);
    expect(result.cannotSkip).toContain('notification-apns-delivery-and-tenant');
    expect(result.vitest.globs).toContain('__tests__/services/apns-*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/api/notifications-*.test.ts');
  });

  it('routes Garmin / Apple Health / wearable changes into health-integration tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'src/services/garmin.ts',
          'src/services/apple-health.ts',
          'src/api/routes/wearable-routes.ts',
        ].join(','),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.healthIntegration).toBe(true);
    expect(result.cannotSkip).toContain('health-integration-tenant-isolation');
    expect(result.vitest.globs).toContain('__tests__/services/garmin-*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/apple-health-*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/api/wearable-*.test.ts');
  });

  it('routes rate-limit middleware changes into rate-limiter + security tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/api/middleware/rate-limit.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.rateLimit).toBe(true);
    expect(result.cannotSkip).toContain('auth-rate-limit-and-lockout');
    expect(result.vitest.globs).toContain('__tests__/api/rate-limiter.test.ts');
    expect(result.vitest.globs).toContain('__tests__/security/**/*.test.ts');
  });

  it('preserves all new flags as false on unrelated diff (no false positives)', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/cooking-shopping-list.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as { flags: Record<string, boolean> };

    expect(result.flags.logger).toBe(false);
    expect(result.flags.scheduler).toBe(false);
    expect(result.flags.notification).toBe(false);
    expect(result.flags.healthIntegration).toBe(false);
    expect(result.flags.rateLimit).toBe(false);
  });
});
