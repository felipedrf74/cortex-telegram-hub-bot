import { describe, expect, it } from 'vitest';
import {
  defaultMeshPriorityForSignal,
  resolveDirectiveMatrix,
  resolveDirectiveSet,
  type MeshDirective,
} from '../../src/services/conflict-resolver';

function directive(overrides: Partial<MeshDirective> = {}): MeshDirective {
  return {
    id: overrides.id ?? 'd1',
    date: overrides.date ?? '2026-04-15',
    target: overrides.target ?? 'availability',
    domain: overrides.domain ?? 'training',
    summary: overrides.summary ?? 'Default summary',
    action: overrides.action ?? 'default',
    signalType: overrides.signalType ?? 'travel_window',
    signalId: overrides.signalId ?? 1,
    meshPriority: overrides.meshPriority,
  };
}

describe('conflict-resolver', () => {
  it('maps existing training recovery signals to mesh priority 2', () => {
    expect(defaultMeshPriorityForSignal('low_sleep')).toBe(2);
    expect(defaultMeshPriorityForSignal('low_hrv')).toBe(2);
    expect(defaultMeshPriorityForSignal('calendar_conflict')).toBe(2);
  });

  it('lets a higher-priority directive win automatically', () => {
    const result = resolveDirectiveSet([
      directive({
        id: 'travel',
        signalType: 'travel_window',
        signalId: 11,
        summary: 'Travel blocks the day',
        action: 'travel',
        meshPriority: 1,
      }),
      directive({
        id: 'shoot',
        signalType: 'shoot_day_locked',
        signalId: 22,
        summary: 'Filming is ready to lock',
        action: 'shoot',
        meshPriority: 3,
      }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].id).toBe('travel');
    expect(result.shadowed.map((entry) => entry.id)).toEqual(['shoot']);
    expect(result.conflicts).toEqual([]);
  });

  it('uses negotiation precedence when a same-priority collision has an obvious real-world winner', () => {
    const result = resolveDirectiveSet([
      directive({
        id: 'travel',
        signalType: 'travel_window',
        signalId: 11,
        summary: 'Travel blocks the day',
        action: 'travel',
        meshPriority: 1,
      }),
      directive({
        id: 'tax',
        signalType: 'tax_deadline',
        signalId: 22,
        summary: 'Tax deadline needs attention',
        action: 'tax',
        meshPriority: 1,
      }),
    ]);

    expect(result.accepted.map((entry) => entry.id)).toEqual(['travel']);
    expect(result.shadowed.map((entry) => entry.id)).toContain('tax');
    expect(result.conflicts).toEqual([]);
    expect(result.criticalConflicts).toEqual([]);
  });

  it('merges travel with calendar saturation when both describe the same availability block', () => {
    const result = resolveDirectiveSet([
      directive({
        id: 'travel',
        signalType: 'travel_window',
        signalId: 11,
        summary: 'Travel blocks the day',
        action: 'travel',
        meshPriority: 1,
      }),
      directive({
        id: 'calendar',
        signalType: 'calendar_busy_blocks',
        signalId: 12,
        summary: 'Calendar is already full',
        action: 'calendar-busy',
        meshPriority: 1,
      }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].action).toBe('travel');
    expect(result.accepted[0].summary).toContain('calendar is already too tight');
    expect(result.shadowed).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('merges sponsor deliverable pressure with a locked filming slot into one content commitment', () => {
    const result = resolveDirectiveSet([
      directive({
        id: 'sponsor',
        target: 'primary-commitment',
        domain: 'content',
        signalType: 'sponsor_deliverable_due',
        signalId: 21,
        summary: 'Sponsor deliverable needs a committed slot',
        action: 'sponsor',
        meshPriority: 1,
      }),
      directive({
        id: 'shoot',
        target: 'primary-commitment',
        domain: 'content',
        signalType: 'shoot_day_locked',
        signalId: 22,
        summary: 'Filming slot is ready to lock',
        action: 'shoot',
        meshPriority: 1,
      }),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].domain).toBe('content');
    expect(result.accepted[0].action).toBe('shoot');
    expect(result.accepted[0].summary).toContain('Sponsor deliverable is due');
    expect(result.shadowed).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('still surfaces a conflict when same-priority contenders remain genuinely ambiguous', () => {
    const result = resolveDirectiveSet([
      directive({
        id: 'publish-a',
        signalType: 'publishing_commitment',
        signalId: 31,
        summary: 'First publishing commitment',
        action: 'publish-a',
        meshPriority: 2,
      }),
      directive({
        id: 'publish-b',
        signalType: 'publishing_commitment',
        signalId: 32,
        summary: 'Second publishing commitment',
        action: 'publish-b',
        meshPriority: 2,
      }),
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.criticalConflicts).toEqual([]);
    expect(result.conflicts[0].signalIds).toEqual([31, 32]);
  });

  it('handles a meshPriority-1 collision scenario in the matrix stress case', () => {
    const result = resolveDirectiveMatrix([
      directive({
        id: 'travel',
        date: '2026-04-17',
        signalType: 'travel_window',
        signalId: 1,
        summary: 'Travel blocks Friday',
        action: 'travel',
        meshPriority: 1,
      }),
      directive({
        id: 'sponsor',
        date: '2026-04-17',
        target: 'availability',
        domain: 'content',
        signalType: 'sponsor_deliverable_due',
        signalId: 2,
        summary: 'Sponsor deliverable is due Friday',
        action: 'sponsor',
        meshPriority: 1,
      }),
      directive({
        id: 'shoot',
        date: '2026-04-18',
        target: 'primary-commitment',
        domain: 'content',
        signalType: 'shoot_day_locked',
        signalId: 3,
        summary: 'Saturday filming slot is ready',
        action: 'shoot',
        meshPriority: 3,
      }),
    ]);

    expect(result.criticalConflicts).toEqual([]);
    expect(result.accepted.map((entry) => entry.id)).toEqual(['travel', 'shoot']);
    expect(result.shadowed.map((entry) => entry.id)).toContain('sponsor');
  });
});
