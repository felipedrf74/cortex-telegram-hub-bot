import { describe, expect, it, vi } from 'vitest';
import {
  createDecisionCenterEngineSelector,
  parseDecisionCenterRewriteMode,
} from '../../src/services/decision-center/engine-selector';

interface Command { decisionId: string }
interface Result { engine: string }
interface Delivery { deliveryId: string }

function harness(mode: string | undefined) {
  const activeExecute = vi.fn(async (): Promise<{ result: Result; deliveryRequests: Delivery[] }> => ({
    result: { engine: 'active' },
    deliveryRequests: [{ deliveryId: 'delivery-active' }],
  }));
  const legacyExecute = vi.fn(async (): Promise<{ result: Result; deliveryRequests: Delivery[] }> => ({
    result: { engine: 'legacy' },
    deliveryRequests: [{ deliveryId: 'delivery-legacy' }],
  }));
  const authorize = vi.fn();
  const authorizeDelivery = vi.fn();
  const env = mode === undefined ? {} : { DECISION_CENTER_REWRITE_MODE: mode };
  const selector = createDecisionCenterEngineSelector<Command, Result, Delivery>({
    active: { engineId: 'rewrite-v2', execute: activeExecute },
    legacy: { engineId: 'legacy-v1', execute: legacyExecute },
    guards: { authorize, authorizeDelivery },
    env,
  });
  return { selector, activeExecute, legacyExecute, authorize, authorizeDelivery };
}

describe('decision-center engine selector', () => {
  it('defaults an absent mode to the active rewrite and never dual executes', async () => {
    const state = harness(undefined);
    const command = { decisionId: 'dc_1' };

    await expect(state.selector.execute(command)).resolves.toEqual({
      result: { engine: 'active' },
      deliveryRequests: [{ deliveryId: 'delivery-active' }],
    });
    expect(state.selector).toMatchObject({ mode: 'active', engineId: 'rewrite-v2' });
    expect(state.activeExecute).toHaveBeenCalledOnce();
    expect(state.legacyExecute).not.toHaveBeenCalled();
    expect(state.authorize).toHaveBeenCalledWith(command, 'active');
    expect(state.authorizeDelivery).toHaveBeenCalledWith(
      { deliveryId: 'delivery-active' },
      command,
      'active',
    );
  });

  it('wraps legacy mode in the same authorization and delivery guards', async () => {
    const state = harness('legacy');
    const command = { decisionId: 'dc_2' };

    await state.selector.execute(command);
    expect(state.selector).toMatchObject({ mode: 'legacy', engineId: 'legacy-v1' });
    expect(state.activeExecute).not.toHaveBeenCalled();
    expect(state.legacyExecute).toHaveBeenCalledOnce();
    expect(state.authorize).toHaveBeenCalledWith(command, 'legacy');
    expect(state.authorizeDelivery).toHaveBeenCalledWith(
      { deliveryId: 'delivery-legacy' },
      command,
      'legacy',
    );
  });

  it.each(['', 'ACTIVE', 'shadow', 'legacy '])(
    'fails startup for invalid explicit mode %j',
    (raw) => {
      expect(() => parseDecisionCenterRewriteMode(raw)).toThrow(expect.objectContaining({
        code: 'DECISION_CONFIGURATION_INVALID',
        status: 500,
      }));
    },
  );

  it('does not expose delivery requests if the common delivery guard rejects', async () => {
    const state = harness('active');
    state.authorizeDelivery.mockRejectedValueOnce(new Error('delivery blocked'));
    await expect(state.selector.execute({ decisionId: 'dc_3' })).rejects.toThrow('delivery blocked');
  });
});
