import { describe, expect, it } from 'vitest';
import { buildHomeOrchestrationSummary } from '../../src/api/routes/dashboard';
import type { DailyBriefResponse } from '../../src/services/daily-brief-orchestrator';

function makeBrief(overrides: Partial<DailyBriefResponse> = {}): DailyBriefResponse {
  return {
    date: '2026-04-20',
    generatedAt: '2026-04-20T08:00:00.000Z',
    degraded: false,
    gated: { skills: [] },
    garmin_stale: false,
    conflicts: [],
    creativeCopy: {
      headline: 'Creative fallback headline',
      note: 'Creative fallback note',
    },
    day: {
      date: '2026-04-20',
      weekday: 'segunda-feira',
      headline: 'Dia com foco protegido',
      training: {
        title: 'Recovery day',
        type: 'session',
        status: 'scheduled',
        durationMinutes: 40,
        intensity: 'low',
        reason: 'Recovery takes priority on this day',
        decisions: [],
      },
      meals: [],
      content: null,
      secretary: {
        focusBlock: null,
        pendingTasks: 4,
        overdueTasks: 1,
        travel: false,
        busy: true,
        priorityNote: 'Proteger o foco antes de adicionar mais contexto.',
        sequence: ['Fechar a manhã', 'Resolver admin depois do almoço'],
        tradeoffNote: 'A manhã está a ficar demasiado fragmentada.',
        decisions: [],
      },
      finance: null,
    } as any,
    coordination: {
      topPriority: 'Proteger o bloco profundo',
      executionOrder: ['Proteger o bloco profundo'],
      watchouts: ['Não empurres o foco para o fim do dia.'],
      handoffs: ['Conteúdo fica para sexta.'],
      confidence: 'high',
      dayOrchestration: {
        posture: 'meeting_salvage_day',
        title: 'Hoje protege foco antes de carga.',
        summary: 'Reserva 10:30–12:00 para o bloco principal e move o resto para depois de almoço.',
        confidence: 'high',
        mainThing: 'Bloco profundo antes de admin',
        reasons: ['A manhã está fragmentada.'],
        affectedSkills: ['secretary', 'training'],
      },
      weekOrchestration: {
        posture: 'consistency',
        title: 'Esta semana protege primeiro a consistência.',
        summary: 'Reduzimos a pressão hoje para preservar a sessão forte e a janela criativa de sexta.',
        confidence: 'high',
        reasons: ['Recuperação baixa no início da semana.'],
        affectedSkills: ['secretary', 'training', 'content'],
      },
      nextBestAction: {
        kind: 'protect_focus',
        title: 'Proteger foco das 10:30',
        summary: 'Reserva 10:30–12:00 para o trabalho mais importante do dia.',
        whyNow: 'Isto mantém a sessão-chave de terça e a janela criativa de sexta.',
        targetWindow: '10:30–12:00',
        urgency: 'today',
        confidence: 'high',
        affectedSkills: ['secretary', 'training'],
      },
      blockers: [
        {
          id: 'calendar-overload',
          kind: 'calendar_overload',
          severity: 'high',
          urgency: 'today',
          confidence: 'high',
          title: 'Agenda fragmentada',
          summary: 'A manhã está a partir o melhor bloco de execução.',
          affectedArea: 'calendar',
          affectedSkills: ['secretary'],
          recommendedAction: 'Agrupar admin e preservar foco.',
        },
      ],
      suggestedMoves: [],
      protectedBlocks: [
        {
          id: 'focus-window',
          type: 'focus',
          title: 'Bloco de foco protegido',
          summary: 'Amanhã continua com margem para trabalho profundo.',
          windowLabel: '10:30–12:00',
          quality: 'deep_focus',
          affectedSkills: ['secretary'],
        },
      ],
      risks: [],
      crossSkillImpacts: [
        {
          id: 'training',
          skillId: 'training',
          skillLabel: 'Treino',
          summary: 'Treino leve hoje para proteger a sessão forte.',
        },
        {
          id: 'content',
          skillId: 'content',
          skillLabel: 'Conteúdo',
          summary: 'Janela criativa preservada para sexta.',
        },
      ],
    },
    ...overrides,
  };
}

describe('dashboard home orchestration summary', () => {
  it('prefers rich coordination fields for hero, insight, and weekly decision', () => {
    const summary = buildHomeOrchestrationSummary(makeBrief(), 'pt-PT');

    expect(summary).not.toBeNull();
    expect(summary?.heroHeadline).toBe('Hoje protege foco antes de carga.');
    expect(summary?.heroDetail).toBe('Reserva 10:30–12:00 para o trabalho mais importante do dia.');
    expect(summary?.insightSummary).toBe('A manhã está a partir o melhor bloco de execução.');
    expect(summary?.weeklyHeadline).toBe('Esta semana protege primeiro a consistência.');
    expect(summary?.weeklyDetail).toBe('Reduzimos a pressão hoje para preservar a sessão forte e a janela criativa de sexta.');
    expect(summary?.headline).toBe('Esta semana protege primeiro a consistência.');
    expect(summary?.detail).toBe('Reduzimos a pressão hoje para preservar a sessão forte e a janela criativa de sexta.');
    expect(summary?.protectedLater).toBe('Isto mantém a sessão-chave de terça e a janela criativa de sexta.');
  });

  it('keeps weekly copy stable when the rich coordination fields are absent', () => {
    const summary = buildHomeOrchestrationSummary(
      makeBrief({
        coordination: {
          ...makeBrief().coordination,
          dayOrchestration: {
            ...makeBrief().coordination.dayOrchestration,
            title: '',
            summary: '',
          },
          weekOrchestration: {
            ...makeBrief().coordination.weekOrchestration,
            title: '',
            summary: '',
          },
          nextBestAction: null,
          blockers: [],
          protectedBlocks: [],
        },
      }),
      'pt-PT',
    );

    expect(summary).not.toBeNull();
    expect(summary?.headline).toBe('Dia com foco protegido');
    expect(summary?.detail).toBe('Conteúdo fica para sexta.');
  });

  it('does not fall back to raw execution-order prose for protectedLater on home', () => {
    const summary = buildHomeOrchestrationSummary(
      makeBrief({
        coordination: {
          ...makeBrief().coordination,
          nextBestAction: null,
          protectedBlocks: [],
          handoffs: [],
          executionOrder: ['Treat the existing calendar load as fixed before adding anything else.'],
        },
        day: {
          ...makeBrief().day,
          content: null,
        } as any,
      }),
      'pt-PT',
    );

    expect(summary).not.toBeNull();
    expect(summary?.protectedLater).toBeNull();
  });
});
