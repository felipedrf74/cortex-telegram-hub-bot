#!/usr/bin/env npx tsx
/**
 * Alert-channel weekly smoke run — Phase 10 batch 55 (2026-05-16).
 *
 * Exercises every registered alert channel with a synthetic [SMOKE]-tagged
 * info-severity payload so that broken channels (rotated webhooks, expired
 * tokens, etc.) surface before a real incident needs them.
 *
 * Phase 12 batch 65 (2026-05-16): per-region channel construction. Each
 * channel-type now accepts an optional region suffix on its env var.
 * Channels constructed from `SMOKE_<NAME>_<REGION>` get id
 * `<channel-type>-<region>` so the routing-policy layer can target them.
 * The non-suffixed form (e.g. SMOKE_SLACK_WEBHOOK_URL) still works for
 * single-region operators.
 *
 * Channel set is configured by operator-supplied environment variables:
 *
 *   PagerDuty
 *     SMOKE_PAGERDUTY_ROUTING_KEY                  (base)
 *     SMOKE_PAGERDUTY_ROUTING_KEY_<REGION>         (per-region)
 *
 *   Slack
 *     SMOKE_SLACK_WEBHOOK_URL                      (base)
 *     SMOKE_SLACK_WEBHOOK_URL_<REGION>             (per-region)
 *
 *   Discord
 *     SMOKE_DISCORD_WEBHOOK_URL                    (base)
 *     SMOKE_DISCORD_WEBHOOK_URL_<REGION>           (per-region)
 *
 *   Datadog (needs API key + site, paired per region)
 *     SMOKE_DATADOG_API_KEY + SMOKE_DATADOG_SITE                            (base)
 *     SMOKE_DATADOG_API_KEY_<REGION> + SMOKE_DATADOG_SITE_<REGION>          (per-region)
 *
 *   Opsgenie
 *     SMOKE_OPSGENIE_API_KEY                       (base)
 *     SMOKE_OPSGENIE_API_KEY_<REGION>              (per-region)
 *
 * `<REGION>` is one of US / EU / APAC / GLOBAL — case-sensitive in the env
 * var name, lower-cased in the resulting channel id (`pagerduty-eu`, etc.).
 *
 * Output: Markdown report on stdout, or `--output <path>` to write to file.
 * Use `--dry-run` to walk the channel set without actually invoking send.
 *
 * Intended to be run via a weekly cron (Sunday 08:00 UTC suggested) and the
 * report appended to .local/release/eval-evidence/alert-channel-smoke-runs/.
 *
 * Usage:
 *   npx tsx scripts/registry-alert-channel-smoke.ts [options]
 *
 * Options:
 *   --dry-run            Walk channels without calling send
 *   --output <path>      Write Markdown report to file (default: stdout)
 *   --timeout-ms <n>     Per-channel timeout (default: 5000)
 */

import { writeFileSync } from 'fs';
import { argv, env, stdout, exit } from 'process';

import {
  formatChannelSmokeMarkdown,
  runChannelSmoke,
} from '../src/services/registry-channel-smoke';
import {
  buildSmokeChannelSetFromEnv,
} from '../src/services/registry-channel-smoke-builder';

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function arg(name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function main(): Promise<void> {
  const channels = buildSmokeChannelSetFromEnv(env);
  const result = await runChannelSmoke(channels, {
    dryRun: flag('dry-run'),
    perChannelTimeoutMs: arg('timeout-ms') ? Number(arg('timeout-ms')) : undefined,
  });
  const md = formatChannelSmokeMarkdown(result);
  const outputPath = arg('output');
  if (outputPath) {
    writeFileSync(outputPath, md);
    stdout.write(`smoke report written to ${outputPath}\n`);
  } else {
    stdout.write(md + '\n');
  }
  if (result.failedCount > 0) exit(2);
}

main().catch((err) => {
  stdout.write(`smoke run crashed: ${err instanceof Error ? err.message : String(err)}\n`);
  exit(1);
});
