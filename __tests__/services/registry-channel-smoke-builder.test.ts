// Phase 12 batch 65 (2026-05-16): per-region smoke-channel builder tests.
//
// Verifies that `buildSmokeChannelSetFromEnv`:
//   • Builds zero channels for an empty env.
//   • Builds one channel per channel-type from base env vars.
//   • Builds one channel per region when region-suffixed env vars exist.
//   • Strips region suffix from channel id (lower-cased).
//   • Skips channel-types missing one of their required env vars.
//   • Returns regional channels in deterministic order.

import { describe, expect, it } from 'vitest';

import {
  buildSmokeChannelSetFromEnv,
  pickRegionalEnv,
  withRegionalChannelId,
} from '../../src/services/registry-channel-smoke-builder';
import {
  formatChannelSmokeMarkdown,
  runChannelSmoke,
} from '../../src/services/registry-channel-smoke';
import type { AlertChannel } from '../../src/services/registry-cross-tenant-alert-hook';

describe('pickRegionalEnv (Phase 12 batch 65)', () => {
  it('returns the base form when no regional vars are present', () => {
    const env = { FOO: 'bar' };
    const got = pickRegionalEnv<{ FOO: string }>(env, ['FOO']);
    expect(got).toHaveLength(1);
    expect(got[0].region).toBeUndefined();
    expect(got[0].values.FOO).toBe('bar');
  });

  it('returns one tuple per region when regional vars are present', () => {
    const env = { FOO_US: 'us-value', FOO_EU: 'eu-value' };
    const got = pickRegionalEnv<{ FOO: string }>(env, ['FOO']);
    expect(got).toHaveLength(2);
    expect(got.find((g) => g.region === 'us')?.values.FOO).toBe('us-value');
    expect(got.find((g) => g.region === 'eu')?.values.FOO).toBe('eu-value');
  });

  it('prefers regional vars over the base form when both are set', () => {
    const env = { FOO: 'base', FOO_US: 'us-value' };
    const got = pickRegionalEnv<{ FOO: string }>(env, ['FOO']);
    expect(got).toHaveLength(1);
    expect(got[0].region).toBe('us');
  });

  it('only emits a region tuple when ALL required keys are present', () => {
    // FOO_EU set but BAR_EU missing → no EU tuple.
    const env = { FOO_EU: 'x' };
    const got = pickRegionalEnv<{ FOO: string; BAR: string }>(env, ['FOO', 'BAR']);
    expect(got).toHaveLength(0);
  });

  it('returns an empty array when no form is satisfied', () => {
    expect(pickRegionalEnv<{ FOO: string }>({}, ['FOO'])).toEqual([]);
  });
});

describe('withRegionalChannelId (Phase 12 batch 65)', () => {
  const base: AlertChannel = { id: 'slack', minSeverity: 'info', send: () => {} };

  it('preserves id when region is undefined', () => {
    expect(withRegionalChannelId(base, undefined).id).toBe('slack');
  });

  it('appends -<region> when region is set', () => {
    expect(withRegionalChannelId(base, 'eu').id).toBe('slack-eu');
  });

  it('does not mutate the source channel', () => {
    const wrapped = withRegionalChannelId(base, 'us');
    expect(base.id).toBe('slack');
    expect(wrapped).not.toBe(base);
  });
});

describe('buildSmokeChannelSetFromEnv (Phase 12 batch 65)', () => {
  it('returns an empty channel set when no env vars are set', () => {
    expect(buildSmokeChannelSetFromEnv({})).toEqual([]);
  });

  it('builds single-region channels from base env vars', () => {
    const channels = buildSmokeChannelSetFromEnv({
      SMOKE_SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/X',
      SMOKE_PAGERDUTY_ROUTING_KEY: 'pd-key-1',
    });
    const ids = channels.map((c) => c.id).sort();
    expect(ids).toEqual(['pagerduty', 'slack']);
  });

  it('builds region-distinguished channels from regional env vars', () => {
    const channels = buildSmokeChannelSetFromEnv({
      SMOKE_SLACK_WEBHOOK_URL_US: 'https://hooks.slack.com/services/US',
      SMOKE_SLACK_WEBHOOK_URL_EU: 'https://hooks.slack.com/services/EU',
    });
    const ids = channels.map((c) => c.id).sort();
    expect(ids).toEqual(['slack-eu', 'slack-us']);
  });

  it('mixes region-based and base channel-types (different channel-types can use different forms)', () => {
    const channels = buildSmokeChannelSetFromEnv({
      // Slack regional
      SMOKE_SLACK_WEBHOOK_URL_US: 'https://hooks.slack.com/services/US',
      SMOKE_SLACK_WEBHOOK_URL_EU: 'https://hooks.slack.com/services/EU',
      // PagerDuty base (no region split)
      SMOKE_PAGERDUTY_ROUTING_KEY: 'pd-key-1',
    });
    const ids = channels.map((c) => c.id).sort();
    expect(ids).toEqual(['pagerduty', 'slack-eu', 'slack-us']);
  });

  it('requires BOTH telegram env vars set per region (paired keys)', () => {
    // Only botToken set → telegram not constructed.
    const channels = buildSmokeChannelSetFromEnv({ SMOKE_TELEGRAM_BOT_TOKEN: 't' });
    expect(channels.find((c) => c.id.startsWith('telegram'))).toBeUndefined();
  });

  it('constructs telegram with both env vars present', () => {
    const channels = buildSmokeChannelSetFromEnv({
      SMOKE_TELEGRAM_BOT_TOKEN: 't',
      SMOKE_TELEGRAM_CHAT_ID: '12345',
    });
    expect(channels.find((c) => c.id === 'telegram')).toBeDefined();
  });

  it('supports all 6 channel-types simultaneously', () => {
    const channels = buildSmokeChannelSetFromEnv({
      SMOKE_PAGERDUTY_ROUTING_KEY: 'pd',
      SMOKE_SLACK_WEBHOOK_URL: 'slack-url',
      SMOKE_TELEGRAM_BOT_TOKEN: 't', SMOKE_TELEGRAM_CHAT_ID: '1',
      SMOKE_DISCORD_WEBHOOK_URL: 'discord-url',
      SMOKE_DATADOG_API_KEY: 'dd-key', SMOKE_DATADOG_SITE: 'datadoghq.com',
      SMOKE_OPSGENIE_API_KEY: 'og-key',
    });
    const ids = channels.map((c) => c.id).sort();
    expect(ids).toEqual(['datadog', 'discord', 'opsgenie', 'pagerduty', 'slack', 'telegram']);
  });

  it('handles 3 regions across one channel-type', () => {
    const channels = buildSmokeChannelSetFromEnv({
      SMOKE_OPSGENIE_API_KEY_US: 'us-key',
      SMOKE_OPSGENIE_API_KEY_EU: 'eu-key',
      SMOKE_OPSGENIE_API_KEY_APAC: 'apac-key',
    });
    const ids = channels.map((c) => c.id).sort();
    expect(ids).toEqual(['opsgenie-apac', 'opsgenie-eu', 'opsgenie-us']);
  });

  it('dry-run markdown shows slack-us/eu without leaking webhook or tenant/user internals', async () => {
    const channels = buildSmokeChannelSetFromEnv({
      SMOKE_SLACK_WEBHOOK_URL_US: 'https://example.com/us-secret-webhook',
      SMOKE_SLACK_WEBHOOK_URL_EU: 'https://example.com/eu-secret-webhook',
    });
    const result = await runChannelSmoke(channels, {
      dryRun: true,
      nowIso: '2026-05-16T12:00:00Z',
    });
    const markdown = formatChannelSmokeMarkdown(result);

    expect(markdown).toContain('slack-us');
    expect(markdown).toContain('slack-eu');
    expect(markdown).not.toContain('us-secret-webhook');
    expect(markdown).not.toContain('eu-secret-webhook');
    expect(markdown).not.toMatch(/\b(?:executor|tenantId|userId|access_token|refresh_token|secret)\b/i);
  });
});
