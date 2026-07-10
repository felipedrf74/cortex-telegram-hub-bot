// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Training skill hardening (2026-05-19):
// Source-level contract pins for the Token-Zero rule. Training plan creation
// should be deterministic by default; LLM usage may explain or synthesize, but
// must not become the scheduling source of truth.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(__dirname, '..', '..');

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('training plan generation source contract', () => {
  it('keeps the operational plan-generation route deterministic by default', () => {
    const source = read('src/api/routes/training-plan-generation.ts');

    expect(source).toContain('generateTrainingPlan');
    expect(source).toContain('buildCoachKernelTrainingPlan');
    expect(source).not.toMatch(/\bGemini\b|\bgenerateText\b|\bcallAI\b|\banthropic\b/i);
    expect(source).not.toContain('api_usage');
  });

  it('documents that normal plan creation is token-zero and future provider calls own reservations', () => {
    const source = read('src/api/routes/training-plan-routes.ts');

    expect(source).toContain('deterministic by default');
    expect(source).toContain('Plan generation is deterministic and token-zero');
    expect(source).toContain('that specific call must own its own classified');
  });
});
