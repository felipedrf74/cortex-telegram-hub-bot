import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyDeletedTests } from '../../scripts/test-cleanup-classifier.mjs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const nightly = readFileSync('.github/workflows/nightly.yml', 'utf8');
const mutation = readFileSync('.github/workflows/mutation-weekly.yml', 'utf8');
const security = readFileSync('.github/workflows/security.yml', 'utf8');
const baseResolver = readFileSync('scripts/resolve-ci-change-base.sh', 'utf8');
const cleanupClassifier = readFileSync('scripts/test-cleanup-classifier.mjs', 'utf8');
const mutationGate = readFileSync('scripts/mutation-gate.mjs', 'utf8');

describe('lean required CI contracts', () => {
  it('preserves the protected check names', () => {
    expect(workflow.match(/^\s{4}name: 🧪 Tests$/gm)).toHaveLength(1);
    expect(workflow.match(/^\s{4}name: 🔍 Lint & Type Check$/gm)).toHaveLength(1);
    expect(workflow.match(/^\s{4}name: 🔨 Build$/gm)).toHaveLength(1);
  });

  it('runs selected tests once on pull requests and main', () => {
    expect(workflow).toContain('test_focused:');
    expect(workflow).toContain("needs.classify.outputs.vitest_mode == 'focused'");
    expect(workflow).toContain('scripts/risk-gate.sh \\');
    expect(workflow).not.toContain('changed_coverage:');
    expect(workflow).not.toContain('changed-coverage-gate.mjs');
    expect(workflow).not.toContain('test_full_shard:');
    expect(workflow).not.toContain('--full');
    expect(workflow).not.toContain('workflow_dispatch:');
  });

  it('gives worst-case selected coverage enough time without reducing its scope', () => {
    const focusedJob = workflow.match(
      /  test_focused:\n(?<body>[\s\S]*?)(?=\n  [a-z_]+:|$)/,
    )?.groups?.body ?? '';

    // A conservative multi-area change can select every group. The old
    // 25-minute job limit killed that valid run before Vitest emitted a result.
    expect(focusedJob).toContain('timeout-minutes: 45');
    expect(focusedJob).toContain('--coverage');
    expect(focusedJob).toContain('scripts/risk-gate.sh \\');
    expect(focusedJob).not.toContain('--skip-tests');
  });

  it('fails closed unless selected coverage can be staged for upload', () => {
    const focusedJob = workflow.match(
      /  test_focused:\n(?<body>[\s\S]*?)(?=\n  [a-z_]+:|$)/,
    )?.groups?.body ?? '';

    expect(focusedJob).toContain('test -s .local/coverage/selected/coverage-final.json');
    expect(focusedJob).toContain('test -s .local/coverage/selected/coverage-summary.json');
    expect(focusedJob).toContain('test -s .local/coverage/selected/lcov.info');
    expect(focusedJob).toContain('cp -R .local/coverage/selected/. selected-coverage/');
    expect(focusedJob).toContain('path: selected-coverage/');
    expect(focusedJob).toContain('if-no-files-found: error');
  });

  it('publishes exact selected-test metadata for the protected main SHA', () => {
    expect(workflow).toContain('NEXUS_TEST_SELECTION_OUTPUT: .local/ci-evidence/test-selection.json');
    expect(workflow).toContain('protected-main-test-selection-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(workflow).toContain('Record docs-only exact selection without Vitest');
    expect(workflow).not.toContain('selection_metadata:');
    expect(workflow).toContain("PROTECTED_MAIN: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}");
    expect(workflow).toContain('skip|focused)');
    expect(workflow).toContain('test "$FOCUSED_RESULT" = "success"');
    expect(workflow).toContain('test_focused:');
    expect(workflow).toMatch(/test_focused:[\s\S]*?\n\s{6}- run: npm ci/);
  });

  it('binds lightweight docs and secret checks into every required test result', () => {
    expect(workflow).toContain('docs_and_secrets:');
    expect(workflow).toContain('cache: npm');
    expect(workflow).toContain('- run: npm ci');
    expect(workflow).toContain('node scripts/changed-secret-scan.mjs --base "$BASE"');
    expect(workflow).toContain('test "$DOCS_RESULT" = "success"');
  });

  it('retains exact checkout, dependency, documentation, and migration safety contracts', () => {
    expect(workflow).toContain("NPM_CONFIG_AUDIT: 'false'");
    expect(workflow).toContain("NPM_CONFIG_FUND: 'false'");
    expect(workflow).toContain('name: Project map freshness');
    expect(workflow).toContain('run: npm run project:map:check');
    expect(workflow).toContain('EXPECTED_SHA: ${{ github.sha }}');
    expect(workflow).toContain('test "$HEAD_SHA" = "$EXPECTED_SHA"');
    expect(workflow).toContain("git rev-parse 'HEAD^2'");

    const migrationJob = workflow.match(
      /  migrations:\n(?<body>[\s\S]*?)(?=\n  [a-z_]+:|$)/,
    )?.groups?.body ?? '';
    expect(migrationJob.indexOf('actions/setup-node@')).toBeGreaterThan(-1);
    expect(migrationJob.indexOf('- run: npm ci'))
      .toBeGreaterThan(migrationJob.indexOf('actions/setup-node@'));
    expect(migrationJob.indexOf('node scripts/migration-safety-check.mjs'))
      .toBeGreaterThan(migrationJob.indexOf('- run: npm ci'));

    expect(security).toContain('name: Dependency audit');
    expect(security).toContain('npm audit --audit-level=high --omit=dev');
  });

  it('classifies the complete pushed range from one exact base', () => {
    expect(workflow).toContain('PUSH_BEFORE_SHA: ${{ github.event.before }}');
    expect(workflow).toContain('BASE_REF="$(bash scripts/resolve-ci-change-base.sh)"');
    expect(workflow).toContain('base_sha: ${{ steps.classify.outputs.base_sha }}');
    expect(baseResolver).toContain('merge-base --is-ancestor "$PUSH_BEFORE_SHA" HEAD');
    expect(baseResolver).toContain('ZERO_SHA="0000000000000000000000000000000000000000"');
    expect(workflow).not.toContain('BASE_REF="HEAD~1"');
    for (const source of [cleanupClassifier, mutationGate]) {
      expect(source).toContain('gitMergeBaseArgs');
      expect(source).toContain('gitNameStatusDiffArgs');
      expect(source).toContain('parseGitNameStatusRecordsZ');
    }
    expect(mutationGate).not.toContain("split('\\n').filter(Boolean)");
  });

  it('classifies test changes conservatively before dependency installation', () => {
    expect(workflow).toContain(
      'node scripts/test-cleanup-classifier.mjs --base "$BASE_REF" --field requiresMutation',
    );
    expect(workflow).toContain('SELECTED_GROUPS="$(jq -c \'.vitest.groups\' /tmp/classifier.json)"');
    expect(workflow).not.toMatch(/^\s*GROUPS="/m);
    const classifier = readFileSync('scripts/test-cleanup-classifier.mjs', 'utf8');
    expect(classifier).not.toContain("from './mutation-gate.mjs'");
    expect(classifier).toContain('runs before npm ci');
    expect(classifier).toContain('/^[DMR]/');
    expect(mutationGate).not.toContain("import ts from 'typescript'");
    expect(mutationGate).toContain("requireFromMutationGate('typescript')");
    expect(mutationGate).toContain('NEXUS_TYPESCRIPT_EVIDENCE_UNAVAILABLE');

    const test = '__tests__/services/retained-contract.test.ts';
    const result = classifyDeletedTests(
      [
        { status: 'A', paths: ['__tests__/services/added.test.ts'] },
        { status: 'M', paths: ['archive/__tests__/services/prefix.test.ts'] },
        { status: 'M', paths: ['__tests__/services/suffix.test.ts.backup'] },
        { status: 'M', paths: [test] },
      ],
      () => "it('owns two guarantees', () => { expect(owner).toBe('user'); expect(status).toBe('ready'); });",
      [],
      () => true,
      () => "it('owns one guarantee', () => { expect(status).toBe('ready'); });",
    );
    expect(result.requiresMutation).toBe(true);
    expect(result.tests).toEqual([
      expect.objectContaining({
        file: test,
        status: 'M',
        requiresMutation: true,
      }),
    ]);
  });

  it('keeps full and mutation suites outside scheduled CI', () => {
    expect(nightly).not.toContain('run-test-tier.mjs deterministic');
    expect(nightly).not.toContain('release-test-evidence.mjs');
    expect(mutation).not.toContain('schedule:');
    expect(mutation).toContain('--scope test-cleanup');
  });
});
