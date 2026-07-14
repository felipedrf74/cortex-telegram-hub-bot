import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

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

  it('preserves one required aggregate Tests context and fails closed by mode', () => {
    expect(workflow.match(/^\s{4}name: 🧪 Tests$/gm)).toHaveLength(1);
    expect(workflow).toContain('needs: [classify, test_full_shard, test_focused]');
    expect(workflow).toContain('FULL_RESULT: ${{ needs.test_full_shard.result }}');
    expect(workflow).toContain('FOCUSED_RESULT: ${{ needs.test_focused.result }}');
    expect(workflow).toContain('Unexpected Vitest mode');
    expect(workflow).not.toContain('continue-on-error:');
  });
});
