// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 10 batch 54 (2026-05-16): channel routing policy layer.
//
// Phase 7 batch 37 introduced `AlertChannel` with a per-channel
// `minSeverity` threshold. That worked but coupled severity policy to
// channel construction — you couldn't, say, route the same Slack channel
// to receive critical incidents during work hours and ignore them at
// night, or send criticals to multiple destinations simultaneously
// without instantiating duplicate channels.
//
// This module adds a per-severity → channelIds[] mapping that decides at
// dispatch time which channels each alert flows through. The mapping
// composes with the existing per-channel `minSeverity` filter (both must
// admit the alert), so legacy code keeps working unchanged.
//
// Example policy:
//
//   const policy: ChannelRoutingPolicy = {
//     critical: ['pagerduty-primary', 'slack-oncall', 'telegram-felipe'],
//     high:     ['slack-oncall', 'telegram-felipe'],
//     medium:   ['slack-oncall'],
//     info:     ['email-weekly-digest'],
//   };
//
// Optional features:
//   • DEFAULT_ROUTING_POLICY constant for common-case operator wiring.
//   • validateChannelRoutingPolicy: ensures every channelId in the
//     policy maps to a real channel + every severity is mapped.
//   • dispatchCrossTenantAlertsWithPolicy: like the legacy dispatcher
//     but consults the policy first.

import type {
  AlertChannel,
  AlertDispatchOptions,
  AlertDispatchResult,
  AlertPayload,
} from './registry-cross-tenant-alert-hook';
import { formatAlertPayload } from './registry-cross-tenant-alert-hook';
import type {
  CrossTenantAdversarialPattern,
  CrossTenantSeverity,
} from './registry-adversarial-discovery';

export type ChannelRoutingPolicy = Record<CrossTenantSeverity, string[]>;

export interface ChannelRoutingValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Default routing policy. Operators can override individual severities,
 * but this represents a sensible baseline mapping:
 *   critical → all incident-grade channels
 *   high     → real-time visibility channels
 *   medium   → operator dashboards (Slack)
 *   info     → digest channels (email)
 *
 * Note: the channel IDs are PLACEHOLDERS — operators register channels
 * with these IDs (or override the policy) to wire the policy up.
 */
export const DEFAULT_ROUTING_POLICY: ChannelRoutingPolicy = {
  critical: ['pagerduty-primary', 'slack-oncall', 'telegram-felipe'],
  high: ['slack-oncall', 'telegram-felipe'],
  medium: ['slack-oncall'],
  info: ['email-weekly-digest'],
};

/**
 * Validates that every channelId referenced by the policy exists in the
 * `channels` array, and that every CrossTenantSeverity is mapped. Returns
 * a result describing any gaps. Operators should call this at startup
 * before passing the policy to a dispatcher.
 */
export function validateChannelRoutingPolicy(
  policy: ChannelRoutingPolicy,
  channels: AlertChannel[],
): ChannelRoutingValidationResult {
  const errors: string[] = [];
  const knownIds = new Set(channels.map((c) => c.id));
  const requiredSeverities: CrossTenantSeverity[] = ['critical', 'high', 'medium', 'info'];
  for (const severity of requiredSeverities) {
    const assigned = policy[severity];
    if (!assigned) {
      errors.push(`policy missing severity: ${severity}`);
      continue;
    }
    if (!Array.isArray(assigned)) {
      errors.push(`policy severity ${severity} is not an array`);
      continue;
    }
    for (const id of assigned) {
      if (!knownIds.has(id)) {
        errors.push(`policy references unknown channel id "${id}" for severity ${severity}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Dispatches patterns through channels selected by the routing policy.
 * Each pattern's severity selects the set of channelIds; the matching
 * channels also must pass their own `minSeverity` check. Errors thrown
 * by individual channels are captured per-channel without stopping the
 * fanout.
 */
export async function dispatchCrossTenantAlertsWithPolicy(
  patterns: CrossTenantAdversarialPattern[],
  channels: AlertChannel[],
  policy: ChannelRoutingPolicy,
  options: AlertDispatchOptions = {},
): Promise<AlertDispatchResult> {
  const generatedAt = options.nowIso ?? new Date().toISOString();
  const channelsById = new Map<string, AlertChannel>(channels.map((c) => [c.id, c]));
  const perChannel: Record<string, { sent: number; skipped: number; errors: string[] }> = {};
  for (const channel of channels) {
    perChannel[channel.id] = { sent: 0, skipped: 0, errors: [] };
  }

  let alertsSent = 0;
  let alertsSkipped = 0;
  for (const pattern of patterns) {
    const targetIds = policy[pattern.severity] ?? [];
    const payload: AlertPayload = formatAlertPayload(pattern, generatedAt);
    for (const id of targetIds) {
      const channel = channelsById.get(id);
      if (!channel) {
        // Validate-at-startup should catch this, but guard at dispatch
        // too — a config drift after startup shouldn't crash dispatch.
        if (!perChannel[id]) perChannel[id] = { sent: 0, skipped: 0, errors: [] };
        perChannel[id].errors.push(`channel ${id} referenced by policy but not registered`);
        alertsSkipped += 1;
        continue;
      }
      // Existing per-channel minSeverity still applies — policy can
      // route a high alert to a critical-only channel, but the channel
      // will still skip it. This is intentional: the policy describes
      // intent, the channel describes capacity.
      const channelRank = SEVERITY_RANK[channel.minSeverity];
      const patternRank = SEVERITY_RANK[pattern.severity];
      if (patternRank < channelRank) {
        perChannel[channel.id].skipped += 1;
        alertsSkipped += 1;
        continue;
      }
      if (options.shadowMode) {
        perChannel[channel.id].skipped += 1;
        alertsSkipped += 1;
        continue;
      }
      try {
        await channel.send(payload);
        perChannel[channel.id].sent += 1;
        alertsSent += 1;
      } catch (err) {
        perChannel[channel.id].errors.push(err instanceof Error ? err.message : String(err));
        alertsSkipped += 1;
      }
    }
  }
  return {
    totalPatterns: patterns.length,
    alertsSent,
    alertsSkipped,
    perChannel,
  };
}

const SEVERITY_RANK: Record<CrossTenantSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  info: 0,
};

// ──────────────────────────── Multi-region routing ────────────────────────────
//
// Phase 11 batch 57 (2026-05-16): per-region routing rules.
//
// Why: a global alert channel landscape often shards by region — EU
// on-call rotation uses different webhooks than US on-call. Forcing a
// single global policy means EU operators get paged when US-only patterns
// fire (and vice versa). The multi-region variant lets operators define
// region-specific overrides while still keeping a `default` fallback.
//
// The pattern itself doesn't carry a region — tenant→region resolution
// lives one level up (operator passes `region` at dispatch). This keeps
// the routing policy stateless and easy to test.
//
// Example:
//   const policy: MultiRegionChannelRoutingPolicy = {
//     default: DEFAULT_ROUTING_POLICY,
//     byRegion: {
//       eu: { critical: ['pagerduty-eu', 'slack-eu'], ... },
//       us: { critical: ['pagerduty-us', 'slack-us'], ... },
//     },
//   };
//   const policyForRequest = pickPolicyForRegion(policy, 'eu');
//   dispatchCrossTenantAlertsWithPolicy(patterns, channels, policyForRequest, ...)

export type AlertRegion = 'us' | 'eu' | 'apac' | 'global';

export interface MultiRegionChannelRoutingPolicy {
  default: ChannelRoutingPolicy;
  byRegion?: Partial<Record<AlertRegion, ChannelRoutingPolicy>>;
}

/**
 * Selects the effective policy for a given region. Falls back to
 * `default` if the region has no specific override. Returns the
 * `default` policy unchanged when `region` is undefined.
 *
 * The function does NOT merge region + default — operators who want
 * inheritance should explicitly spread the default into each region:
 *
 *   eu: { ...DEFAULT_ROUTING_POLICY, critical: ['pagerduty-eu'] }
 *
 * That keeps the merge logic explicit and prevents surprises when a
 * region forgets to define one severity.
 */
export function pickPolicyForRegion(
  policy: MultiRegionChannelRoutingPolicy,
  region?: AlertRegion,
): ChannelRoutingPolicy {
  if (!region) return policy.default;
  const override = policy.byRegion?.[region];
  return override ?? policy.default;
}

/**
 * Validates every region's policy against the channels list. Returns the
 * combined error list, prefixed with the region for traceability.
 */
export function validateMultiRegionChannelRoutingPolicy(
  policy: MultiRegionChannelRoutingPolicy,
  channels: AlertChannel[],
): ChannelRoutingValidationResult {
  const errors: string[] = [];
  const defaultResult = validateChannelRoutingPolicy(policy.default, channels);
  for (const err of defaultResult.errors) {
    errors.push(`[default] ${err}`);
  }
  for (const [region, regionPolicy] of Object.entries(policy.byRegion ?? {})) {
    if (!regionPolicy) continue;
    const regionResult = validateChannelRoutingPolicy(regionPolicy, channels);
    for (const err of regionResult.errors) {
      errors.push(`[${region}] ${err}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Multi-region dispatcher: picks the right policy for `region` then
 * delegates to `dispatchCrossTenantAlertsWithPolicy`. Useful when the
 * caller already knows which region the pattern set belongs to (e.g.,
 * processing US tenants in one job and EU tenants in another).
 */
export async function dispatchCrossTenantAlertsWithMultiRegionPolicy(
  patterns: CrossTenantAdversarialPattern[],
  channels: AlertChannel[],
  policy: MultiRegionChannelRoutingPolicy,
  options: AlertDispatchOptions & { region?: AlertRegion } = {},
): Promise<AlertDispatchResult> {
  const selected = pickPolicyForRegion(policy, options.region);
  return dispatchCrossTenantAlertsWithPolicy(patterns, channels, selected, options);
}
