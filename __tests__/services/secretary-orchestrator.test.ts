import { describe, expect, it } from 'vitest';
import {
  buildSecretaryCoordination,
  type SecretaryOrchestrationInput,
} from '../../src/services/secretary-orchestrator';
import type { WeeklyPlanDay } from '../../src/services/weekly-plan-orchestrator';
import type { WeeklyPlanSourceHealth } from '../../src/services/secretary-planning-context';

function readySourceHealth(): WeeklyPlanSourceHealth {
  const ready = { status: 'ready' as const, warningCodes: [], warnings: [] };
  return {
    calendar: ready,
    tasks: ready,
    mail: ready,
    focus: ready,
    training: ready,
    cooking: ready,
    content: ready,
    finance: ready,
  };
}

function makeDay(overrides: Partial<WeeklyPlanDay> = {}): WeeklyPlanDay {
  return {
    date: '2026-04-20',
    weekday: 'Monday',
    headline: 'A stable day.',
    training: {
      title: 'Recovery run',
      type: 'run',
      status: 'planned',
      durationMinutes: 45,
      intensity: 'Easy',
      reason: 'Keep the planned session intact.',
      decisions: [],
    },
    meals: [],
    content: null,
    secretary: {
      focusBlock: null,
      pendingTasks: 2,
      overdueTasks: 0,
      tasksDueOnDate: 0,
      mailUnreadTotal: 0,
      calendarEventCount: 1,
      fragmented: false,
      criticalMeetingCount: 0,
      movableTaskCount: 2,
      fixedTaskCount: 0,
      portableTaskRatio: 1,
      writableCalendar: true,
      travel: false,
      busy: false,
      priorityNote: 'Protect the main block first.',
      sequence: ['Protect the main block.', 'Batch the smaller tasks later.'],
      tradeoffNote: null,
      decisions: [],
    },
    finance: null,
    ...overrides,
  };
}

function confirmedContent(
  overrides: Partial<NonNullable<WeeklyPlanDay['content']>> = {},
): NonNullable<WeeklyPlanDay['content']> {
  return {
    status: 'scheduled',
    planStatus: 'confirmed',
    scheduleAuthority: 'secretary',
    scheduleAuthorityStatus: 'current',
    scheduleSemantics: 'private_work_session',
    title: 'Confirmed Content work block',
    note: 'Secretary-confirmed private work session; this is not a publication commitment.',
    blockStart: '2026-04-20T13:30:00.000Z',
    blockEnd: '2026-04-20T15:00:00.000Z',
    confirmedBlocks: [{
      itemId: 41,
      title: 'Confirmed Content work block',
      authorityStatus: 'current',
      confirmationStatus: 'confirmed',
      itemStatus: 'approved',
      outcome: 'Record the approved Content item.',
      estimatedEffortMinutes: 90,
      dependency: null,
      approvalState: 'approved',
      nextAction: { action: 'none', label: 'No further action', reason: 'The block is ready.' },
      startsAt: '2026-04-20T13:30:00.000Z',
      endsAt: '2026-04-20T15:00:00.000Z',
      workKind: 'record',
      state: 'provider_synced',
      contentChangedSinceScheduling: false,
    }],
    decisions: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<SecretaryOrchestrationInput> = {}): SecretaryOrchestrationInput {
  const day = makeDay();
  return {
    date: day.date,
    day,
    weekPlan: {
      days: [day],
      conflicts: [],
      variant: 'steady',
    },
    conflicts: [],
    language: 'pt-PT',
    sourceHealth: readySourceHealth(),
    ...overrides,
  };
}

describe('secretary-orchestrator', () => {
  it('switches to salvage mode on overloaded fragmented days', () => {
    const overloadedDay = makeDay({
      training: {
        title: 'Track intervals',
        type: 'run',
        status: 'planned',
        durationMinutes: 60,
        intensity: 'Hard',
        reason: 'High-value training block today.',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Work on the recap',
        note: 'Use the confirmed private block for the recorded Content work.',
        blockStart: '2026-04-20T15:00:00.000Z',
        blockEnd: '2026-04-20T16:00:00.000Z',
      }),
      secretary: {
        ...makeDay().secretary,
        focusBlock: {
          start: '2026-04-20T10:00:00.000Z',
          end: '2026-04-20T11:30:00.000Z',
          note: 'Best focus block of the day.',
        },
        pendingTasks: 8,
        overdueTasks: 2,
        tasksDueOnDate: 4,
        mailUnreadTotal: 18,
        calendarEventCount: 6,
        fragmented: true,
        criticalMeetingCount: 2,
        busy: true,
        tradeoffNote: 'Training, content and admin are competing for the same day.',
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: overloadedDay,
      conflicts: [
        {
          id: 'conflict-1',
          date: '2026-04-20',
          target: 'primary-commitment',
          signalIds: [1 as any],
          signalTypes: ['deadline_pressure'],
          meshPriority: 1,
          message: 'Two fixed commitments are fighting for the same slot.',
        },
      ],
      weekPlan: {
        days: [overloadedDay],
        conflicts: [
          {
            id: 'conflict-1',
            date: '2026-04-20',
            target: 'primary-commitment',
            signalIds: [1 as any],
            signalTypes: ['deadline_pressure'],
            meshPriority: 1,
            message: 'Two fixed commitments are fighting for the same slot.',
          },
        ],
        variant: 'steady',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('meeting_salvage_day');
    expect(result.blockers[0]?.kind).toBe('calendar_overload');
    expect(result.nextBestAction?.kind).toBe('salvage_day');
    expect(result.suggestedMoves[0]?.action).toBe('protect');
    expect(result.suggestedMoves.length).toBeLessThanOrEqual(2);
    expect(result.executionOrder.length).toBeLessThanOrEqual(3);
  });

  it('protects recovery when training load and content pressure collide', () => {
    const recoveryDay = makeDay({
      training: {
        title: 'Recovery / open day',
        type: 'run',
        status: 'adjusted',
        durationMinutes: 30,
        intensity: 'Light',
        reason: 'Recovery is strained, so keep the day lighter.',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Filmar revisão',
        note: 'Secretary confirmed this private filming work session.',
        blockStart: '2026-04-20T14:00:00.000Z',
        blockEnd: '2026-04-20T15:30:00.000Z',
      }),
      meals: [
        {
          mealType: 'lunch',
          title: 'Bowl de recuperação',
          note: 'Keep fueling simple.',
          decisions: [],
        },
      ],
      secretary: {
        ...makeDay().secretary,
        focusBlock: {
          start: '2026-04-20T10:00:00.000Z',
          end: '2026-04-20T11:00:00.000Z',
          note: 'Light admin or writing fits here.',
        },
        calendarEventCount: 3,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: recoveryDay,
      weekPlan: {
        days: [recoveryDay, makeDay({ date: '2026-04-21', training: { ...recoveryDay.training, status: 'adjusted' } })],
        conflicts: [],
        variant: 'conservative',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('recovery_protected_day');
    expect(result.weekOrchestration.posture).toBe('recovery');
    expect(result.blockers.some((blocker) => blocker.kind == 'energy_constraint')).toBe(true);
    expect(result.protectedBlocks.some((block) => block.type == 'recovery' || block.type == 'training')).toBe(true);
    expect(result.crossSkillImpacts.map((impact) => impact.skillId)).toEqual(expect.arrayContaining(['training', 'content', 'cooking']));
  });

  it('does not let finance pressure override a recovery-protected day', () => {
    const recoveryWithAdminDay = makeDay({
      training: {
        title: 'Recovery spin',
        type: 'ride',
        status: 'adjusted',
        durationMinutes: 35,
        intensity: 'Light',
        reason: 'Recovery is low, so keep the day lighter and avoid extra friction.',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Review the draft',
        note: 'There is a confirmed private work block later.',
        blockStart: '2026-04-20T15:00:00.000Z',
        blockEnd: '2026-04-20T16:00:00.000Z',
      }),
      finance: {
        budgetNote: 'Finance/admin needs the first protected slot today.',
        taxNote: 'Tax payment is due today.',
        subscriptionNote: null,
        decisions: [],
      },
      secretary: {
        ...makeDay().secretary,
        focusBlock: {
          start: '2026-04-20T10:00:00.000Z',
          end: '2026-04-20T11:00:00.000Z',
          note: 'Only light admin or writing should happen here.',
        },
        calendarEventCount: 3,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: recoveryWithAdminDay,
      weekPlan: {
        days: [recoveryWithAdminDay],
        conflicts: [],
        variant: 'conservative',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('recovery_protected_day');
    expect(result.nextBestAction?.kind).toBe('lighten_day');
    expect(result.nextBestAction?.affectedSkills).toEqual(expect.arrayContaining(['training', 'content', 'secretary']));
  });

  it('stays coherent for a content-only user without assuming other skills', () => {
    const contentOnlyDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Validar ângulo e fechar roteiro',
        note: 'This private Content work block was confirmed by Secretary.',
        blockStart: '2026-04-20T11:00:00.000Z',
        blockEnd: '2026-04-20T12:30:00.000Z',
      }),
      meals: [],
      finance: null,
      secretary: {
        ...makeDay().secretary,
        focusBlock: {
          start: '2026-04-20T11:00:00.000Z',
          end: '2026-04-20T12:30:00.000Z',
          note: 'Clean creative slot.',
        },
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: contentOnlyDay,
      weekPlan: {
        days: [contentOnlyDay],
        conflicts: [],
        variant: 'push',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('high_output_day');
    expect(result.nextBestAction?.kind).toBe('work_content');
    expect(result.nextBestAction?.summary).toContain('não é uma promessa de publicação');
    expect(result.crossSkillImpacts.every((impact) => impact.skillId === 'content' || impact.skillId === 'secretary')).toBe(true);
    expect(result.protectedBlocks.some((block) => block.type == 'content')).toBe(true);
  });

  it('protects a current confirmed block when the bounded day projection is partial', () => {
    const partialDay = makeDay({
      content: confirmedContent({
        planStatus: 'partial',
        scheduleAuthorityStatus: 'partially_unavailable',
      }),
    });

    const result = buildSecretaryCoordination(makeInput({
      day: partialDay,
      weekPlan: {
        days: [partialDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.protectedBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'content' }),
    ]));
  });

  it.each([
    ['current authority', { authorityStatus: 'unavailable' }],
    ['confirmed status', { confirmationStatus: 'unconfirmed' }],
  ] as const)('does not trust a partial aggregate without per-block %s', (_label, invalidMarker) => {
    const partialContent = confirmedContent({
      planStatus: 'partial',
      scheduleAuthorityStatus: 'partially_unavailable',
    });
    const invalidBlock = {
      ...partialContent.confirmedBlocks[0],
      ...invalidMarker,
    } as unknown as NonNullable<WeeklyPlanDay['content']>['confirmedBlocks'][number];
    const partialDay = makeDay({
      content: {
        ...partialContent,
        confirmedBlocks: [invalidBlock],
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: partialDay,
      weekPlan: {
        days: [partialDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.protectedBlocks.some((block) => block.type === 'content')).toBe(false);
    expect(result.nextBestAction?.kind).not.toBe('work_content');
  });

  it('never protects an advisory Content proposal even when it includes suggested times', () => {
    const proposalDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      content: {
        // A legacy-looking top-level status must not override the structured
        // proposal semantics and current Secretary authority contract.
        status: 'scheduled',
        planStatus: 'proposed',
        scheduleAuthority: 'secretary',
        scheduleAuthorityStatus: 'current',
        scheduleSemantics: 'proposal_not_calendar_reservation',
        title: 'Proposed filming session',
        note: 'Recommendation only; Secretary has not confirmed a private work block.',
        blockStart: '2026-04-20T11:00:00.000Z',
        blockEnd: '2026-04-20T12:30:00.000Z',
        confirmedBlocks: [],
        decisions: [],
      },
      meals: [],
      finance: null,
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 0,
        sequence: [],
        priorityNote: null,
      },
    });
    const secondProposalDay = {
      ...proposalDay,
      date: '2026-04-21',
      weekday: 'Tuesday',
    };

    const result = buildSecretaryCoordination(makeInput({
      day: proposalDay,
      weekPlan: {
        days: [proposalDay, secondProposalDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.protectedBlocks.some((block) => block.type === 'content')).toBe(false);
    expect(result.nextBestAction?.kind).not.toBe('work_content');
    expect(result.dayOrchestration.posture).not.toBe('high_output_day');
    expect(result.weekOrchestration.posture).not.toBe('output');
    expect(result.weekOrchestration.title).not.toContain('confirmados');
  });

  it('never protects a Content block when Secretary authority is unavailable', () => {
    const unavailableDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      content: confirmedContent({
        planStatus: 'unavailable',
        scheduleAuthorityStatus: 'unavailable',
        note: 'Stale-looking times without current Secretary authority.',
      }),
      meals: [],
      finance: null,
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 0,
        sequence: [],
        priorityNote: null,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: unavailableDay,
      weekPlan: {
        days: [unavailableDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.protectedBlocks.some((block) => block.type === 'content')).toBe(false);
    expect(result.nextBestAction?.kind).not.toBe('work_content');
    expect(result.dayOrchestration.posture).not.toBe('high_output_day');
  });

  it('stays coherent for a training-only user and keeps content/cooking out of the stack', () => {
    const trainingOnlyDay = makeDay({
      content: null,
      meals: [],
      finance: null,
      training: {
        title: 'Long run',
        type: 'run',
        status: 'planned',
        durationMinutes: 90,
        intensity: 'Moderate',
        reason: 'This is the key training commitment of the day.',
        decisions: [],
      },
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        calendarEventCount: 2,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: trainingOnlyDay,
      weekPlan: {
        days: [trainingOnlyDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.crossSkillImpacts.every((impact) => impact.skillId === 'training' || impact.skillId === 'secretary')).toBe(true);
    expect(result.nextBestAction?.kind).toBe('protect_training');
  });

  it('treats a collision with a confirmed private Content block as a real blocker', () => {
    const deadlineDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Fechar o roteiro do recap',
        note: 'A Secretary confirmou esta sessão privada de trabalho.',
        blockStart: '2026-04-20T13:30:00.000Z',
        blockEnd: '2026-04-20T15:00:00.000Z',
      }),
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 5,
        overdueTasks: 1,
        tasksDueOnDate: 3,
        mailUnreadTotal: 9,
        calendarEventCount: 4,
        fragmented: true,
        criticalMeetingCount: 1,
        busy: true,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: deadlineDay,
      conflicts: [
        {
          id: 'deadline-1',
          date: '2026-04-20',
          target: 'primary-commitment',
          signalIds: [1 as any],
          signalTypes: ['shoot_day_locked', 'tax_deadline'],
          meshPriority: 1,
          message: 'O bloco privado de Content está a competir com outro compromisso confirmado.',
        },
      ],
      weekPlan: {
        days: [deadlineDay],
        conflicts: [
          {
            id: 'deadline-1',
            date: '2026-04-20',
            target: 'primary-commitment',
            signalIds: [1 as any],
            signalTypes: ['shoot_day_locked', 'tax_deadline'],
            meshPriority: 1,
            message: 'O bloco privado de Content está a competir com outro compromisso confirmado.',
          },
        ],
        variant: 'push',
      },
    }));

    expect(result.blockers[0]?.kind).toBe('deadline_collision');
    expect(result.suggestedMoves[0]?.targetWindow).toBe('14:30–16:00');
    expect(result.nextBestAction?.kind).toBe('work_content');
    expect(result.nextBestAction?.targetWindow).toBe('14:30–16:00');
    expect(result.nextBestAction?.summary).toContain('sem inferir publicação');
  });

  it('does not let finance pressure hide a real confirmed-work collision', () => {
    const financeAndDeadlineDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Fechar o roteiro do recap',
        note: 'This private Content work block was confirmed by Secretary.',
        blockStart: '2026-04-20T13:30:00.000Z',
        blockEnd: '2026-04-20T15:00:00.000Z',
      }),
      finance: {
        budgetNote: 'Admin needs a reliable slot today.',
        taxNote: 'Tax follow-up is due today.',
        subscriptionNote: null,
        decisions: [],
      },
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 5,
        overdueTasks: 1,
        tasksDueOnDate: 3,
        mailUnreadTotal: 9,
        calendarEventCount: 4,
        fragmented: true,
        criticalMeetingCount: 1,
        busy: true,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: financeAndDeadlineDay,
      conflicts: [
        {
          id: 'deadline-finance-1',
          date: '2026-04-20',
          target: 'primary-commitment',
          signalIds: [1 as any],
          signalTypes: ['shoot_day_locked', 'tax_deadline'],
          meshPriority: 1,
          message: 'O bloco privado de Content está a competir com outro compromisso confirmado.',
        },
      ],
      weekPlan: {
        days: [financeAndDeadlineDay],
        conflicts: [
          {
            id: 'deadline-finance-1',
            date: '2026-04-20',
            target: 'primary-commitment',
            signalIds: [1 as any],
            signalTypes: ['shoot_day_locked', 'tax_deadline'],
            meshPriority: 1,
            message: 'O bloco privado de Content está a competir com outro compromisso confirmado.',
          },
        ],
        variant: 'push',
      },
    }));

    expect(result.blockers[0]?.kind).toBe('deadline_collision');
    expect(result.nextBestAction?.kind).toBe('work_content');
    expect(result.nextBestAction?.targetWindow).toBe('14:30–16:00');
  });

  it('keeps reactive days focused on batching portable pressure instead of inventing deep work', () => {
    const reactiveDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      meals: [],
      content: null,
      finance: null,
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 7,
        overdueTasks: 2,
        tasksDueOnDate: 2,
        mailUnreadTotal: 14,
        calendarEventCount: 3,
        fragmented: true,
        criticalMeetingCount: 1,
        movableTaskCount: 6,
        fixedTaskCount: 1,
        portableTaskRatio: 0.85,
        busy: false,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: reactiveDay,
      weekPlan: {
        days: [reactiveDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('reactive_day');
    expect(result.blockers[0]?.kind).toBe('task_pressure');
    expect(result.suggestedMoves[0]?.action).toBe('batch');
    expect(result.nextBestAction?.kind).toBe('batch_overdue');
  });

  it('promotes focus-gap above generic task pressure when a fragmented day still has a high-value content window', () => {
    const fragmentedCreativeDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      content: confirmedContent({
        title: 'Escrever argumento final',
        note: 'A Secretary confirmou esta sessão privada de trabalho a meio do dia.',
        blockStart: '2026-04-20T12:00:00.000Z',
        blockEnd: '2026-04-20T13:15:00.000Z',
      }),
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 5,
        overdueTasks: 1,
        tasksDueOnDate: 1,
        mailUnreadTotal: 8,
        calendarEventCount: 3,
        fragmented: true,
        criticalMeetingCount: 1,
        movableTaskCount: 4,
        fixedTaskCount: 1,
        portableTaskRatio: 0.8,
        busy: false,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: fragmentedCreativeDay,
      weekPlan: {
        days: [fragmentedCreativeDay],
        conflicts: [],
        variant: 'push',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('reactive_day');
    expect(result.blockers[0]?.kind).toBe('focus_gap');
    expect(result.suggestedMoves[0]?.action).toBe('protect');
    expect(result.nextBestAction?.kind).toBe('protect_focus');
  });

  it('falls back gracefully for a secretary-only day with no meaningful coordination insight', () => {
    const secretaryOnlyDay = makeDay({
      training: {
        title: '',
        type: 'none',
        status: 'gated',
        durationMinutes: null,
        intensity: null,
        reason: '',
        decisions: [],
      },
      meals: [],
      content: null,
      finance: null,
      secretary: {
        ...makeDay().secretary,
        focusBlock: null,
        pendingTasks: 0,
        overdueTasks: 0,
        tasksDueOnDate: 0,
        mailUnreadTotal: 0,
        calendarEventCount: 0,
        sequence: [],
        priorityNote: null,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day: secretaryOnlyDay,
      weekPlan: {
        days: [secretaryOnlyDay],
        conflicts: [],
        variant: 'steady',
      },
    }));

    expect(result.dayOrchestration.posture).toBe('stable_day');
    expect(result.blockers).toHaveLength(0);
    expect(result.nextBestAction).toBeNull();
    expect(result.crossSkillImpacts).toHaveLength(1);
    expect(result.crossSkillImpacts[0]?.skillId).toBe('secretary');
    expect(result.confidence).toBe('low');
  });

  it('summarizes Secretary today with checked, handled, needs-user, and waiting states', () => {
    const day = makeDay({
      secretary: {
        ...makeDay().secretary,
        writableCalendar: false,
        pendingTasks: 5,
        tasksDueOnDate: 3,
        overdueTasks: 1,
        mailUnreadTotal: 9,
      },
    });

    const result = buildSecretaryCoordination(makeInput({
      day,
      weekPlan: { days: [day], conflicts: [], variant: 'steady' },
      language: 'en-US',
      secretaryTodaySignals: {
        handledCount: 1,
        handledTitles: ['Secretary reflowed the agenda and verified the state.'],
        needsUserCount: 1,
        needsUserTitles: ['Choose which commitment Secretary should protect.'],
        staleCount: 1,
        topUserAction: 'Choose the protected commitment.',
      },
    }));

    expect(result.secretaryToday.checked.map((entry) => entry.source)).toEqual(
      expect.arrayContaining(['agenda_sync', 'conflict_scan', 'reminders', 'coordination']),
    );
    expect(result.secretaryToday.handled[0]?.detail).toContain('reflowed');
    expect(result.secretaryToday.needsUser[0]?.detail).toContain('protect');
    expect(result.secretaryToday.waitingOnSource.map((entry) => entry.source)).toContain('source_health');
    expect(result.secretaryToday.nextBestMove).toBe('Choose the protected commitment.');
  });

  it('does not claim agenda, conflicts, tasks, or mail were checked when source health is not ready', () => {
    const unavailable = { status: 'unavailable' as const, warningCodes: ['SOURCE_UNAVAILABLE'], warnings: ['Unavailable.'] };
    const result = buildSecretaryCoordination(makeInput({
      sourceHealth: {
        calendar: unavailable,
        tasks: unavailable,
        mail: unavailable,
      },
    }));

    const checkedIds = result.secretaryToday.checked.map((entry) => entry.id);
    expect(checkedIds).not.toEqual(expect.arrayContaining(['agenda-sync', 'conflict-scan', 'reminder-pressure']));
    expect(result.secretaryToday.waitingOnSource.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['source-health-calendar', 'source-health-tasks', 'source-health-mail']),
    );
    expect(result.secretaryToday.summary).not.toContain('Agenda checked');
  });

  it('keeps a healthy calendar with unknown write capability separate from source availability', () => {
    const secretary = { ...makeDay().secretary };
    delete secretary.writableCalendar;
    const day = makeDay({
      secretary,
    });
    const result = buildSecretaryCoordination(makeInput({
      day,
      weekPlan: { days: [day], conflicts: [], variant: 'steady' },
      language: 'en-US',
    }));

    expect(result.secretaryToday.checked).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'agenda-sync',
        detail: expect.stringContaining('read, but calendar write access is not available'),
      }),
    ]));
    expect(result.secretaryToday.waitingOnSource.map((entry) => entry.id))
      .not.toContain('calendar-write-unavailable');
    expect(result.secretaryToday.summary).not.toContain('source still needs to confirm');
  });
});
