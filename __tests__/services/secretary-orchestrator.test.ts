import { describe, expect, it } from 'vitest';
import {
  buildSecretaryCoordination,
  type SecretaryOrchestrationInput,
} from '../../src/services/secretary-orchestrator';
import type { WeeklyPlanDay } from '../../src/services/weekly-plan-orchestrator';

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
      content: {
        status: 'scheduled',
        title: 'Publicar recap',
        note: 'Ship the recap today.',
        blockStart: '2026-04-20T15:00:00.000Z',
        blockEnd: '2026-04-20T16:00:00.000Z',
        decisions: [],
      },
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
      content: {
        status: 'scheduled',
        title: 'Filmar revisão',
        note: 'Creative window is open in the afternoon.',
        blockStart: '2026-04-20T14:00:00.000Z',
        blockEnd: '2026-04-20T15:30:00.000Z',
        decisions: [],
      },
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
      content: {
        status: 'scheduled',
        title: 'Validar ângulo e fechar roteiro',
        note: 'This is the best clean creative slot of the day.',
        blockStart: '2026-04-20T11:00:00.000Z',
        blockEnd: '2026-04-20T12:30:00.000Z',
        decisions: [],
      },
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
    expect(result.nextBestAction?.kind).toBe('ship_content');
    expect(result.crossSkillImpacts.every((impact) => impact.skillId === 'content' || impact.skillId === 'secretary')).toBe(true);
    expect(result.protectedBlocks.some((block) => block.type == 'content')).toBe(true);
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

  it('treats a hard delivery conflict as the top blocker on a deadline-heavy content day', () => {
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
      content: {
        status: 'scheduled',
        title: 'Fechar roteiro e publicar recap',
        note: 'A única janela de entrega útil fica entre almoço e tarde.',
        blockStart: '2026-04-20T13:30:00.000Z',
        blockEnd: '2026-04-20T15:00:00.000Z',
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
      day: deadlineDay,
      conflicts: [
        {
          id: 'deadline-1',
          date: '2026-04-20',
          target: 'publishing-window',
          signalIds: [1 as any],
          signalTypes: ['publishing_commitment'],
          meshPriority: 1,
          message: 'A entrega de conteúdo está a competir com a única janela útil da tarde.',
        },
      ],
      weekPlan: {
        days: [deadlineDay],
        conflicts: [
          {
            id: 'deadline-1',
            date: '2026-04-20',
            target: 'publishing-window',
            signalIds: [1 as any],
            signalTypes: ['publishing_commitment'],
            meshPriority: 1,
            message: 'A entrega de conteúdo está a competir com a única janela útil da tarde.',
          },
        ],
        variant: 'push',
      },
    }));

    expect(result.blockers[0]?.kind).toBe('deadline_collision');
    expect(result.suggestedMoves[0]?.targetWindow).toBe('14:30–16:00');
    expect(result.nextBestAction?.kind).toBe('ship_content');
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
      content: {
        status: 'scheduled',
        title: 'Escrever argumento final',
        note: 'Ainda há uma boa janela criativa a meio do dia.',
        blockStart: '2026-04-20T12:00:00.000Z',
        blockEnd: '2026-04-20T13:15:00.000Z',
        decisions: [],
      },
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
});
