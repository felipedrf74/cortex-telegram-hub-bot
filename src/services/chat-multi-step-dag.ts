// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionPlan, ChatPlanStep, ChatStepExecutionResult } from './chat/types';
import type { ChatMultiStepSegment } from './chat-multi-step-splitter';

export interface BuildChatMultiStepDagInput {
  plan: ChatActionPlan;
  segments: ChatMultiStepSegment[];
}

export type ChatMultiStepDagResult = {
  ok: true;
  plan: ChatActionPlan;
} | {
  ok: false;
  reason: 'cycle' | 'empty';
};

// M16 (multi-step upgrade): dependency inference is data-flow-first.
//
// A step depends on a prior step ONLY when there is data-flow evidence:
//   (a) its args contain a {$ref} into that step's result,
//   (b) its segment carries pronoun mentions that anchor to a prior step
//       (the segment router wires resolvable pronouns into $refs; an
//       unresolved pronoun still chains conservatively), or
//   (c) deterministic entity overlap — the same normalized entity value
//       (title/taskId/eventId/...) appears in both steps' args.
//
// Connectives decide the remaining cases:
//   - sequencing connectives ('then', 'and then', 'depois', 'e depois',
//     'luego', 'y luego', 'after that', 'em seguida') ALWAYS chain to the
//     previous step — as a UNION with any data-flow deps (adversarial fix:
//     data flow into an earlier step must never erase the user's explicit
//     ordering);
//   - relaxed siblings (',', '+', '&', 'also', 'plus', 'também',
//     'también' — and, per M16, 'and'/'e'/'y') run independently WHEN no
//     data-flow links the steps (entity overlap stays a fallback signal for
//     relaxed/absent connectives only in the sense that it can add deps,
//     never remove the sequencing chain);
//   - anything else (unknown/absent connective) chains — when in doubt,
//     CHAIN (conservative default).
const RELAXED_CONNECTIVES = /^(?:,|\+|&|and|e|y|also|plus|tamb[eé]m|tambi[eé]n)$/i;
const SEQUENCING_CONNECTIVES = /^(?:and then|then|e depois|depois|y luego|luego|after that|em seguida)$/i;

/** Shared with the segment-router seam (data-need chaining eligibility). */
export function isRelaxedChatMultiStepConnective(connective: string | null | undefined): boolean {
  return typeof connective === 'string' && RELAXED_CONNECTIVES.test(connective);
}

// Deterministic entity-overlap evidence (c) compares normalized string
// values under these arg keys. Exact match only — no fuzzy matching.
const ENTITY_OVERLAP_ARG_KEYS = ['title', 'taskId', 'eventId', 'listId', 'topicTitle', 'message'];

export function buildChatMultiStepDag(input: BuildChatMultiStepDagInput): ChatMultiStepDagResult {
  if (input.plan.steps.length === 0) return { ok: false, reason: 'empty' };
  const steps = input.plan.steps.map((step, index) => {
    const stable: ChatPlanStep = {
      ...step,
      stepId: `step_${index + 1}`,
      dependsOnStepIds: undefined,
    };
    return stable;
  });
  for (let index = 1; index < steps.length; index += 1) {
    const step = steps[index];
    const priorSteps = steps.slice(0, index);
    const dataFlowDeps = inferDataFlowDependencies(step, priorSteps);
    const segment = input.segments[index];
    const connective = segment?.connective ?? null;
    // Adversarial fix: an explicit sequencing connective ALWAYS chains to
    // the previous step IN ADDITION to any data-flow deps (deduped union) —
    // never replaced by them.
    const sequencing = connective !== null && SEQUENCING_CONNECTIVES.test(connective);
    if (dataFlowDeps.length > 0 || sequencing) {
      const deps = new Set(dataFlowDeps);
      if (sequencing) deps.add(`step_${index}`);
      step.dependsOnStepIds = [...deps].sort((a, b) => stepIndexOf(a) - stepIndexOf(b));
      continue;
    }
    const pronounAnchored = (segment?.pronounMentions?.length ?? 0) > 0;
    if (pronounAnchored) {
      // Unresolved pronoun (no $ref was wired): the step still talks about
      // "it/that" — chain to the previous step conservatively.
      step.dependsOnStepIds = [`step_${index}`];
      continue;
    }
    if (connective && RELAXED_CONNECTIVES.test(connective)) {
      // Independent sibling — no data flow, relaxed connective.
      continue;
    }
    // Sequencing connective, unknown connective, or no connective at all:
    // conservative default is to chain.
    step.dependsOnStepIds = [`step_${index}`];
  }
  if (hasCycle(steps)) return { ok: false, reason: 'cycle' };
  return {
    ok: true,
    plan: {
      ...input.plan,
      steps,
      planner: 'mixed',
      requiresConfirmation: input.plan.requiresConfirmation || steps.length >= 2,
      debug: {
        routingSignals: [
          ...(input.plan.debug?.routingSignals ?? []),
          'multi_step_splitter',
          'multi_step_dag',
        ],
        rejectedFastPaths: input.plan.debug?.rejectedFastPaths ?? [],
        parser: input.plan.debug?.parser ?? 'mixed',
        modelProvider: input.plan.debug?.modelProvider,
      },
    },
  };
}

function inferDataFlowDependencies(step: ChatPlanStep, priorSteps: ChatPlanStep[]): string[] {
  const deps = new Set<string>();
  const priorIds = new Set(priorSteps.map((prior) => prior.stepId));
  for (const ref of collectStepRefIds(step.args)) {
    if (priorIds.has(ref)) deps.add(ref);
  }
  if (deps.size === 0) {
    const overlap = findLatestEntityOverlapStep(step, priorSteps);
    if (overlap) deps.add(overlap);
  }
  return [...deps].sort((a, b) => stepIndexOf(a) - stepIndexOf(b));
}

function stepIndexOf(stepId: string): number {
  const match = /^step_(\d+)$/.exec(stepId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function collectStepRefIds(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) collectStepRefIds(entry, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') {
    const match = /^(step_\d+)\.result(?:\..+)?$/.exec(record.$ref);
    if (match) out.push(match[1]);
    return out;
  }
  for (const entry of Object.values(record)) collectStepRefIds(entry, out);
  return out;
}

function findLatestEntityOverlapStep(step: ChatPlanStep, priorSteps: ChatPlanStep[]): string | null {
  const own = entityValuesForStep(step);
  if (own.size === 0) return null;
  for (let index = priorSteps.length - 1; index >= 0; index -= 1) {
    const prior = entityValuesForStep(priorSteps[index]);
    for (const value of own) {
      if (prior.has(value)) return priorSteps[index].stepId;
    }
  }
  return null;
}

function entityValuesForStep(step: ChatPlanStep): Set<string> {
  const values = new Set<string>();
  for (const key of ENTITY_OVERLAP_ARG_KEYS) {
    const raw = step.args?.[key];
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized.length >= 3) values.add(normalized);
  }
  return values;
}

export function resolveStepRefs(args: Record<string, unknown>, results: ChatStepExecutionResult[]): Record<string, unknown> {
  return resolveRefValue(args, results) as Record<string, unknown>;
}

export function buildMultiStepSummary(plan: ChatActionPlan, results: ChatStepExecutionResult[]) {
  const perStep = plan.steps.map((step) => {
    const result = results.find((candidate) => candidate.step.stepId === step.stepId);
    return {
      stepId: step.stepId,
      skill: step.skill,
      action: step.action,
      status: result?.status ?? 'pending',
      error: result?.error,
      dependsOnStepIds: step.dependsOnStepIds ?? [],
    };
  });
  return {
    totalSteps: plan.steps.length,
    succeeded: perStep.filter((step) => step.status === 'verified_success').length,
    failed: perStep.filter((step) => step.status === 'failed').length,
    blocked: perStep.filter((step) => step.status === 'blocked').length,
    needsClarification: plan.steps.filter((step) => !step.requiredArgsPresent).length,
    perStep,
  };
}

function resolveRefValue(value: unknown, results: ChatStepExecutionResult[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => resolveRefValue(entry, results));
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') return lookupStepRef(record.$ref, results);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[key] = resolveRefValue(entry, results);
  }
  return out;
}

function lookupStepRef(ref: string, results: ChatStepExecutionResult[]): unknown {
  const match = /^step_(\d+)\.result(?:\.(.+))?$/.exec(ref);
  if (!match) return undefined;
  const stepId = `step_${match[1]}`;
  const result = results.find((candidate) => candidate.step.stepId === stepId);
  if (!result) return undefined;
  if (!match[2]) return result.result;
  return match[2].split('.').reduce<unknown>((current, part) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, result.result);
}

function hasCycle(steps: ChatPlanStep[]): boolean {
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const step of steps) {
    incoming.set(step.stepId, new Set(step.dependsOnStepIds ?? []));
    for (const dep of step.dependsOnStepIds ?? []) {
      const edges = outgoing.get(dep) ?? new Set<string>();
      edges.add(step.stepId);
      outgoing.set(dep, edges);
    }
  }
  const ready = [...incoming.entries()].filter(([, deps]) => deps.size === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    for (const target of outgoing.get(id) ?? []) {
      const deps = incoming.get(target);
      if (!deps) continue;
      deps.delete(id);
      if (deps.size === 0) ready.push(target);
    }
  }
  return visited !== steps.length;
}
