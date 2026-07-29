import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDeletedTests } from '../../scripts/test-cleanup-classifier.mjs';
import { assertResolvedChangeImpact } from '../../scripts/lib/changed-area-classifier.mjs';
import {
  classifyTestGroups,
  loadTestGroups,
  resolveRetirementMapping,
  validateRetirementMapping,
} from '../../scripts/lib/test-groups.mjs';
import {
  gitNameStatusDiffArgs,
  gitNameStatusRecordsToChanges,
  parseGitNameStatusRecordsZ,
} from '../../scripts/lib/git-changed-paths.mjs';

const RETIREMENT_BASE_SHA = '7b724f185580b18ce722a396b6e01d5ae268d3c1';
const PHASE4A_RETIREMENT_BASE_SHA = '247ac7dc940009aacb0d1419a58db4749a76c75a';

function classify(files: string[]) {
  return JSON.parse(execFileSync('bash', [
    'scripts/changed-area-classifier.sh',
    '--json',
    '--files',
    files.join(','),
  ], { encoding: 'utf8' }));
}

describe('lean changed-area classification', () => {
  it.each([
    ['src/api/auth-middleware.ts', 'platform-security'],
    ['src/services/apple-token-revocation.ts', 'platform-security'],
    ['__tests__/services/apple-token-revocation.test.ts', 'platform-security'],
    ['src/services/chat-answer-contract.ts', 'chat-secretary'],
    ['src/services/training-plans.ts', 'training'],
    ['src/services/google-calendar.ts', 'calendar-health'],
    ['src/services/content-workflow.ts', 'content'],
    ['src/services/invoice-filer.ts', 'finance-billing'],
    ['__tests__/services/apple-subscription-lifecycle.test.ts', 'finance-billing'],
    ['src/services/notification-orchestrator.ts', 'tasks-notifications'],
    ['src/services/gemini-provider.ts', 'providers-integrations'],
    ['src/portal/server.ts', 'portal-skills'],
    ['prompts/secretary.md', 'chat-secretary'],
    ['catalog/training/exercise-media/v1/manifest.json', 'training'],
    ['ecosystem.release.config.js', 'release-ops'],
    ['scripts/risk-gate.sh', 'release-ops'],
    ['content-engine/main.py', 'content-engine'],
    ['migrations/001_initial_schema.sql', 'migrations'],
  ])('maps %s to %s', (file, group) => {
    const result = classify([file]);
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.groups).toContain(group);
    expect(result.flags.fullSuiteTrigger).toBe(false);
  });

  it('maps the protected-main intent routing rollout to chat-secretary', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-groups.json', 'utf8'));
    const files = [
      'src/services/intent-resolution/confidence.ts',
      'src/services/intent-resolution/divergence-shadow.ts',
      'src/services/intent-resolution/intent-resolver.ts',
      'src/services/intent-resolution/manifest-projections.ts',
      'src/services/intent-resolution/manifest-routing-flags.ts',
      'src/services/intent-resolution/routing-domain-map.ts',
      'src/services/intent-resolution/vocabulary.ts',
      'src/services/routing-accuracy.ts',
      'src/services/routing-corpus.ts',
      '__tests__/services/intent-resolution/confidence.test.ts',
      '__tests__/services/intent-resolution/intent-resolver.test.ts',
      '__tests__/services/intent-resolution/manifest-projections.test.ts',
      '__tests__/services/intent-resolution/manifest-routing-flags.test.ts',
      '__tests__/services/intent-resolution/manifest-routing-parity.test.ts',
      '__tests__/services/intent-resolution/manifest-routing-safety-ownership.test.ts',
      '__tests__/services/intent-resolution/routing-domain-map.test.ts',
      '__tests__/services/intent-resolution/vocabulary-parity.test.ts',
      '__tests__/services/routing-corpus.test.ts',
    ];

    for (const file of files) {
      expect(classifyTestGroups([file], policy), file).toEqual({
        groups: ['chat-secretary'],
        unmapped: [],
      });
    }
  });

  it('skips Vitest for a docs-only change', () => {
    expect(classify(['docs/testing.md']).vitest).toMatchObject({
      mode: 'skip',
      groups: [],
      skipReason: 'docs-only diff',
    });
  });

  it('keeps Python and migration safety flags independent from Vitest selection', () => {
    const python = classify(['content-engine/main.py']);
    expect(python.flags.pythonEngine).toBe(true);
    expect(python.pytest.globs).toContain('content-engine/tests');
    expect(python.vitest.groups).toContain('content-engine');

    const irreversible = classify([
      'migrations/200_content_radar_phase0_rollout_guards.sql',
    ]);
    expect(irreversible.flags.migration).toBe(true);
    expect(irreversible.flags.irreversibleMigration).toBe(true);
    expect(irreversible.vitest.groups).toContain('migrations');

    const forwardAndRollback = classify([
      'migrations/233_agent_job_runner_audit.sql',
      'migrations/down/233_agent_job_runner_audit.sql',
    ]);
    expect(forwardAndRollback.flags.migration).toBe(true);
    expect(forwardAndRollback.flags.irreversibleMigration).toBe(false);
  });

  it('fails migration-policy changes closed without widening into a full Vitest run', () => {
    const result = classify(['config/irreversible-migrations.json']);
    expect(result.flags.migration).toBe(true);
    expect(result.flags.irreversibleMigration).toBe(true);
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.groups).toEqual(expect.arrayContaining([
      'migrations',
      'release-ops',
    ]));
  });

  it('keeps migration-governance scripts in the conditional migration gate', () => {
    const result = classify(['scripts/migration-safety-check.mjs']);
    expect(result.flags.migration).toBe(true);
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.groups).toContain('release-ops');
    expect(result.vitest.mode).not.toBe('full');
  });

  it.each([
    ['authentication', ['src/api/auth-middleware.ts'], ['platform-security']],
    ['chat', ['src/api/routes/chat.ts'], ['chat-secretary']],
    ['training', ['src/services/training-plans.ts'], ['training']],
    ['content', ['src/services/content-radar-engine.ts'], ['content']],
    ['billing', ['src/api/routes/billing.ts'], ['finance-billing']],
    ['migration', ['migrations/001_initial_schema.sql'], ['migrations']],
    ['provider', ['src/services/gemini-provider.ts'], ['providers-integrations']],
    ['release', ['scripts/risk-gate.sh'], ['release-ops']],
    [
      'cross-group training/provider',
      ['src/services/training-plans.ts', 'src/services/gemini-provider.ts'],
      ['training', 'providers-integrations'],
    ],
  ])('replays representative historical %s changes without full mode', (_name, files, groups) => {
    const result = classify(files as string[]);
    expect(result.vitest.mode).toBe('focused');
    expect(result.vitest.groups).toEqual(expect.arrayContaining(groups as string[]));
    expect(result.vitest.mode).not.toBe('full');
  });

  it('fails instead of silently selecting all tests for an unmapped source path', () => {
    const result = spawnSync('bash', [
      'scripts/changed-area-classifier.sh',
      '--json',
      '--files',
      'src/new-unowned-area.ts',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Test-group policy has no owner');
    expect(result.stderr).toContain('config/test-groups.json');
  });

  it('fails closed when Git cannot resolve changed-file impact from an ancestor', () => {
    expect(() => assertResolvedChangeImpact(false, 'non-ancestor-sha')).toThrow(
      /base 'non-ancestor-sha' is not an ancestor of HEAD.*full-suite fallback is intentionally disabled/,
    );
    expect(() => assertResolvedChangeImpact(true, 'ancestor-sha')).not.toThrow();
  });

  it('fails a new test that has no explicit or source-derived owner group', () => {
    const result = spawnSync('bash', [
      'scripts/changed-area-classifier.sh',
      '--json',
      '--files',
      '__tests__/unknown/new-product-surface.test.ts',
    ], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Test-group policy has no owner');
  });

  it('maps changed paths and reports unmapped production owners without a full fallback', () => {
    const policy = {
      groups: {
        content: {
          paths: ['src/services/content-*.ts'],
          tests: ['__tests__/services/content-*.test.ts'],
        },
      },
    };
    expect(classifyTestGroups([
      'src/services/content-workflow.ts',
      'src/services/new-unowned-area.ts',
      'docs/testing.md',
    ], policy)).toEqual({
      groups: ['content'],
      unmapped: ['src/services/new-unowned-area.ts'],
    });
  });

  it('selects core, group contracts, and static dependents without a critical union', () => {
    const classifier = classify(['src/services/content-radar-engine.ts']);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-test-groups-'));
    const classifierPath = path.join(directory, 'classifier.json');
    fs.writeFileSync(classifierPath, JSON.stringify(classifier));
    try {
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const selection = JSON.parse(execFileSync(process.execPath, [
        'scripts/select-vitest-files.mjs',
        '--base',
        base,
        '--classifier',
        classifierPath,
        '--source-root',
        process.env.NEXUS_MUTATION_SOURCE_ROOT ?? path.resolve('.'),
        '--json',
      ], { encoding: 'utf8' }));
      expect(selection.schema).toBe('nexus.test-selection.v2');
      expect(selection.groups).toEqual(['content']);
      expect(selection.core).toContain('__tests__/services/tenant-scope.test.ts');
      expect(selection.contracts).toContain('__tests__/services/content-tenant-scope.test.ts');
      expect(selection).not.toHaveProperty('critical');
      expect(selection.groupTests).toContain('__tests__/services/content-tenant-scope.test.ts');
      expect(selection.dependents).toContain('__tests__/services/content-radar-engine.test.ts');
      expect(selection.selected.length).toBeLessThan(300);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires an explicit replacement mapping even when a test and owner are removed together', () => {
    const sources = new Map([
      ['__tests__/scripts/retired.test.ts', "import '../../scripts/retired.mjs';\n"],
      ['scripts/retired.mjs', 'export const retired = true;\n'],
      ['__tests__/services/surviving.test.ts', "import '../../src/services/surviving.js';\n"],
      ['src/services/surviving.js', 'export const surviving = true;\n'],
    ]);
    const result = classifyDeletedTests([
      { status: 'D', paths: ['__tests__/scripts/retired.test.ts'] },
      { status: 'D', paths: ['scripts/retired.mjs'] },
    ], (file) => sources.get(file) ?? '');
    expect(result.requiresMutation).toBe(true);
    expect(result.tests[0]).toMatchObject({
      retiredWithOwner: false,
      requiresMutation: true,
    });

    const surviving = classifyDeletedTests([
      { status: 'D', paths: ['__tests__/services/surviving.test.ts'] },
    ], (file) => sources.get(file) ?? '');
    expect(surviving.requiresMutation).toBe(true);
  });

  it('binds the real retirement policy to exact baselines and explicit behavior ownership', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-groups.json', 'utf8'));
    expect(policy.retirementMappings.length).toBeGreaterThan(0);
    expect(new Set(policy.retirementMappings.map(
      (mapping: { baseSha?: string }) => mapping.baseSha,
    ))).toEqual(new Set([
      RETIREMENT_BASE_SHA,
      PHASE4A_RETIREMENT_BASE_SHA,
    ]));

    const artifactTest = '__tests__/scripts/release-artifact-manifest.test.ts';
    const matches = policy.retirementMappings.filter((mapping: {
      test?: string;
      tests?: string[];
    }) => mapping.test === artifactTest || mapping.tests?.includes(artifactTest));
    expect(matches).toEqual([expect.objectContaining({
      test: artifactTest,
      baselineOwnerPaths: ['scripts/release-evidence.mjs'],
      requiredRemovedPaths: ['scripts/release-evidence.mjs'],
    })]);

    const phase4aRetirementTests = [
      '__tests__/scripts/chatv2-import-legacy-parity-labels.test.ts',
      '__tests__/scripts/chatv2-import-legacy-parity-observations.test.ts',
      '__tests__/services/chat-answer-contract.test.ts',
      '__tests__/services/chat-core-v2-locale-policy.test.ts',
      '__tests__/services/chat-core-v2-unsupported-policy.test.ts',
      '__tests__/services/chat-day-to-day-simulation.test.ts',
      '__tests__/services/chat-legacy-retirement-evidence.test.ts',
      '__tests__/services/chat-turn-context.test.ts',
      '__tests__/services/registry-examples-as-living-corpus-shadow.test.ts',
      '__tests__/services/registry-examples-end-to-end-routing.test.ts',
      '__tests__/services/registry-real-eval-gates-locale.test.ts',
      '__tests__/services/registry-shadow-smoke-corpus.test.ts',
      '__tests__/services/routing-corpus.test.ts',
    ];
    const phase4aMappings = policy.retirementMappings.filter((mapping: {
      baseSha?: string;
    }) => mapping.baseSha === PHASE4A_RETIREMENT_BASE_SHA);
    expect(phase4aMappings.map((mapping: { test?: string }) => mapping.test).sort())
      .toEqual(phase4aRetirementTests.sort());
    const registryRoutingMappings = new Set([
      '__tests__/services/registry-examples-as-living-corpus-shadow.test.ts',
      '__tests__/services/registry-examples-end-to-end-routing.test.ts',
      '__tests__/services/registry-real-eval-gates-locale.test.ts',
      '__tests__/services/registry-shadow-smoke-corpus.test.ts',
    ]);
    const parityEvidenceMappings = new Set([
      '__tests__/scripts/chatv2-import-legacy-parity-labels.test.ts',
      '__tests__/scripts/chatv2-import-legacy-parity-observations.test.ts',
      '__tests__/services/chat-legacy-retirement-evidence.test.ts',
    ]);
    for (const mapping of phase4aMappings) {
      expect(mapping.requiredChangedPaths.length).toBeGreaterThan(0);
      expect(mapping.replacementTests).toContain(mapping.test);
      expect(mapping.replacementTests).toContain(
        registryRoutingMappings.has(mapping.test)
          ? '__tests__/services/registry-examples-end-to-end-routing.test.ts'
          : parityEvidenceMappings.has(mapping.test)
            ? '__tests__/services/chat-legacy-parity-labels.test.ts'
            : '__tests__/services/chat-locale-detection-es.test.ts',
      );
    }
  });

  it('detects assertion removal inside a surviving modified test file', () => {
    const testFile = '__tests__/services/modified-contract.test.ts';
    const previous = `
      import '../../src/services/content-workflow';
      it('keeps both guarantees', () => {
        expect(result.owner).toBe('user');
        expect(result.status).toBe('ready');
      });
    `;
    const current = `
      import '../../src/services/content-workflow';
      it('keeps one guarantee', () => {
        expect(result.status).toBe('ready');
      });
    `;
    const result = classifyDeletedTests(
      [{ status: 'M', paths: [testFile] }],
      (file) => file === testFile ? previous : '',
      [],
      () => true,
      (file) => file === testFile ? current : '',
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests).toEqual([
      expect.objectContaining({
        file: testFile,
        currentFile: testFile,
        status: 'M',
        requiresMutation: true,
      }),
    ]);
  });

  it('requires explicit cleanup evidence for a pure rename', () => {
    const previousTest = '__tests__/scripts/legacy-contract.test.ts';
    const currentTest = '__tests__/scripts/renamed-contract.test.ts';
    const source = "it('keeps behavior', () => expect(status).toBe('ready'));";
    const result = classifyDeletedTests(
      [{ status: 'R100', paths: [previousTest, currentTest] }],
      (file) => file === previousTest ? source : '',
      [],
      (file) => file === currentTest,
      (file) => file === currentTest ? source : '',
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests).toEqual([expect.objectContaining({
      file: previousTest,
      currentFile: currentTest,
      status: 'R100',
      requiresMutation: true,
      retiredWithOwner: false,
    })]);
    const policy = JSON.parse(fs.readFileSync('config/test-groups.json', 'utf8'));
    expect(classifyTestGroups([previousTest, currentTest], policy)).toEqual({
      groups: ['release-ops'],
      unmapped: [],
    });
  });

  it('keeps assertion-removing renames fail-closed without exact retirement', () => {
    const previousTest = '__tests__/scripts/legacy-contract.test.ts';
    const currentTest = '__tests__/scripts/renamed-contract.test.ts';
    const result = classifyDeletedTests(
      [{ status: 'R090', paths: [previousTest, currentTest] }],
      (file) => file === previousTest
        ? "it('keeps behavior', () => { expect(owner).toBe('user'); expect(status).toBe('ready'); });"
        : '',
      [],
      (file) => file === currentTest,
      (file) => file === currentTest
        ? "it('keeps behavior', () => expect(status).toBe('ready'));"
        : '',
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests[0]).toMatchObject({
      file: previousTest,
      currentFile: currentTest,
      requiresMutation: true,
    });
  });

  it('does not treat the previous side of a rename as a removed retirement owner', () => {
    const previousTest = '__tests__/scripts/legacy-contract.test.ts';
    const currentTest = '__tests__/scripts/renamed-contract.test.ts';
    const source = "it('keeps behavior', () => expect(status).toBe('ready'));";
    const result = classifyDeletedTests(
      [{ status: 'R100', paths: [previousTest, currentTest] }],
      (file) => file === previousTest ? source : '',
      [{
        baseSha: RETIREMENT_BASE_SHA,
        test: previousTest,
        requiredRemovedPaths: [previousTest],
        replacementTests: [currentTest],
        reason: 'A rename alone must not masquerade as an exact owner retirement.',
      }],
      (file) => file === currentTest,
      (file) => file === currentTest ? source : '',
      RETIREMENT_BASE_SHA,
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests[0]).toMatchObject({
      retiredWithOwner: false,
      requiresMutation: true,
    });
  });

  it('binds grouped retirement ownership to baseline test source only', () => {
    const testFile = '__tests__/scripts/legacy-release.test.ts';
    const retiredOwner = 'scripts/retired-release.mjs';
    const replacement = '__tests__/scripts/lean-release-path.test.ts';
    const previous = `
      import '../../scripts/live-release.mjs';
      it('keeps both guarantees', () => {
        expect(owner).toBe('user');
        expect(status).toBe('ready');
      });
    `;
    const current = `
      import '../../scripts/retired-release.mjs';
      it('keeps one guarantee', () => expect(status).toBe('ready'));
    `;
    const result = classifyDeletedTests(
      [
        { status: 'M', paths: [testFile] },
        { status: 'D', paths: [retiredOwner] },
      ],
      (file) => file === testFile ? previous : '',
      [{
        baseSha: RETIREMENT_BASE_SHA,
        testPatterns: ['__tests__/scripts/*-release.test.ts'],
        requiredRemovedPaths: [retiredOwner],
        replacementTests: [replacement],
        reason: 'Only baseline ownership can authorize this grouped retirement mapping.',
      }],
      (file) => file === testFile || file === replacement,
      (file) => file === testFile ? current : '',
      RETIREMENT_BASE_SHA,
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests[0]).toMatchObject({
      retiredWithOwner: false,
      requiresMutation: true,
    });
  });

  it('accepts a modified-test retirement only when its exact machinery change and replacement exist', () => {
    const testFile = '__tests__/scripts/legacy-contract.test.ts';
    const machinery = 'scripts/legacy-contract.mjs';
    const replacement = '__tests__/scripts/lean-contract.test.ts';
    const previous = "it('old behavior', () => { expect(oldPath()).toBe(true); expect(owner()).toBe('user'); });";
    const current = "it('replacement behavior', () => { expect(newPath()).toBe(true); });";
    const mapping = {
      baseSha: RETIREMENT_BASE_SHA,
      test: testFile,
      requiredChangedPaths: [machinery],
      replacementTests: [replacement],
      reason: 'The modified legacy implementation is replaced by the retained lean contract.',
    };
    const readAtBase = (file: string) => file === testFile ? previous : '';
    const readCurrent = (file: string) => file === testFile ? current : '';
    const exists = (file: string) => file === testFile || file === replacement || file === machinery;

    const approved = classifyDeletedTests(
      [
        { status: 'M', paths: [testFile] },
        { status: 'M', paths: [machinery] },
      ],
      readAtBase,
      [mapping],
      exists,
      readCurrent,
      RETIREMENT_BASE_SHA,
    );
    expect(approved.requiresMutation).toBe(false);
    expect(approved.tests[0].retirement).toMatchObject({
      replacementTests: [replacement],
    });

    const unrelated = classifyDeletedTests(
      [{ status: 'M', paths: [testFile] }],
      readAtBase,
      [mapping],
      exists,
      readCurrent,
      RETIREMENT_BASE_SHA,
    );
    expect(unrelated.requiresMutation).toBe(true);
  });

  it('fails mixed live ownership closed unless an explicit retirement mapping applies', () => {
    const testFile = '__tests__/scripts/legacy-release.test.ts';
    const sources = new Map([
      [testFile, "import '../../scripts/retired.mjs';\nimport '../../scripts/live.mjs';\n"],
      ['scripts/retired.mjs', 'export const retired = true;\n'],
      ['scripts/live.mjs', 'export const live = true;\n'],
    ]);
    const records = [
      { status: 'D', paths: [testFile] },
      { status: 'D', paths: ['scripts/retired.mjs'] },
    ];
    const strict = classifyDeletedTests(records, (file) => sources.get(file) ?? '');
    expect(strict.requiresMutation).toBe(true);

    const approvedRetirement = classifyDeletedTests(
      records,
      (file) => sources.get(file) ?? '',
      [{
        baseSha: RETIREMENT_BASE_SHA,
        testPatterns: [testFile],
        requiredRemovedPaths: ['scripts/retired.mjs', 'scripts/retired.*'],
        replacementTests: ['__tests__/scripts/lean-release-path.test.ts'],
        reason: 'The retired path is replaced by the lean release contract.',
      }],
      (file) => file === '__tests__/scripts/lean-release-path.test.ts',
      undefined,
      RETIREMENT_BASE_SHA,
    );
    expect(approvedRetirement.requiresMutation).toBe(false);
    expect(approvedRetirement.tests[0].retirement).toMatchObject({
      replacementTests: ['__tests__/scripts/lean-release-path.test.ts'],
    });

    const partialRetirement = classifyDeletedTests(
      records,
      (file) => sources.get(file) ?? '',
      [{
        baseSha: RETIREMENT_BASE_SHA,
        test: testFile,
        requiredRemovedPaths: ['scripts/retired.mjs', 'scripts/not-removed.mjs'],
        replacementTests: ['__tests__/scripts/lean-release-path.test.ts'],
        reason: 'Incomplete retirement must not be accepted.',
      }],
      () => true,
      undefined,
      RETIREMENT_BASE_SHA,
    );
    expect(partialRetirement.requiresMutation).toBe(true);

    const missingReplacement = classifyDeletedTests(
      records,
      (file) => sources.get(file) ?? '',
      [{
        baseSha: RETIREMENT_BASE_SHA,
        test: testFile,
        requiredRemovedPaths: ['scripts/retired.mjs'],
        replacementTests: ['__tests__/scripts/missing-replacement.test.ts'],
        reason: 'Missing replacement must not be accepted.',
      }],
      () => false,
      undefined,
      RETIREMENT_BASE_SHA,
    );
    expect(missingReplacement.requiresMutation).toBe(true);
  });

  it('does not let a broad retirement bucket exempt a test with an unrelated owner', () => {
    const testFile = '__tests__/scripts/unrelated-release.test.ts';
    const result = classifyDeletedTests(
      [
        { status: 'D', paths: [testFile] },
        { status: 'D', paths: ['scripts/retired-release.mjs'] },
      ],
      (file) => file === testFile ? "import '../../scripts/live-release.mjs';" : '',
      [{
        baseSha: RETIREMENT_BASE_SHA,
        testPatterns: ['__tests__/scripts/*-release.test.ts'],
        requiredRemovedPaths: ['scripts/retired-release.mjs'],
        replacementTests: ['__tests__/scripts/lean-release-path.test.ts'],
        reason: 'Only tests owned by the retired release script may use this broad retirement.',
      }],
      (file) => file === '__tests__/scripts/lean-release-path.test.ts',
      undefined,
      RETIREMENT_BASE_SHA,
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests[0]).toMatchObject({
      retiredWithOwner: false,
      requiresMutation: true,
    });
  });

  it('rejects unsafe policy paths and ambiguous retirement matches', () => {
    const baseMapping = {
      baseSha: RETIREMENT_BASE_SHA,
      test: '__tests__/scripts/legacy.test.ts',
      requiredRemovedPaths: ['scripts/legacy.mjs'],
      replacementTests: ['__tests__/scripts/lean.test.ts'],
      reason: 'The exact lean test replaces the exact retired implementation behavior.',
    };
    expect(validateRetirementMapping({
      ...baseMapping,
      replacementTests: ['../../outside.test.ts'],
    })).toContain('invalid retirement replacement test: ../../outside.test.ts');
    expect(validateRetirementMapping({
      ...baseMapping,
      requiredRemovedPaths: ['/etc/passwd'],
    })).toContain('invalid retirement owner path pattern: /etc/passwd');
    expect(validateRetirementMapping({
      ...baseMapping,
      test: '__tests__\\scripts\\legacy.test.ts',
    })).toContain('invalid exact retirement test path: __tests__\\scripts\\legacy.test.ts');

    expect(() => resolveRetirementMapping({
      baseSha: RETIREMENT_BASE_SHA,
      testFile: baseMapping.test,
      mappings: [
        baseMapping,
        {
          ...baseMapping,
          testPatterns: [baseMapping.test],
          test: undefined,
        },
      ],
      removedPaths: ['scripts/legacy.mjs'],
      existsCurrent: () => true,
    })).toThrow(/ambiguous retirement mappings/);
  });

  it('rejects unsafe group keys before they can reach workflow outputs', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-unsafe-group-'));
    fs.mkdirSync(path.join(directory, 'config'));
    fs.writeFileSync(path.join(directory, 'config/test-groups.json'), JSON.stringify({
      core: { tests: ['__tests__/services/safe.test.ts'] },
      groups: {
        'safe\noutput=true': {
          paths: ['src/services/safe.ts'],
          tests: ['__tests__/services/safe.test.ts'],
          contracts: ['__tests__/services/safe.test.ts'],
        },
      },
    }));
    try {
      expect(() => loadTestGroups(directory)).toThrow(/invalid test-group key/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses NUL-safe rename records into the shared triple-dot change model', () => {
    const records = parseGitNameStatusRecordsZ(
      'R100\0__tests__/old name.test.ts\0__tests__/new\nname.test.ts\0M\0scripts/gate.mjs\0',
    );
    expect(gitNameStatusRecordsToChanges(records)).toEqual([
      {
        status: 'R100',
        file: '__tests__/new\nname.test.ts',
        previous: '__tests__/old name.test.ts',
      },
      {
        status: 'M',
        file: 'scripts/gate.mjs',
        previous: null,
      },
    ]);
    expect(gitNameStatusDiffArgs('a'.repeat(40))).toEqual([
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      `${'a'.repeat(40)}...HEAD`,
    ]);
  });
});
