// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';
import type {
  SecretarySourceSkill,
  SecretarySourceSkillFeedback,
} from './secretary-scheduling-arbitrator';

/**
 * In-process emitter for Secretary scheduling feedback (W-B workstream).
 *
 * The arbitrator computes `SecretarySourceSkillFeedback` after every
 * persisted decision (single-intent + batch paths). Before W-B, the
 * computed feedback was returned to the caller but no consumer actually
 * processed it cross-cutting — Training never learned that its 60-min
 * session was compressed to 45, Cooking never learned that its meal prep
 * window moved.
 *
 * This module provides a tiny single-file in-process fast path. Consumers
 * register at module load via `registerSecretaryFeedbackConsumer`; the
 * arbitrator calls `emitSecretaryFeedback` after persist; each consumer runs
 * in a try/catch so one bad handler never breaks arbitration. Training also
 * has a durable event_outbox path (`secretary.training_feedback.requested.v1`)
 * written atomically with the agenda version; that path is authoritative for
 * crash/restart delivery and uses the same idempotent projection.
 *
 * Wave 1 consumers:
 * - Training (writes "compressed_session +recovery_debt" hint into the
 *   training_feedback_decisions table)
 *
 * Wave 2 consumers:
 * - Cooking / Finance / Content persist compact, tenant-scoped feedback in
 *   secretary_source_skill_feedback so their next deterministic read/model
 *   pass can refresh user-facing copy without reparsing agenda rows.
 *
 * Idempotency: handlers receive `(agendaItemId, version)` as part of the
 * feedback shape. Training keeps one monotonic row per scoped source intent;
 * legacy Wave 2 consumers still dedupe per agenda item + source intent.
 *
 * Plan reference: Wave 1 workstream W-B in graceful-stirring-scone
 */

export type SecretaryFeedbackHandler = (
  feedback: SecretarySourceSkillFeedback,
) => void | Promise<void>;

export interface SecretaryFeedbackConsumer {
  sourceSkill: SecretarySourceSkill;
  /**
   * Stable identifier for this consumer. Used to dedupe registrations
   * when the module that registers it is reloaded (test setup, hot reload).
   */
  handlerId: string;
  handler: SecretaryFeedbackHandler;
}

const consumers = new Map<string, SecretaryFeedbackConsumer>();

function consumerKey(sourceSkill: SecretarySourceSkill, handlerId: string): string {
  return `${sourceSkill}:${handlerId}`;
}

/**
 * Register a consumer for Secretary scheduling feedback. The handler is
 * invoked synchronously after each decision persists; promise-returning
 * handlers are awaited via the emit-await loop.
 *
 * Returns an unregister function. Re-registering the same
 * `(sourceSkill, handlerId)` pair overwrites the previous handler — used
 * by test setup that re-imports the module.
 */
export function registerSecretaryFeedbackConsumer(
  consumer: SecretaryFeedbackConsumer,
): () => void {
  const key = consumerKey(consumer.sourceSkill, consumer.handlerId);
  consumers.set(key, consumer);
  return () => {
    consumers.delete(key);
  };
}

/**
 * Internal: emit feedback to every matching consumer. Each handler runs
 * in its own try/catch so one bad consumer cannot break arbitration. Bad
 * handlers are logged at warn level with the agenda item context for
 * triage; arbitration return value is unaffected.
 *
 * Synchronous fire-and-forget for async handlers (logger.warn on
 * rejection); arbitration does not wait. Wave 2 may add an awaitable
 * variant when needed.
 */
export function emitSecretaryFeedback(feedback: SecretarySourceSkillFeedback): void {
  for (const [key, consumer] of consumers) {
    if (consumer.sourceSkill !== feedback.sourceSkill) continue;
    try {
      const result = consumer.handler(feedback);
      if (result instanceof Promise) {
        result.catch((err) => {
          logger.warn(
            { err, consumerKey: key, agendaItemId: feedback.agendaItemId, sourceSkill: feedback.sourceSkill },
            '[secretary-feedback-bus] async consumer rejected',
          );
        });
      }
    } catch (err) {
      logger.warn(
        { err, consumerKey: key, agendaItemId: feedback.agendaItemId, sourceSkill: feedback.sourceSkill },
        '[secretary-feedback-bus] sync consumer threw',
      );
    }
  }
}

/** Test-only: clear all registered consumers. */
export function _resetSecretaryFeedbackBusForTests(): void {
  consumers.clear();
}

/** Test-only: count registered consumers. */
export function _secretaryFeedbackBusConsumerCount(): number {
  return consumers.size;
}
