import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const nightlyWorkflow = readFileSync('.github/workflows/nightly.yml', 'utf8');
const securityWorkflow = readFileSync('.github/workflows/security.yml', 'utf8');
const baseResolver = readFileSync('scripts/resolve-ci-change-base.sh', 'utf8');

describe('required CI test sharding', () => {
  it('runs full mode in four fail-complete shards', () => {
    expect(workflow).toContain('test_full_shard:');
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('shard: [1, 2, 3, 4]');
    expect(workflow).toContain('--vitest-shard "${{ matrix.shard }}/4"');
    expect(workflow).toContain('timeout-minutes: 25');
    expect(workflow).toContain('name: Verify exact checked-out source');
    expect(workflow.match(/test "\$HEAD_SHA" = "\$EXPECTED_SHA"/g)).toHaveLength(2);
    expect(workflow).toContain("git rev-parse 'HEAD^2'");
    expect(workflow).toContain('git merge-base --is-ancestor "$PR_HEAD_SHA" "$HEAD_SHA"');
  });

  it('keeps focused mode on the risk gate', () => {
    expect(workflow).toContain('test_focused:');
    expect(workflow).toContain("needs.classify.outputs.vitest_mode != 'full'");
    expect(workflow).toContain('name: Run focused Vitest gate');
    expect(workflow).toContain('scripts/risk-gate.sh \\');
  });

  it('uses exact cached installs without duplicating the required security audit', () => {
    expect(workflow).toContain("NPM_CONFIG_AUDIT: 'false'");
    expect(workflow).toContain("NPM_CONFIG_FUND: 'false'");
    expect(workflow).toContain("NPM_CONFIG_PREFER_OFFLINE: 'true'");
    expect(workflow).toContain("PIP_DISABLE_PIP_VERSION_CHECK: '1'");
    expect(workflow).toContain('content-engine/requirements-dev.txt');
    expect(securityWorkflow).toContain('name: Dependency audit');
    expect(securityWorkflow).toContain('npm audit --audit-level=high --omit=dev');
  });

  it('keeps interpreted CodeQL source extraction independent from install and build work', () => {
    const codeqlJob = securityWorkflow.match(
      /  codeql:\n(?<body>[\s\S]*?)(?=\n  dependency-audit:)/,
    )?.groups?.body ?? '';

    expect(codeqlJob).toContain('languages: javascript-typescript');
    expect(codeqlJob).toContain('actions/setup-node@');
    expect(codeqlJob).toContain('Initialize broad required CodeQL scan');
    expect(codeqlJob).toContain('Initialize manual deployed-source shadow');
    expect(codeqlJob).toContain('config-file: ./.github/codeql/deployed-source-shadow.yml');
    expect(codeqlJob).toContain("github.event_name == 'workflow_dispatch'");
    expect(codeqlJob).toContain('scope:deployed-source-shadow');
    expect(codeqlJob).not.toContain('npm ci');
    expect(codeqlJob).not.toContain('npm run build');
    expect(codeqlJob).toContain('upload: always');
    expect(codeqlJob).toContain('upload-database: false');
    expect(codeqlJob).toContain('wait-for-processing: true');
    expect(codeqlJob.indexOf('github/codeql-action/init@'))
      .toBeLessThan(codeqlJob.indexOf('github/codeql-action/analyze@'));
  });

  it('fails CI when the generated project map drifts', () => {
    expect(workflow).toContain('name: Project map freshness');
    expect(workflow).toContain('run: npm run project:map:check');
    expect(workflow).toMatch(/docs_and_secrets:[\s\S]*?- run: npm ci[\s\S]*?audit-docs\.mjs --strict/);
  });

  it('installs locked Node dependencies before migration rehearsals', () => {
    const migrationJob = workflow.match(
      /  migrations:\n(?<body>[\s\S]*?)(?=\n  [a-z_]+:|$)/,
    )?.groups?.body ?? '';
    const nightlyMigrationJob = nightlyWorkflow.match(
      /  migration-rehearsal:\n(?<body>[\s\S]*?)(?=\n  [a-z_-]+:)/,
    )?.groups?.body ?? '';

    for (const job of [migrationJob, nightlyMigrationJob]) {
      const setupNode = job.indexOf('actions/setup-node@');
      const install = job.indexOf('- run: npm ci');
      const migrationCheck = job.indexOf('node scripts/migration-safety-check.mjs');
      expect(setupNode).toBeGreaterThan(-1);
      expect(install).toBeGreaterThan(setupNode);
      expect(migrationCheck).toBeGreaterThan(install);
    }
  });

  it('classifies the complete pushed range and propagates one exact base', () => {
    const classifyJob = workflow.match(/  classify:\n(?<body>[\s\S]*?)(?=\n  mutation_cleanup:)/)?.groups?.body ?? '';
    const setupNode = classifyJob.indexOf('actions/setup-node@');
    const runClassifier = classifyJob.indexOf('- name: Run classifier');

    expect(workflow).toContain('PUSH_BEFORE_SHA: ${{ github.event.before }}');
    expect(workflow).toContain('BASE_REF="$(bash scripts/resolve-ci-change-base.sh)"');
    expect(workflow).toContain('base_sha: ${{ steps.classify.outputs.base_sha }}');
    expect(workflow).toContain("BASE='${{ needs.classify.outputs.base_sha }}'");
    expect(baseResolver).toContain('merge-base --is-ancestor "$PUSH_BEFORE_SHA" HEAD');
    expect(baseResolver).toContain('PUSH_BEFORE_SHA="${PUSH_BEFORE_SHA:-}"');
    expect(baseResolver).toContain('ZERO_SHA="0000000000000000000000000000000000000000"');
    expect(setupNode).toBeGreaterThan(-1);
    expect(setupNode).toBeLessThan(runClassifier);
    expect(classifyJob).toContain('node-version: ${{ env.NODE_VERSION }}');
    expect(workflow).not.toContain('BASE_REF="HEAD~1"');
    expect(workflow).not.toContain('BASE="HEAD~1"');
  });

  it('preserves one required aggregate Tests context and fails closed by mode', () => {
    expect(workflow.match(/^\s{4}name: 🧪 Tests$/gm)).toHaveLength(1);
    expect(workflow).toContain(
      'needs: [classify, mutation_cleanup, changed_coverage, test_full_shard, test_focused]',
    );
    expect(workflow).toContain('if: ${{ always() }}');
    expect(workflow).toContain('MUTATION_RESULT: ${{ needs.mutation_cleanup.result }}');
    expect(workflow).toContain('COVERAGE_RESULT: ${{ needs.changed_coverage.result }}');
    expect(workflow).toContain('test "$COVERAGE_RESULT" = "success"');
    expect(workflow).toContain('test "$MUTATION_RESULT" = "success"');
    expect(workflow).toContain('test "$COVERAGE_RESULT" = "skipped"');
    expect(workflow).toContain('test "$MUTATION_RESULT" = "skipped"');
    expect(workflow).toContain('FULL_RESULT: ${{ needs.test_full_shard.result }}');
    expect(workflow).toContain('FOCUSED_RESULT: ${{ needs.test_focused.result }}');
    expect(workflow).toContain('Unexpected Vitest mode');
    expect(workflow).not.toContain('continue-on-error:');
  });
});
