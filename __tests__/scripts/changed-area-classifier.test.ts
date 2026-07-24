import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CANNOT_SKIP_GATE_NAMES,
  classifyChangedFiles,
} from '../../scripts/lib/changed-area-classifier.mjs';

const root = resolve(process.cwd());
const generatedAt = '2026-07-15T00:00:00Z';

function classify(files: string | string[]) {
  return classifyChangedFiles({
    files: Array.isArray(files) ? files : files.split(',').filter(Boolean),
    root,
    generatedAt,
  });
}

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) delete env[key];
  return env;
}

function installClassifierFixture(repo: string): void {
  mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
  mkdirSync(join(repo, 'config'), { recursive: true });
  for (const file of [
    'scripts/changed-area-classifier.sh',
    'scripts/changed-area-classifier.mjs',
    'scripts/lib/changed-area-classifier.mjs',
    'scripts/lib/git-changed-paths.mjs',
    'scripts/lib/irreversible-migration-policy.mjs',
    'scripts/lib/migration-safety-policy-classifier.mjs',
    'scripts/lib/git-ref.mjs',
    'config/test-policy.json',
    'config/irreversible-migrations.json',
  ]) {
    copyFileSync(file, join(repo, file));
  }
  chmodSync(join(repo, 'scripts/changed-area-classifier.sh'), 0o755);
}

type RoutingFixture = {
  name: string;
  files: string[];
  flags: Record<string, boolean>;
  gates?: string[];
  vitest?: string[];
  xctest?: string[];
  mode?: string;
};

const routingFixtures: RoutingFixture[] = [
  {
    name: 'content agents',
    files: ['src/agents/reaction-radar-agent.ts'],
    flags: { content: true, contentAgent: true },
    gates: ['content-agent-neutrality'],
    vitest: ['__tests__/security/content-agent-neutrality.test.ts', '__tests__/services/cross-agent-learning*.test.ts'],
  },
  {
    name: 'cross-agent domain adapters',
    files: ['src/services/cross-agent-learning/training-mesh-context.ts'],
    flags: { contentAgent: true },
    gates: ['content-agent-neutrality'],
    vitest: [
      '__tests__/services/cross-agent-learning*.test.ts',
      '__tests__/services/*mesh-context.test.ts',
      '__tests__/services/mesh-context-scope.test.ts',
    ],
  },
  {
    name: 'backend auth and OAuth',
    files: ['src/api/routes/auth.ts', 'src/services/google-sign-in.ts', 'src/services/apple-sign-in-nonce.ts', 'src/services/oauth-flow.ts', 'src/portal/oauth-routes.ts'],
    flags: { authOrTenant: true, portal: true },
    gates: ['tenant-auth-security'],
    vitest: ['__tests__/api/auth-*.test.ts', '__tests__/services/google-sign-in.test.ts', '__tests__/services/apple-sign-in-nonce.test.ts', '__tests__/services/oauth*.test.ts', '__tests__/portal/portal-oauth-routes.test.ts'],
  },
  {
    name: 'OAuth token store',
    files: ['src/services/oauth-store.ts'],
    flags: { authOrTenant: true },
    gates: ['tenant-auth-security'],
    vitest: ['__tests__/services/oauth*.test.ts', '__tests__/security/**/*.test.ts'],
    mode: 'focused',
  },
  {
    name: 'finance tenant safety',
    files: ['src/services/finance-tracker.ts'],
    flags: { finance: true },
    vitest: ['__tests__/services/finance-*.test.ts', '__tests__/security/finance-*.test.ts'],
    mode: 'focused',
  },
  {
    name: 'iOS auth',
    files: ['Nexus Hub/Core/AuthManager.swift', 'Nexus Hub/Core/KeychainHelper.swift', 'Nexus Hub/Views/Auth/AuthenticationView.swift'],
    flags: { iosSrc: true, iosAuth: true, authOrTenant: true },
    gates: ['tenant-auth-security'],
    xctest: ['Nexus HubTests/AppleSignInNonceTests', 'Nexus HubTests/KeychainHelperTests', 'Nexus HubTests/AuthManagerPersistenceTests', 'Nexus HubTests/GoogleAuthCallbackResolverTests'],
  },
  {
    name: 'chat planner and executor',
    files: ['src/services/chat/planner/orchestrator.ts', 'src/services/chat/executor/plan-executor.ts'],
    flags: { chatReasoning: true, secretary: true },
    vitest: ['__tests__/services/chat-action-planner.test.ts', '__tests__/services/chat-action-production-safety.test.ts', '__tests__/api/chat-routes.test.ts', '__tests__/security/p0-chat-identity-isolation.test.ts'],
  },
  {
    name: 'Chat Core v2',
    files: ['src/services/chat-core-v2/route-decision.ts'],
    flags: { chatReasoning: false, chatCoreV2: true },
    vitest: ['__tests__/services/chat-core-v2-*.test.ts'],
    mode: 'focused',
  },
  {
    name: 'logger and redaction',
    files: ['src/utils/logger.ts'],
    flags: { logger: true },
    gates: ['logger-redaction-pii-scan'],
    vitest: ['__tests__/utils/logger-*.test.ts', '__tests__/api/secret-guards.test.ts'],
  },
  {
    name: 'scheduler',
    files: ['src/services/scheduler.ts'],
    flags: { scheduler: true },
    gates: ['scheduler-tenant-scope-and-failure'],
    vitest: ['__tests__/services/scheduler-*.test.ts'],
  },
  {
    name: 'governed agent jobs',
    files: [
      'src/services/agent-job-runner.ts',
      'src/services/scheduled-agent-jobs.ts',
      'src/services/chat-action-fixer-worker.ts',
      'src/services/channel-learner.ts',
      'src/services/garmin-coach.ts',
      'src/agents/voice-evolution-agent.ts',
    ],
    flags: { scheduler: true },
    gates: ['scheduler-tenant-scope-and-failure'],
    vitest: [
      '__tests__/services/scheduler-*.test.ts',
      '__tests__/services/agent-job-runner.test.ts',
      '__tests__/services/scheduled-agent-job-governance.test.ts',
      '__tests__/services/chat-action-fixer-worker.test.ts',
      '__tests__/services/channel-learner-relearn-gate.test.ts',
      '__tests__/services/garmin-coach-user-scope.test.ts',
      '__tests__/agents/voice-evolution-multi-tenant.test.ts',
      '__tests__/scripts/runtime-manifests.test.ts',
    ],
  },
  {
    name: 'APNs and notification routes',
    files: ['src/services/apns-sender.ts', 'src/api/routes/notifications.ts'],
    flags: { notification: true },
    gates: ['notification-apns-delivery-and-tenant'],
    vitest: ['__tests__/services/apns-*.test.ts', '__tests__/api/notifications-*.test.ts'],
  },
  {
    name: 'Garmin Apple Health and wearable',
    files: ['src/services/garmin.ts', 'src/services/apple-health.ts', 'src/api/routes/wearable-routes.ts'],
    flags: { healthIntegration: true },
    gates: ['health-integration-tenant-isolation'],
    vitest: ['__tests__/services/garmin-*.test.ts', '__tests__/services/apple-health-*.test.ts', '__tests__/api/wearable-*.test.ts'],
  },
  {
    name: 'rate limiting',
    files: ['src/api/middleware/rate-limit.ts'],
    flags: { rateLimit: true },
    gates: ['auth-rate-limit-and-lockout'],
    vitest: ['__tests__/api/rate-limiter.test.ts', '__tests__/security/**/*.test.ts'],
  },
  {
    name: 'audit trail',
    files: ['src/services/audit-trail.ts'],
    flags: { audit: true },
    gates: ['audit-trail-emission-and-scope'],
    vitest: ['__tests__/services/audit-trail.test.ts', '__tests__/api/authenticated-support-routes-scope.test.ts'],
  },
  {
    name: 'release and PM2 config',
    files: ['ecosystem.config.js'],
    flags: { deployConfig: true },
    gates: ['deploy-config-health-rehearsal'],
    vitest: ['__tests__/services/config-*.test.ts', '__tests__/scripts/*.test.ts'],
  },
  {
    name: 'exact release operator',
    files: ['scripts/promote-exact-release.sh', 'scripts/remote-release-readiness.sh'],
    flags: { releaseOperator: true },
    gates: ['exact-release-promotion-rehearsal'],
    vitest: [
      '__tests__/scripts/release-artifact-manifest.test.ts',
      '__tests__/scripts/release-manifest-v2.test.ts',
      '__tests__/scripts/trusted-release-signing.test.ts',
      '__tests__/scripts/release-runtime-safeguards.test.ts',
      '__tests__/scripts/exact-promotion-operational-safety.test.ts',
      '__tests__/scripts/release-exact-attestations.test.ts',
      '__tests__/scripts/release-backup-runtime-artifact.test.ts',
      '__tests__/scripts/production-shape-migration-rehearsal.test.ts',
      '__tests__/scripts/rollback-versioned-runtime.test.ts',
      '__tests__/scripts/pm2-sanitized-start.test.ts',
      '__tests__/scripts/release-evidence-container.test.ts',
      '__tests__/scripts/release-plan-evaluator.test.ts',
    ],
    mode: 'focused',
  },
  {
    name: 'iOS navigation',
    files: ['Nexus Hub/Views/MainTabView.swift', 'Nexus Hub/ViewModels/DashboardViewModel.swift'],
    flags: { iosSrc: true, iosNavigation: true },
    gates: ['ios-navigation-responsiveness'],
    xctest: ['Nexus HubTests/NavigationPerformanceSourcePinsTests', 'Nexus HubUITests/AppWideResponsivenessUITests'],
  },
  {
    name: 'iOS DTO and decoders',
    files: ['Nexus Hub/Core/Services/TrainingService.swift', 'Nexus Hub/Core/DTO/TrainingDTO.swift'],
    flags: { iosSrc: true, iosDto: true },
    gates: ['ios-contract-decoder-resilience'],
    xctest: ['Nexus HubTests/ContractDecoderResilienceTests', 'Nexus HubTests/TrainingHomeViewStateContractDecodingTests'],
  },
  {
    name: 'prompt-only changes',
    files: ['prompts/secretary.md'],
    flags: { prompt: true, docsOnly: true },
    gates: ['prompt-injection-defense'],
    vitest: ['__tests__/security/**/*.test.ts', '__tests__/services/prompt-cleanliness.test.ts'],
    mode: 'focused',
  },
  {
    name: 'Training',
    files: ['src/services/training-plan-volume-enforcement.ts'],
    flags: { training: true },
    gates: ['training-plan-create-e2e'],
    vitest: ['__tests__/integration/training-plan-create-cycle.test.ts'],
  },
];

describe('changed-area-classifier pure routing fixtures', () => {
  it.each(routingFixtures)('routes $name without shell or Git', (fixture) => {
    const result = classify(fixture.files);
    for (const [flag, expected] of Object.entries(fixture.flags)) expect(result.flags[flag]).toBe(expected);
    for (const gate of fixture.gates ?? []) expect(result.cannotSkip).toContain(gate);
    for (const route of fixture.vitest ?? []) expect(result.vitest.globs).toContain(route);
    for (const testClass of fixture.xctest ?? []) expect(result.xctest.classes).toContain(testClass);
    if (fixture.mode) expect(result.vitest.mode).toBe(fixture.mode);
  });

  it('keeps enrichment flags false on an unrelated backend change', () => {
    const result = classify('src/services/plain-helper.ts');
    for (const flag of ['logger', 'scheduler', 'notification', 'healthIntegration', 'rateLimit', 'audit', 'deployConfig', 'releaseOperator', 'operationsTooling', 'iosNavigation', 'iosDto']) {
      expect(result.flags[flag]).toBe(false);
    }
  });
});

const fullSuiteTriggers = [
  'config/test-policy.json',
  'config/irreversible-migrations.json',
  'scripts/changed-area-classifier.sh',
  'scripts/changed-area-classifier.mjs',
  'scripts/lib/changed-area-classifier.mjs',
  'scripts/lib/git-changed-paths.mjs',
  'scripts/lib/irreversible-migration-policy.mjs',
  'scripts/lib/migration-safety-policy-classifier.mjs',
  'scripts/migration-safety-check.mjs',
  'scripts/release-test-gate.sh',
  'scripts/release-verify.sh',
  'scripts/resolve-ci-change-base.sh',
  'scripts/select-vitest-files.mjs',
  'scripts/protected-main-ci-evidence.mjs',
  'scripts/run-test-tier.mjs',
  'scripts/risk-gate.sh',
  'scripts/lib/git-ref.mjs',
  'scripts/lib/test-policy.mjs',
  '.github/workflows/ci.yml',
  '__tests__/fixtures/shared-database.ts',
];

describe('changed-area-classifier pure CI and release policy fixtures', () => {
  it('classifies docs-only changes as skip', () => {
    const result = classify('docs/release/example.md');
    expect(result.flags.docsOnly).toBe(true);
    expect(result.vitest.mode).toBe('skip');
    expect(result.vitest.skipReason).toContain('docs-only');
  });

  it('classifies package and test config changes as full', () => {
    const result = classify('package-lock.json,vitest.config.ts');
    expect(result.flags.packageJson).toBe(true);
    expect(result.flags.testConfig).toBe(true);
    expect(result.vitest.mode).toBe('full');
  });

  it.each(fullSuiteTriggers)('forces full Vitest for governed test infrastructure: %s', (file) => {
    const result = classify(file);
    expect(result.flags.docsOnly).toBe(false);
    expect(result.flags.fullSuiteTrigger).toBe(true);
    expect(result.vitest.mode).toBe('full');
    expect(result.cannotSkip).toContain('test-infrastructure-full-suite');
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
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
    expect(result.vitest.mode).toBe('changed-only');
  });

  it.each([
    'migrations/246_content_pipeline_workspace_exit.sql',
    'migrations/250_content_performance_workspace_lineage.sql',
    'migrations/252_content_legacy_script_workspace_parity.sql',
  ])('flags policy-governed state-coupled cutover %s', (file) => {
    const result = classify(file);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
  });

  it('honors the reviewed syntax exemption for the lossless rollout-metrics rebuild', () => {
    const result = classify('migrations/248_content_workspace_rollout_observability.sql');
    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(false);
    expect(result.cannotSkip).not.toContain('irreversible-migration-manual-approval');
  });

  it('revokes the syntax exemption when migration 248 bytes drift', () => {
    const migration = 'migrations/248_content_workspace_rollout_observability.sql';
    const absolute = join(root, migration);
    const result = classifyChangedFiles({
      files: [migration],
      root,
      generatedAt,
      readText: (file) => file === absolute
        ? `${readFileSync(file, 'utf8')}\nDROP TABLE content_workspace_metrics;\n`
        : readFileSync(file, 'utf8'),
    });

    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
  });

  it('fails closed when the irreversible-migration registry itself changes', () => {
    const result = classify('config/irreversible-migrations.json');
    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.flags.fullSuiteTrigger).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
  });

  it.each([
    ['.github/workflows/ci.yml', true],
    ['.husky/pre-commit', false],
    ['scripts/changed-area-classifier.mjs', true],
    ['scripts/lib/changed-area-classifier.mjs', true],
    ['scripts/lib/git-changed-paths.mjs', true],
    ['scripts/lib/irreversible-migration-policy.mjs', true],
    ['scripts/lib/migration-safety-policy-classifier.mjs', true],
    ['config/production-migration-lineages.json', true],
    ['scripts/lib/production-migration-lineage.mjs', true],
    ['scripts/migration-safety-check.mjs', true],
    ['scripts/promote-exact-release.sh', false],
    ['scripts/remote-create-release-backup.sh', false],
    ['scripts/remote-production-shape-migration-rehearsal.sh', false],
    ['scripts/production-shape-migration-rehearsal.mjs', true],
    ['scripts/validate-production-shape-migration-rehearsal.mjs', true],
    ['scripts/lib/production-shape-migration-rehearsal-evidence.mjs', true],
    ['scripts/risk-gate.sh', true],
    ['scripts/release-test-gate.sh', true],
    ['scripts/release-verify.sh', true],
  ])('fails closed when migration governance code changes: %s', (file, fullSuiteExpected) => {
    const result = classify(file);
    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.flags.fullSuiteTrigger).toBe(fullSuiteExpected);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
  });

  it('does not mistake rollback DROP statements for an irreversible forward migration', () => {
    const result = classify([
      'migrations/233_agent_job_runner_audit.sql',
      'migrations/down/233_agent_job_runner_audit.sql',
    ]);

    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(false);
    expect(result.cannotSkip).toContain('migration-rollback-review');
    expect(result.cannotSkip).not.toContain('irreversible-migration-manual-approval');
  });

  it('classifies runtime infrastructure as full with staging smoke', () => {
    const result = classify('Dockerfile.release-test,.nvmrc,.env.example,docker-compose.yml');
    expect(result.flags.runtimeInfra).toBe(true);
    expect(result.flags.deployConfig).toBe(true);
    expect(result.flags.docsOnly).toBe(false);
    expect(result.vitest.mode).toBe('full');
    expect(result.stagingSmoke.generic).toBe(true);
  });

  it('classifies release gate helpers as runtime infrastructure', () => {
    const result = classify('scripts/lib/release-gates.sh');
    expect(result.flags.runtimeInfra).toBe(true);
    expect(result.flags.deployConfig).toBe(true);
    expect(result.vitest.mode).toBe('full');
    expect(result.stagingSmoke.generic).toBe(true);
  });

  it.each([
    'scripts/release-operator.sh',
    'scripts/promote-exact-release.sh',
    'scripts/env-parity-check.sh',
    'scripts/remote-release-preflight.sh',
    'scripts/remote-release-readiness.sh',
    'scripts/remote-prepare-release-backup.sh',
    'scripts/remote-create-release-backup.sh',
    'scripts/remote-production-shape-migration-rehearsal.sh',
    'scripts/remote-start-sanitized-pm2.sh',
    'scripts/rollback.sh',
    'scripts/restore.sh',
    'scripts/remote-promotion-control.sh',
    'scripts/remote-promotion-worker-control.sh',
    'scripts/remote-promotion-systemd-install.sh',
    'scripts/remote-promotion-transaction.sh',
    'scripts/remote-release-capacity.sh',
    'scripts/release-artifact-manifest.mjs',
    'scripts/release-bundle.mjs',
    'scripts/release-manifest-v2.mjs',
    'scripts/release-plan-evaluator.mjs',
    'scripts/release-sequence.mjs',
    'scripts/protected-main-ci-evidence.mjs',
    'scripts/complete-promotion-migration-gate.mjs',
    'scripts/trusted-release-signer.mjs',
    'scripts/rollback-drill-kvm-coordinator.mjs',
    'scripts/lib/release-artifact-manifest.mjs',
    'scripts/lib/release-plan-evaluation.mjs',
    'scripts/lib/rollback-drill-kvm-evidence.mjs',
  ])('routes exact release entrypoint %s through the operator gate', (file) => {
    const result = classify(file);
    expect(result.flags.releaseOperator).toBe(true);
    expect(result.cannotSkip).toContain('exact-release-promotion-rehearsal');
    expect(result.tiers).toContain('T4');
    expect(result.vitest.mode).toBe(file === 'scripts/protected-main-ci-evidence.mjs' ? 'full' : 'focused');
    expect(result.stagingSmoke.generic).toBe(true);
  });

  it.each([
    'ops/sonarqube/compose.yaml',
    'scripts/quality-sonar-scan.sh',
    'scripts/ollama-observation-collector.mjs',
    'scripts/ollama-soak-evidence.mjs',
    'ops/application-dr/backup.env.example',
    'scripts/application-dr-backup.sh',
    'scripts/application-dr-recovery-runtime.mjs',
    'scripts/application-dr-systemd-install.sh',
  ])('routes advisory/backup operations tooling %s to focused checks without a staging release gate', (file) => {
    const result = classify(file);
    expect(result.flags.operationsTooling).toBe(true);
    expect(result.flags.releaseOperator).toBe(false);
    expect(result.vitest.mode).toBe('focused');
    expect(result.stagingSmoke.generic).toBe(false);
  });

  it('selects every application DR contract test for DR operations changes', () => {
    const result = classify('scripts/application-dr-recovery-runtime.mjs');
    expect(result.vitest.globs).toContain(
      '__tests__/scripts/application-disaster-recovery.test.ts',
    );
    expect(result.vitest.globs).toContain('__tests__/scripts/application-dr-*.test.ts');
  });

  it.each([
    'scripts/install-ollama.sh',
    'scripts/staging-smoke-ollama.sh',
  ])('routes Ollama host policy %s through deploy-config verification', (file) => {
    const result = classify(file);
    expect(result.flags.deployConfig).toBe(true);
    expect(result.vitest.mode).toBe('focused');
    expect(result.stagingSmoke.generic).toBe(true);
  });

  it.each([
    'src/services/ollama-model-policy.ts',
    'src/services/ollama-provider.ts',
    'src/services/model-config.ts',
  ])('routes local-model policy %s through model-routing safety tests', (file) => {
    const result = classify(file);
    expect(result.flags.modelRouting).toBe(true);
    expect(result.cannotSkip).toContain('model-routing-cost-attribution');
    expect(result.vitest.globs).toContain('__tests__/services/ollama-small-only-policy.test.ts');
  });

  it.each([
    'config/production-migration-lineages.json',
    'scripts/production-shape-migration-rehearsal.mjs',
    'scripts/validate-production-shape-migration-rehearsal.mjs',
    'scripts/lib/production-migration-lineage.mjs',
    'scripts/lib/production-shape-migration-rehearsal-evidence.mjs',
  ])('routes migration rehearsal trust-boundary code %s through the operator gate and full suite', (file) => {
    const result = classify(file);
    expect(result.flags.releaseOperator).toBe(true);
    expect(result.cannotSkip).toContain('exact-release-promotion-rehearsal');
    expect(result.tiers).toContain('T4');
    expect(result.vitest.mode).toBe('full');
    expect(result.stagingSmoke.generic).toBe(true);
  });

  it.each([
    'scripts/deploy.sh',
    'scripts/deploy-staging.sh',
    'scripts/deploy-readiness-check.sh',
    'scripts/promote-to-prod.sh',
  ])('does not preserve retired repository-sync semantics for %s', (file) => {
    const result = classify(file);
    expect(result.flags.releaseOperator).toBe(false);
    expect(result.cannotSkip).not.toContain('exact-release-promotion-rehearsal');
  });

  it('normalizes workspace-prefixed backend and migration paths', () => {
    const result = classify('engine/src/api/routes/billing.ts,engine/migrations/203_apple_health_encrypted_payload.sql');
    expect(result.changedFiles).toEqual(['migrations/203_apple_health_encrypted_payload.sql', 'src/api/routes/billing.ts']);
    expect(result.flags).toMatchObject({ backendSrc: true, apiRoute: true, migration: true, appleNotificationWebhook: true });
    expect(result.cannotSkip).toContain('migration-rollback-review');
    expect(result.cannotSkip).toContain('apple-notifications-jws-verify');
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.globs).toContain('__tests__/security/billing-apple-notifications-jws-verify.test.ts');
  });

  it('fails closed for deleted or renamed migration paths', () => {
    const result = classify('engine/migrations/999_deleted_forward_only.sql');
    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.cannotSkip).toContain('irreversible-migration-manual-approval');
  });
});

describe('changed-area-classifier process-boundary integration', () => {
  it.each(['delete', 'rename'] as const)('forces the full suite when a test file is %sd', (operation) => {
    const repo = mkdtempSync(join(tmpdir(), `nexus-classifier-test-${operation}-`));
    const gitEnv = cleanGitEnv();
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: gitEnv,
    }).trim();
    try {
      installClassifierFixture(repo);
      mkdirSync(join(repo, '__tests__/services'), { recursive: true });
      writeFileSync(join(repo, '__tests__/services/obsolete.test.ts'), 'export {};\n');
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Nexus CI Fixture');
      git('config', 'user.email', 'ci-fixture@example.invalid');
      git('add', '.');
      git('commit', '-m', 'fixture: base');
      const base = git('rev-parse', 'HEAD');
      if (operation === 'delete') git('rm', '__tests__/services/obsolete.test.ts');
      else git('mv', '__tests__/services/obsolete.test.ts', '__tests__/services/renamed.test.ts');

      const result = JSON.parse(execFileSync(
        'bash',
        ['scripts/changed-area-classifier.sh', '--json', '--base', base],
        { cwd: repo, encoding: 'utf8', env: gitEnv },
      ));

      expect(result.flags).toMatchObject({ testTopologyChange: true, fullSuiteTrigger: true });
      expect(result.vitest).toMatchObject({ mode: 'full' });
      expect(result.cannotSkip).toContain('test-infrastructure-full-suite');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('preserves both sides of a tracked rename whose paths contain spaces', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nexus-classifier-spaced-rename-'));
    const gitEnv = cleanGitEnv();
    const git = (...args: string[]) => execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: gitEnv,
    }).trim();
    try {
      installClassifierFixture(repo);
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src/old feature.ts'), 'export const value = 1;\n');
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Nexus CI Fixture');
      git('config', 'user.email', 'ci-fixture@example.invalid');
      git('add', '.');
      git('commit', '-m', 'fixture: base');
      const base = git('rev-parse', 'HEAD');
      git('mv', 'src/old feature.ts', 'src/new feature.ts');

      const result = JSON.parse(execFileSync(
        'bash',
        ['scripts/changed-area-classifier.sh', '--json', '--base', base],
        { cwd: repo, encoding: 'utf8', env: gitEnv },
      ));

      expect(result.changedFiles).toEqual(['src/new feature.ts', 'src/old feature.ts']);
      expect(result.flags.backendSrc).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('reads candidate source state while enforcing the trusted policy path', () => {
    const candidate = mkdtempSync(join(tmpdir(), 'nexus-classifier-candidate-'));
    const trusted = mkdtempSync(join(tmpdir(), 'nexus-classifier-policy-'));
    try {
      mkdirSync(join(candidate, 'migrations'), { recursive: true });
      mkdirSync(join(candidate, 'config'), { recursive: true });
      mkdirSync(join(trusted, 'config'), { recursive: true });
      writeFileSync(
        join(candidate, 'migrations/999_candidate.sql'),
        'DROP TABLE candidate_only;\n',
      );
      writeFileSync(
        join(candidate, 'config/test-policy.json'),
        JSON.stringify({ fullSuiteTriggers: [] }),
      );
      const trustedPolicy = join(trusted, 'config/test-policy.json');
      const trustedIrreversiblePolicy = join(trusted, 'config/irreversible-migrations.json');
      writeFileSync(
        trustedPolicy,
        JSON.stringify({ fullSuiteTriggers: ['src/runtime-feature.ts'] }),
      );
      copyFileSync(
        join(root, 'config/irreversible-migrations.json'),
        trustedIrreversiblePolicy,
      );
      const invoke = (file: string) => JSON.parse(execFileSync(
        'bash',
        [join(root, 'scripts/changed-area-classifier.sh'), '--json', '--files', file],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...cleanGitEnv(),
            GIT_DIR: '/invalid/inherited/git-dir',
            NEXUS_CLASSIFIER_REPO_ROOT: candidate,
            NEXUS_TEST_POLICY_PATH: trustedPolicy,
            NEXUS_IRREVERSIBLE_MIGRATIONS_PATH: trustedIrreversiblePolicy,
          },
        },
      ));

      const migration = invoke('migrations/999_candidate.sql');
      expect(migration.flags.irreversibleMigration).toBe(true);
      expect(migration.cannotSkip).toContain('irreversible-migration-manual-approval');

      const governedSource = invoke('src/runtime-feature.ts');
      expect(governedSource.flags.fullSuiteTrigger).toBe(true);
      expect(governedSource.vitest.mode).toBe('full');
    } finally {
      rmSync(candidate, { recursive: true, force: true });
      rmSync(trusted, { recursive: true, force: true });
    }
  });

  it('preserves explicit CLI behavior for a large change set', () => {
    const files = ['__tests__/services/product-learning.test.ts', 'src/services/product-learning.ts', ...Array.from({ length: 2_000 }, (_, index) => `docs/generated-${index}.md`)];
    const raw = execFileSync('bash', ['scripts/changed-area-classifier.sh', '--json', '--files', files.join(',')], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const result = JSON.parse(raw);
    expect(result.flags).toMatchObject({ backendSrc: true, backendTest: true, docsOnly: false });
    expect(result.vitest.mode).toBe('changed-only');
  });

  it('emits the complete cannot-skip dashboard through its compatibility CLI', () => {
    const raw = execFileSync('bash', ['scripts/cannot-skip-gate-dashboard.sh', '--json', '--no-evidence', '--base', 'origin/main'], { encoding: 'utf8' });
    const result = JSON.parse(raw);
    expect(result.summary).toMatchObject({ verdict: 'PASS', fail: 0 });
    expect(result.summary.total).toBe(CANNOT_SKIP_GATE_NAMES.length);
    expect(result.summary.pass).toBe(result.summary.total);
    expect(result.gates.map((gate: { gate: string }) => gate.gate).sort())
      .toEqual([...CANNOT_SKIP_GATE_NAMES].sort());
    expect(result.gates.every((gate: { pass: boolean }) => gate.pass)).toBe(true);
  });

  it('includes a runtime commit followed by a docs commit when the push base is used', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nexus-push-range-'));
    const gitEnv = cleanGitEnv();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();
    try {
      installClassifierFixture(repo);
      writeFileSync(join(repo, 'README.md'), 'fixture\n');
      git('init');
      git('config', 'user.name', 'Nexus CI Fixture');
      git('config', 'user.email', 'ci-fixture@example.invalid');
      git('add', '.');
      git('commit', '-m', 'fixture: base');
      const pushBefore = git('rev-parse', 'HEAD');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src/runtime-feature.ts'), 'export const runtimeFeature = true;\n');
      git('add', 'src/runtime-feature.ts');
      git('commit', '-m', 'feat: runtime');
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(join(repo, 'docs/release.md'), '# Release\n');
      git('add', 'docs/release.md');
      git('commit', '-m', 'docs: release');
      const result = JSON.parse(execFileSync('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', pushBefore], { cwd: repo, encoding: 'utf8', env: gitEnv }));
      expect(result.changedFiles).toEqual(['docs/release.md', 'src/runtime-feature.ts']);
      expect(result.flags).toMatchObject({ docsOnly: false, backendSrc: true, impactResolved: true });
      expect(result.vitest.mode).not.toBe('skip');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('rejects invalid push bases and fails closed for a non-ancestor base', () => {
    const repo = mkdtempSync(join(tmpdir(), 'nexus-ci-base-resolution-'));
    const gitEnv = cleanGitEnv();
    const resolver = join(process.cwd(), 'scripts/resolve-ci-change-base.sh');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv }).trim();
    const resolvePush = (before?: string) => execFileSync('bash', [resolver], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...gitEnv, NEXUS_CI_REPO_ROOT: repo, EVENT_NAME: 'push', ...(before === undefined ? {} : { PUSH_BEFORE_SHA: before }) },
    }).trim();
    try {
      git('init', '--initial-branch=main');
      git('config', 'user.name', 'Nexus CI Fixture');
      git('config', 'user.email', 'ci-fixture@example.invalid');
      installClassifierFixture(repo);
      writeFileSync(join(repo, 'base.txt'), 'base\n');
      git('add', '.');
      git('commit', '-m', 'fixture: base');
      const ancestor = git('rev-parse', 'HEAD');
      writeFileSync(join(repo, 'runtime.txt'), 'runtime\n');
      git('add', '.');
      git('commit', '-m', 'fixture: runtime');
      expect(resolvePush(ancestor)).toBe(ancestor);
      expect(resolvePush()).toBe('');
      expect(resolvePush('0'.repeat(40))).toBe('');
      expect(resolvePush('f'.repeat(40))).toBe('');
      git('checkout', '--orphan', 'rewritten');
      execFileSync('git', ['rm', '-rf', '.'], { cwd: repo, env: gitEnv });
      installClassifierFixture(repo);
      writeFileSync(join(repo, 'docs-only.md'), 'rewritten\n');
      git('add', '.');
      git('commit', '-m', 'fixture: unrelated rewrite');
      expect(resolvePush(ancestor)).toBe('');
      const result = JSON.parse(execFileSync('bash', ['scripts/changed-area-classifier.sh', '--json', '--base', ancestor], { cwd: repo, encoding: 'utf8', env: gitEnv }));
      expect(result.flags).toMatchObject({ impactResolved: false, docsOnly: false, migration: true, pythonEngine: true });
      expect(result.vitest.mode).toBe('full');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
