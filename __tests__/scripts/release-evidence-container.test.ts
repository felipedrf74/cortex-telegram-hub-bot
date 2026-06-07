import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release-evidence-container wrapper', () => {
  const script = () => readFileSync('scripts/release-evidence-container.sh', 'utf8');
  const workflow = () => readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');

  it('marks the bind-mounted workspace as a safe git directory', () => {
    const raw = script();

    expect(raw).toContain('-e GIT_CONFIG_COUNT=1');
    expect(raw).toContain('-e GIT_CONFIG_KEY_0=safe.directory');
    expect(raw).toContain('-e GIT_CONFIG_VALUE_0=/workspace');
  });

  it('forwards CI identity into the evidence-writing container', () => {
    const raw = script();

    for (const name of [
      'NEXUS_RELEASE_CI_PROVIDER',
      'NEXUS_RELEASE_RUN_ID',
      'NEXUS_RELEASE_RUN_ATTEMPT',
      'GITHUB_ACTIONS',
      'GITHUB_WORKFLOW',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_JOB',
    ]) {
      expect(raw).toContain(name);
    }
  });

  it('fails fast before evidence writing when prerequisite full suites fail', () => {
    const raw = workflow();
    const stopIndex = raw.indexOf('Stop when full-suite prerequisites failed');
    const countIndex = raw.indexOf('Count tests from shard artifacts');
    const writeIndex = raw.indexOf('- name: Write release evidence');

    expect(stopIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(stopIndex);
    expect(writeIndex).toBeGreaterThan(stopIndex);
    expect(raw).toContain("needs.vitest-full.result != 'success' || needs.python-full.result != 'success'");
    expect(raw).toContain('timeout-minutes: 30');
  });
});
