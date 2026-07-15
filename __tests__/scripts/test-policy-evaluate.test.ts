import { describe, expect, it } from 'vitest';
import {
  loadTestPolicy,
  partitionTestFiles,
  resolveTestDisposition,
  walkTestFiles,
} from '../../scripts/lib/test-policy.mjs';

describe('test policy evaluation boundary', () => {
  it('keeps only subjective persona and output-quality grading in test:evaluate', () => {
    const policy = loadTestPolicy();
    const evaluate = partitionTestFiles(walkTestFiles(), policy).evaluation;

    expect(evaluate).toEqual([
      '__tests__/services/coach-kernel-evaluation.test.ts',
      '__tests__/services/content-day-to-day-evaluation.test.ts',
    ]);
  });

  it.each([
    '__tests__/services/decision-conflict-evaluator.test.ts',
    '__tests__/services/decision-preexecution-revalidator.test.ts',
    '__tests__/services/registry-real-eval-gates.test.ts',
    '__tests__/services/chat-core-v2-corpus-eval-runner.test.ts',
    '__tests__/services/chat-evaluation-harness.test.ts',
    '__tests__/portal/portal-eval-history-routes.test.ts',
    '__tests__/tools/content-evaluation-harness.test.ts',
  ])('keeps deterministic runtime evaluator coverage in correctness tiers: %s', (file) => {
    const policy = loadTestPolicy();
    expect(resolveTestDisposition(file, policy)?.disposition).not.toBe('eval');
  });
});
