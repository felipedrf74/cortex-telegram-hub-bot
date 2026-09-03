import { describe, expect, it } from 'vitest';

import { buildEditorialCoordinationSignals } from '../../src/agents/editorial-coordinator-agent';

describe('editorial-coordinator-agent', () => {
  it('keeps a reaction window proposed even when Secretary has a separate focus block', () => {
    const result = buildEditorialCoordinationSignals({
      content: {
        filmingRecommendation: null,
        unreadNotifications: [],
        recentSignals: [
          {
            type: 'reaction_opportunity',
            title: 'Creators are debating carb myths again',
            summary: 'Fast reaction window with enough context to move now.',
            priority: 'urgent',
            relevanceScore: 0.94,
            confidence: 0.82,
          },
        ],
        nextExecution: {
          mode: 'reaction_window',
          title: 'Creators are debating carb myths again',
          summary: 'Fast reaction window with enough context to move now.',
          scheduledDate: null,
          dateSemantics: 'none',
          calendarConfirmed: false,
          confidence: 'high',
          sourceType: 'reaction_opportunity',
        },
      } as any,
      secretary: {
        focusBlock: {
          date: '2026-04-24',
          start: '2026-04-24T10:00:00.000Z',
          end: '2026-04-24T11:30:00.000Z',
          reason: 'Best protected focus block this week.',
          reasons: ['Calendar is lighter here.', 'Energy is stronger before lunch.'],
        },
      } as any,
      training: {
        trainingContext: {
          flags: {
            lowReadiness: false,
          },
        },
      } as any,
    });

    expect(result.signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalType: 'content_capture_opportunity',
          priority: 'normal',
          payload: expect.objectContaining({
            title: 'Creators are debating carb myths again',
            angle: 'reaction_window',
            derivedFromFocusBlock: true,
            sourceSignalType: 'reaction_opportunity',
            planStatus: 'proposed',
            semantics: 'proposal_not_calendar_reservation',
            nextExecutionDateSemantics: 'none',
            nextExecutionCalendarConfirmed: false,
          }),
        }),
      ]),
    );
    expect(result.signals.some((signal) => signal.signalType === 'shoot_day_locked')).toBe(false);
  });

  it('locks only a current Secretary-confirmed private Content work block', () => {
    const result = buildEditorialCoordinationSignals({
      content: {
        filmingRecommendation: null,
        unreadNotifications: [],
        recentSignals: [],
        nextExecution: {
          mode: 'film_window',
          title: 'Recommended filming work',
          summary: 'Recommendation only.',
          scheduledDate: '2026-04-24',
          dateSemantics: 'recommended_work_date',
          calendarConfirmed: false,
          confidence: 'high',
          sourceType: 'desk_item',
        },
        workSchedule: {
          authority: 'secretary',
          authorityStatus: 'current',
          planStatus: 'confirmed',
          semantics: 'private_work_session',
          attentionCount: 0,
          confirmedBlocks: [
            {
              itemId: 41,
              title: 'Film the approved outline',
              date: '2026-04-25',
              startsAt: '2026-04-25T10:00:00.000Z',
              endsAt: '2026-04-25T11:30:00.000Z',
              workKind: 'record',
              state: 'provider_synced',
              authority: 'secretary',
              authorityStatus: 'current',
              semantics: 'private_work_session',
              contentChangedSinceScheduling: false,
            },
            {
              itemId: 42,
              title: 'Edit the approved capture',
              date: '2026-04-26',
              startsAt: '2026-04-26T10:00:00.000Z',
              endsAt: '2026-04-26T11:30:00.000Z',
              workKind: 'edit',
              state: 'scheduled',
              authority: 'secretary',
              authorityStatus: 'current',
              semantics: 'private_work_session',
              contentChangedSinceScheduling: false,
            },
            {
              itemId: 43,
              title: 'Record with local provider attention',
              date: '2026-04-27',
              startsAt: '2026-04-27T10:00:00.000Z',
              endsAt: '2026-04-27T11:30:00.000Z',
              workKind: 'record',
              state: 'sync_failed',
              authority: 'secretary',
              authorityStatus: 'current',
              semantics: 'private_work_session',
              contentChangedSinceScheduling: false,
            },
          ],
        },
      } as any,
      secretary: {
        focusBlock: null,
      } as any,
      training: {
        trainingContext: { flags: { lowReadiness: false } },
      } as any,
    });

    expect(result.signals).toEqual([
      expect.objectContaining({
        signalType: 'shoot_day_locked',
        payload: expect.objectContaining({
          itemId: 41,
          blockStart: '2026-04-25T10:00:00.000Z',
          blockEnd: '2026-04-25T11:30:00.000Z',
          workKind: 'filming',
          sourceWorkKind: 'record',
          planStatus: 'confirmed',
          scheduleAuthority: 'secretary',
          scheduleAuthorityStatus: 'current',
          semantics: 'private_work_session',
          sourceState: 'provider_synced',
          providerAttention: false,
        }),
      }),
      expect.objectContaining({
        signalType: 'shoot_day_locked',
        payload: expect.objectContaining({
          itemId: 43,
          sourceWorkKind: 'record',
          sourceState: 'sync_failed',
          providerAttention: true,
          planStatus: 'confirmed',
          scheduleAuthorityStatus: 'current',
          semantics: 'private_work_session',
        }),
      }),
    ]);
  });

  it('does not promote an embedded block when aggregate schedule authority is unavailable', () => {
    const result = buildEditorialCoordinationSignals({
      content: {
        filmingRecommendation: null,
        unreadNotifications: [],
        recentSignals: [],
        nextExecution: null,
        workSchedule: {
          authority: 'secretary',
          authorityStatus: 'unavailable',
          planStatus: 'unavailable',
          semantics: 'private_work_session',
          attentionCount: 0,
          confirmedBlocks: [{
            itemId: 41,
            title: 'Stale embedded filming block',
            date: '2026-04-25',
            startsAt: '2026-04-25T10:00:00.000Z',
            endsAt: '2026-04-25T11:30:00.000Z',
            workKind: 'record',
            state: 'provider_synced',
            authority: 'secretary',
            authorityStatus: 'current',
            semantics: 'private_work_session',
            contentChangedSinceScheduling: false,
          }],
        },
      } as any,
      secretary: { focusBlock: null } as any,
      training: { trainingContext: { flags: { lowReadiness: false } } } as any,
    });

    expect(result.signals).toEqual([]);
  });

  it('requires explicit due evidence before emitting a sponsor deadline constraint', () => {
    const base = {
      content: {
        filmingRecommendation: null,
        recentSignals: [],
        nextExecution: null,
        unreadNotifications: [{
          id: 70,
          title: 'Sponsor partnership update',
          body: 'The brand approved the new creative direction.',
          data: { sponsor: true },
          createdAt: '2026-04-24T08:00:00.000Z',
        }],
      } as any,
      secretary: { focusBlock: null } as any,
      training: { trainingContext: { flags: { lowReadiness: false } } } as any,
    };

    const generic = buildEditorialCoordinationSignals(base);
    expect(generic.signals.some((signal) => signal.signalType === 'sponsor_deliverable_due')).toBe(false);

    const withMalformedDeadline = buildEditorialCoordinationSignals({
      ...base,
      content: {
        ...base.content,
        unreadNotifications: [{
          ...base.content.unreadNotifications[0],
          data: { sponsor: true, deadlineAt: '2026-02-30T17:00:00Z' },
        }],
      },
    });
    expect(withMalformedDeadline.signals.some((signal) => signal.signalType === 'sponsor_deliverable_due')).toBe(false);

    const withValidatedDeadline = buildEditorialCoordinationSignals({
      ...base,
      content: {
        ...base.content,
        unreadNotifications: [{
          ...base.content.unreadNotifications[0],
          data: { sponsor: true, deadlineAt: '2026-04-28T17:00:00.000Z' },
        }],
      },
    });
    const dueSignal = withValidatedDeadline.signals.find((signal) => signal.signalType === 'sponsor_deliverable_due');
    expect(dueSignal).toEqual(expect.objectContaining({
      priority: 'urgent',
      payload: expect.objectContaining({
        dueAt: '2026-04-28T17:00:00.000Z',
        publicationAuthority: 'not_established',
        semantics: 'external_deadline_not_publication_authority',
      }),
    }));
    expect(dueSignal).not.toHaveProperty('expiresAt');

    const withExplicitBrandDueLanguage = buildEditorialCoordinationSignals({
      ...base,
      content: {
        ...base.content,
        unreadNotifications: [{
          ...base.content.unreadNotifications[0],
          title: 'Brand creative due this week',
          body: 'The approved deliverable is due Friday.',
          data: {},
        }],
      },
    });
    expect(withExplicitBrandDueLanguage.signals).toEqual([
      expect.objectContaining({
        signalType: 'sponsor_deliverable_due',
        payload: expect.objectContaining({
          dueAt: null,
          publicationAuthority: 'not_established',
          semantics: 'external_deadline_not_publication_authority',
        }),
      }),
    ]);
  });
});
