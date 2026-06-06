// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 8 batch 42 (2026-05-15): cross-tenant alert channel implementations.
//
// Phase 7 batch 37 shipped the AlertChannel interface + dispatcher. This
// module adds concrete channel adapters for the three primary alert
// destinations Felipe uses operationally:
//
//   • PagerDuty — Events API v2 (incident-grade severity routing)
//   • Slack — Incoming Webhook (operator visibility)
//   • Telegram — Bot API (Felipe's personal notification path)
//
// Each adapter exposes:
//   • A factory function (createPagerDutyChannel, createSlackChannel,
//     createTelegramChannel) — takes config + minSeverity
//   • A pure payload-formatter (formatPagerDutyPayload, etc.) — useful
//     for testing and shadow-mode validation
//
// The factories use an injectable `fetch`-shaped transport (defaults to
// global fetch). This keeps the module testable without network access
// and lets operators substitute custom HTTP clients (e.g., authenticated
// proxies, mTLS).

import type {
  AlertChannel,
  AlertPayload,
} from './registry-cross-tenant-alert-hook';
import type {
  CrossTenantSeverity,
} from './registry-adversarial-discovery';

/** Minimal fetch-shaped transport; defaults to global fetch. */
export type AlertHttpTransport = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

const DEFAULT_TRANSPORT: AlertHttpTransport = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, statusText: res.statusText };
};

// ──────────────────────────── PagerDuty ────────────────────────────

export interface PagerDutyChannelConfig {
  routingKey: string;
  minSeverity?: CrossTenantSeverity;
  source?: string;
  transport?: AlertHttpTransport;
  url?: string;
}

/** Builds a PagerDuty Events API v2 payload from an AlertPayload. */
export function formatPagerDutyPayload(
  payload: AlertPayload,
  routingKey: string,
  source: string,
): unknown {
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    payload: {
      summary: payload.title,
      severity: mapSeverityToPagerDuty(payload.severity),
      source,
      timestamp: payload.generatedAt,
      custom_details: {
        skill: payload.pattern.skill,
        action: payload.pattern.action,
        tenantCount: payload.pattern.tenantCount,
        totalCount: payload.pattern.totalCount,
        failureReason: payload.pattern.failureReason,
        outcome: payload.pattern.outcome,
        windowDays: payload.pattern.windowDays,
        firstSeen: payload.pattern.firstSeen,
        lastSeen: payload.pattern.lastSeen,
      },
    },
  };
}

function mapSeverityToPagerDuty(severity: CrossTenantSeverity): string {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'info';
}

export function createPagerDutyChannel(config: PagerDutyChannelConfig): AlertChannel {
  const url = config.url ?? 'https://events.pagerduty.com/v2/enqueue';
  const source = config.source ?? 'nexus-hub-registry-alerts';
  const transport = config.transport ?? DEFAULT_TRANSPORT;
  return {
    id: 'pagerduty',
    minSeverity: config.minSeverity ?? 'high',
    send: async (payload) => {
      const body = JSON.stringify(formatPagerDutyPayload(payload, config.routingKey, source));
      const res = await transport(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(`PagerDuty rejected: ${res.status} ${res.statusText}`);
      }
    },
  };
}

// ────────────────────────────── Slack ──────────────────────────────

export interface SlackChannelConfig {
  webhookUrl: string;
  minSeverity?: CrossTenantSeverity;
  channelOverride?: string;
  transport?: AlertHttpTransport;
}

/** Builds a Slack Incoming Webhook payload with severity-colored attachment. */
export function formatSlackPayload(payload: AlertPayload, channelOverride?: string): unknown {
  return {
    text: payload.title,
    ...(channelOverride ? { channel: channelOverride } : {}),
    attachments: [
      {
        color: slackColorForSeverity(payload.severity),
        title: payload.title,
        text: payload.description,
        fields: [
          { title: 'Severity', value: payload.severity, short: true },
          { title: 'Skill', value: payload.pattern.skill ?? '?', short: true },
          { title: 'Action', value: payload.pattern.action ?? '?', short: true },
          { title: 'Tenants', value: String(payload.pattern.tenantCount), short: true },
          { title: 'Total rows', value: String(payload.pattern.totalCount), short: true },
          { title: 'Window (days)', value: payload.pattern.windowDays.toFixed(2), short: true },
        ],
        ts: Math.floor(new Date(payload.generatedAt).getTime() / 1000),
      },
    ],
  };
}

function slackColorForSeverity(severity: CrossTenantSeverity): string {
  if (severity === 'critical') return '#cc0000';
  if (severity === 'high') return '#e07b00';
  if (severity === 'medium') return '#dfc100';
  return '#3aa3e3';
}

export function createSlackChannel(config: SlackChannelConfig): AlertChannel {
  const transport = config.transport ?? DEFAULT_TRANSPORT;
  return {
    id: 'slack',
    minSeverity: config.minSeverity ?? 'medium',
    send: async (payload) => {
      const body = JSON.stringify(formatSlackPayload(payload, config.channelOverride));
      const res = await transport(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(`Slack rejected: ${res.status} ${res.statusText}`);
      }
    },
  };
}

// ──────────────────────────── Telegram ─────────────────────────────

export interface TelegramChannelConfig {
  botToken: string;
  chatId: string | number;
  minSeverity?: CrossTenantSeverity;
  transport?: AlertHttpTransport;
}

/** Builds a Telegram sendMessage payload with HTML formatting. */
export function formatTelegramPayload(payload: AlertPayload, chatId: string | number): unknown {
  const severityEmoji =
    payload.severity === 'critical' ? '🚨' :
    payload.severity === 'high' ? '⚠️' :
    payload.severity === 'medium' ? '🟡' : 'ℹ️';
  const lines: string[] = [];
  lines.push(`${severityEmoji} <b>${escapeHtml(payload.title)}</b>`);
  lines.push('');
  lines.push(escapeHtml(payload.description));
  lines.push('');
  lines.push(`<i>Generated at ${payload.generatedAt}</i>`);
  return {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createTelegramChannel(config: TelegramChannelConfig): AlertChannel {
  const transport = config.transport ?? DEFAULT_TRANSPORT;
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  return {
    id: 'telegram',
    minSeverity: config.minSeverity ?? 'high',
    send: async (payload) => {
      const body = JSON.stringify(formatTelegramPayload(payload, config.chatId));
      const res = await transport(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(`Telegram rejected: ${res.status} ${res.statusText}`);
      }
    },
  };
}

// ──────────────────────────── Discord ──────────────────────────────
// Phase 9 batch 46 (2026-05-16): Discord webhook channel.

export interface DiscordChannelConfig {
  webhookUrl: string;
  minSeverity?: CrossTenantSeverity;
  username?: string;
  transport?: AlertHttpTransport;
}

/** Builds a Discord webhook payload with severity-colored embed. */
export function formatDiscordPayload(payload: AlertPayload, username?: string): unknown {
  return {
    ...(username ? { username } : {}),
    embeds: [
      {
        title: payload.title,
        description: payload.description,
        color: discordColorForSeverity(payload.severity),
        timestamp: payload.generatedAt,
        fields: [
          { name: 'Severity', value: payload.severity, inline: true },
          { name: 'Skill', value: payload.pattern.skill ?? '?', inline: true },
          { name: 'Action', value: payload.pattern.action ?? '?', inline: true },
          { name: 'Tenants', value: String(payload.pattern.tenantCount), inline: true },
          { name: 'Total', value: String(payload.pattern.totalCount), inline: true },
          { name: 'Window (days)', value: payload.pattern.windowDays.toFixed(2), inline: true },
        ],
      },
    ],
  };
}

function discordColorForSeverity(severity: CrossTenantSeverity): number {
  // Discord wants integer colors (0xRRGGBB).
  if (severity === 'critical') return 0xcc0000;
  if (severity === 'high') return 0xe07b00;
  if (severity === 'medium') return 0xdfc100;
  return 0x3aa3e3;
}

export function createDiscordChannel(config: DiscordChannelConfig): AlertChannel {
  const transport = config.transport ?? DEFAULT_TRANSPORT;
  return {
    id: 'discord',
    minSeverity: config.minSeverity ?? 'medium',
    send: async (payload) => {
      const body = JSON.stringify(formatDiscordPayload(payload, config.username));
      const res = await transport(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        throw new Error(`Discord rejected: ${res.status} ${res.statusText}`);
      }
    },
  };
}

// ────────────────────────────── Email ──────────────────────────────
// Phase 9 batch 46: Email channel via an injectable mail-sender adapter.
// The adapter is provider-agnostic (SendGrid, Postmark, SES) — channel
// only knows the contract.

export interface EmailSender {
  (input: {
    to: string;
    from: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> | void;
}

export interface EmailChannelConfig {
  from: string;
  to: string;
  sender: EmailSender;
  minSeverity?: CrossTenantSeverity;
}

/** Builds an email payload — both text and HTML versions. */
export function formatEmailPayload(payload: AlertPayload, from: string, to: string): {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
} {
  const subject = `[${payload.severity.toUpperCase()}] ${payload.title}`;
  const text = [
    payload.title,
    '',
    payload.description,
    '',
    `Severity: ${payload.severity}`,
    `Skill: ${payload.pattern.skill ?? '?'}`,
    `Action: ${payload.pattern.action ?? '?'}`,
    `Tenants: ${payload.pattern.tenantCount} (${payload.pattern.totalCount} total rows)`,
    `Window: ${payload.pattern.windowDays.toFixed(2)} days`,
    `First seen: ${payload.pattern.firstSeen}`,
    `Last seen: ${payload.pattern.lastSeen}`,
    `Generated at: ${payload.generatedAt}`,
  ].join('\n');
  const html = `<h2>${escapeHtml(payload.title)}</h2>
<p>${escapeHtml(payload.description).replace(/\n/g, '<br/>')}</p>
<table>
  <tr><td><b>Severity</b></td><td>${escapeHtml(payload.severity)}</td></tr>
  <tr><td><b>Skill</b></td><td>${escapeHtml(payload.pattern.skill ?? '?')}</td></tr>
  <tr><td><b>Action</b></td><td>${escapeHtml(payload.pattern.action ?? '?')}</td></tr>
  <tr><td><b>Tenants</b></td><td>${payload.pattern.tenantCount} (${payload.pattern.totalCount} total rows)</td></tr>
  <tr><td><b>Window (days)</b></td><td>${payload.pattern.windowDays.toFixed(2)}</td></tr>
  <tr><td><b>First seen</b></td><td>${escapeHtml(payload.pattern.firstSeen)}</td></tr>
  <tr><td><b>Last seen</b></td><td>${escapeHtml(payload.pattern.lastSeen)}</td></tr>
</table>`;
  return { to, from, subject, text, html };
}

export function createEmailChannel(config: EmailChannelConfig): AlertChannel {
  return {
    id: 'email',
    minSeverity: config.minSeverity ?? 'high',
    send: async (payload) => {
      const message = formatEmailPayload(payload, config.from, config.to);
      await config.sender(message);
    },
  };
}

// ──────────────────────────── Datadog ──────────────────────────────
// Phase 9 batch 46: Datadog Events API channel.

export interface DatadogChannelConfig {
  apiKey: string;
  site?: string;
  minSeverity?: CrossTenantSeverity;
  transport?: AlertHttpTransport;
}

/** Builds a Datadog Events API v1 payload. */
export function formatDatadogPayload(payload: AlertPayload): unknown {
  return {
    title: payload.title,
    text: payload.description,
    alert_type: mapSeverityToDatadog(payload.severity),
    priority: payload.severity === 'critical' || payload.severity === 'high' ? 'normal' : 'low',
    source_type_name: 'nexus-hub-registry',
    tags: [
      `severity:${payload.severity}`,
      `skill:${payload.pattern.skill ?? 'unknown'}`,
      `action:${payload.pattern.action ?? 'unknown'}`,
      `tenants:${payload.pattern.tenantCount}`,
    ],
    date_happened: Math.floor(new Date(payload.generatedAt).getTime() / 1000),
  };
}

function mapSeverityToDatadog(severity: CrossTenantSeverity): string {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warning';
  return 'info';
}

export function createDatadogChannel(config: DatadogChannelConfig): AlertChannel {
  const transport = config.transport ?? DEFAULT_TRANSPORT;
  const site = config.site ?? 'datadoghq.com';
  const url = `https://api.${site}/api/v1/events`;
  return {
    id: 'datadog',
    minSeverity: config.minSeverity ?? 'medium',
    send: async (payload) => {
      const body = JSON.stringify(formatDatadogPayload(payload));
      const res = await transport(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': config.apiKey,
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`Datadog rejected: ${res.status} ${res.statusText}`);
      }
    },
  };
}

// ────────────────────────────── Opsgenie ───────────────────────────
// Phase 9 batch 46: Opsgenie alert API channel.

export interface OpsgenieChannelConfig {
  apiKey: string;
  region?: 'us' | 'eu';
  minSeverity?: CrossTenantSeverity;
  transport?: AlertHttpTransport;
}

/** Builds an Opsgenie alert payload. */
export function formatOpsgeniePayload(payload: AlertPayload): unknown {
  return {
    message: payload.title,
    description: payload.description,
    priority: mapSeverityToOpsgenie(payload.severity),
    source: 'nexus-hub-registry',
    tags: [
      `severity:${payload.severity}`,
      `skill:${payload.pattern.skill ?? 'unknown'}`,
      `action:${payload.pattern.action ?? 'unknown'}`,
    ],
    details: {
      tenantCount: String(payload.pattern.tenantCount),
      totalCount: String(payload.pattern.totalCount),
      windowDays: payload.pattern.windowDays.toFixed(2),
      firstSeen: payload.pattern.firstSeen,
      lastSeen: payload.pattern.lastSeen,
    },
  };
}

function mapSeverityToOpsgenie(severity: CrossTenantSeverity): string {
  if (severity === 'critical') return 'P1';
  if (severity === 'high') return 'P2';
  if (severity === 'medium') return 'P3';
  return 'P5';
}

export function createOpsgenieChannel(config: OpsgenieChannelConfig): AlertChannel {
  const transport = config.transport ?? DEFAULT_TRANSPORT;
  const region = config.region ?? 'us';
  const url = region === 'eu'
    ? 'https://api.eu.opsgenie.com/v2/alerts'
    : 'https://api.opsgenie.com/v2/alerts';
  return {
    id: 'opsgenie',
    minSeverity: config.minSeverity ?? 'high',
    send: async (payload) => {
      const body = JSON.stringify(formatOpsgeniePayload(payload));
      const res = await transport(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `GenieKey ${config.apiKey}`,
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`Opsgenie rejected: ${res.status} ${res.statusText}`);
      }
    },
  };
}
