// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  isDecisionActionAllowedFromApns,
  listDecisionActionTruthTable,
} from '../../src/services/decision-center-action-truth-table';
import {
  findDecisionExecutor,
  listDecisionExecutors,
} from '../../src/services/decision-center/execution-registry';
import { resolveNotificationContract } from '../../src/services/notification-contracts';

describe('Decision Center executor registry parity', () => {
  it('has exactly one registry entry for every implemented truth-table action', () => {
    const implemented = listDecisionActionTruthTable()
      .filter((entry) => entry.implemented)
      .map((entry) => entry.actionType)
      .sort();
    const registered = listDecisionExecutors().map((entry) => entry.actionId).sort();

    expect(registered).toEqual(implemented);
    expect(new Set(registered).size).toBe(registered.length);
  });

  it('keeps unsupported retry and choose_priority actions unregistered', () => {
    expect(findDecisionExecutor('retry')).toBeNull();
    expect(findDecisionExecutor('choose_priority')).toBeNull();
    expect(resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'decision_required',
      actionId: 'choose_priority',
    }).supportedActions).not.toContain('choose_priority');
  });

  it('requires a read-back contract for every registered mutation', () => {
    const invalid = listDecisionExecutors().filter((entry) => (
      entry.executionKind === 'mutation' && !entry.readBackKey
    ));
    expect(invalid).toEqual([]);
  });

  it('keeps declared APNs capability identical to the runtime allowlist', () => {
    for (const entry of listDecisionActionTruthTable()) {
      expect(isDecisionActionAllowedFromApns(entry.actionType), entry.actionType)
        .toBe(entry.apnsActionAllowed);
    }
  });
});
