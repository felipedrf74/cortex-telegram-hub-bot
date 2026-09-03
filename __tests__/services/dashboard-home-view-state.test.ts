import { describe, expect, it } from 'vitest';
import {
  buildDashboardHomeViewState,
  type DashboardHomeBuildInput,
} from '../../src/services/dashboard-home-view-state';

function makeInput(overrides: Partial<DashboardHomeBuildInput> = {}): DashboardHomeBuildInput {
  return {
    readinessScore: 74,
    bodyBattery: 62,
    tasksDue: 1,
    overdueTasks: 0,
    eventsCount: 2,
    nextEventTitle: 'Bloco de foco',
    nextEventTime: '10:00',
    nextEventSource: 'Outlook',
    hasCalendarUnavailable: false,
    trainingTitle: 'Corrida',
    trainingTime: '07:00',
    trainingDurationMinutes: 45,
    trainingStatus: 'ready',
    contentHeadline: '2 prontos na mesa',
    contentSubline: 'Janela de gravação na sexta',
    cookingHeadline: 'Bowl de recuperação',
    cookingSubline: 'Hoje · almoço',
    financeHeadline: '€ 239 gastos',
    financeSubline: '€ 88 líquido',
    orchestrationSummary: null,
    warningMessages: [],
    secretaryItems: [
      {
        id: '1',
        time: '10:00–11:00',
        title: 'Bloco de foco',
        source: 'Outlook',
        isNow: false,
        isPast: false,
      },
    ],
    secretarySummary: 'Próximo bloco às 10:00',
    ...overrides,
  };
}

describe('dashboard-home-view-state', () => {
  it('marks recovery protected when readiness is low', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        readinessScore: 54,
        bodyBattery: 38,
        orchestrationSummary: {
          headline: 'Hoje protegemos recuperação para sustentar consistência.',
          detail: 'A recuperação caiu e o sistema abriu margem.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino ajustado' },
          ],
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('recoveryProtected');
    expect(viewState.meta.source).toBe('server');
    expect(viewState.meta.isFallback).toBe(false);
    expect(viewState.hero.title).toBe('Hoje pede margem');
    expect(viewState.hero.primaryAction.target).toBe('training');
    expect(viewState.skillQueue[0]?.whyNow).toBe('O treino foi mantido mais leve para proteger a consistência da semana.');
    expect(viewState.skillQueue[0]?.confidenceText).toBe('Confiança alta');
  });

  it('marks overloaded when overdue pressure is high', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        tasksDue: 3,
        overdueTasks: 2,
        eventsCount: 5,
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('overloaded');
    expect(viewState.quickActions[0]?.target).toBe('tasks');
  });

  it('marks competing priorities when multiple strong fronts are active together', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        overdueTasks: 1,
        eventsCount: 4,
        orchestrationSummary: {
          headline: 'Hoje pede ordem entre treino, agenda e execução.',
          detail: 'Há várias frentes legítimas a competir.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino importante hoje.' },
            { id: 'content', domain: 'content', detail: 'Janela boa para gravação.' },
          ],
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('competingPriorities');
    expect(viewState.coordinatedDecision?.stateLabel).toBe('Define ordem');
  });

  it('does not turn a generic Content block into protected filming time', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        orchestrationSummary: {
          headline: 'Today needs a clear execution order.',
          detail: 'Content and training both need review.',
          protectedLater: null,
          impacts: [
            { id: 'content', domain: 'content', detail: 'Confirmed Content block needs review' },
          ],
          watchouts: [],
        },
      }),
      'en-US',
    );

    const contentOutcome = viewState.coordinatedWeek?.outcomes.find((outcome) => outcome.skillId === 'content');
    expect(contentOutcome?.decisionTitle).toBe('Content work block');
    expect(contentOutcome?.decisionTitle).not.toMatch(/film|preserv|protect/i);
  });

  it('marks cross-skill conflict when pressure collides with recovery constraints', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        readinessScore: 58,
        bodyBattery: 40,
        overdueTasks: 1,
        eventsCount: 4,
        orchestrationSummary: {
          headline: 'Hoje protegemos margem para não partir a semana.',
          detail: 'Recuperação, tarefas e agenda estão a colidir.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino mais leve.' },
            { id: 'cooking', domain: 'cooking', detail: 'Refeição alinhada.' },
          ],
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('crossSkillConflict');
    expect(viewState.coordinatedDecision?.stateLabel).toBe('Resolve conflito');
  });

  it('marks no next action when the day is open', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        tasksDue: 0,
        overdueTasks: 0,
        eventsCount: 0,
        nextEventTitle: null,
        nextEventTime: null,
        nextEventSource: null,
        trainingTitle: null,
        trainingTime: null,
        trainingDurationMinutes: null,
        contentHeadline: 'Nenhuma ideia ainda',
        contentSubline: 'Toque para planear',
        secretaryItems: [],
        secretarySummary: 'Dia aberto',
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('noNextAction');
    expect(viewState.hero.primaryAction.target).toBe('contentRadar');
  });

  it('promotes coordinated decision when orchestration summary exists', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        orchestrationSummary: {
          headline: 'Hoje protegemos recuperação para sustentar consistência.',
          detail: 'A recuperação caiu, por isso treino e cozinha ficaram mais leves.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino com menos carga.' },
            { id: 'cooking', domain: 'cooking', detail: 'Refeição de suporte pronta.' },
          ],
        },
      }),
      'pt-BR',
    );

    expect(viewState.coordinatedDecision?.summary).toBe('Hoje protegemos recuperação para sustentar consistência.');
    expect(viewState.coordinatedDecision?.stateLabel).toBe('Protege consistência');
    expect(viewState.coordinatedDecision?.confidenceText).toBe('Confiança moderada');
    expect(viewState.coordinatedDecision?.protectedLater).toBeNull();
    expect(viewState.coordinatedDecision?.impacts).toHaveLength(2);
    expect(viewState.coordinatedDecision?.primaryAction.target).toBe('dayPlan');
  });

  it('builds a skill-aware coordinated week contract with ranked outcomes', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        orchestrationSummary: {
          headline: 'Hoje protegemos recuperação para sustentar consistência.',
          detail: 'A recuperação caiu, por isso treino e cozinha ficaram mais leves.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino com menos carga.' },
            { id: 'cooking', domain: 'cooking', detail: 'Refeição de suporte pronta.' },
          ],
        },
      }),
      'pt-BR',
    );

    expect(viewState.coordinatedWeek?.weeklyPosture).toBe('Hoje protegemos recuperação para sustentar consistência.');
    expect(viewState.coordinatedWeek?.summary).toBe('A recuperação caiu, por isso treino e cozinha ficaram mais leves.');
    expect(viewState.coordinatedWeek?.stateLabel).toBe('Protege consistência');
    expect(viewState.coordinatedWeek?.confidenceText).toBe('Confiança alta');
    expect(viewState.coordinatedWeek?.outcomes).toHaveLength(3);
    expect(viewState.coordinatedWeek?.outcomes[0]?.skillId).toBe('training');
    expect(viewState.coordinatedWeek?.outcomes.some((outcome) => outcome.skillId === 'content')).toBe(true);
    expect(viewState.coordinatedWeek?.primaryAction.target).toBe('dayPlan');
  });

  it('respects explicit skill availability and degrades to a single-outcome weekly card', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        tasksDue: 0,
        trainingTitle: null,
        trainingTime: null,
        trainingDurationMinutes: null,
        trainingStatus: 'unavailable',
        cookingHeadline: 'Planear refeições',
        cookingSubline: null,
        financeHeadline: '€ 0 gastos',
        financeSubline: null,
        skillAvailability: {
          availableSkills: ['secretary', 'content'],
          hiddenSkills: ['training', 'cooking', 'finance'],
          capabilityFlags: {
            secretary: true,
            training: false,
            cooking: false,
            content: true,
            finance: false,
          },
        },
        orchestrationSummary: {
          headline: 'Esta semana protege a melhor janela criativa.',
          detail: 'A gravação foi empurrada para sexta para encaixar melhor energia e agenda.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino leve hoje.' },
            { id: 'content', domain: 'content', detail: 'Janela de gravação preservada.' },
          ],
        },
      }),
      'pt-BR',
    );

    expect(viewState.coordinatedWeek?.outcomes.map((outcome) => outcome.skillId)).toEqual(['content']);
    expect(viewState.coordinatedWeek?.outcomes.every((outcome) => (
      viewState.coordinatedWeek?.skillAvailability.availableSkills.includes(outcome.skillId)
    ))).toBe(true);
    expect(viewState.coordinatedWeek?.outcomes[0]?.tint).toBe('content');
    expect(viewState.coordinatedWeek?.outcomes[0]?.icon).toBe('sparkles');
    expect(viewState.coordinatedWeek?.fallbackMode).toBe('singleOutcome');
    expect(viewState.coordinatedWeek?.secondaryAction?.target).toBe('contentRadar');
    expect(viewState.coordinatedWeek?.skillAvailability.availableSkills).toEqual(['secretary', 'content']);
  });

  it('builds attention insights from warning messages and watchouts', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        warningMessages: ['O Outlook Calendar está indisponível agora.'],
        orchestrationSummary: {
          headline: 'Hoje protegemos recuperação para sustentar consistência.',
          detail: 'A recuperação caiu, por isso treino e cozinha ficaram mais leves.',
          protectedLater: 'Isto protege a sessão-chave de terça e mantém margem para gravar na sexta.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino com menos carga.' },
          ],
          watchouts: ['Evita empurrar a sessão forte para o fim do dia.'],
        },
      }),
      'pt-BR',
    );

    expect(viewState.insights).toHaveLength(2);
    expect(viewState.insights[0]?.target).toBe('training');
    expect(viewState.coordinatedDecision?.stateLabel).toBe('Protege consistência');
    expect(viewState.coordinatedDecision?.confidenceText).toBe('Confiança alta');
    expect(viewState.insights[0]?.title).toBe('Presta atenção');
    expect(viewState.insights[1]?.target).toBe('connections');
    expect(viewState.coordinatedDecision?.protectedLater).toContain('sessão-chave');
  });

  it('deduplicates repeated insight summaries across warnings and watchouts', () => {
    const duplicatedMessage = 'Body Battery indisponível.';

    const viewState = buildDashboardHomeViewState(
      makeInput({
        orchestrationSummary: {
          headline: 'Hoje protegemos recuperação para sustentar consistência.',
          detail: 'A recuperação caiu, por isso treino e cozinha ficaram mais leves.',
          protectedLater: null,
          watchouts: [duplicatedMessage],
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino com menos carga.' },
          ],
        },
        warningMessages: [duplicatedMessage],
      }),
      'pt-BR',
    );

    expect(viewState.insights).toHaveLength(1);
    expect(viewState.insights[0]?.summary).toBe(duplicatedMessage);
  });

  it('uses the executive orchestration fields without repeating the same reasoning across hero and week cards', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        orchestrationSummary: {
          headline: 'Esta semana protege primeiro a consistência.',
          detail: 'A carga foi redistribuída para manter a semana executável.',
          heroHeadline: 'Hoje protege foco antes de carga.',
          heroDetail: 'Reserva 10:30–12:00 para o bloco principal e empurra o resto para depois de almoço.',
          insightSummary: 'A manhã está a fragmentar o melhor bloco de execução.',
          weeklyHeadline: 'Esta semana protege primeiro a consistência.',
          weeklyDetail: 'Reduzimos a pressão hoje para preservar a sessão forte e a janela de gravação.',
          protectedLater: 'Isto mantém a sessão-chave de terça e a janela criativa de sexta.',
          impacts: [
            { id: 'training', domain: 'training', detail: 'Treino leve hoje.' },
            { id: 'content', domain: 'content', detail: 'Janela de gravação preservada.' },
          ],
          watchouts: ['Não empurres o bloco profundo para o fim do dia.'],
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.whyNow).toBe('Reserva 10:30–12:00 para o bloco principal e empurra o resto para depois de almoço.');
    expect(viewState.insights[0]?.summary).toBe('A manhã está a fragmentar o melhor bloco de execução.');
    expect(viewState.coordinatedWeek?.weeklyPosture).toBe('Esta semana protege primeiro a consistência.');
    expect(viewState.coordinatedWeek?.summary).toBe('Reduzimos a pressão hoje para preservar a sessão forte e a janela de gravação.');
    expect(viewState.coordinatedDecision?.reason).toBe('Reduzimos a pressão hoje para preservar a sessão forte e a janela de gravação.');
  });

  it('keeps explicit meta when the route marks the home contract as partial', () => {
    const viewState = buildDashboardHomeViewState(
      makeInput({
        meta: {
          source: 'server',
          isFallback: true,
          isPartial: true,
          isStale: false,
          generatedAt: '2026-04-19T10:00:00.000Z',
          reasonCodes: ['DAILY_BRIEF_UNAVAILABLE', 'CALENDAR_UNAVAILABLE'],
        },
      }),
      'pt-BR',
    );

    expect(viewState.meta.isFallback).toBe(true);
    expect(viewState.meta.reasonCodes).toEqual(['DAILY_BRIEF_UNAVAILABLE', 'CALENDAR_UNAVAILABLE']);
  });
});
