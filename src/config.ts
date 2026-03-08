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
    model: 'claude-sonnet-4-5-20250929' as const,
    classifierModel: 'claude-haiku-4-5-20251001' as const,
    maxTokens: 1024,             // triathlon/content — conversational, rarely exceeds 800 tokens
    secretaryMaxTokens: 2048,   // needs headroom for parallel tool calls
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
    digestTime: process.env.TODO_DIGEST_TIME || '08:00',
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
  },
  rateLimit: {
    maxMessagesPerMinute: 30,
  },
} as const;
