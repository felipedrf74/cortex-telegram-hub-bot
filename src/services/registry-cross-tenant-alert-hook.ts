// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 7 batch 37 (2026-05-15): cross-tenant adversarial alerting hook.
//
// Phase 6 batch 33 added `discoverCrossTenantAdversarialPatterns` which
// surfaces coordinated-attack candidates from telemetry. This module adds
// an alerting layer: when patterns at critical/high severity surface, a
// configurable dispatcher emits notifications via the user's preferred
// alert channel (PagerDuty / Slack / Telegram bot / etc.).
//
// The dispatcher is INTERFACE-only. Concrete channel implementations are
// injected by callers (the operator chooses where to route). This module
// exports:
//
//   • AlertChannel — interface every channel must implement
//   • dispatchCrossTenantAlerts — fans pattern → channel mapping
//   • formatAlertPayload — builds the per-channel payload shape
//
// No automatic channel registration. Callers are responsible for wiring
// the channel(s) for their environment.

import type {
  CrossTenantAdversarialPattern,
  CrossTenantSeverity,
} from './registry-adversarial-discovery';

export interface AlertPayload {
  severity: CrossTenantSeverity;
  title: string;
  description: string;
  pattern: CrossTenantAdversarialPattern;
  /** ISO timestamp when the alert was generated. */
  generatedAt: string;
}

export interface AlertChannel {
  /** Human-readable channel identifier (for logs). */
  readonly id: string;
  /** Severity threshold for this channel — patterns below are skipped. */
  readonly minSeverity: CrossTenantSeverity;
  /** Sends an alert payload. Should be async/await-safe. */
  send(payload: AlertPayload): Promise<void> | void;
}

export interface AlertDispatchOptions {
  /** Override the current ISO timestamp (for tests). */
  nowIso?: string;
  /** If true, suppress all alerts (dry-run / shadow mode). */
  shadowMode?: boolean;
}

export interface AlertDispatchResult {
  totalPatterns: number;
  alertsSent: number;
  alertsSkipped: number;
  perChannel: Record<string, { sent: number; skipped: number; errors: string[] }>;
}

const SEVERITY_RANK: Record<CrossTenantSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  info: 0,
};

/**
 * Dispatches alert payloads to all registered channels that meet the per-
 * channel severity threshold. Returns a structured result describing what
 * was sent / skipped per channel.
 */
export async function dispatchCrossTenantAlerts(
  patterns: CrossTenantAdversarialPattern[],
  channels: AlertChannel[],
  options: AlertDispatchOptions = {},
): Promise<AlertDispatchResult> {
  const generatedAt = options.nowIso ?? new Date().toISOString();
  const perChannel: Record<string, { sent: number; skipped: number; errors: string[] }> = {};
  for (const channel of channels) {
    perChannel[channel.id] = { sent: 0, skipped: 0, errors: [] };
  }
  let sent = 0;
  let skipped = 0;
  for (const pattern of patterns) {
    const payload: AlertPayload = formatAlertPayload(pattern, generatedAt);
    for (const channel of channels) {
      const channelMin = SEVERITY_RANK[channel.minSeverity];
      const patternRank = SEVERITY_RANK[pattern.severity];
      if (patternRank < channelMin) {
        perChannel[channel.id].skipped += 1;
        skipped += 1;
        continue;
      }
      if (options.shadowMode) {
        perChannel[channel.id].skipped += 1;
        skipped += 1;
        continue;
      }
      try {
        await channel.send(payload);
        perChannel[channel.id].sent += 1;
        sent += 1;
      } catch (err) {
        perChannel[channel.id].errors.push(
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
  return {
    totalPatterns: patterns.length,
    alertsSent: sent,
    alertsSkipped: skipped,
    perChannel,
  };
}

/**
 * Builds a structured alert payload from a pattern. Pure function; consumers
 * may transform the payload before sending (e.g., serialize for Slack
 * blocks, etc.).
 */
export function formatAlertPayload(
  pattern: CrossTenantAdversarialPattern,
  generatedAt: string,
): AlertPayload {
  const severityLabel = pattern.severity.toUpperCase();
  return {
    severity: pattern.severity,
    title: `[${severityLabel}] Cross-tenant adversarial pattern on ${pattern.skill ?? '?'}.${pattern.action ?? '?'}`,
    description: [
      `Pattern: ${pattern.failureReason ?? 'unknown'} / ${pattern.outcome ?? 'unknown'}`,
      `Distinct tenants: ${pattern.tenantCount} (${pattern.totalCount} total rows)`,
      `Window: ${pattern.windowDays.toFixed(2)} days (first ${pattern.firstSeen}, last ${pattern.lastSeen})`,
    ].join('\n'),
    pattern,
    generatedAt,
  };
}

/**
 * In-memory test channel — useful for unit tests and dry-run validation.
 * Records every payload it receives.
 */
export class RecordingAlertChannel implements AlertChannel {
  readonly id: string;
  readonly minSeverity: CrossTenantSeverity;
  readonly received: AlertPayload[] = [];

  constructor(id: string, minSeverity: CrossTenantSeverity = 'medium') {
    this.id = id;
    this.minSeverity = minSeverity;
  }

  send(payload: AlertPayload): void {
    this.received.push(payload);
  }
}
