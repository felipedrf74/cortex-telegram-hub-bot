import { describe, expect, it, vi } from 'vitest';
import {
  createDecisionMutationCommand,
  type DecisionMutationCommandInput,
} from '../../src/services/decision-center/contracts';
import { normalizeDecisionCenterError } from '../../src/services/decision-center/errors';
import { createDecisionPlanningContext } from '../../src/services/decision-center/planning-context';

const NOW = '2026-03-29T00:30:00.000Z';

function mutationInput(
  overrides: Partial<DecisionMutationCommandInput<Readonly<Record<string, unknown>>>> = {},
): DecisionMutationCommandInput<Readonly<Record<string, unknown>>> {
  return {
    commandId: 'cmd_1',
    decisionId: 'dc_1',
    operation: 'dismiss',
    actionId: 'dismiss',
    scope: { userId: 7, tenantId: 11 },
    channel: 'rest',
    idempotencyKey: 'idem_1',
    recordVersion: 3,
    contextVersion: 'ctx_3',
    approval: { requiredLevel: 'none', evidence: null },
    execution: {
      executorId: 'decision-center.dismiss',
      strategy: 'synchronous',
      riskLevel: 'low',
      reversible: false,
      supportsIdempotency: true,
    },
    readback: {
      verifierId: 'notification-center-status',
      entityType: 'notification_center_item',
      entityId: 'dc_1',
      mode: 'versioned',
      expectedState: { status: 'dismissed' },
    },
    payload: {},
    requestedAt: NOW,
    ...overrides,
  };
}

describe('decision-center rewrite contracts', () => {
  it.each([
    {
      timezone: 'Europe/Lisbon',
      now: '2026-03-29T00:30:00.000Z',
      localDate: '2026-03-29',
      weekKey: '2026-W13',
      startsOn: '2026-03-23',
      endsOn: '2026-03-29',
    },
    {
      timezone: 'America/Sao_Paulo',
      now: '2026-01-01T02:30:00.000Z',
      localDate: '2025-12-31',
      weekKey: '2026-W01',
      startsOn: '2025-12-29',
      endsOn: '2026-01-04',
    },
    {
      timezone: 'America/Los_Angeles',
      now: '2026-03-08T09:30:00.000Z',
      localDate: '2026-03-08',
      weekKey: '2026-W10',
      startsOn: '2026-03-02',
      endsOn: '2026-03-08',
    },
  ])('captures one coherent local calendar snapshot for $timezone', (fixture) => {
    const now = vi.fn(() => new Date(fixture.now));
    const context = createDecisionPlanningContext({
      scope: { userId: 7, tenantId: 11 },
      timezone: fixture.timezone,
      locale: 'pt-PT',
      clock: { now },
    });

    expect(now).toHaveBeenCalledTimes(1);
    expect(context.localDate).toBe(fixture.localDate);
    expect(context.isoWeek).toMatchObject({
      key: fixture.weekKey,
      startsOn: fixture.startsOn,
      endsOn: fixture.endsOn,
    });
    expect(context.capturedAt).toBe(fixture.now);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.isoWeek)).toBe(true);
  });

  it('rejects invalid planning scope, locale, timezone, and clocks with typed errors', () => {
    const valid = {
      scope: { userId: 7, tenantId: 11 },
      timezone: 'Europe/Lisbon',
      locale: 'pt-PT',
      clock: { now: () => new Date(NOW) },
    };
    expect(() => createDecisionPlanningContext({ ...valid, scope: { userId: 0, tenantId: 11 } }))
      .toThrow(expect.objectContaining({ code: 'DECISION_SCOPE_INVALID', status: 400 }));
    expect(() => createDecisionPlanningContext({ ...valid, timezone: 'Mars/Olympus' }))
      .toThrow(expect.objectContaining({ code: 'DECISION_PLANNING_CONTEXT_INVALID', status: 400 }));
    expect(() => createDecisionPlanningContext({ ...valid, locale: 'not a locale' }))
      .toThrow(expect.objectContaining({ code: 'DECISION_PLANNING_CONTEXT_INVALID', status: 400 }));
    expect(() => createDecisionPlanningContext({ ...valid, clock: { now: () => new Date('invalid') } }))
      .toThrow(expect.objectContaining({ code: 'DECISION_PLANNING_CONTEXT_INVALID', status: 500 }));
  });

  it('creates an immutable command carrying scope, versions, execution, and readback', () => {
    const command = createDecisionMutationCommand(mutationInput());

    expect(command).toMatchObject({
      schemaVersion: 'decision_mutation_command@1.0.0',
      scope: { userId: 7, tenantId: 11 },
      recordVersion: 3,
      contextVersion: 'ctx_3',
      idempotencyKey: 'idem_1',
      execution: { executorId: 'decision-center.dismiss', supportsIdempotency: true },
      readback: { verifierId: 'notification-center-status', mode: 'versioned' },
    });
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.payload)).toBe(true);
    expect(Object.isFrozen(command.readback.expectedState)).toBe(true);
  });

  it('preserves the existing iOS mutation channel in the unified command contract', () => {
    expect(createDecisionMutationCommand(mutationInput({ channel: 'ios' }))).toMatchObject({
      channel: 'ios',
      scope: { userId: 7, tenantId: 11 },
      recordVersion: 3,
      contextVersion: 'ctx_3',
    });
  });

  it.each(['apns', 'automation'] as const)(
    'fails closed when %s execution is missing record or context versions',
    (channel) => {
      expect(() => createDecisionMutationCommand(mutationInput({ channel, contextVersion: null })))
        .toThrow(expect.objectContaining({ code: 'DECISION_PRECONDITION_REQUIRED', status: 428 }));
      expect(() => createDecisionMutationCommand(mutationInput({ channel, recordVersion: null })))
        .toThrow(expect.objectContaining({ code: 'DECISION_PRECONDITION_REQUIRED', status: 428 }));
    },
  );

  it('allows proposal creation without nonexistent record versions while retaining the command envelope', () => {
    const command = createDecisionMutationCommand(mutationInput({
      operation: 'create_intent',
      actionId: 'create_intent',
      channel: 'automation',
      recordVersion: null,
      contextVersion: null,
      execution: {
        executorId: 'decision-center.proposal.atomic',
        strategy: 'background',
        riskLevel: 'low',
        reversible: true,
        supportsIdempotency: true,
      },
      readback: {
        verifierId: 'decision-center.proposal.exact',
        entityType: 'notification_intent',
        entityId: 'dc_1',
        mode: 'exact',
        expectedState: { persisted: true },
      },
    }));

    expect(command).toMatchObject({
      operation: 'create_intent',
      channel: 'automation',
      recordVersion: null,
      contextVersion: null,
    });
  });

  it('enforces strong approval independently of runtime flags', () => {
    expect(() => createDecisionMutationCommand(mutationInput({
      approval: {
        requiredLevel: 'strong_confirmation',
        evidence: {
          level: 'user_confirmation',
          actorUserId: 7,
          confirmedAt: NOW,
          evidenceRef: 'approval_digest_1',
        },
      },
    }))).toThrow(expect.objectContaining({ code: 'DECISION_APPROVAL_REQUIRED', status: 409 }));

    expect(createDecisionMutationCommand(mutationInput({
      approval: {
        requiredLevel: 'strong_confirmation',
        evidence: {
          level: 'strong_confirmation',
          actorUserId: 7,
          confirmedAt: NOW,
          evidenceRef: 'approval_digest_2',
        },
      },
    }))).toMatchObject({ approval: { requiredLevel: 'strong_confirmation' } });
  });

  it('maps unexpected failures to a privacy-safe 500 instead of a validation error', () => {
    const error = normalizeDecisionCenterError(new Error('database password leaked here'));
    expect(error).toMatchObject({
      code: 'DECISION_INTERNAL_ERROR',
      status: 500,
      message: 'Decision Center could not complete the request.',
    });
    expect(error.message).not.toContain('password');
  });
});
