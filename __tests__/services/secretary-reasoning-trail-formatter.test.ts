// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the C2 workstream formatter: PT-PT/PT-BR/EN-US
 * rendering of a Secretary agenda item's reasoning trail for Telegram.
 *
 * The producer (W-E) guarantees trail nodes carry NO user copy; this
 * formatter must (a) render the structured fields safely, (b) escape
 * HTML in the title, and (c) emit no English fragments when lang is PT.
 *
 * Plan reference: Wave 1 workstream C2.
 */

import { describe, expect, it } from 'vitest';
import { formatReasoningTrailForTelegram } from '../../src/services/secretary-reasoning-trail-formatter';
import type { SecretaryAgendaItem } from '../../src/services/secretary-scheduling-arbitrator';

function fakeAgenda(overrides: Partial<SecretaryAgendaItem> = {}): SecretaryAgendaItem {
  return {
    agendaItemId: 'sec_agenda_test_001',
    sourceIntentId: 'intent-1',
    sourceSkill: 'training',
    sourceAction: null,
    intentAction: 'schedule_this',
    sourceEntityId: null,
    sourceEntityType: null,
    ownerUserId: 42,
    tenantId: 'tenant-1',
    lifecycleState: 'scheduled',
    providerSyncState: 'not_synced',
    providerEventId: null,
    providerSource: null,
    version: 1,
    title: 'Tempo run',
    startAt: '2026-05-20T08:00:00.000Z',
    endAt: '2026-05-20T09:00:00.000Z',
    durationMinutes: 60,
    decisionAction: 'scheduled',
    decisionReasonCodes: ['scheduled_in_available_window'],
    decisionExplanation: null,
    sourceShapeHash: 'abc',
    scheduledSegments: [],
    cancellationReason: null,
    supersededByAgendaItemId: null,
    createdAt: '2026-05-13T12:00:00.000Z',
    updatedAt: '2026-05-13T12:00:00.000Z',
    completedAt: null,
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    reasoningTrail: [
      { kind: 'priority', weight: 12, detail: 'skill:training' },
      { kind: 'phase_boost', weight: 3, detail: 'phase:peak' },
      { kind: 'candidate', detail: 'cand:1' },
      {
        kind: 'chosen',
        slot: { start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' },
        reasonCode: 'scheduled_in_available_window',
        detail: 'dur:60',
      },
    ],
    ...overrides,
  };
}

describe('C2: secretary reasoning trail formatter', () => {
  it('renders an EN-US trail with all expected node kinds', () => {
    const out = formatReasoningTrailForTelegram(fakeAgenda(), 'en-US');
    expect(out).toContain('Why Secretary decided');
    expect(out).toContain('Status: Scheduled');
    expect(out).toContain('Priority: weight 12');
    expect(out).toContain('Goal phase: +3');
    expect(out).toContain('Candidate windows: cand:1');
    expect(out).toContain('Chosen:');
    expect(out).toContain('2026-05-20T08:00:00.000Z');
  });

  it('renders a PT-PT trail with no English fragments', () => {
    const out = formatReasoningTrailForTelegram(fakeAgenda(), 'pt-PT');
    expect(out).toContain('Porque Secretary decidiu');
    expect(out).toContain('Estado: Agendado');
    expect(out).toContain('Prioridade:');
    expect(out).toContain('Escolhido:');
    // PT-PT must not leak common EN markers
    expect(out).not.toContain('Scheduled');
    expect(out).not.toContain('Reflowed');
    expect(out).not.toContain('Status:');
    expect(out).not.toContain('Chosen:');
  });

  it('PT-BR also renders Portuguese (shares PT formatter branch)', () => {
    const out = formatReasoningTrailForTelegram(fakeAgenda(), 'pt-BR');
    expect(out).toContain('Porque Secretary decidiu');
    expect(out).toContain('Estado: Agendado');
  });

  it('escapes HTML in the title (XSS guard)', () => {
    const out = formatReasoningTrailForTelegram(
      fakeAgenda({ title: '<script>alert(1)</script>' }),
      'en-US',
    );
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('handles empty reasoning trail with a fallback line', () => {
    const out = formatReasoningTrailForTelegram(
      fakeAgenda({ reasoningTrail: [] }),
      'en-US',
    );
    expect(out).toContain('No reasoning trail stored');
  });

  it('handles every node kind without throwing', () => {
    const allKinds: SecretaryAgendaItem['reasoningTrail'] = [
      { kind: 'validation', reasonCode: 'missing_duration' },
      { kind: 'priority', weight: 8, detail: 'skill:cooking' },
      { kind: 'phase_boost', weight: -3, detail: 'phase:deload' },
      { kind: 'candidate', detail: 'cand:3' },
      { kind: 'busy_block', detail: 'busy:2' },
      { kind: 'considered', slot: { start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' } },
      { kind: 'compression', reasonCode: 'compressed_to_fit_capacity', detail: 'min:45' },
      { kind: 'reflow', reasonCode: 'reflowed_to_available_window' },
      { kind: 'chosen', slot: { start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T09:00:00.000Z' }, detail: 'dur:60' },
      { kind: 'rejected', reasonCode: 'invalid_source_skill' },
      { kind: 'deferred', reasonCode: 'deferred_due_to_current_capacity' },
      { kind: 'unscheduled', reasonCode: 'unscheduled_no_capacity' },
    ];
    const out = formatReasoningTrailForTelegram(fakeAgenda({ reasoningTrail: allKinds }), 'en-US');
    expect(out.split('\n').length).toBeGreaterThan(allKinds.length);
  });
});
