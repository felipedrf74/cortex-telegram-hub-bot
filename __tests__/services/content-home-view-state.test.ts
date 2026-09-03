import { describe, expect, it } from 'vitest';
import { buildContentHomeViewState, type ContentHomeBuildInput } from '../../src/services/content-home-view-state';

const publicationTracking = {
  availability: 'unavailable',
  reasonCode: 'CONTENT_PUBLICATION_TRACKING_NOT_SUPPORTED',
  publicationExecution: 'not_supported',
} as const;

function makeInput(overrides: Partial<ContentHomeBuildInput> = {}): ContentHomeBuildInput {
  return {
    pipeline: null,
    ideas: [],
    topics: [],
    workSchedule: null,
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

  it('promotes filming work while keeping its recommended date review-bound', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          publicationTracking,
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
        workSchedule: {
          confirmedThisWeek: 0,
          attentionThisWeek: 0,
          authorityStatus: 'current',
          semantics: 'private_work_session',
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('readyToFilm');
    expect(viewState.hero.primaryAction.target).toBe('schedule');
    expect(viewState.hero.confidence).toBe('Revisão necessária');
    expect(viewState.reasoning?.confidence).toBe('Revisão necessária');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'schedule',
        detail: 'A recomendação é uma proposta e requer confirmação da Secretary antes de reservar tempo.',
        tone: 'caution',
      }),
    ]));
    expect(viewState.flow.steps[2]?.status).toBe('current');
  });

  it('keeps filming recommendations review-bound when schedule authority is partial', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          publicationTracking,
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
          localizedReason: 'A calendar window appears favorable.',
          localizedConfidenceLabel: 'High confidence',
        },
        workSchedule: {
          confirmedThisWeek: 1,
          attentionThisWeek: 1,
          authorityStatus: 'partially_unavailable',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.hero.state).toBe('readyToFilm');
    expect(viewState.hero.confidence).toBe('Review required');
    expect(viewState.reasoning?.confidence).toBe('Review required');
    expect(viewState.reasoning?.summary).toContain('plan status is partial');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'schedule',
        detail: 'The recommendation is a proposal and requires Secretary confirmation before it reserves time.',
        tone: 'caution',
      }),
      expect.objectContaining({
        id: 'schedule-authority',
        effect: 'Schedule authority is partial and plan status is partial.',
        tone: 'caution',
      }),
    ]));
  });

  it('does not present a cross-skill filming window as high confidence when schedule authority is unavailable', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        discovery: {
          activeCount: 1,
          deskReadyCount: 1,
          monitoredPillars: [],
          deskItems: [{ title: 'Useful signal', body: 'Ready for review.' }],
        },
        filmingRecommendation: {
          date: '2026-04-24',
          confidence: 'high',
          localizedReason: 'A calendar window appears favorable.',
          localizedConfidenceLabel: 'High confidence',
        },
        workSchedule: {
          confirmedThisWeek: 0,
          attentionThisWeek: 0,
          authorityStatus: 'unavailable',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.hero.state).toBe('crossSkillOpportunity');
    expect(viewState.hero.confidence).toBe('Review required');
    expect(viewState.reasoning?.confidence).toBe('Review required');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'schedule-authority',
        effect: 'Schedule authority is unavailable and plan status is unavailable.',
        tone: 'caution',
      }),
    ]));
  });

  it('treats a legacy topic date as a workspace deadline, not a scheduled work block', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        topics: [
          { status: 'planned', scheduledDate: '2026-04-24' },
        ],
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('scriptInProgress');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deadline', detail: 'Um prazo não é um evento de calendário.' }),
    ]));
    expect(viewState.pipelineHealth.metrics.find((metric) => metric.id === 'scheduled')?.value).toBe('0');
  });

  it('keeps a current provider-attention block confirmed and exposes its attention separately', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        workSchedule: {
          confirmedThisWeek: 1,
          attentionThisWeek: 1,
          authorityStatus: 'current',
          semantics: 'private_work_session',
        },
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('scheduled');
    expect(viewState.hero.primaryAction.target).toBe('schedule');
    expect(viewState.hero.summary).toContain('não agenda nem executa a publicação');
    expect(viewState.hero.confidence).toBe('Revisão necessária');
    expect(viewState.workSchedule).toMatchObject({
      authority: 'secretary',
      authorityStatus: 'current',
      planStatus: 'confirmed',
      attentionThisWeek: 1,
    });
    expect(viewState.pipelineHealth.metrics.find((metric) => metric.id === 'scheduled')).toMatchObject({
      label: 'Blocos de trabalho',
      value: '1',
    });
    expect(viewState.pipelineHealth.metrics.find((metric) => metric.id === 'attention')?.value).toBe('1');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'schedule-authority',
        effect: expect.stringContaining('estado de sincronização ou agenda que precisa de atenção'),
      }),
    ]));
  });

  it('labels a partially authoritative work plan as partial without hiding confirmed blocks', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        workSchedule: {
          confirmedThisWeek: 1,
          attentionThisWeek: 1,
          authorityStatus: 'partially_unavailable',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.hero.state).toBe('scheduled');
    expect(viewState.hero.subtitle).toContain('Plan status: partial');
    expect(viewState.hero.summary).toContain('overall plan status is partial');
    expect(viewState.workSchedule).toMatchObject({
      authority: 'secretary',
      confirmedThisWeek: 1,
      authorityStatus: 'partially_unavailable',
      planStatus: 'partial',
    });
    expect(viewState.meta).toMatchObject({ isFallback: false, isPartial: true });
    expect(viewState.meta.reasonCodes).toContain('CONTENT_SCHEDULE_AUTHORITY_PARTIAL');
    expect(viewState.reasoning?.confidence).toBe('Review required');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'schedule-authority', tone: 'caution' }),
    ]));
  });

  it('exposes unavailable schedule authority as unavailable', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        workSchedule: {
          confirmedThisWeek: 0,
          attentionThisWeek: 0,
          authorityStatus: 'unavailable',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.workSchedule).toMatchObject({
      authority: 'secretary',
      authorityStatus: 'unavailable',
      planStatus: 'unavailable',
    });
    expect(viewState.meta).toMatchObject({ isFallback: false, isPartial: true });
    expect(viewState.meta.reasonCodes).toContain('CONTENT_SCHEDULE_AUTHORITY_UNAVAILABLE');
  });

  it('reports a current zero-block schedule as unplanned, not confirmed', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        workSchedule: {
          confirmedThisWeek: 0,
          attentionThisWeek: 0,
          authorityStatus: 'current',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.workSchedule).toMatchObject({
      authority: 'secretary',
      authorityStatus: 'current',
      confirmedThisWeek: 0,
      planStatus: 'unplanned',
    });
  });

  it('keeps attention-only cancellation state unplanned rather than inventing a proposal', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        workSchedule: {
          confirmedThisWeek: 0,
          attentionThisWeek: 2,
          authorityStatus: 'current',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.workSchedule).toMatchObject({
      authorityStatus: 'current',
      confirmedThisWeek: 0,
      attentionThisWeek: 2,
      planStatus: 'unplanned',
    });
    expect(viewState.pipelineHealth.metrics.find((metric) => metric.id === 'attention')?.value).toBe('2');
  });

  it('reports a current recommendation without a confirmed block as proposed', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        filmingRecommendation: {
          date: '2026-04-24',
          confidence: 'high',
          localizedReason: 'This date is only a recommended work date.',
          localizedConfidenceLabel: 'High confidence',
        },
        workSchedule: {
          confirmedThisWeek: 0,
          attentionThisWeek: 0,
          authorityStatus: 'current',
          semantics: 'private_work_session',
        },
      }),
      'en',
    );

    expect(viewState.workSchedule.planStatus).toBe('proposed');
    expect(viewState.reasoning?.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'schedule-authority',
        effect: expect.stringContaining('window remains proposed until Secretary confirms'),
      }),
    ]));
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

  it('does not treat an internal published workflow label as external publication history', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          publicationTracking,
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

    expect(viewState.hero.state).toBe('noIdeaYet');
    expect(viewState.pipelineHealth.metrics.find((metric) => metric.id === 'published')).toMatchObject({
      value: 'Não monitorizada',
      tint: 'info',
    });
    expect(viewState.pipelineHealth.publicationTracking).toEqual(publicationTracking);
  });

  it('detects backlog overload before promoting new creation work', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          publicationTracking,
          stages: {
            ideas: [{ title: 'Idea 1' }, { title: 'Idea 2' }, { title: 'Idea 3' }],
            scripted: [{ title: 'Script 1' }, { title: 'Script 2' }],
            filmed: [],
            editing: [{ title: 'Edit 1' }, { title: 'Edit 2' }],
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

  it('does not double-count compatibility topics already represented in the canonical pipeline', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          publicationTracking,
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
          { status: 'ready', scheduledDate: '2026-04-24' },
        ],
      }),
      'pt-BR',
    );

    expect(viewState.hero.state).toBe('readyToFilm');
    expect(viewState.reasoning?.signals.find((signal) => signal.id === 'backlog')).toBeUndefined();
  });

  it('surfaces measured learning without inferring that Nexus observed publication', () => {
    const viewState = buildContentHomeViewState(
      makeInput({
        pipeline: {
          publicationTracking,
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
    expect(viewState.meta.reasonCodes).toEqual([
      'PIPELINE_UNAVAILABLE',
      'TOPICS_UNAVAILABLE',
      'CONTENT_SCHEDULE_AUTHORITY_UNAVAILABLE',
    ]);
  });
});
