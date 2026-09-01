// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { resolveDecisionChoice } from '../../src/services/decision-center/action-resolution';

describe('Decision Center action resolution', () => {
  const current = {
    options: [
      {
        optionId: 'slot_early',
        actionId: 'choose_another_time',
        actionPayload: { startAt: '2026-10-26T09:00:00Z', endAt: '2026-10-26T10:00:00Z' },
      },
      {
        optionId: 'keep_current',
        actionId: 'keep_existing_commitment',
      },
    ],
    actions: [
      { id: 'choose_another_time' },
      { id: 'keep_existing_commitment' },
      { id: 'open_detail' },
    ],
  };

  it.each([
    ['A', 'slot_early'],
    ['1', 'slot_early'],
    ['b', 'keep_current'],
    ['2', 'keep_current'],
  ])('maps presentation alias %s to the current server option %s', (alias, optionId) => {
    const result = resolveDecisionChoice(current, alias);
    expect(result).toMatchObject({ ok: true, value: { optionId } });
  });

  it('returns the exact action payload declared by the current server option', () => {
    expect(resolveDecisionChoice(current, 'slot_early')).toEqual({
      ok: true,
      value: {
        optionId: 'slot_early',
        actionId: 'choose_another_time',
        payload: { startAt: '2026-10-26T09:00:00Z', endAt: '2026-10-26T10:00:00Z' },
      },
    });
  });

  it('accepts an exact declared action ID for legacy clients', () => {
    expect(resolveDecisionChoice(current, 'open_detail')).toEqual({
      ok: true,
      value: { optionId: null, actionId: 'open_detail', payload: {} },
    });
  });

  it('never forwards an unknown alias as an executable action ID', () => {
    expect(resolveDecisionChoice(current, 'option_z')).toEqual({
      ok: false,
      code: 'DECISION_CHOICE_NOT_AVAILABLE',
    });
  });

  it('supports ordinal aliases on legacy action-only decisions', () => {
    expect(resolveDecisionChoice({ actions: [{ id: 'accept' }, { id: 'reject' }] }, '2')).toEqual({
      ok: true,
      value: { optionId: null, actionId: 'reject', payload: {} },
    });
  });
});
