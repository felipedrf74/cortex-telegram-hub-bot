// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CROSS_SKILL_SMOKE_RESULTS_PATH,
  evaluatePhase7CrossSkillFlagContract,
  evaluateCrossSkillSmokePrerequisites,
  renderCrossSkillSmokeReportMarkdown,
  runLocalFixtureSmoke,
  runTrainingCrossSkillStagingSmoke,
} from '../../src/tools/training-cross-skill-staging-smoke';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STAGING: 'true',
    TRAINING_CROSS_SKILL_STAGING_SMOKE: '1',
    TRAINING_CROSS_SKILL_STAGING_USER_ID: '42',
    DATABASE_PATH: '/tmp/nexus-staging.db',
    AI_CROSS_SKILL_EXECUTION: 'true',
    AI_ROUTING_MANIFEST_KILL: 'false',
    NEXUS_RELEASE_ROLE: 'staging',
    NEXUS_RELEASE_SHA: 'a'.repeat(40),
    NEXUS_RELEASE_ARTIFACT_SHA256: 'b'.repeat(64),
    ...overrides,
  };
}

describe('training cross-skill staging smoke harness', () => {
  it('keeps its default mutable result under ignored local release evidence', () => {
    expect(DEFAULT_CROSS_SKILL_SMOKE_RESULTS_PATH).toBe(
      '.local/release/smoke-evidence/training-cross-skill-staging-latest.md',
    );
  });

  it('blocks staging reads unless explicit staging guardrails are present', () => {
    const report = evaluateCrossSkillSmokePrerequisites({});

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('STAGING=true or NODE_ENV=staging');
    expect(report.missing).toContain('TRAINING_CROSS_SKILL_STAGING_SMOKE=1');
    expect(report.missing).toContain('TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id>');
  });

  it('refuses production mode even if other staging flags are present', () => {
    const report = evaluateCrossSkillSmokePrerequisites(env({
      NODE_ENV: 'production',
      STAGING: 'true',
    }));

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('NODE_ENV must not be production');
  });

  it('requires the Phase 7 cross-skill flag to be effectively on', () => {
    const disabled = evaluateCrossSkillSmokePrerequisites(env({
      AI_CROSS_SKILL_EXECUTION: 'false',
    }));
    const killed = evaluateCrossSkillSmokePrerequisites(env({
      AI_ROUTING_MANIFEST_KILL: 'true',
    }));

    expect(disabled.ok).toBe(false);
    expect(disabled.missing).toContain('AI_CROSS_SKILL_EXECUTION=true');
    expect(killed.ok).toBe(false);
    expect(killed.missing).toContain('AI_ROUTING_MANIFEST_KILL must be false/unset');
  });

  it('requires an exact staging runtime and artifact identity', () => {
    const report = evaluateCrossSkillSmokePrerequisites(env({
      NEXUS_RELEASE_ROLE: 'production',
      NEXUS_RELEASE_SHA: 'abc123',
      NEXUS_RELEASE_ARTIFACT_SHA256: 'not-a-digest',
    }));

    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining([
      'NEXUS_RELEASE_ROLE=staging',
      'NEXUS_RELEASE_SHA=<full lowercase 40-hex SHA>',
      'NEXUS_RELEASE_ARTIFACT_SHA256=<full lowercase 64-hex digest>',
    ]));
  });

  it('proves the real flag-on ownership, grouped preview, decline, and executor confirmation paths', async () => {
    const operation = await evaluatePhase7CrossSkillFlagContract(env());

    expect(operation).toMatchObject({
      flow: 'phase7_cross_skill_flag_contract',
      status: 'pass',
    });
    expect(operation.evidence).toEqual(expect.arrayContaining([
      'AI_CROSS_SKILL_EXECUTION=enabled',
      'AI_ROUTING_MANIFEST_KILL=off',
      'training_plan_create.outputRefs=absent',
      'ownership=tasks.add_subtasks_to_task->secretary_calendar.schedule_event',
      'groupedPreview=training+secretary_calendar',
      'declineBoundary=flag-on-only',
      'executorConfirmation=needs_confirmation;executedActions=0',
      'executionGuards=dependencyAccesses:0;executorAccesses:0',
      'scope=user:42;tenant:42',
    ]));
  });

  it('keeps the dry-run receipt marked non-evidentiary and refusals off the blocked-by-design code', () => {
    const wrapper = fs.readFileSync(
      path.resolve('scripts/training-cross-skill-staging-smoke.sh'),
      'utf8',
    );

    expect(wrapper).toContain('GUARD_REFUSAL_EXIT=3');
    expect(wrapper).toContain('export NEXUS_SMOKE_NON_EVIDENTIARY=1');
    // Every refusal has to route through the distinct code; a bare `exit 2`
    // would be read as "blocked by design" by the aggregating callers.
    expect(wrapper).not.toMatch(/^\s*exit 2$/m);
  });

  it('binds the wrapper to verified candidate bytes and never reuses stale dist', () => {
    const wrapper = fs.readFileSync(
      path.resolve('scripts/training-cross-skill-staging-smoke.sh'),
      'utf8',
    );
    const artifactManifest = fs.readFileSync(
      path.resolve('scripts/lib/release-artifact-manifest.mjs'),
      'utf8',
    );

    expect(wrapper).not.toContain('if [ ! -f dist/tools/training-cross-skill-staging-smoke.js ]');
    expect(wrapper).toContain('--verify-installed-source "$ROOT_DIR"');
    expect(wrapper).toContain('--require-declared-file dist/tools/training-cross-skill-staging-smoke.js');
    expect(wrapper).toContain('nexus.release-installed-source-verification.v1');
    expect(wrapper).toContain('npm run build');
    expect(wrapper).toContain('NEXUS_RELEASE_SHA="$VERIFIED_RUNTIME_SHA"');
    expect(wrapper).toContain('NEXUS_RELEASE_ARTIFACT_SHA256="$VERIFIED_ARTIFACT_DIGEST"');
    expect(artifactManifest).toContain("'scripts/training-cross-skill-staging-smoke.sh'");
    expect(artifactManifest).toContain("'scripts/with-smoke-evidence.sh'");
  });

  it('passes local fixture contracts for Secretary, Cooking, Finance, Content, and milestone flow', () => {
    const operations = runLocalFixtureSmoke();

    expect(operations).toHaveLength(6);
    expect(operations.every((operation) => operation.status === 'pass')).toBe(true);
    expect(operations.map((operation) => operation.flow)).toEqual([
      'local_fixture_contracts',
      'secretary_conflict',
      'cooking_fueling_gap',
      'finance_budget_constraint',
      'content_workload',
      'training_content_milestone',
    ]);
  });

  it('does not fake staging success when prerequisites are missing', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      runId: 'run-missing-prereqs',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: {},
    });

    expect(report.localFixtureOperations.every((operation) => operation.status === 'pass')).toBe(true);
    expect(report.operations).toEqual([
      expect.objectContaining({
        flow: 'staging_prerequisites',
        status: 'blocked',
      }),
    ]);
  });

  it('does not fake staging success in dry-run mode', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-dry',
      dryRun: true,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    });

    expect(report.operations).toEqual([
      expect.objectContaining({
        flow: 'staging_prerequisites',
        status: 'blocked',
        actual: expect.stringContaining('dry run requested'),
      }),
    ]);

    const markdown = renderCrossSkillSmokeReportMarkdown(report);
    expect(markdown).toContain('this was a dry run');
    expect(markdown).not.toContain('All requested staging runtime flows passed.');
  });

  it('renders blocked staging separately from local fixture passes', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-render',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: {},
    });

    const markdown = renderCrossSkillSmokeReportMarkdown(report);

    expect(markdown).toContain('## Local Fixture Contract Checks');
    expect(markdown).toContain('## Staging Runtime Checks');
    expect(markdown).toContain('Real staging validation was **not** run');
    expect(markdown).toContain('staging_prerequisites');
  });

  it('blocks runtime flows when staging user lacks required cross-skill fixture data', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-empty-runtime',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, buildRuntimeReader({
      secretarySignals: [],
      cookingSignals: [],
      financeSignals: [],
      contentSignals: [],
      trainingSignals: [],
      sharedDecisionContext: [
        'Secretary: context shell present.',
        'Cooking: context shell present.',
        'Finance: context shell present.',
        'Content: context shell present.',
      ].join('\n'),
    }));

    const runtime = Object.fromEntries(report.operations.map((operation) => [operation.flow, operation.status]));

    expect(runtime.secretary_conflict).toBe('blocked');
    expect(runtime.cooking_fueling_gap).toBe('blocked');
    expect(runtime.finance_budget_constraint).toBe('blocked');
    expect(runtime.content_workload).toBe('blocked');
    expect(runtime.shared_context_scope).toBe('pass');
  });

  it('passes runtime flows only when scoped staging fixture signals are present and deduped', async () => {
    const report = await runTrainingCrossSkillStagingSmoke({
      userId: 42,
      runId: 'run-rich-runtime',
      dryRun: false,
      now: new Date('2026-05-01T08:00:00.000Z'),
      env: env(),
    }, buildRuntimeReader({
      secretarySignals: [signal('calendar_busy_blocks', { dates: ['2026-05-05'] }), signal('travel_window', { dates: ['2026-05-08'] })],
      cookingSignals: [signal('fueling_support_status', { status: 'at_risk' })],
      financeSignals: [signal('budget_remaining', { budgetMode: 'tight', trainingSpendMode: 'selective' })],
      contentSignals: [signal('publishing_commitment', { nextDate: '2026-05-07' })],
      trainingSignals: [signal('content_capture_opportunity', { title: 'Travel-week training win' })],
      sharedDecisionContext: [
        'Secretary: travel, focus, and admin constraints are active.',
        'Cooking: hard-session fueling is missing on 2026-05-05.',
        'Finance: budget mode is tight and training spend is selective.',
        'Content: filming window is Thursday 10:00-12:00.',
      ].join('\n'),
    }));

    const statuses = report.operations.map((operation) => operation.status);

    expect(statuses).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(report.operations[0]?.flow).toBe('phase7_cross_skill_flag_contract');
    expect(report.releaseIdentity).toEqual({
      environment: 'staging',
      runtimeSha: 'a'.repeat(40),
      artifactDigest: 'b'.repeat(64),
    });
    expect(renderCrossSkillSmokeReportMarkdown(report)).toContain(`Runtime SHA: \`${'a'.repeat(40)}\``);
  });
});

describe('training cross-skill staging smoke shell wrapper', () => {
  const wrapperRoots: string[] = [];

  afterEach(() => {
    while (wrapperRoots.length > 0) {
      fs.rmSync(wrapperRoots.pop()!, { recursive: true, force: true });
    }
  });

  /** Fixture root holding only the wrapper, so guards run before any build. */
  function wrapperFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cross-skill-wrapper-'));
    wrapperRoots.push(root);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.resolve('scripts/training-cross-skill-staging-smoke.sh'),
      path.join(root, 'scripts/training-cross-skill-staging-smoke.sh'),
    );
    return root;
  }

  /** Operator-shaped environment: no inherited release identity variables. */
  function wrapperEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(base)) {
      if (key.startsWith('NEXUS_') || key.startsWith('TRAINING_CROSS_SKILL_')) delete base[key];
    }
    return { ...base, ...overrides };
  }

  function runWrapper(root: string, args: string[], env: NodeJS.ProcessEnv) {
    return spawnSync(
      'bash',
      [path.join(root, 'scripts/training-cross-skill-staging-smoke.sh'), ...args],
      { cwd: root, encoding: 'utf8', env },
    );
  }

  it('refuses a production release role at the shell level before building anything', () => {
    const root = wrapperFixture();
    const result = runWrapper(root, ['--dry-run'], wrapperEnv({ NEXUS_RELEASE_ROLE: 'production' }));

    expect(result.status).toBe(3);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain('staging-only');
    expect(result.stdout).not.toContain('Building current source');
  });

  it('refuses staging proof from a source checkout with a hard-failure exit code', () => {
    const root = wrapperFixture();
    const result = runWrapper(root, [], wrapperEnv());

    // 3, not 2: callers treat 2 as an intentional by-design block, which would
    // silently turn this refusal into a green leg.
    expect(result.status).toBe(3);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain('Refusing staging proof outside an installed release');
  });

  it('refuses an installed release without a release base dir using the hard-failure code', () => {
    const root = wrapperFixture();
    fs.writeFileSync(path.join(root, '.complete.json'), '{"schema":"nexus.release-bundle.v1"}\n');
    const result = runWrapper(root, [], wrapperEnv());

    expect(result.status).toBe(3);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain('NEXUS_RELEASE_BASE_DIR is required');
  });

  it('does not let a failed source build inherit the compiler blocked-by-design code', () => {
    const root = wrapperFixture();
    // tsc exits 2 on compile errors, which is exactly the code callers treat as
    // an intentional block — the wrapper has to translate it into a refusal.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'nexus-build-failure-fixture', version: '1.0.0', private: true, scripts: { build: 'exit 2' } }, null, 2)}\n`,
    );
    const result = runWrapper(root, ['--dry-run'], wrapperEnv());

    expect(result.status).toBe(3);
    expect(result.status).not.toBe(2);
    expect(result.stderr).toContain('source build failed before the dry-run');
  }, 30000);

  it('keeps a source-checkout dry-run blocked by design and its receipt non-evidentiary', () => {
    const root = wrapperFixture();
    for (const directory of ['dist/tools', 'scripts/lib', 'config', 'migrations', 'prompts']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: 'nexus-dry-run-fixture', version: '1.0.0', private: true, scripts: { build: 'true' } }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(root, 'config/capability-manifest.json'), '{"schemaReferences":{}}\n');
    fs.writeFileSync(path.join(root, 'migrations/001_init.sql'), 'SELECT 1;\n');
    fs.writeFileSync(path.join(root, 'prompts/base.md'), 'prompt\n');
    fs.writeFileSync(
      path.join(root, 'dist/tools/training-cross-skill-staging-smoke.js'),
      [
        'if (process.env.NEXUS_SMOKE_NON_EVIDENTIARY !== "1") process.exit(9);',
        'if (!/^[0-9a-f]{40}$/.test(process.env.NEXUS_RELEASE_SHA || "")) process.exit(8);',
        'if (!/^[0-9a-f]{64}$/.test(process.env.NEXUS_RELEASE_ARTIFACT_SHA256 || "")) process.exit(7);',
        'process.stdout.write("dry-run-fixture-smoke\\n");',
        '// Mirrors the real tool: the staging runtime section is blocked by design.',
        'process.exit(2);',
      ].join('\n'),
    );
    for (const relative of [
      'scripts/with-smoke-evidence.sh',
      'scripts/release-artifact-manifest.mjs',
      'scripts/lib/release-artifact-manifest.mjs',
    ]) {
      fs.copyFileSync(path.resolve(relative), path.join(root, relative));
    }
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    };
    expect(spawnSync('git', ['init', '--quiet'], { cwd: root, env: gitEnv }).status).toBe(0);
    expect(spawnSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'fixture'], {
      cwd: root,
      env: gitEnv,
    }).status).toBe(0);

    const result = runWrapper(root, ['--dry-run'], wrapperEnv());

    // Exit 2 is preserved for the by-design block so local callers stay green.
    expect(result.status).toBe(2);
    expect(result.stdout).toContain('dry-run-fixture-smoke');
    const evidenceDir = path.join(root, '.local/release/smoke-evidence');
    const receiptFile = fs.readdirSync(evidenceDir).find((name) => name.endsWith('.json'));
    expect(receiptFile).toMatch(/^nonevidentiary-training-cross-skill-staging-/);
    const receipt = JSON.parse(fs.readFileSync(path.join(evidenceDir, receiptFile!), 'utf8'));
    expect(receipt).toMatchObject({
      smokeName: 'training-cross-skill-staging',
      nonEvidentiary: true,
      verdict: 'blocked',
      exitCode: 2,
    });
  }, 60000);
});

function buildRuntimeReader(opts: {
  secretarySignals: any[];
  cookingSignals: any[];
  financeSignals: any[];
  contentSignals: any[];
  trainingSignals: any[];
  sharedDecisionContext: string;
}) {
  const userId = 42;
  return {
    async readTrainingMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        activePlan: null,
        activeWeek: null,
        sessions: [],
        trainingContext: { signals: [], flags: {} },
        coachBriefing: null,
        adherence: null,
        coachPhaseMemory: null,
        derivedSignals: opts.trainingSignals,
      } as any;
    },
    async readCookingMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        meals: [],
        shoppingList: null,
        derivedSignals: opts.cookingSignals,
      } as any;
    },
    async readFinanceMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        month: '2026-05',
        monthlySummary: {},
        budgetView: { affordability: opts.financeSignals.length > 0 ? 'tight' : 'unknown' },
        taxEvents: [],
        annualSummary: {},
        subscription: {},
        derivedSignals: opts.financeSignals,
      } as any;
    },
    async readContentMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        upcomingTopicCount: opts.contentSignals.length > 0 ? 2 : 0,
        scheduledTopics: [],
        filmingRecommendation: opts.contentSignals.length > 0 ? { date: '2026-05-07' } : null,
        unreadNotifications: [],
        deskItems: [],
        monitoredPillars: [],
        recentSignals: [],
        nextExecution: opts.contentSignals.length > 0 ? { title: 'Training block update' } : null,
        voiceDnaEntries: [],
        knowledgeStats: {},
        derivedSignals: opts.contentSignals,
      } as any;
    },
    async readSecretaryMeshContext() {
      return {
        userId,
        weekStart: '2026-05-04',
        weekEnd: '2026-05-10',
        events: opts.secretarySignals.length > 0 ? [{ id: 'busy-1', title: 'Board review' }] : [],
        focusBlock: opts.secretarySignals.length > 0 ? { date: '2026-05-06' } : null,
        dueToday: [],
        dueThisWeek: [],
        overdue: [],
        pending: [],
        writableCalendar: true,
        mailPressure: null,
        derivedSignals: opts.secretarySignals,
      } as any;
    },
    async buildSharedDecisionContext() {
      return opts.sharedDecisionContext;
    },
    async buildSharedDecisionContracts() {
      return {
        secretary: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
        cooking: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
        finance: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
        content: { nonNegotiables: [], preferredWindows: [], fallbackIfDeferred: [], notes: [] },
      };
    },
  } as any;
}

function signal(signalType: string, payload: Record<string, unknown>) {
  return {
    sourceAgent: `test.${signalType}`,
    signalType,
    meshPriority: 3,
    priority: 'normal',
    payload,
    expiresAt: '2026-05-10T23:59:59.000Z',
  };
}
