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

  // ── M16: data-flow-first dependency inference ────────────────────

  it("treats 'and'/'e'/'y'/'&' as relaxed siblings when no data flow links the steps", () => {
    for (const connective of ['and', 'e', 'y', '&']) {
      const dag = buildChatMultiStepDag({
        plan: plan([step('a', { title: 'Buy milk' }), step('b', { title: 'Call mom' })]),
        segments: [
          { index: 0, text: 'Create task Buy milk', connective: null, pronounMentions: [] },
          { index: 1, text: 'create task Call mom', connective, pronounMentions: [] },
        ],
      });
      expect(dag.ok).toBe(true);
      if (!dag.ok) return;
      expect(dag.plan.steps[1].dependsOnStepIds).toBeUndefined();
    }
  });

  it("chains 'A and B and C' -> 3 independent steps when nothing links them", () => {
    const dag = buildChatMultiStepDag({
      plan: plan([
        step('a', { title: 'alpha' }),
        step('b', { title: 'beta' }),
        step('c', { title: 'gamma' }),
      ]),
      segments: [
        { index: 0, text: 'Create task alpha', connective: null, pronounMentions: [] },
        { index: 1, text: 'create task beta', connective: 'and', pronounMentions: [] },
        { index: 2, text: 'create task gamma', connective: 'and', pronounMentions: [] },
      ],
    });
    expect(dag.ok).toBe(true);
    if (!dag.ok) return;
    expect(dag.plan.steps.map((candidate) => candidate.dependsOnStepIds)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("chains on $ref data flow even across an 'and' connective", () => {
    const dag = buildChatMultiStepDag({
      plan: plan([
        step('a', { title: 'Buy milk' }),
        step('b', { taskId: { $ref: 'step_1.result.task.id' } }),
      ]),
      segments: [
        { index: 0, text: 'Create a task to buy milk', connective: null, pronounMentions: [] },
        { index: 1, text: 'complete it', connective: 'and', pronounMentions: ['it'] },
      ],
    });
    expect(dag.ok).toBe(true);
    if (!dag.ok) return;
    expect(dag.plan.steps[1].dependsOnStepIds).toEqual(['step_1']);
  });

  it('chains on deterministic entity overlap without an explicit $ref', () => {
    const dag = buildChatMultiStepDag({
      plan: plan([
        step('a', { title: 'Quarterly review' }),
        step('b', { title: 'quarterly review', changedFields: { dueAt: '2026-05-24' } }),
      ]),
      segments: [
        { index: 0, text: 'Create task Quarterly review', connective: null, pronounMentions: [] },
        { index: 1, text: 'set the Quarterly review due date to tomorrow', connective: 'and', pronounMentions: [] },
      ],
    });
    expect(dag.ok).toBe(true);
    if (!dag.ok) return;
    expect(dag.plan.steps[1].dependsOnStepIds).toEqual(['step_1']);
  });

  it('chains conservatively for unresolved pronouns and unknown connectives', () => {
    const pronoun = buildChatMultiStepDag({
      plan: plan([step('a', { title: 'Buy milk' }), step('b', {})]),
      segments: [
        { index: 0, text: 'Create task Buy milk', connective: null, pronounMentions: [] },
        { index: 1, text: 'archive it somewhere', connective: 'and', pronounMentions: ['it'] },
      ],
    });
    expect(pronoun.ok).toBe(true);
    if (!pronoun.ok) return;
    expect(pronoun.plan.steps[1].dependsOnStepIds).toEqual(['step_1']);

    const unknown = buildChatMultiStepDag({
      plan: plan([step('a', { title: 'alpha' }), step('b', { title: 'beta' })]),
      segments: [
        { index: 0, text: 'Create task alpha', connective: null, pronounMentions: [] },
        { index: 1, text: 'create task beta', connective: 'meanwhile', pronounMentions: [] },
      ],
    });
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.plan.steps[1].dependsOnStepIds).toEqual(['step_1']);
  });

  it('M16 adversarial fix: sequencing connectives UNION with data-flow deps (never replaced)', () => {
    // Reviewer repro: reminder 'gym' → then delete evt-1 → then create task
    // 'gym'. Entity overlap links step_3 to step_1 ('gym'), but the explicit
    // 'then' ordering onto step_2 must SURVIVE as an additional dep — data
    // flow into an earlier step must never erase the user's stated sequence.
    const dag = buildChatMultiStepDag({
      plan: plan([
        step('a', { message: 'gym' }),
        step('b', { eventId: 'evt-1' }),
        step('c', { title: 'gym' }),
      ]),
      segments: [
        { index: 0, text: 'Set a reminder for gym', connective: null, pronounMentions: [] },
        { index: 1, text: 'delete the 5pm event', connective: 'then', pronounMentions: [] },
        { index: 2, text: 'create task gym', connective: 'then', pronounMentions: [] },
      ],
    });
    expect(dag.ok).toBe(true);
    if (!dag.ok) return;
    expect(dag.plan.steps[2].dependsOnStepIds).toEqual(['step_1', 'step_2']);
    // step_2 keeps its own sequencing chain onto step_1.
    expect(dag.plan.steps[1].dependsOnStepIds).toEqual(['step_1']);
  });

  it("keeps sequencing connectives ('then', 'depois', 'luego', 'em seguida') chained", () => {
    for (const connective of ['then', 'and then', 'depois', 'e depois', 'luego', 'y luego', 'em seguida', 'after that']) {
      const dag = buildChatMultiStepDag({
        plan: plan([step('a', { title: 'alpha' }), step('b', { title: 'beta' })]),
        segments: [
          { index: 0, text: 'Create task alpha', connective: null, pronounMentions: [] },
          { index: 1, text: 'create task beta', connective, pronounMentions: [] },
        ],
      });
      expect(dag.ok).toBe(true);
      if (!dag.ok) return;
      expect(dag.plan.steps[1].dependsOnStepIds).toEqual(['step_1']);
    }
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
