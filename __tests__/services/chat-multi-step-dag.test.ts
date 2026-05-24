import { describe, expect, it } from 'vitest';

import { buildChatMultiStepDag, buildMultiStepSummary, resolveStepRefs } from '../../src/services/chat-multi-step-dag';
import type { ChatActionPlan, ChatPlanStep, ChatStepExecutionResult } from '../../src/services/chat/types';

function step(stepId: string, args: Record<string, unknown> = {}): ChatPlanStep {
  return {
    stepId,
    skill: 'tasks',
    type: 'create_task',
    action: 'create_task',
    risk: 'safe_write',
    riskClass: 'R1',
    provider: 'nexus',
    args,
    requiredArgsPresent: true,
    idempotencyKey: `hash-${stepId}`,
    verification: { required: true, method: 'local_read_back', expectedFields: args },
  };
}

function plan(steps: ChatPlanStep[]): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: '1',
    tenantId: '1',
    conversationId: 'conv',
    messageId: 'msg',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    channel: 'ios',
    createdAt: '2026-05-23T12:00:00+01:00',
    planner: 'mixed',
    steps,
    requiresConfirmation: false,
    confidence: 0.9,
  };
}

describe('chat multi-step DAG', () => {
  it('assigns stable ids and sequential dependencies by default', () => {
    const dag = buildChatMultiStepDag({
      plan: plan([step('a'), step('b'), step('c')]),
      segments: [
        { index: 0, text: 'Create task A', connective: null, pronounMentions: [] },
        { index: 1, text: 'create task B', connective: 'and then', pronounMentions: [] },
        { index: 2, text: 'create task C', connective: 'then', pronounMentions: [] },
      ],
    });

    expect(dag.ok).toBe(true);
    if (!dag.ok) return;
    expect(dag.plan.requiresConfirmation).toBe(true);
    expect(dag.plan.steps.map((candidate) => candidate.stepId)).toEqual(['step_1', 'step_2', 'step_3']);
    expect(dag.plan.steps.map((candidate) => candidate.dependsOnStepIds ?? [])).toEqual([
      [],
      ['step_1'],
      ['step_2'],
    ]);
  });

  it('lets relaxed connective siblings run independently', () => {
    const dag = buildChatMultiStepDag({
      plan: plan([step('a'), step('b')]),
      segments: [
        { index: 0, text: 'Create task A', connective: null, pronounMentions: [] },
        { index: 1, text: 'create task B', connective: ',', pronounMentions: [] },
      ],
    });

    expect(dag.ok).toBe(true);
    if (!dag.ok) return;
    expect(dag.plan.steps[1].dependsOnStepIds).toBeUndefined();
  });

  it('resolves {$ref} placeholders from prior step results', () => {
    const resolved = resolveStepRefs({
      taskId: { $ref: 'step_1.result.providerObjectId' },
      title: 'follow-up',
    }, [{
      step: step('step_1'),
      status: 'verified_success',
      result: { providerObjectId: 'task-123' },
    }]);

    expect(resolved).toEqual({ taskId: 'task-123', title: 'follow-up' });
  });

  it('summarizes per-step results for iOS metadata', () => {
    const source = plan([step('step_1'), step('step_2')]);
    const results: ChatStepExecutionResult[] = [
      { step: source.steps[0], status: 'verified_success' },
      { step: source.steps[1], status: 'blocked', error: 'dependency_failed' },
    ];

    expect(buildMultiStepSummary(source, results)).toMatchObject({
      totalSteps: 2,
      succeeded: 1,
      blocked: 1,
      perStep: [
        { stepId: 'step_1', status: 'verified_success' },
        { stepId: 'step_2', status: 'blocked', error: 'dependency_failed' },
      ],
    });
  });
});
