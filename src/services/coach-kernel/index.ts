// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export * from './types';
export * from './knowledge-loader';
export * from './planner-engine';
export * from './guardrails';
export * from './feedback-analysis';
export * from './decision-trail';
export * from './capacity-reconciliation';
export * from './poor-recovery-variation';
export * from './tools';
export * from './engines/hybrid-engine';
export * from './seed/sample-athletes';
export * from './stores/in-memory-plan-store';
export * from './evaluation';
// Capability modules surfaced 2026-05-23 (PR 3 disposition). Each has
// dedicated tests under `__tests__/services/coach-kernel-*.test.ts` and a
// documented intended integration point — see the file headers and the
// "Unwired kernel capability modules" entry in
// `docs/training/training-engine-open-items.md`. The modules are kept and
// exported so the public kernel surface matches what tests already pin.
export * from './adaptation-engine';
export * from './athlete-lifecycle-state';
export * from './safety-guardrails';
