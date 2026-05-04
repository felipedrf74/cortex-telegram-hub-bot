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
});
