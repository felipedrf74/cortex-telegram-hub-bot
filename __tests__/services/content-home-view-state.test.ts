import { describe, expect, it } from 'vitest';
import { buildContentHomeViewState, type ContentHomeBuildInput } from '../../src/services/content-home-view-state';

function makeInput(overrides: Partial<ContentHomeBuildInput> = {}): ContentHomeBuildInput {
  return {
    pipeline: null,
    ideas: [],
    topics: [],
    discovery: null,
    script: null,
    optimization: null,
    filmingRecommendation: null,
    hasAttemptedLoad: true,
    lastLoadError: null,
    ...overrides,
  };
}

describe('content-home-view-state', () => {
  it('promotes radar when the creator has no idea in motion yet', () => {
    const viewState = buildContentHomeViewState(makeInput(), 'pt-BR');

    expect(viewState.hero.state).toBe('noIdeaYet');
    expect(viewState.meta.source).toBe('server');
    expect(viewState.meta.isFallback).toBe(false);
    expect(viewState.hero.primaryAction.target).toBe('radar');
    expect(viewState.flow.steps[0]?.status).toBe('current');
    expect(viewState.emptyState).not.toBeNull();
  });

  it('does not mark ready to film from filming recommendation alone without mature execution work', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        filmingRecommendation: {
          date: '2026-04-24',
          confidence: 'high',
          localizedReason: 'Só há treino leve planeado, por isso deve ser mais fácil filmar bem.',
          localizedConfidenceLabel: 'Alta confiança',
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('noIdeaYet');
    expect(viewState.hero.primaryAction.target).toBe('radar');
  });

  it('promotes filming when a mature execution step exists and a window is available', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          stages: {
            ideas: [],
            scripted: [{ title: 'AI creator stack' }],
            filmed: [],
            editing: [],
            published: [],
          },
        },
        filmingRecommendation: {
          date: '2026-04-24',
          confidence: 'high',
          localizedReason: 'Só há treino leve planeado, por isso deve ser mais fácil filmar bem.',
          localizedConfidenceLabel: 'Alta confiança',
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('readyToFilm');
    expect(viewState.hero.primaryAction.target).toBe('schedule');
    expect(viewState.flow.steps[2]?.status).toBe('current');
  });

  it('marks scheduled when the next piece is already protected on the calendar', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        topics: [
          { status: 'planned', scheduledDate: '2026-04-24' },
        ],
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('scheduled');
    expect(viewState.hero.primaryAction.target).toBe('schedule');
  });

  it('marks cross-skill opportunity when there is a good window but no mature execution yet', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        discovery: {
          activeCount: 2,
          deskReadyCount: 1,
          monitoredPillars: [],
          deskItems: [{ title: 'Tema com boa janela', body: 'Está a encaixar bem na semana.' }],
        },
        filmingRecommendation: {
          date: '2026-04-24',
          confidence: 'high',
          localizedReason: 'A semana abriu uma janela boa para filmar.',
          localizedConfidenceLabel: 'Alta confiança',
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('crossSkillOpportunity');
    expect(viewState.hero.primaryAction.target).toBe('scriptGenerator');
  });

  it('marks empty pipeline when there is history but nothing new in motion', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          stages: {
            ideas: [],
            scripted: [],
            filmed: [],
            editing: [],
            published: [{ title: 'Published 1' }],
          },
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('emptyPipeline');
    expect(viewState.emptyState?.action.target).toBe('radar');
  });

  it('detects backlog overload before promoting new creation work', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          stages: {
            ideas: [{ title: 'Idea 1' }, { title: 'Idea 2' }, { title: 'Idea 3' }],
            scripted: [{ title: 'Script 1' }, { title: 'Script 2' }],
            filmed: [],
            editing: [{ title: 'Edit 1' }],
            published: [],
          },
        },
        topics: [
          { status: 'drafting', scheduledDate: null },
          { status: 'ready', scheduledDate: null },
        ],
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('backlogOverload');
    expect(viewState.hero.primaryAction.target).toBe('pipeline');
    expect(viewState.actions[0]?.target).toBe('pipeline');
  });

  it('surfaces learning when optimization is active and recent publishing exists', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          stages: {
            ideas: [],
            scripted: [],
            filmed: [],
            editing: [],
            published: [{ title: 'Published 1' }],
          },
        },
        optimization: {
          activeInsightCount: 2,
          recentSignals: [{ title: 'Performance dos hooks', summary: 'Há um padrão recente sobre o que está a segurar melhor a audiência.' }],
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('learningAvailable');
    expect(viewState.hero.primaryAction.target).toBe('learnings');
  });

  it('keeps pt-BR creator copy out of pt-PT wording on the render-ready contract', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        discovery: {
          activeCount: 1,
          deskReadyCount: 0,
          monitoredPillars: [],
          deskItems: [],
        },
        script: {
          hasBrandVoice: true,
          voicePatternCount: 9,
          referenceChannelCount: 6,
          sourceCount: 3,
        },
        optimization: {
          activeInsightCount: 1,
          recentSignals: [],
        },
      }),
      'pt-BR',
    );

    const effects = viewState.reasoning?.signals.map((signal) => signal.effect).join(' ');

    expect(effects).toContain('Sua voz já tem 9 padrões ativos');
    expect(effects).toContain('1 sinal já está empurrando o próximo tema.');
    expect(effects).not.toContain('A tua voz');
    expect(effects).not.toContain('estão a empurrar');
  });

  it('keeps explicit partial meta when the route had to degrade some content reads', () => {
    const viewState = buildContentHomeViewState(makeInput({
      meta: {
        source: 'server',
        isFallback: true,
        isPartial: true,
        isStale: false,
        generatedAt: '2026-04-19T10:00:00.000Z',
        reasonCodes: ['PIPELINE_UNAVAILABLE', 'TOPICS_UNAVAILABLE'],
      },
    }), 'pt-BR');

    expect(viewState.meta.isFallback).toBe(true);
    expect(viewState.meta.reasonCodes).toEqual(['PIPELINE_UNAVAILABLE', 'TOPICS_UNAVAILABLE']);
  });
});
