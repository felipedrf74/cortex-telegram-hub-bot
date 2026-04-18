// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import dotenv from 'dotenv';
dotenv.config({ override: true });

// STAGING flag set by ecosystem.staging.config.js. When true, certain
// "production-only" required env vars (TELEGRAM_BOT_TOKEN, etc.) become
// optional so the staging install can boot without a second bot. The bot
// startup code in src/index.ts checks isStaging() and skips bot.start()
// when there's no token. Quarter audit item: staging environment.
const IS_STAGING = process.env.STAGING === 'true' || process.env.NODE_ENV === 'staging';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/**
 * Like required() but returns an empty string instead of throwing when
 * STAGING=true. Use this for env vars that are critical in production but
 * can be safely missing in a staging install (e.g. a second Telegram bot
 * token that the operator doesn't want to provision yet).
 */
function requiredInProd(key: string): string {
  const value = process.env[key];
  if (!value) {
    if (IS_STAGING) return '';
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  telegram: {
    botToken: requiredInProd('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: requiredInProd('TELEGRAM_ALLOWED_USER_IDS')
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id)),
    // Webhook mode (Month 2 audit item). When TELEGRAM_WEBHOOK_URL is set,
    // the bot uses webhook delivery instead of long-polling. Default: empty
    // (= long-polling). Setting/unsetting this env var is the safety switch
    // — flip it back to "" and restart the bot to instantly revert to
    // polling mode without any code rollback.
    //
    // The URL must be HTTPS and reachable by Telegram (not localhost).
    // For Nexus Hub: https://api.nexushub.me/webhooks/telegram
    //
    // TELEGRAM_WEBHOOK_SECRET is an optional 1-256 char token from
    // [A-Za-z0-9_-]. Telegram echoes it back in the
    // X-Telegram-Bot-Api-Secret-Token header on every delivery, and
    // grammy verifies it. Strongly recommended in production.
    webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || '',
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
  },
  isStaging: IS_STAGING,
  anthropic: {
    // April 9 2026 — Anthropic kill switch. The cost dashboard showed
    // $0.20/day still burning on Claude calls via fallback paths
    // (coach_analysis on Sonnet, content_workflow_youtube on Haiku,
    // classify_message fallback on Haiku) even though the domain router
    // was flipped to Gemini-first in commit 339c43e. The fix is
    // belt-and-suspenders:
    //   1. ANTHROPIC_API_KEY is now OPTIONAL (was `required()`). If
    //      unset, the SDK throws on the first call — one safety net.
    //   2. `anthropic-hook.trackedCreate` hard-throws unless
    //      `ANTHROPIC_ENABLED === 'true'`. Default is disabled.
    //      Re-enable per-session with `ANTHROPIC_ENABLED=true` env.
    //   3. The fallback position in `providerRouting` below is now
    //      `openai` instead of `anthropic`. GPT is the new fallback.
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    classifierModel: process.env.ANTHROPIC_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
    maxTokens: 2048,             // Cooking/triathlon/content — bumped from 1024; recipes and
                                // training plans easily exceed 800 tokens and were getting
                                // truncated mid-instruction (see cooking chat screenshot).
    secretaryMaxTokens: 4096,   // CHAT-M4: bumped from 2048 — state context (tasks + calendar
                                // + reminders + Garmin) consumes 500-1500 tokens of input,
                                // leaving insufficient budget for the response. 4096 gives
                                // enough headroom for full day briefings + tool call summaries.
  },
  // ── Alternative AI Providers (optional fallbacks) ──────────────────
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-5.4-nano',
    classifierModel: process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-5.4-nano',
    maxTokens: 2048,            // bumped from 1024 — cooking/content need full recipe length
    secretaryMaxTokens: 4096,   // CHAT-M4: bumped from 2048 (see anthropic.secretaryMaxTokens)
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // gemini-2.5-flash is the current flagship Flash model on the Google
    // Generative AI API ($0.30/M in, $2.50/M out). The previous default
    // 'gemini-3-flash' was aspirational — that model name doesn't exist
    // on the API and every heavy-tier Gemini call was silently 404'ing
    // and falling back to Anthropic. See git blame for full investigation.
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    classifierModel: process.env.GEMINI_CLASSIFIER_MODEL || 'gemini-2.5-flash-lite',
    maxTokens: 2048,            // bumped from 1024 — same reason as above
    secretaryMaxTokens: 4096,   // CHAT-M4: bumped from 2048
  },
  // ── Provider Fallback Routing ─────────────────────────────────────
  // Per-task-type primary/fallback. Values: 'anthropic' | 'openai' | 'gemini'
  //
  // Defaults are now GEMINI-first for every task type (April 2026 cost
  // migration). Anthropic is retained as the reliability fallback because
  // Sonnet 4.6's tool-use chain is still more deterministic on edge cases.
  // Previous defaults had chat+toolUse primary=anthropic, which was a
  // correct choice at the time but stale by the time the Gemini migration
  // shipped — the env vars in prod .env (AI_*_PRIMARY=gemini) were the
  // only thing keeping the runtime on Gemini. If an operator removes
  // those env vars on a fresh deploy (staging first-run, for instance),
  // the old defaults would silently revert cost back to Anthropic. This
  // change makes the Gemini-first behavior the code default too, so the
  // env vars are an OVERRIDE not a LIFELINE.
  providerRouting: {
    // April 9 2026 — fallback defaults flipped from 'anthropic' to
    // 'openai'. Gemini stays primary (the post-cost-migration default).
    // When Gemini fails, the router now tries GPT instead of Claude.
    // Anthropic is only reachable when BOTH an explicit env var points
    // at it AND `ANTHROPIC_ENABLED=true` is set in the environment —
    // see `anthropic-hook.trackedCreate` for the hard gate.
    classify: {
      primary: process.env.AI_CLASSIFY_PRIMARY || 'gemini',
      fallback: process.env.AI_CLASSIFY_FALLBACK || 'openai',
    },
    chat: {
      primary: process.env.AI_CHAT_PRIMARY || 'gemini',
      fallback: process.env.AI_CHAT_FALLBACK || 'openai',
    },
    toolUse: {
      primary: process.env.AI_TOOL_USE_PRIMARY || 'gemini',
      fallback: process.env.AI_TOOL_USE_FALLBACK || 'openai',
    },
    circuitBreaker: {
      failureThreshold: parseInt(process.env.AI_CB_FAILURE_THRESHOLD || '3', 10),
      cooldownMs: parseInt(process.env.AI_CB_COOLDOWN_MS || '60000', 10),
    },
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    iosClientId: process.env.GOOGLE_IOS_CLIENT_ID || '',
  },
  outlook: {
    clientId: process.env.OUTLOOK_CLIENT_ID || '',
    clientSecret: process.env.OUTLOOK_CLIENT_SECRET || '',
    tenantId: process.env.OUTLOOK_TENANT_ID || 'consumers',
    refreshToken: process.env.OUTLOOK_REFRESH_TOKEN || '',
  },
  app: {
    timezone: optional('TIMEZONE', 'Europe/Lisbon'),
    databasePath: optional('DATABASE_PATH', './data/bot.db'),
    logLevel: optional('LOG_LEVEL', 'info'),
  },
  todo: {
    defaultList: process.env.TODO_DEFAULT_LIST || 'Tasks',
    digestEnabled: (process.env.TODO_DIGEST_ENABLED || 'true') === 'true',
    digestTime: process.env.TODO_DIGEST_TIME || '06:00',
  },
  // ── Invoice/Receipt Filing (via SSH/SCP to Mac → iCloud Drive) ─────
  invoices: {
    enabled: (process.env.INVOICE_FILING_ENABLED || 'true') === 'true',
    sshHost: process.env.INVOICE_SSH_HOST || '',
    sshPort: process.env.INVOICE_SSH_PORT || '22',
    sshUser: process.env.INVOICE_SSH_USER || '',
    sshKeyPath: process.env.INVOICE_SSH_KEY || '',
    remotePath: process.env.INVOICE_REMOTE_PATH || '',
    minConfidence: parseFloat(process.env.INVOICE_MIN_CONFIDENCE || '0.70'),
    compressionEnabled: (process.env.INVOICE_COMPRESSION_ENABLED || 'true') === 'true',
    jpegQuality: parseInt(process.env.INVOICE_JPEG_QUALITY || '80', 10),
    monthlyCollectionEnabled: (process.env.INVOICE_MONTHLY_COLLECTION || 'true') === 'true',
    // Amazon.es invoice collection (browser automation via Playwright)
    amazonEnabled: (process.env.AMAZON_COLLECTION_ENABLED || 'false') === 'true',
    amazonEmail: process.env.AMAZON_EMAIL || '',
    amazonPassword: process.env.AMAZON_PASSWORD || '',
    amazonSessionPath: process.env.AMAZON_SESSION_PATH || './data/amazon-session.json',
    amazonHeadless: (process.env.AMAZON_HEADLESS || 'true') === 'true',
    // Uber/Uber Eats invoice collection (browser automation via Playwright)
    uberEnabled: (process.env.UBER_COLLECTION_ENABLED || 'false') === 'true',
    uberEmail: process.env.UBER_EMAIL || '',
    uberPassword: process.env.UBER_PASSWORD || '',
    uberSessionPath: process.env.UBER_SESSION_PATH || './data/uber-session.json',
    uberHeadless: (process.env.UBER_HEADLESS || 'true') === 'true',
    uberRidesEnabled: (process.env.UBER_RIDES_ENABLED || 'true') === 'true',
    uberEatsEnabled: (process.env.UBER_EATS_ENABLED || 'true') === 'true',
  },
  // ── Sentry Error Tracking ────────────────────────────────────────────
  // Cloud-based error monitoring alongside our existing SQLite + Telegram
  // alerting. Free tier gives 5K errors/month which is plenty. Set SENTRY_DSN
  // in prod .env to enable; leave empty for local/staging to run without it.
  // tracesSampleRate defaults to 0 (errors only, no APM traces) to preserve
  // the free-tier quota — flip to 0.1 if you want 10% of requests traced.
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: optional('SENTRY_ENVIRONMENT', 'development'),
    release: process.env.SENTRY_RELEASE || '',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0'),
  },
  // ── Todoist (TASK-16b — task provider with webhooks) ───────────────
  todoist: {
    clientId: process.env.TODOIST_CLIENT_ID || '',
    clientSecret: process.env.TODOIST_CLIENT_SECRET || '',
    // Webhook secret defaults to client_secret per Todoist's signature spec.
    // Override only if you've rotated webhook keys independently.
    webhookSecret: process.env.TODOIST_WEBHOOK_SECRET || process.env.TODOIST_CLIENT_SECRET || '',
  },
  // ── Notion (TASK-16b — task provider, polling-only) ────────────────
  notion: {
    clientId: process.env.NOTION_CLIENT_ID || '',
    clientSecret: process.env.NOTION_CLIENT_SECRET || '',
  },
  // ── Garmin Connect (Daily Coach) ────────────────────────────────────
  garmin: {
    email: process.env.GARMIN_EMAIL || '',
    password: process.env.GARMIN_PASSWORD || '',
    tokenPath: process.env.GARMIN_TOKEN_PATH || './data/garmin-tokens',
    coachEnabled: (process.env.GARMIN_COACH_ENABLED || 'false') === 'true',
    coachTime: process.env.GARMIN_COACH_TIME || '21:00',
  },
  // ── Google Drive (DOCX uploads) ───────────────────────────────────
  googleDrive: {
    enabled: process.env.GOOGLE_DRIVE_ENABLED
      ? process.env.GOOGLE_DRIVE_ENABLED === 'true'
      : !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN),
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '',
  },
  // ── YouTube ────────────────────────────────────────────────────────
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || '',
    channelId: process.env.YOUTUBE_CHANNEL_ID || '',  // Felipe's own channel ID
  },
  // ── Content Engine (Python microservice) ────────────────────────────
  contentEngine: {
    enabled: (process.env.CONTENT_ENGINE_ENABLED || 'false') === 'true',
    port: parseInt(process.env.CONTENT_ENGINE_PORT || '8100', 10),
  },
  // ── Database Backup ─────────────────────────────────────────────────
  backup: {
    enabled: (process.env.BACKUP_ENABLED || 'true') === 'true',
    dir: process.env.BACKUP_DIR || './data/backups',
    retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10),
    time: process.env.BACKUP_TIME || '03:00',
    encrypt: (process.env.BACKUP_ENCRYPT || 'false') === 'true',
    encryptionKey: process.env.BACKUP_KEY || '',
  },
  // ── Status Portal ──────────────────────────────────────────────────
  portal: {
    enabled: (process.env.PORTAL_ENABLED || 'true') === 'true',
    port: parseInt(process.env.PORTAL_PORT || '8200', 10),
    bind: process.env.PORTAL_BIND || '0.0.0.0',
    token: process.env.PORTAL_TOKEN || '',
  },
  // ── WhatsApp Cloud API (optional) ──────────────────────────────────
  whatsapp: {
    phoneNumberId: process.env.WHATSAPP_PHONE_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    enabled: !!process.env.WHATSAPP_PHONE_ID && !!process.env.WHATSAPP_ACCESS_TOKEN,
  },
  // ── Webhook Infrastructure ─────────────────────────────────────────
  webhooks: {
    enabled: (process.env.WEBHOOKS_ENABLED || 'true') === 'true',
    secret: process.env.WEBHOOK_SECRET || '',
    maxPayloadBytes: parseInt(process.env.WEBHOOK_MAX_PAYLOAD || '1048576', 10),
    eventRetentionDays: parseInt(process.env.WEBHOOK_RETENTION_DAYS || '30', 10),
  },
  // ── Health Check ──────────────────────────────────────────────────
  health: {
    token: process.env.HEALTH_TOKEN || '',
  },
  // ── Finance Data Encryption ─────────────────────────────────────
  financeEncryption: {
    enabled: (process.env.FINANCE_ENCRYPTION_ENABLED || 'true') === 'true',
    masterKey: process.env.FINANCE_ENCRYPTION_KEY || '',
  },
  rateLimit: {
    maxMessagesPerMinute: 30,
  },
  // ── iOS API ─────────────────────────────────────────────────────────
  ios: {
    enabled: (process.env.IOS_API_ENABLED || 'false') === 'true',
    websocketEnabled: (process.env.IOS_WS_ENABLED || 'false') === 'true',
    jwtSecret: process.env.IOS_API_JWT_SECRET || '',
    jwtExpiry: process.env.IOS_JWT_EXPIRY || '7d',
    rateLimit: parseInt(process.env.IOS_API_RATE_LIMIT || '60', 10),
    inviteCode: process.env.IOS_INVITE_CODE || '',
    ownerCode: process.env.IOS_OWNER_CODE || '',
  },
  mesh: {
    enabled: process.env.NEXUS_MULTISKILL_MESH === 'on',
  },
  // ── Apple Push Notification Service (APNs) ────────────────────────
  // Token-based auth only (modern .p8 approach). All four env vars must
  // be present for the sender to actually dispatch — when any are missing,
  // the sender logs a single warn on first call and then no-ops for every
  // subsequent call. This means the iOS app ships + the crons run even
  // when APNs isn't fully configured yet, without touching the app code.
  //
  // APNS_AUTH_KEY_P8 can be either:
  //   (a) the full raw contents of the .p8 file (including BEGIN/END lines),
  //       with newlines preserved as \n when set via a single-line .env
  //   (b) the file path to the .p8 (e.g. "/home/dominguez/secrets/AuthKey_AB.p8")
  // The sender auto-detects which one was passed (file path = exists on disk).
  apns: {
    enabled: (process.env.APNS_ENABLED || 'false') === 'true',
    teamId: process.env.APNS_TEAM_ID || '',
    keyId: process.env.APNS_KEY_ID || '',
    bundleId: process.env.APNS_BUNDLE_ID || 'me.nexushub.app',
    authKey: process.env.APNS_AUTH_KEY_P8 || '',
    // 'production' → api.push.apple.com, 'sandbox' → api.sandbox.push.apple.com
    environment: (process.env.APNS_ENVIRONMENT || 'production') as 'production' | 'sandbox',
  },
  // ── Stripe Billing ────────────────────────────────────────────────
  // Web checkout: users subscribe at nexushub.me, Stripe webhook writes
  // to the subscriptions table. iOS reads status via GET /billing/status.
  // Empty values = Stripe not configured (billing endpoints return 503).
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    // USD prices
    priceProMonthly: process.env.STRIPE_PRICE_PRO_MONTHLY || '',
    priceProYearly: process.env.STRIPE_PRICE_PRO_YEARLY || '',
    priceMaxMonthly: process.env.STRIPE_PRICE_MAX_MONTHLY || '',
    priceMaxYearly: process.env.STRIPE_PRICE_MAX_YEARLY || '',
    // BRL prices
    priceProMonthlyBrl: process.env.STRIPE_PRICE_PRO_MONTHLY_BRL || '',
    priceProYearlyBrl: process.env.STRIPE_PRICE_PRO_YEARLY_BRL || '',
    priceMaxMonthlyBrl: process.env.STRIPE_PRICE_MAX_MONTHLY_BRL || '',
    priceMaxYearlyBrl: process.env.STRIPE_PRICE_MAX_YEARLY_BRL || '',
    // EUR prices
    priceProMonthlyEur: process.env.STRIPE_PRICE_PRO_MONTHLY_EUR || '',
    priceProYearlyEur: process.env.STRIPE_PRICE_PRO_YEARLY_EUR || '',
    priceMaxMonthlyEur: process.env.STRIPE_PRICE_MAX_MONTHLY_EUR || '',
    priceMaxYearlyEur: process.env.STRIPE_PRICE_MAX_YEARLY_EUR || '',
  },

  // ── AI Safety ─────────────────────────────────────────────────────
  aiSafety: {
    callTimeoutMs: parseInt(process.env.AI_CALL_TIMEOUT_MS || '30000', 10),
    globalDailyLimitUsd: parseFloat(process.env.GLOBAL_DAILY_COST_LIMIT || '10.00'),
    alertThresholdPercent: parseFloat(process.env.COST_ALERT_THRESHOLD || '0.80'),
  },
} as const;

// Fail-fast: empty allowedUserIds would silently reject all Telegram ingress.
// This list is no longer used as owner bootstrap state.
// Skipped in staging because Telegram is optional there — see requiredInProd
// above. In staging the bot may not even start, so an empty allowlist isn't
// a security risk, just a "no fallback users registered" warning.
if (!IS_STAGING && config.telegram.allowedUserIds.length === 0) {
  throw new Error('TELEGRAM_ALLOWED_USER_IDS parsed to empty list — check env var format (comma-separated numeric IDs)');
}

// Fail-fast: iOS API enabled without a proper JWT secret is a security risk
if (config.ios.enabled && !config.ios.jwtSecret) {
  throw new Error('IOS_API_ENABLED=true but IOS_API_JWT_SECRET is not set. Set a 256-bit secret.');
}
if (config.ios.enabled && !config.ios.inviteCode) {
  throw new Error('IOS_API_ENABLED=true but IOS_INVITE_CODE is not set.');
}
