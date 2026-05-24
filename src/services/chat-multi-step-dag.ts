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

const RELAXED_CONNECTIVES = /^(?:,|\+|also|plus|tamb[eé]m|tambi[eé]n)$/i;

export function buildChatMultiStepDag(input: BuildChatMultiStepDagInput): ChatMultiStepDagResult {
  if (input.plan.steps.length === 0) return { ok: false, reason: 'empty' };
  const steps = input.plan.steps.map((step, index) => {
    const previous = index > 0 ? `step_${index}` : null;
    const segment = input.segments[index];
    const relaxed = segment?.connective ? RELAXED_CONNECTIVES.test(segment.connective) : false;
    const stable: ChatPlanStep = {
      ...step,
      stepId: `step_${index + 1}`,
      dependsOnStepIds: previous && !relaxed ? [previous] : undefined,
    };
    return stable;
  });
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
