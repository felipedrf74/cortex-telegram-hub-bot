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
  },
  isStaging: IS_STAGING,
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    classifierModel: process.env.ANTHROPIC_CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
    maxTokens: 1024,             // triathlon/content — conversational, rarely exceeds 800 tokens
    secretaryMaxTokens: 2048,   // needs headroom for parallel tool calls
  },
  // ── Alternative AI Providers (optional fallbacks) ──────────────────
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    classifierModel: process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-5-nano',
    maxTokens: 1024,            // content domain — conversational
    secretaryMaxTokens: 2048,   // secretary — parallel tool calls need headroom
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
    maxTokens: 1024,
    secretaryMaxTokens: 2048,
  },
  // ── Provider Fallback Routing ─────────────────────────────────────
  // Per-task-type primary/fallback. Values: 'anthropic' | 'openai' | 'gemini'
  providerRouting: {
    classify: {
      primary: process.env.AI_CLASSIFY_PRIMARY || 'gemini',
      fallback: process.env.AI_CLASSIFY_FALLBACK || 'anthropic',
    },
    chat: {
      primary: process.env.AI_CHAT_PRIMARY || 'anthropic',
      fallback: process.env.AI_CHAT_FALLBACK || 'gemini',
    },
    toolUse: {
      primary: process.env.AI_TOOL_USE_PRIMARY || 'anthropic',
      fallback: process.env.AI_TOOL_USE_FALLBACK || 'gemini',
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
    jwtSecret: process.env.IOS_API_JWT_SECRET || '',
    jwtExpiry: process.env.IOS_JWT_EXPIRY || '7d',
    rateLimit: parseInt(process.env.IOS_API_RATE_LIMIT || '60', 10),
    inviteCode: process.env.IOS_INVITE_CODE || '',
  },
  // ── AI Safety ─────────────────────────────────────────────────────
  aiSafety: {
    callTimeoutMs: parseInt(process.env.AI_CALL_TIMEOUT_MS || '30000', 10),
    globalDailyLimitUsd: parseFloat(process.env.GLOBAL_DAILY_COST_LIMIT || '10.00'),
    alertThresholdPercent: parseFloat(process.env.COST_ALERT_THRESHOLD || '0.80'),
  },
} as const;

// Fail-fast: empty allowedUserIds would silently reject all messages.
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
