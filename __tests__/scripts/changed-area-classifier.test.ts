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
