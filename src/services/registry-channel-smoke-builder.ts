// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 12 batch 65 (2026-05-16): builder helpers for the alert-channel
// smoke runner. Extracted from the runner script so they're importable by
// tests without triggering the script's `main()` entry point.
//
// `buildSmokeChannelSetFromEnv(env)` returns the set of AlertChannel
// instances that the runner would dispatch a smoke payload to. The
// channels are constructed from operator-supplied env vars (see runner
// script header for the full list). Each channel-type also accepts a
// `_<REGION>` suffix on its env vars to construct region-specific
// channels with id `<channel-type>-<region>`.

import type { AlertChannel } from './registry-cross-tenant-alert-hook';
import {
  createDatadogChannel,
  createDiscordChannel,
  createOpsgenieChannel,
  createPagerDutyChannel,
  createSlackChannel,
} from './registry-cross-tenant-alert-channels';

export const SMOKE_REGIONS = ['US', 'EU', 'APAC', 'GLOBAL'] as const;
export type SmokeRegionKey = typeof SMOKE_REGIONS[number];

/** Minimal env-bag shape — accepts process.env or a test stub. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Walks `env` for region-suffixed variants of `requiredKeys`. Returns one
 * `{ region, values }` tuple per region where ALL required keys are set.
 * Falls back to the base (un-suffixed) form when no regional vars exist.
 * The `region` field is undefined for the base case and a lower-cased
 * region string ('us'/'eu'/'apac'/'global') for regional cases.
 */
export function pickRegionalEnv<T extends Record<string, string>>(
  env: EnvLike,
  requiredKeys: Array<keyof T & string>,
): Array<{ region?: string; values: T }> {
  const found: Array<{ region?: string; values: T }> = [];

  for (const region of SMOKE_REGIONS) {
    const values: Partial<T> = {};
    let complete = true;
    for (const key of requiredKeys) {
      const v = env[`${key}_${region}`];
      if (!v) { complete = false; break; }
      (values as Record<string, string>)[key] = v;
    }
    if (complete) found.push({ region: region.toLowerCase(), values: values as T });
  }

  if (found.length === 0) {
    const values: Partial<T> = {};
    let complete = true;
    for (const key of requiredKeys) {
      const v = env[key];
      if (!v) { complete = false; break; }
      (values as Record<string, string>)[key] = v;
    }
    if (complete) found.push({ values: values as T });
  }

  return found;
}

/** Rewrites the channel's `id` with `<id>-<region>` when region is set. */
export function withRegionalChannelId(channel: AlertChannel, region?: string): AlertChannel {
  if (!region) return channel;
  return { ...channel, id: `${channel.id}-${region}` };
}

/**
 * Constructs the full alert-channel set for a smoke run from an env-bag.
 * Each channel-type is enabled when its required env vars are present.
 * Region-suffixed env vars produce region-distinguished channel ids.
 */
export function buildSmokeChannelSetFromEnv(env: EnvLike): AlertChannel[] {
  const channels: AlertChannel[] = [];

  for (const { region, values } of pickRegionalEnv<{ SMOKE_PAGERDUTY_ROUTING_KEY: string }>(env, ['SMOKE_PAGERDUTY_ROUTING_KEY'])) {
    channels.push(withRegionalChannelId(createPagerDutyChannel({
      routingKey: values.SMOKE_PAGERDUTY_ROUTING_KEY,
      minSeverity: 'info',
    }), region));
  }

  for (const { region, values } of pickRegionalEnv<{ SMOKE_SLACK_WEBHOOK_URL: string }>(env, ['SMOKE_SLACK_WEBHOOK_URL'])) {
    channels.push(withRegionalChannelId(createSlackChannel({
      webhookUrl: values.SMOKE_SLACK_WEBHOOK_URL,
      minSeverity: 'info',
    }), region));
  }

  for (const { region, values } of pickRegionalEnv<{ SMOKE_DISCORD_WEBHOOK_URL: string }>(env, ['SMOKE_DISCORD_WEBHOOK_URL'])) {
    channels.push(withRegionalChannelId(createDiscordChannel({
      webhookUrl: values.SMOKE_DISCORD_WEBHOOK_URL,
      minSeverity: 'info',
    }), region));
  }

  for (const { region, values } of pickRegionalEnv<{ SMOKE_DATADOG_API_KEY: string; SMOKE_DATADOG_SITE: string }>(env, ['SMOKE_DATADOG_API_KEY', 'SMOKE_DATADOG_SITE'])) {
    channels.push(withRegionalChannelId(createDatadogChannel({
      apiKey: values.SMOKE_DATADOG_API_KEY,
      site: values.SMOKE_DATADOG_SITE,
      minSeverity: 'info',
    }), region));
  }

  for (const { region, values } of pickRegionalEnv<{ SMOKE_OPSGENIE_API_KEY: string }>(env, ['SMOKE_OPSGENIE_API_KEY'])) {
    const opsgenieRegionKey = region
      ? `SMOKE_OPSGENIE_REGION_${region.toUpperCase()}`
      : 'SMOKE_OPSGENIE_REGION';
    channels.push(withRegionalChannelId(createOpsgenieChannel({
      apiKey: values.SMOKE_OPSGENIE_API_KEY,
      region: (env[opsgenieRegionKey] as 'us' | 'eu' | undefined) ?? 'us',
      minSeverity: 'info',
    }), region));
  }

  return channels;
}
