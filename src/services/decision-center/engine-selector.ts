// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DecisionCenterConfigurationError } from './errors';

export const DECISION_CENTER_REWRITE_MODE_ENV = 'DECISION_CENTER_REWRITE_MODE' as const;
export type DecisionCenterRewriteMode = 'active' | 'legacy';

export interface DecisionCenterEngineOutcome<Result, DeliveryRequest> {
  readonly result: Result;
  /** Engines propose durable delivery jobs; they never send before commit. */
  readonly deliveryRequests: readonly DeliveryRequest[];
}

export interface DecisionCenterEngine<Command, Result, DeliveryRequest> {
  readonly engineId: string;
  execute(command: Command): Promise<DecisionCenterEngineOutcome<Result, DeliveryRequest>>;
}

export interface DecisionCenterEngineGuards<Command, DeliveryRequest> {
  authorize(command: Command, mode: DecisionCenterRewriteMode): Promise<void> | void;
  authorizeDelivery(
    delivery: DeliveryRequest,
    command: Command,
    mode: DecisionCenterRewriteMode,
  ): Promise<void> | void;
}

export interface SelectedDecisionCenterEngine<Command, Result, DeliveryRequest> {
  readonly mode: DecisionCenterRewriteMode;
  readonly engineId: string;
  execute(command: Command): Promise<DecisionCenterEngineOutcome<Result, DeliveryRequest>>;
}

export function parseDecisionCenterRewriteMode(raw: string | undefined): DecisionCenterRewriteMode {
  if (raw === undefined) return 'active';
  if (raw === 'active' || raw === 'legacy') return raw;
  throw new DecisionCenterConfigurationError(
    `${DECISION_CENTER_REWRITE_MODE_ENV} must be "active" or "legacy".`,
    { environmentVariable: DECISION_CENTER_REWRITE_MODE_ENV },
  );
}

export function resolveDecisionCenterRewriteMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DecisionCenterRewriteMode {
  return parseDecisionCenterRewriteMode(env[DECISION_CENTER_REWRITE_MODE_ENV]);
}

/**
 * Select exactly one engine, while keeping authorization and delivery guards
 * outside both implementations so emergency legacy mode cannot bypass them.
 */
export function createDecisionCenterEngineSelector<Command, Result, DeliveryRequest>(input: {
  readonly active: DecisionCenterEngine<Command, Result, DeliveryRequest>;
  readonly legacy: DecisionCenterEngine<Command, Result, DeliveryRequest>;
  readonly guards: DecisionCenterEngineGuards<Command, DeliveryRequest>;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): SelectedDecisionCenterEngine<Command, Result, DeliveryRequest> {
  const mode = resolveDecisionCenterRewriteMode(input.env);
  const selected = mode === 'active' ? input.active : input.legacy;

  return Object.freeze({
    mode,
    engineId: selected.engineId,
    async execute(command: Command): Promise<DecisionCenterEngineOutcome<Result, DeliveryRequest>> {
      await input.guards.authorize(command, mode);
      const outcome = await selected.execute(command);
      for (const delivery of outcome.deliveryRequests) {
        await input.guards.authorizeDelivery(delivery, command, mode);
      }
      return outcome;
    },
  });
}
