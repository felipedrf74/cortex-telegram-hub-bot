// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import dotenv from 'dotenv';
dotenv.config({ override: true });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  telegram: {
    botToken: required('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: required('TELEGRAM_ALLOWED_USER_IDS')
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !isNaN(id)),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: 'claude-sonnet-4-6' as const,
    classifierModel: 'claude-haiku-4-5-20251001' as const,
    maxTokens: 1024,             // triathlon/content — conversational, rarely exceeds 800 tokens
    secretaryMaxTokens: 2048,   // needs headroom for parallel tool calls
  },
  // ── Alternative AI Providers (optional fallbacks) ──────────────────
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    classifierModel: process.env.OPENAI_CLASSIFIER_MODEL || 'gpt-4o-mini',
    maxTokens: 1024,            // content domain — conversational
    secretaryMaxTokens: 2048,   // secretary — parallel tool calls need headroom
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    classifierModel: process.env.GEMINI_CLASSIFIER_MODEL || 'gemini-2.0-flash',
    maxTokens: 1024,
    secretaryMaxTokens: 2048,
  },
  // ── Provider Fallback Routing ─────────────────────────────────────
  // Per-task-type primary/fallback. Values: 'anthropic' | 'openai' | 'gemini'
  providerRouting: {
    classify: {
      primary: process.env.AI_CLASSIFY_PRIMARY || 'anthropic',
      fallback: process.env.AI_CLASSIFY_FALLBACK || 'openai',
    },
    chat: {
      primary: process.env.AI_CHAT_PRIMARY || 'anthropic',
      fallback: process.env.AI_CHAT_FALLBACK || 'openai',
    },
    toolUse: {
      primary: process.env.AI_TOOL_USE_PRIMARY || 'anthropic',
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
  },
  // ── Status Portal ──────────────────────────────────────────────────
  portal: {
    enabled: (process.env.PORTAL_ENABLED || 'true') === 'true',
    port: parseInt(process.env.PORTAL_PORT || '8200', 10),
    bind: process.env.PORTAL_BIND || '0.0.0.0',
    token: process.env.PORTAL_TOKEN || '',
  },
  // ── Webhook Infrastructure ─────────────────────────────────────────
  webhooks: {
    enabled: (process.env.WEBHOOKS_ENABLED || 'true') === 'true',
    secret: process.env.WEBHOOK_SECRET || '',        // HMAC-SHA256 signing secret (shared with providers)
    maxPayloadBytes: parseInt(process.env.WEBHOOK_MAX_PAYLOAD || '1048576', 10), // 1MB default
    eventRetentionDays: parseInt(process.env.WEBHOOK_RETENTION_DAYS || '30', 10),
  },
  // ── Data Encryption ─────────────────────────────────────────────────
  encryption: {
    dataKey: process.env.DATA_ENCRYPTION_KEY || '',  // 64 hex chars (256-bit AES key)
  },
  rateLimit: {
    maxMessagesPerMinute: 30,
  },
} as const;

// Fail-fast: empty allowedUserIds would silently reject all messages
if (config.telegram.allowedUserIds.length === 0) {
  throw new Error('TELEGRAM_ALLOWED_USER_IDS parsed to empty list — check env var format (comma-separated numeric IDs)');
}
