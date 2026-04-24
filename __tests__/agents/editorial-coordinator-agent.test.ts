import { describe, expect, it } from 'vitest';

import { buildEditorialCoordinationSignals } from '../../src/agents/editorial-coordinator-agent';

describe('editorial-coordinator-agent', () => {
  it('promotes a reaction window into a protected capture opportunity when Secretary has a focus block', () => {
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
          }),
        }),
        expect.objectContaining({
          signalType: 'shoot_day_locked',
          priority: 'urgent',
          payload: expect.objectContaining({
            kind: 'reaction_window',
            title: 'Creators are debating carb myths again',
            blockStart: '2026-04-24T10:00:00.000Z',
            blockEnd: '2026-04-24T11:30:00.000Z',
          }),
        }),
      ]),
    );
  });
});
