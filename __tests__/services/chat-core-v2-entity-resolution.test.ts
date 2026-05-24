import { describe, expect, it } from 'vitest';
import type { EntityResolutionCandidate } from '../../src/services/chat-core-v2';
import {
  buildEntityResolutionPreconditions,
  resolveEntityReferenceFromCandidates,
} from '../../src/services/chat-core-v2';

const candidates: EntityResolutionCandidate[] = [
  {
    id: 'task-1',
    label: 'Review João proposal',
    confidence: 0.92,
    reason: 'Title and due date match the user phrase.',
    entityVersion: 'task-1:v3',
    domain: 'tasks',
  },
  {
    id: 'task-2',
    label: 'Review invoices',
    confidence: 0.41,
    reason: 'Shares only the word review.',
    entityVersion: 'task-2:v1',
    domain: 'tasks',
  },
];

describe('Chat Core v2 entity resolution', () => {
  it('resolves a single high-confidence candidate and exposes entity preconditions', () => {
    const resolution = resolveEntityReferenceFromCandidates({
      entityType: 'task',
      userPhrase: 'complete the João proposal task',
      candidates,
    });

    expect(resolution).toMatchObject({
      status: 'resolved',
      selectedId: 'task-1',
      reasonCodes: ['single_high_confidence_candidate'],
    });
    expect(resolution.candidates.map((candidate) => candidate.id)).toEqual(['task-1', 'task-2']);
    expect(buildEntityResolutionPreconditions(resolution).requiredEntityVersions)
      .toEqual({ 'task-1': 'task-1:v3' });
  });

  it('returns ambiguous when confidence is below the resolution threshold', () => {
    const resolution = resolveEntityReferenceFromCandidates({
      entityType: 'training_session',
      userPhrase: 'move tomorrow workout',
      candidates: [
        {
          id: 'session-1',
          label: 'Easy run',
          confidence: 0.55,
          reason: 'Date matches but title is generic.',
          domain: 'training',
        },
      ],
    });

    expect(resolution.status).toBe('ambiguous');
    expect(resolution.selectedId).toBeUndefined();
    expect(resolution.reasonCodes).toEqual(['low_confidence']);
  });

  it('returns ambiguous when multiple candidates are plausible', () => {
    const resolution = resolveEntityReferenceFromCandidates({
      entityType: 'event',
      userPhrase: 'reschedule João meeting',
      candidates: [
        {
          id: 'event-1',
          label: 'João sync',
          confidence: 0.88,
          reason: 'Attendee and title match.',
          domain: 'secretary',
        },
        {
          id: 'event-2',
          label: 'João proposal review',
          confidence: 0.83,
          reason: 'Attendee match and nearby date.',
          domain: 'secretary',
        },
      ],
    });

    expect(resolution.status).toBe('ambiguous');
    expect(resolution.reasonCodes).toEqual(['multiple_plausible_candidates']);
    expect(resolution.selectedId).toBeUndefined();
  });

  it('returns not_found when the candidate search returns nothing', () => {
    const resolution = resolveEntityReferenceFromCandidates({
      entityType: 'notification',
      userPhrase: 'snooze that alert',
      candidates: [],
    });

    expect(resolution).toEqual({
      entityType: 'notification',
      userPhrase: 'snooze that alert',
      candidates: [],
      status: 'not_found',
      reasonCodes: ['no_candidates'],
    });
  });

  it('dedupes candidate ids by highest confidence and caps the returned candidate list', () => {
    const resolution = resolveEntityReferenceFromCandidates({
      entityType: 'decision',
      userPhrase: 'dismiss the schedule decision',
      candidates: [
        {
          id: 'decision-1',
          label: 'Schedule decision',
          confidence: 0.8,
          reason: 'Weak older match.',
          domain: 'decision_center',
        },
        {
          id: 'decision-1',
          label: 'Schedule decision',
          confidence: 0.94,
          reason: 'Fresh exact match.',
          domain: 'decision_center',
        },
        {
          id: 'decision-2',
          label: 'Content decision',
          confidence: 0.2,
          reason: 'Different domain.',
          domain: 'decision_center',
        },
      ],
    }, {
      minResolvedConfidence: 0.78,
      ambiguityMargin: 0.08,
      maxCandidates: 1,
    });

    expect(resolution.status).toBe('resolved');
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.selectedCandidate?.reason).toBe('Fresh exact match.');
  });

  it('rejects invalid candidates and policy values before command proposal', () => {
    expect(() => resolveEntityReferenceFromCandidates({
      entityType: 'task',
      userPhrase: 'complete task',
      candidates: [
        {
          id: '',
          label: 'Task',
          confidence: 0.9,
          reason: 'Missing id.',
        },
      ],
    })).toThrow(/candidate.id/);

    expect(() => resolveEntityReferenceFromCandidates({
      entityType: 'task',
      userPhrase: 'complete task',
      candidates,
    }, {
      minResolvedConfidence: 1.2,
      ambiguityMargin: 0.08,
      maxCandidates: 5,
    })).toThrow(/minResolvedConfidence/);
  });
});
