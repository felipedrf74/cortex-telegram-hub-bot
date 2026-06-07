import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release-evidence-container wrapper', () => {
  const script = () => readFileSync('scripts/release-evidence-container.sh', 'utf8');

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
});
