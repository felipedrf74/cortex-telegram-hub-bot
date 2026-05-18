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
          'src/config.ts',
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

// Test-infra plan Phase A + E (2026-05-18): per-feature iOS classification.
// These tests pin the mapping from iOS source paths → XCTest classes so a
// future agent who renames a UI test class without updating the classifier
// gets a test failure instead of a silently-shrunk test suite.
describe('changed-area-classifier per-feature iOS mapping', () => {
  it('routes Home dashboard changes into only Home-relevant XCTest classes (not Training, Decision Center, etc.)', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub/Views/Dashboard/DashboardView.swift',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { mode: string; classes: string[] };
    };

    expect(result.flags.iosHome).toBe(true);
    expect(result.flags.iosTraining).toBe(false);
    expect(result.flags.iosDecisionCenter).toBe(false);
    expect(result.flags.iosContent).toBe(false);
    expect(result.flags.iosCooking).toBe(false);
    expect(result.flags.iosFinance).toBe(false);
    expect(result.flags.iosChat).toBe(false);
    expect(result.flags.iosSharedBehavior).toBe(false);

    expect(result.xctest.mode).toBe('focused');
    expect(result.xctest.classes).toContain('Nexus HubUITests/HomeWeekNavigationPerformanceUITests');
    expect(result.xctest.classes).toContain('Nexus HubUITests/AppShellVisualSnapshotUITests');
    expect(result.xctest.classes).toContain('Nexus HubTests/NavigationPerformanceSourcePinsTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/HealthDaySnapshotPayloadTests');
    // Unrelated UI suites must NOT be selected for a Home-only diff.
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/TrainingFixtureBypassUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/TrainingValidationUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/ContentCreationLiveWorkflowUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/NewTaskSheetCreateTaskUITests');
  });

  it('routes Decision Center changes into NotificationDecisionCenterUITests only', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub/Views/DecisionCenter/NotificationDecisionCenterView.swift',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { classes: string[] };
    };

    expect(result.flags.iosDecisionCenter).toBe(true);
    expect(result.flags.iosNotification).toBe(true);
    expect(result.flags.iosHome).toBe(false);
    expect(result.xctest.classes).toContain('Nexus HubUITests/NotificationDecisionCenterUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/TrainingFixtureBypassUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/HomeWeekNavigationPerformanceUITests');
  });

  it('routes Chat / message changes into Chat-only XCTest classes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub/Models/Message.swift',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { classes: string[] };
    };

    expect(result.flags.iosChat).toBe(true);
    expect(result.flags.iosHome).toBe(false);
    expect(result.xctest.classes).toContain('Nexus HubTests/ChatResponseBlockPresentationTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/ChatRichStateDecodingTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/MessageBubbleRecipeParsingTests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/HomeWeekNavigationPerformanceUITests');
  });

  it('routes Training view changes into Training-only XCTest classes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub/ViewModels/TrainingViewModel.swift',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { classes: string[] };
    };

    expect(result.flags.iosTraining).toBe(true);
    expect(result.flags.iosHome).toBe(false);
    // ViewModel.swift also matches HAS_IOS_NAVIGATION pattern (existing
    // legacy: any *ViewModel.swift fires HAS_IOS_NAVIGATION). So both
    // Training UI tests AND Navigation tests fire — accept either.
    expect(result.xctest.classes).toContain('Nexus HubUITests/TrainingFixtureBypassUITests');
    expect(result.xctest.classes).toContain('Nexus HubUITests/TrainingValidationUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/NotificationDecisionCenterUITests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/ContentCreationLiveWorkflowUITests');
  });

  it('routes Settings/Connections changes into Settings XCTest classes only', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub/Views/Settings/ConnectionsView.swift',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { classes: string[] };
    };

    expect(result.flags.iosSettings).toBe(true);
    expect(result.flags.iosHome).toBe(false);
    expect(result.xctest.classes).toContain('Nexus HubTests/ModelDecodingTests');
    expect(result.xctest.classes).not.toContain('Nexus HubUITests/TrainingFixtureBypassUITests');
  });

  it('routes Calendar service/repo changes into Calendar XCTest classes', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub/Core/Services/CalendarService.swift',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { classes: string[] };
    };

    expect(result.flags.iosCalendar).toBe(true);
    expect(result.flags.iosHome).toBe(false);
    expect(result.xctest.classes).toContain('Nexus HubTests/CalendarEventPresentationTests');
    expect(result.xctest.classes).toContain('Nexus HubTests/ModelDecodingTests');
  });

  it('escalates Xcode project / xcconfig changes to xctest.mode = full (shared behavior)', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'Nexus Hub.xcodeproj/project.pbxproj',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { mode: string };
    };

    expect(result.flags.iosSharedBehavior).toBe(true);
    expect(result.xctest.mode).toBe('full');
  });

  it('emits empty xctest.classes when no iOS files touched (no false-positive iOS routing)', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/secretary-fastpath.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      xctest: { mode: string; classes: string[] };
    };

    expect(result.flags.iosHome).toBe(false);
    expect(result.flags.iosSrc).toBe(false);
    expect(result.xctest.mode).toBe('skip');
    expect(result.xctest.classes).toEqual([]);
  });
});

// Test-infra plan Phase H-3 (2026-05-18): migration prefix collision
// detection. The classifier now surfaces migrations that share a numeric
// prefix with a sibling local worktree's migrations, so pre-commit can
// warn before the boot-time assertNoUnexpectedMigrationPrefixCollisions
// throw at database.ts:53-63.
describe('changed-area-classifier migration collision detection (Phase H-3)', () => {
  it('emits an empty migrations.collisions array when no migrations changed', () => {
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'src/services/secretary-fastpath.ts',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      migrations: { collisions: string[] };
    };

    expect(result.migrations).toBeDefined();
    expect(result.migrations.collisions).toEqual([]);
  });

  it('exposes migrations.collisions as a string array on the JSON payload', () => {
    // A migration in the diff but no sibling worktree collision → empty
    // array. This pins the shape of the field so consumers (pre-commit,
    // CI) can rely on it.
    const raw = execFileSync(
      'bash',
      [
        'scripts/changed-area-classifier.sh',
        '--json',
        '--files',
        'migrations/999_test_only_should_not_collide.sql',
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(raw) as {
      flags: Record<string, boolean>;
      migrations: { collisions: string[] };
    };

    expect(result.flags.migration).toBe(true);
    expect(Array.isArray(result.migrations.collisions)).toBe(true);
    // The collisions array CAN be empty (no sibling worktree has a 999_*
    // migration in real life). The shape contract is what we pin.
  });
});

describe('changed-area-classifier cannot-skip dashboard wiring (ENG-EXC-O3)', () => {
  // The dashboard spawns 23 sequential bash + node child processes (one
  // per gate). Under full-sweep load (300+ test files in singleFork
  // mode) the default 10s timeout is tight enough to flake. Bump to 60s
  // to absorb the cold-spawn cost without masking a real regression —
  // a real wiring regression prints the failed gate names in the JSON
  // payload regardless of duration.
  it('cannot-skip gate dashboard reports all 23 gates wired and PASS verdict', { timeout: 60_000 }, () => {
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
    expect(result.summary.total).toBeGreaterThanOrEqual(23);
    expect(result.summary.pass).toBe(result.summary.total);
    // Every per-gate row must report pass:true.
    for (const gate of result.gates) {
      expect(gate.pass, `gate ${gate.gate} failed wiring`).toBe(true);
    }
  });
});
