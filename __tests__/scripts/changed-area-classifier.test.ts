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
  it('routes canonical chat planner/executor changes into chat reasoning tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/chat/planner/orchestrator.ts,src/services/chat/executor/plan-executor.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      vitest: { globs: string[] };
    };

    expect(result.flags.chatReasoning).toBe(true);
    expect(result.flags.secretary).toBe(true);
    expect(result.vitest.globs).toContain('__tests__/services/chat-action-planner.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/chat-action-production-safety.test.ts');
    expect(result.vitest.globs).toContain('__tests__/api/chat-routes.test.ts');
    expect(result.vitest.globs).toContain('__tests__/security/p0-chat-identity-isolation.test.ts');
  });

  it('routes Chat Core v2 foundation changes into Chat Core v2 focused tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/chat-core-v2/route-decision.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      vitest: { mode: string; globs: string[] };
    };

    expect(result.flags.chatReasoning).toBe(false);
    expect(result.flags.chatCoreV2).toBe(true);
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.globs).toContain('__tests__/services/chat-core-v2-*.test.ts');
  });

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

  it('routes audit-trail changes into audit emission and scope tests', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'src/services/audit-trail.ts',
          'src/api/routes/audit-trail.ts',
          'src/portal/admin-audit.ts',
        ].join(','),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.audit).toBe(true);
    expect(result.cannotSkip).toContain('audit-trail-emission-and-scope');
    expect(result.vitest.globs).toContain('__tests__/services/audit-trail.test.ts');
    expect(result.vitest.globs).toContain('__tests__/api/authenticated-support-routes-scope.test.ts');
    expect(result.vitest.globs).toContain('__tests__/portal/portal-admin-audit.test.ts');
  });

  it('routes deploy and PM2 config changes into deploy-config gates', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'ecosystem.config.js',
          'ecosystem.staging.config.js',
        ].join(','),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
    };

    expect(result.flags.deployConfig).toBe(true);
    expect(result.cannotSkip).toContain('deploy-config-health-rehearsal');
    expect(result.vitest.globs).toContain('__tests__/services/config-*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/portal/health-endpoint*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/scripts/*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/security/**/*.test.ts');
  });

  it('routes iOS navigation and view-model changes into responsiveness XCTest classes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'Nexus Hub/Views/MainTabView.swift',
          'Nexus Hub/ViewModels/DashboardViewModel.swift',
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
    expect(result.flags.iosNavigation).toBe(true);
    expect(result.cannotSkip).toContain('ios-navigation-responsiveness');
    expect(result.xctest.classes).toContain('Nexus HubTests/NavigationPerformanceSourcePinsTests');
    expect(result.xctest.classes).toContain('Nexus HubUITests/AppWideResponsivenessUITests');
  });

  it('routes iOS DTO and decoder changes into contract decoder XCTest classes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        [
          'Nexus Hub/Core/Services/TrainingService.swift',
          'Nexus HubTests/TrainingHomeViewStateContractDecodingTests.swift',
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
    expect(result.flags.iosDto).toBe(true);
    expect(result.cannotSkip).toContain('ios-contract-decoder-resilience');
    expect(result.xctest.classes).toContain('Nexus HubTests/ContractDecoderResilienceTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/TrainingHomeViewStateContractDecodingTests');
  });

  it('routes prompts-only diff into the security suite (ENG-EXC-O3 fix)', () => {
    // Before this fix, a diff that only touched prompts/*.md was classified
    // as docs-only AND named `prompt-injection-defense` as a cannot-skip
    // gate — but emitted ZERO vitest globs. The cannot-skip-gate dashboard
    // caught the disconnect. The classifier now forces the security suite
    // to run when HAS_PROMPT fires regardless of HAS_NON_DOC.
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'prompts/secretary.md',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { mode: string; globs: string[] };
    };

    expect(result.flags.prompt).toBe(true);
    expect(result.cannotSkip).toContain('prompt-injection-defense');
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.globs).toContain('__tests__/security/**/*.test.ts');
    expect(result.vitest.globs).toContain('__tests__/services/prompt-cleanliness.test.ts');
  });

  it('routes Training changes into the real-DB plan create-cycle E2E cannot-skip gate', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/training-plan-volume-enforcement.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      cannotSkip: string[];
      vitest: { globs: string[] };
      stagingSmoke: { domains: string[] };
    };

    expect(result.flags.training).toBe(true);
    expect(result.cannotSkip).toContain('training-plan-create-e2e');
    expect(result.vitest.globs).toContain('__tests__/integration/training-plan-create-cycle.test.ts');
    expect(result.stagingSmoke.domains).toContain('smoke:training-cross-skill:staging');
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
    expect(result.flags.audit).toBe(false);
    expect(result.flags.deployConfig).toBe(false);
    expect(result.flags.iosNavigation).toBe(false);
    expect(result.flags.iosDto).toBe(false);
  });
});

describe('changed-area-classifier cannot-skip dashboard wiring (ENG-EXC-O3)', () => {
  // The dashboard spawns 24+ sequential bash + node child processes (one
  // per gate). Under full-sweep load (300+ test files in singleFork
  // mode) even a 60s timeout can flake on colder pre-push runs. Bump to
  // 120s to absorb the cold-spawn cost without masking a real regression —
  // a real wiring regression prints the failed gate names in the JSON
  // payload regardless of duration.
  it('cannot-skip gate dashboard reports every gate wired and PASS verdict', { timeout: 120_000 }, () => {
    const raw = execFileSync(
      'bash',
      ['scripts/cannot-skip-gate-dashboard.sh', '--json', '--no-evidence'],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      summary: {
        total: number;
        pass: number;
        fail: number;
        verdict: 'PASS' | 'FAIL';
        failedGates: string[];
      };
      gates: Array<{ gate: string; pass: boolean }>;
    };

    expect(result.summary.verdict).toBe('PASS');
    expect(result.summary.fail).toBe(0);
    expect(result.summary.total).toBeGreaterThanOrEqual(24);
    expect(result.summary.pass).toBe(result.summary.total);
    // Every per-gate row must report pass:true.
    for (const gate of result.gates) {
      expect(gate.pass, `gate ${gate.gate} failed wiring`).toBe(true);
    }
  });
});

describe('changed-area-classifier CI/CD optimization routing', () => {
  function classify(files: string) {
    const raw = execFileSync(
      'bash',
      ['scripts/changed-area-classifier.sh', '--json', '--files', files],
      { encoding: 'utf8' },
    );
    return JSON.parse(raw) as {
      changedFiles: string[];
      flags: Record<string, boolean>;
      vitest: { mode: string; globs: string[]; skipReason?: string | null };
      pytest: { globs: string[] };
      cannotSkip: string[];
    };
  }

  it('classifies docs-only changes as skip', () => {
    const result = classify('docs/release/example.md');

    expect(result.flags.docsOnly).toBe(true);
    expect(result.vitest.mode).toBe('skip');
    expect(result.vitest.skipReason).toContain('docs-only');
  });

  it('classifies package/test config changes as full', () => {
    const result = classify('package-lock.json,vitest.config.ts');

    expect(result.flags.packageJson).toBe(true);
    expect(result.flags.testConfig).toBe(true);
    expect(result.vitest.mode).toBe('full');
  });

  it('classifies unmapped backend source as changed-only', () => {
    const result = classify('src/misc/unmapped-helper.ts');

    expect(result.flags.backendSrc).toBe(true);
    expect(result.vitest.mode).toBe('changed-only');
  });

  it('classifies content-engine changes as full pytest', () => {
    const result = classify('content-engine/main.py');

    expect(result.flags.pythonEngine).toBe(true);
    expect(result.pytest.globs).toContain('content-engine/tests');
  });

  it('escalates high-fan-in source changes to full Vitest', () => {
    const result = classify('src/config.ts');

    expect(result.flags.highFanIn).toBe(true);
    expect(result.vitest.mode).toBe('full');
  });

  it('flags changed irreversible migrations for manual approval', () => {
    const result = classify('migrations/200_content_radar_phase0_rollout_guards.sql');

    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
    expect(result.vitest.mode).toBe('changed-only');
  });

  it('classifies runtime infrastructure changes as full Vitest', () => {
    const result = classify('Dockerfile.release-test,.env.example');

    expect(result.flags.runtimeInfra).toBe(true);
    expect(result.flags.deployConfig).toBe(true);
    expect(result.vitest.mode).toBe('full');
  });

  it('normalizes workspace-prefixed backend and migration paths', () => {
    const result = classify('engine/src/api/routes/billing.ts,engine/migrations/203_apple_health_encrypted_payload.sql');

    expect(result.changedFiles).toContain('src/api/routes/billing.ts');
    expect(result.changedFiles).toContain('migrations/203_apple_health_encrypted_payload.sql');
    expect(result.flags.backendSrc).toBe(true);
    expect(result.flags.apiRoute).toBe(true);
    expect(result.flags.migration).toBe(true);
    expect(result.flags.appleNotificationWebhook).toBe(true);
    expect(result.cannotSkip).toContain('migration-rollback-review');
    expect(result.cannotSkip).toContain('apple-notifications-jws-verify');
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.globs).toContain('__tests__/security/billing-apple-notifications-jws-verify.test.ts');
  });

  it('fails closed for deleted or renamed migration paths', () => {
    const result = classify('engine/migrations/999_deleted_forward_only.sql');

    expect(result.changedFiles).toContain('migrations/999_deleted_forward_only.sql');
    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
  });

  it('classifies runtime infrastructure as deploy config with staging smoke', () => {
    const result = classify('Dockerfile.release-test,.nvmrc,.env.example,docker-compose.yml');

    expect(result.flags.runtimeInfra).toBe(true);
    expect(result.flags.deployConfig).toBe(true);
    expect(result.flags.docsOnly).toBe(false);
    expect(result.vitest.mode).toBe('full');
    expect(result.stagingSmoke.generic).toBe(true);
  });
});
