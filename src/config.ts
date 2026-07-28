// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import dotenv from 'dotenv';
import { contentLiveEvalDotenvOptions } from './services/content-live-evaluation-runtime';
import { resolveOllamaSmallOnlyRuntimeConfig } from './services/ollama-model-policy';
dotenv.config(contentLiveEvalDotenvOptions());

// Fail at process startup before provider registration if any environment
// variable can select a local model outside the ServerDominguez 3B allowlist.
const OLLAMA_MODELS = resolveOllamaSmallOnlyRuntimeConfig(process.env);

// STAGING flag set by ecosystem.staging.config.js. When true, certain
// "production-only" required env vars become optional so the staging
// install can boot with a reduced credential set.
// Quarter audit item: staging environment.
const IS_STAGING = process.env.STAGING === 'true' || process.env.NODE_ENV === 'staging';
const IS_TEST = process.env.NODE_ENV === 'test';
const IS_DEVELOPMENT = !process.env.NODE_ENV || process.env.NODE_ENV === 'development';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PAYWALL_ENABLED = (process.env.PAYWALL_ENABLED ?? 'true') !== 'false';
const PAYWALL_BYPASS_ALLOWED = IS_TEST || IS_DEVELOPMENT || IS_STAGING;
const IOS_JWT_SECRET_MIN_BYTES = 32;
const IOS_JWT_PLACEHOLDER_PATTERN = /(change[-_ ]?me|changeme|stub)/i;
const PORTAL_PUBLIC_BIND_ACK_VALUE = 'production-public-host-reviewed';
const CONTENT_ENGINE_PORT = optionalInt('CONTENT_ENGINE_PORT', 8100, { min: 1, max: 65535 });
export type NotificationDeliveryMode = 'mock' | 'apns';
type ContentWorkspaceRolloutConfigMode = 'off' | 'read_only' | 'recovery_only' | 'write';

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

interface NumericEnvOptions {
  min?: number;
  max?: number;
}

function validateNumericEnv(key: string, raw: string, value: number, options: NumericEnvOptions = {}): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric environment variable: ${key}="${raw}"`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new Error(`Environment variable ${key} must be >= ${options.min}; received "${raw}"`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`Environment variable ${key} must be <= ${options.max}; received "${raw}"`);
  }
  return value;
}

function optionalInt(key: string, fallback: number, options: NumericEnvOptions = {}): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return validateNumericEnv(key, raw, Number.parseInt(raw, 10), options);
}

function optionalFloat(key: string, fallback: number, options: NumericEnvOptions = {}): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return validateNumericEnv(key, raw, Number.parseFloat(raw), options);
}

function optionalBoolean(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  return false;
}

function contentWorkspaceRolloutMode(): ContentWorkspaceRolloutConfigMode {
  const fallback: ContentWorkspaceRolloutConfigMode = IS_PRODUCTION ? 'read_only' : 'write';
  const raw = process.env.CONTENT_WORKSPACE_V1_MODE?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'off' || raw === 'read_only' || raw === 'recovery_only' || raw === 'write') return raw;
  return 'read_only';
}

function parseNotificationDeliveryMode(raw = process.env.NOTIFICATION_DELIVERY_MODE): NotificationDeliveryMode {
  const normalized = (raw || '').trim().toLowerCase();
  if (!normalized) return process.env.NODE_ENV === 'production' ? 'apns' : 'mock';
  if (normalized === 'mock' || normalized === 'apns') return normalized;
  throw new Error(
    `Invalid NOTIFICATION_DELIVERY_MODE="${raw}". Expected one of: mock, apns.`,
  );
}

function warnProductionLaunch(message: string): void {
  if (IS_PRODUCTION && message) {
    console.warn(`[production launch warning] ${message}`);
  }
}

function isUnsafePublicBind(bind: string | undefined): boolean {
  const normalized = (bind || '').trim().toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isStrongIosJwtSecret(secret: string): boolean {
  return Buffer.byteLength(secret, 'utf8') >= IOS_JWT_SECRET_MIN_BYTES
    && !IOS_JWT_PLACEHOLDER_PATTERN.test(secret);
}

export const config = {
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
  // Defaults are mixed by task fit. Classifier and tool-use stay Gemini-first,
  // while generic chat defaults to OpenAI GPT-5.4 nano with Gemini fallback.
  // Previous defaults had chat+toolUse primary=anthropic, which was a
  // correct choice at the time but stale by the time the Gemini migration and
  // GPT nano review shipped. The env vars are an override, not a lifeline.
  // Option 3 (O3-A7): minimum confidence thresholds for the classify
  // task. When a primary classifier returns a result with confidence
  // BELOW these thresholds, TaskRoutingProvider.classify retries via
  // the configured fallback provider. Tool-bearing domains (secretary,
  // triathlon) require a higher bar because misroute risk is higher.
  // Defaults are no-op for Gemini (confidence ≈ 1.0 in practice);
  // become active once AI_CLASSIFY_PRIMARY=ollama.
  classifyConfidenceThresholds: {
    minConfidence: parseFloat(process.env.OLLAMA_CLASSIFIER_MIN_CONFIDENCE || '0.65'),
    toolDomainMinConfidence: parseFloat(process.env.OLLAMA_CLASSIFIER_TOOL_DOMAIN_MIN_CONFIDENCE || '0.80'),
  },
  providerRouting: {
    // May 2026 — generic chat uses GPT-5.4 nano by default because it is
    // cheaper than Gemini Flash on the chat token mix and stronger on
    // structured/instruction-following answers. Domain routing below still
    // pins Training/Content/Finance/Cooking to their safer Gemini baselines.
    // Anthropic is only reachable when BOTH an explicit env var points
    // at it AND `ANTHROPIC_ENABLED=true` is set in the environment —
    // see `anthropic-hook.trackedCreate` for the hard gate.
    classify: {
      primary: process.env.AI_CLASSIFY_PRIMARY || 'gemini',
      fallback: process.env.AI_CLASSIFY_FALLBACK || 'openai',
    },
    chat: {
      primary: process.env.AI_CHAT_PRIMARY || 'openai',
      fallback: process.env.AI_CHAT_FALLBACK || 'gemini',
    },
    toolUse: {
      primary: process.env.AI_TOOL_USE_PRIMARY || 'gemini',
      fallback: process.env.AI_TOOL_USE_FALLBACK || 'openai',
    },
    // ── New task types introduced by WO-ollama-local-llm ──────────
    // `'none'`             = no fallback; surface a structured error.
    // `'approved_cloud_reasoning'` = route through cloud-reasoning-gate.
    scriptGeneration: {
      primary: process.env.AI_SCRIPT_GENERATION_PRIMARY || 'ollama',
      fallback: process.env.AI_SCRIPT_GENERATION_FALLBACK || 'approved_cloud_reasoning',
    },
    localReasoning: {
      primary: process.env.AI_LOCAL_REASONING_PRIMARY || 'ollama',
      fallback: process.env.AI_LOCAL_REASONING_FALLBACK || 'approved_cloud_reasoning',
    },
    circuitBreaker: {
      failureThreshold: optionalInt('AI_CB_FAILURE_THRESHOLD', 3, { min: 1 }),
      cooldownMs: optionalInt('AI_CB_COOLDOWN_MS', 60000, { min: 0 }),
    },
  },

  // ── Local LLM (Ollama) — WO-ollama-local-llm ─────────────────────
  // The provider stays dormant when OLLAMA_ENABLED=false (default). When
  // enabled, the registry exposes the OllamaProvider; routing only kicks
  // in once AI_CLASSIFY_PRIMARY=ollama (or scriptGeneration / localReasoning).
  ollama: {
    enabled: (process.env.OLLAMA_ENABLED || 'false') === 'true',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    model: OLLAMA_MODELS.model,
    classifierModel: OLLAMA_MODELS.classifierModel,
    // Deprecated compatibility alias. There is no separate local rollback
    // model; rollback disables Ollama and uses approved cloud routing.
    operationalRollbackModel: OLLAMA_MODELS.model,
    maxTokens: optionalInt('OLLAMA_MAX_TOKENS', 2048, { min: 64, max: 4096 }),
    secretaryMaxTokens: optionalInt('OLLAMA_SECRETARY_MAX_TOKENS', 4096, { min: 64, max: 4096 }),
    // Provider-level ceiling. Interactive local-chat paths apply their own
    // substantially lower deadlines; this remains generous for bounded
    // background 3B evaluation while the circuit breaker stays authoritative.
    timeoutMs: optionalInt('OLLAMA_TIMEOUT_MS', 360000, { min: 1000, max: 600000 }),

    // Per-task input/output token caps (plan A10 — conservative estimator).
    // Classify output stays small (128); script/reasoning limits remain bounded
    // for compatibility but all calls resolve to the sole approved 3B model.
    tokenCaps: {
      classifyMaxInput: optionalInt('OLLAMA_CLASSIFY_MAX_INPUT_TOKENS', 1500, { min: 128 }),
      classifyMaxOutput: optionalInt('OLLAMA_CLASSIFY_MAX_OUTPUT_TOKENS', 128, { min: 16 }),
      scriptGenMaxInput: optionalInt('OLLAMA_SCRIPT_GEN_MAX_INPUT_TOKENS', 6000, { min: 256 }),
      scriptGenMaxOutput: optionalInt('OLLAMA_SCRIPT_GEN_MAX_OUTPUT_TOKENS', 4096, { min: 256 }),
      localReasoningMaxInput: optionalInt('OLLAMA_LOCAL_REASONING_MAX_INPUT_TOKENS', 6000, { min: 256 }),
      localReasoningMaxOutput: optionalInt('OLLAMA_LOCAL_REASONING_MAX_OUTPUT_TOKENS', 3000, { min: 64 }),
    },

    // Bounded queue — capacity_exceeded does NOT open the circuit.
    queue: {
      backend: (process.env.LOCAL_LLM_QUEUE_BACKEND || 'memory') as 'memory' | 'sqlite' | 'redis',
      classifyDepth: optionalInt('OLLAMA_QUEUE_CLASSIFY_DEPTH', 4, { min: 1, max: 32 }),
      scriptGenDepth: optionalInt('OLLAMA_QUEUE_SCRIPT_GEN_DEPTH', 2, { min: 1, max: 16 }),
      localReasoningDepth: optionalInt('OLLAMA_QUEUE_LOCAL_REASONING_DEPTH', 2, { min: 1, max: 16 }),
      classifyMaxWaitMs: optionalInt('OLLAMA_QUEUE_CLASSIFY_MAX_WAIT_MS', 5000, { min: 0, max: 60000 }),
      scriptGenMaxWaitMs: optionalInt('OLLAMA_QUEUE_SCRIPT_GEN_MAX_WAIT_MS', 30000, { min: 0, max: 300000 }),
      localReasoningMaxWaitMs: optionalInt('OLLAMA_QUEUE_LOCAL_REASONING_MAX_WAIT_MS', 30000, { min: 0, max: 300000 }),
      globalMaxDepth: optionalInt('LOCAL_LLM_GLOBAL_QUEUE_MAX_DEPTH', 8, { min: 1, max: 64 }),
    },

    // Call-count rate limiter — separate from cost-guardrail $ limits
    // because Ollama calls cost $0 and would otherwise be unbounded.
    rateLimit: {
      perUserDaily: optionalInt('LOCAL_LLM_USER_DAILY_CALL_LIMIT', 200, { min: 0 }),
      perUserHourly: optionalInt('LOCAL_LLM_USER_HOURLY_CALL_LIMIT', 40, { min: 0 }),
      scriptGenPerUserDaily: optionalInt('LOCAL_LLM_SCRIPT_DAILY_CALL_LIMIT', 20, { min: 0 }),
    },

    // Artifact retention for generated scripts
    artifacts: {
      retentionDays: optionalInt('LOCAL_LLM_ARTIFACT_RETENTION_DAYS', 14, { min: 0, max: 365 }),
      storePrompts: (process.env.LOCAL_LLM_STORE_PROMPTS || 'false') === 'true',
      storeGenerated: (process.env.LOCAL_LLM_STORE_GENERATED_ARTIFACTS || 'true') === 'true',
    },
  },

  // ── Quality + privacy gate for complex cloud reasoning fallback ──
  cloudReasoningFallback: {
    enabled: (process.env.CLOUD_REASONING_FALLBACK_ENABLED || 'false') === 'true',
    provider: (process.env.CLOUD_REASONING_PROVIDER || '') as '' | 'gemini' | 'openai' | 'anthropic',
    model: process.env.CLOUD_REASONING_MODEL || '',
    requireApprovedModel: (process.env.CLOUD_REASONING_REQUIRE_APPROVED_MODEL || 'true') === 'true',
    allowPreviewModels: (process.env.CLOUD_REASONING_ALLOW_PREVIEW_MODELS || 'false') === 'true',
    approvedReasoningModels: (process.env.APPROVED_REASONING_MODELS || 'gemini-2.5-pro,claude-sonnet-4-6')
      .split(',').map(s => s.trim()).filter(Boolean),
    // Plan amendment R3-8: disallow list blocks flash/flash-lite/nano/mini/haiku/fast/lite/classifier
    // even when the operator accidentally lists them in APPROVED_REASONING_MODELS.
    disallowedSubstrings: (process.env.DISALLOWED_COMPLEX_FALLBACK_MODELS ||
      'flash,flash-lite,nano,mini,haiku,lite,classifier,fast')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // A privacy or quality rejection must surface explicitly. There is no
    // large local model to silently substitute under the small-only policy.
    onUnapproved: (process.env.CLOUD_REASONING_ON_UNAPPROVED_MODEL || 'fail_visibly') as
      'return_local_result_with_warning' | 'fail_visibly' | 'allow',
    privacy: {
      mode: (process.env.CLOUD_REASONING_PRIVACY_MODE || 'redacted_only') as 'redacted_only' | 'allow_raw' | 'never',
      allowRawPrivateData: (process.env.CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA || 'false') === 'true',
    },
  },

  // ── Local LLM evaluation mode ────────────────────────────────────
  localLLMEvaluation: {
    // Local script/reasoning is an explicit evaluation-only role. Production
    // defaults route these workloads through the approved cloud/privacy gate.
    enabled: (process.env.LOCAL_LLM_EVALUATION_MODE || 'false') === 'true',
    showProviderMetadata: (process.env.LOCAL_LLM_SHOW_PROVIDER_METADATA || 'true') === 'true',
    requireLocalForScriptGen: (process.env.AI_SCRIPT_GENERATION_REQUIRE_LOCAL || 'false') === 'true',
  },

  // ── Option 3: classify shadow-eval ───────────────────────────────
  // When `classifyShadow=true`, every live Gemini classify call also
  // fires (fire-and-forget) an Ollama classify call with the small
  // classifier model, and the comparison is logged to
  // `classify_shadow_runs`. The user response is NEVER blocked on the
  // shadow path. Used to validate a future cutover from Gemini→Ollama
  // for classify. Defaults to false; the operator opts in via env.
  localLLM: {
    classifyShadow: (process.env.LOCAL_LLM_CLASSIFY_SHADOW || 'false') === 'true',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
    iosClientId: process.env.GOOGLE_IOS_CLIENT_ID || '',
  },
  appleWeb: {
    // Sign in with Apple on the web uses an Apple Services ID as the
    // OAuth client_id. Keep this separate from APNS_BUNDLE_ID, which is
    // the native iOS App ID audience used by /auth/register/apple.
    clientId: process.env.APPLE_WEB_CLIENT_ID || '',
    redirectUri:
      process.env.APPLE_WEB_REDIRECT_URI ||
      `${process.env.OAUTH_REDIRECT_BASE || 'https://api.nexushub.me'}/oauth/apple/callback`,
  },
  // ── Sign in with Apple token revocation (Guideline 5.1.1(v)) ──────
  //
  // Apple requires an app offering Sign in with Apple to revoke the user's
  // Apple token on account deletion. Revocation is authenticated with an
  // ES256 client-secret JWT built from an Apple "Sign in with Apple" private
  // key (a DIFFERENT key from the APNs one — same .p8 shape, different
  // capability), so these deliberately do NOT reuse config.apns.
  //
  // APPLE_SIGN_IN_PRIVATE_KEY_P8 accepts the same three shapes as
  // APNS_AUTH_KEY_P8: raw .p8 contents, a path on disk, or a single-line
  // value with escaped newlines.
  //
  // All three are optional. When any is unset the feature degrades to the
  // same `local_only` outcome unconfigured providers already record, and
  // account deletion still completes. There is no boot-time invariant here
  // on purpose — production does not have these values yet.
  appleSignIn: {
    // The Apple team id is identical to the one APNs already uses, so
    // APNS_TEAM_ID is the fallback — it is the variable that actually exists
    // in this deployment. Mirrors the clientId/APNS_BUNDLE_ID fallback below.
    teamId: process.env.APPLE_SIGN_IN_TEAM_ID || process.env.APNS_TEAM_ID || '',
    keyId: process.env.APPLE_SIGN_IN_KEY_ID || '',
    privateKey: process.env.APPLE_SIGN_IN_PRIVATE_KEY_P8 || '',
    // The OAuth client_id used for native iOS Sign in with Apple. This is the
    // App ID (bundle identifier), which is also the identity-token audience.
    clientId: process.env.APPLE_SIGN_IN_CLIENT_ID || process.env.APNS_BUNDLE_ID || 'me.nexushub.app',
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
    // M5 single write path: ALL task/list writes (chat tools, chat-core-v2
    // commands, planner skills, callbacks, content-topic sync, list REST)
    // flow through the offline-first ledger instead of writing providers
    // directly. Default ON; operations can revert to the legacy direct
    // provider path without a deploy via TASK_SINGLE_WRITE_PATH=0 (or
    // 'false'). Call sites consult isSingleWritePathEnabled() from
    // src/services/task-store/single-write-path.ts, which re-reads the env
    // at call time (this boot-parsed value is the unset default) so tests
    // can exercise both states without module re-imports.
    singleWritePath:
      (process.env.TASK_SINGLE_WRITE_PATH ?? '1') !== '0'
      && (process.env.TASK_SINGLE_WRITE_PATH ?? 'true') !== 'false',
  },
  // ── Invoice/Receipt Filing (legacy SSH fields retained for backfill metadata) ─────
  invoices: {
    enabled: (process.env.INVOICE_FILING_ENABLED || 'true') === 'true',
    sshHost: process.env.INVOICE_SSH_HOST || '',
    sshPort: process.env.INVOICE_SSH_PORT || '22',
    sshUser: process.env.INVOICE_SSH_USER || '',
    sshKeyPath: process.env.INVOICE_SSH_KEY || '',
    remotePath: process.env.INVOICE_REMOTE_PATH || '',
    minConfidence: optionalFloat('INVOICE_MIN_CONFIDENCE', 0.70, { min: 0, max: 1 }),
    compressionEnabled: (process.env.INVOICE_COMPRESSION_ENABLED || 'true') === 'true',
    jpegQuality: optionalInt('INVOICE_JPEG_QUALITY', 80, { min: 1, max: 100 }),
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
  invoiceObjectStorage: {
    enabled: (process.env.INVOICE_OBJECT_STORAGE_ENABLED || 'true') === 'true',
    filesystemDir: process.env.INVOICE_OBJECT_STORAGE_DIR || './data/invoice-objects',
    maxObjectBytes: optionalInt('INVOICE_OBJECT_MAX_BYTES', 10 * 1024 * 1024, { min: 1 }),
    minFreeBytes: optionalInt('INVOICE_OBJECT_MIN_FREE_BYTES', 512 * 1024 * 1024, { min: 0 }),
    tenantMaxBytes: optionalInt('INVOICE_OBJECT_TENANT_MAX_BYTES', 5 * 1024 * 1024 * 1024, { min: 0 }),
  },
  // ── Sentry Error Tracking ────────────────────────────────────────────
  // Cloud-based error monitoring alongside our existing SQLite + operator
  // alerting. Free tier gives 5K errors/month which is plenty. Set SENTRY_DSN
  // in prod .env to enable; leave empty for local/staging to run without it.
  // tracesSampleRate defaults to 0 (errors only, no APM traces) to preserve
  // the free-tier quota — flip to 0.1 if you want 10% of requests traced.
  sentry: {
    dsn: process.env.SENTRY_DSN || '',
    environment: optional('SENTRY_ENVIRONMENT', 'development'),
    release: process.env.SENTRY_RELEASE || '',
    tracesSampleRate: optionalFloat('SENTRY_TRACES_SAMPLE_RATE', 0, { min: 0, max: 1 }),
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
    channelId: process.env.YOUTUBE_CHANNEL_ID || '',  // configured creator channel ID
  },
  // ── Content Engine (Python microservice) ────────────────────────────
  contentEngine: {
    enabled: (process.env.CONTENT_ENGINE_ENABLED || 'false') === 'true',
    port: CONTENT_ENGINE_PORT,
    baseUrl: optional('CONTENT_ENGINE_BASE_URL', `http://localhost:${CONTENT_ENGINE_PORT}`),
    internalApiSecret: process.env.INTERNAL_API_SECRET || '',
  },
  // Temporary canonical Content workspace rollout authority. Domain services
  // still resolve the live environment at call time so an operator kill switch
  // takes effect without constructing a second configuration authority.
  contentWorkspaceRollout: {
    mode: contentWorkspaceRolloutMode(),
    globalWrite: optionalBoolean('CONTENT_WORKSPACE_V1_GLOBAL_WRITE', false),
    userIds: process.env.CONTENT_WORKSPACE_V1_USER_IDS || '',
    tenantIds: process.env.CONTENT_WORKSPACE_V1_TENANT_IDS || '',
    slices: {
      core: optionalBoolean('CONTENT_WORKSPACE_V1_CORE_WRITES', true),
      revisions: optionalBoolean('CONTENT_WORKSPACE_V1_REVISION_WRITES', true),
      lineage: optionalBoolean('CONTENT_WORKSPACE_V1_LINEAGE_WRITES', true),
      agents: optionalBoolean('CONTENT_WORKSPACE_V1_AGENT_WRITES', true),
      scheduling: optionalBoolean('CONTENT_WORKSPACE_V1_SCHEDULE_WRITES', true),
      recovery: optionalBoolean('CONTENT_WORKSPACE_V1_RECOVERY_WRITES', true),
    },
  },
  // ── Database Backup ─────────────────────────────────────────────────
  backup: {
    enabled: (process.env.BACKUP_ENABLED || 'true') === 'true',
    dir: process.env.BACKUP_DIR || './data/backups',
    retentionDays: optionalInt('BACKUP_RETENTION_DAYS', 30, { min: 1 }),
    time: process.env.BACKUP_TIME || '03:00',
    encrypt: (process.env.BACKUP_ENCRYPT || 'false') === 'true',
    encryptionKey: process.env.BACKUP_KEY || '',
  },
  // ── Status Portal ──────────────────────────────────────────────────
  portal: {
    enabled: (process.env.PORTAL_ENABLED || 'true') === 'true',
    port: optionalInt('PORTAL_PORT', 8200, { min: 1, max: 65535 }),
    bind: process.env.PORTAL_BIND || '127.0.0.1',
    // Legacy full-access admin bearer token. New scoped tokens can be
    // configured below for least-privilege portal usage, but this
    // remains the backward-compatible fallback if operators have not
    // split their portal credentials yet.
    token: process.env.PORTAL_TOKEN || '',
    // Optional read-only portal token. When configured, GET/HEAD/OPTIONS
    // admin routes can use this token while write routes still require
    // `writeToken` (or the legacy full-access token above).
    readToken: process.env.PORTAL_READ_TOKEN || '',
    // Optional write-capable portal token. When configured, mutating
    // admin routes require this token (or the legacy full-access token).
    writeToken: process.env.PORTAL_WRITE_TOKEN || '',
    // Optional elevated admin token. Use this for sensitive operator
    // mutations such as founder grants, plan-policy edits, waitlist
    // approvals, and user entitlement changes. Remote admin mutations
    // fail closed when this is unset unless explicit legacy fallback or
    // loopback-only local bypass is active.
    adminToken: process.env.PORTAL_ADMIN_TOKEN || '',
    // Optional actor-awareness for sensitive portal admin actions.
    // When PORTAL_ADMIN_ACTORS is configured, admin requests must include
    // x-portal-actor/x-admin-actor/x-operator-email matching this allowlist.
    // PORTAL_ADMIN_REQUIRE_ACTOR=true requires a valid actor header even
    // without an allowlist, which improves audit quality for operator clients.
    adminRequireActor:
      (process.env.PORTAL_ADMIN_REQUIRE_ACTOR || 'false') === 'true',
    adminActorAllowlist: (process.env.PORTAL_ADMIN_ACTORS || '')
      .split(',')
      .map((actor) => actor.trim().toLowerCase())
      .filter(Boolean),
    // Optional HMAC hardening for actor-aware admin routes. When configured,
    // sensitive admin requests must include a signed actor hint generated by a
    // trusted gateway/session layer:
    //   x-portal-actor: alice@example.com
    //   x-portal-actor-timestamp: <unix-ms>
    //   x-portal-actor-signature: sha256=<hmac(actor.timestamp)>
    adminActorSignatureSecret: process.env.PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET || '',
    adminActorSignatureToleranceMs: optionalInt(
      'PORTAL_ADMIN_ACTOR_SIGNATURE_TOLERANCE_MS',
      300000,
      { min: 1000 },
    ),
    // Optional short-lived operator session tokens. This is the migration seam
    // away from static shared bearer secrets: a trusted portal/session layer can
    // mint signed sessions that carry actor + scope + expiry, while existing
    // static tokens remain available unless PORTAL_REQUIRE_SESSION_AUTH=true.
    sessionSecret: process.env.PORTAL_SESSION_SECRET || '',
    sessionMaxAgeMs: optionalInt('PORTAL_SESSION_MAX_AGE_MS', 28800000, { min: 60000 }),
    requireSessionAuth:
      (process.env.PORTAL_REQUIRE_SESSION_AUTH || 'false') === 'true',
    // Beta readiness flag (Gap 5): when true, the boot preflight refuses to
    // start if the resolved admin exposure mode is not beta-safe (disabled,
    // loopback_only, session_only, signed_static). This is the single flag
    // the beta runbook points at before exposing the admin surface.
    betaHardened:
      (process.env.PORTAL_BETA_HARDENED || 'false') === 'true',
    // Optional per-operator user scope (Gap 5): JSON object mapping actor hint
    // (lowercased) to the list of user ids that operator is allowed to admin.
    // When unset, admin credentials have god-mode access across all users
    // (preserves single-owner deployment behavior). When set, :userId admin
    // routes fail closed with 403 if the authenticated operator is not scoped
    // to the requested user. Example:
    //   PORTAL_OPERATOR_USER_SCOPES='{"operator@example.com":[1,2,3]}'
    operatorUserScopes: (() => {
      const raw = (process.env.PORTAL_OPERATOR_USER_SCOPES || '').trim();
      if (!raw) return {} as Record<string, readonly number[]>;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') return {};
        const out: Record<string, readonly number[]> = {};
        for (const [actor, ids] of Object.entries(parsed)) {
          const normalizedActor = String(actor).trim().toLowerCase();
          if (!normalizedActor) continue;
          if (!Array.isArray(ids)) continue;
          const numericIds = ids
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0);
          if (numericIds.length > 0) out[normalizedActor] = numericIds;
        }
        return out;
      } catch {
        return {};
      }
    })(),
    // Hardening pass 2026-04-22: once scoped portal tokens exist, the
    // legacy full-access token is disabled by default. Operators who
    // still need the old token during migration must opt in explicitly.
    allowLegacyFallback:
      (process.env.PORTAL_ALLOW_LEGACY_FALLBACK || 'false') === 'true',
    // Hardening pass 2026-04-22: local unauthenticated portal access
    // is now explicit opt-in instead of "empty token => open by default".
    // This bypass is disabled in production/staging even if someone sets
    // the env var by mistake.
    allowLocalBypass:
      (process.env.PORTAL_ALLOW_LOCAL_BYPASS || 'false') === 'true'
      && process.env.NODE_ENV !== 'production'
      && !IS_STAGING,
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
    maxPayloadBytes: optionalInt('WEBHOOK_MAX_PAYLOAD', 1048576, { min: 1 }),
    eventRetentionDays: optionalInt('WEBHOOK_RETENTION_DAYS', 30, { min: 1 }),
  },
  // ── Public Waitlist ────────────────────────────────────────────────
  // Salt used to hash visitor IPs before storing waitlist abuse signals.
  // Missing salt remains backward-compatible with an ephemeral process salt,
  // but production/staging logs a warning because cross-restart dedupe is
  // weaker until WAITLIST_IP_SALT is configured.
  waitlist: {
    ipSalt: process.env.WAITLIST_IP_SALT || '',
    warnOnEphemeralIpSalt: process.env.NODE_ENV === 'production' || IS_STAGING,
    confirmationTtlHours: optionalInt('WAITLIST_CONFIRMATION_TTL_HOURS', 24, { min: 1 }),
  },
  // ── Health Check ──────────────────────────────────────────────────
  health: {
    token: process.env.HEALTH_TOKEN || '',
    // Same hardening rule as the portal token: detailed health is only
    // unauthenticated when explicitly enabled for local development.
    allowUnauthenticatedDetailed:
      (process.env.HEALTH_ALLOW_UNAUTHENTICATED || 'false') === 'true'
      && process.env.NODE_ENV !== 'production'
      && !IS_STAGING,
  },
  // ── Finance Data Encryption ─────────────────────────────────────
  financeEncryption: {
    enabled: (process.env.FINANCE_ENCRYPTION_ENABLED || 'true') === 'true',
    masterKey: process.env.FINANCE_ENCRYPTION_KEY || '',
  },
  financePlanning: {
    allowStaticFxEstimate: (process.env.FINANCE_ALLOW_STATIC_FX_ESTIMATE || 'false') === 'true',
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
    rateLimit: optionalInt('IOS_API_RATE_LIMIT', 60, { min: 1 }),
    readRateLimit: optionalInt('IOS_API_READ_RATE_LIMIT', 300, { min: 1 }),
    inviteCode: process.env.IOS_INVITE_CODE || '',
    ownerCode: process.env.IOS_OWNER_CODE || '',
    betaInviteExpiresDays: optionalInt('BETA_INVITE_EXPIRES_DAYS', 30, { min: 1 }),
    staticInviteExpiresDays: optionalInt('IOS_STATIC_INVITE_EXPIRES_DAYS', 365, { min: 1 }),
  },
  mesh: {
    enabled: process.env.NEXUS_MULTISKILL_MESH === 'on',
  },
  // ── Coaching feature flags ────────────────────────────────────────
  // PR 4 §D4 follow-up (2026-05-23). Coach-rule enforcement is the
  // warning-only linter pass that surfaces five additional research-
  // backed coach principles. Flag defaults OFF; staging flips it on
  // first so a red-team corpus pass can measure false-positive rate
  // before any rule is considered for promotion to blocker severity.
  // Wired through `runPlanLintGuarded` in
  // `src/api/routes/training-plan-persistence.ts` and read from the
  // canonical `PlanLintInput.enableCoachRuleEnforcement` field.
  coaching: {
    ruleEnforcementEnabled: process.env.COACH_RULE_ENFORCEMENT === 'on',
    // ── Coach periodization v2 feature flag ────────────────────────
    // Per the Week-Level Adaptability + Periodization plan (v2.1,
    // build-order week 10–11): all new C6 reflow / C2 travel / A5
    // coach-policy routes ship behind this flag. Off by default;
    // staging soak flips it on for ≥2 weeks; production promote only
    // after false-positive rate per new rule < 5% AND churn rate
    // <25%. When OFF, the new routes return 404 — the legacy
    // training endpoints remain fully functional.
    periodizationV2Enabled: process.env.COACH_PERIODIZATION_V2_ENABLED === 'on',
    trainingSafetyGuardrailsEnabled: process.env.TRAINING_SAFETY_GUARDRAILS_ENABLED === 'on',
    trainingSafetyHealthSignalMaxAgeDays: optionalInt('TRAINING_SAFETY_HEALTH_SIGNAL_MAX_AGE_DAYS', 14, {
      min: 1,
      max: 90,
    }),
    coachKernelEquipmentAuthorityEnabled: process.env.COACH_KERNEL_EQUIPMENT_AUTHORITY_ENABLED === 'on',
    coachKernelEquipmentAuthorityShadowEnabled: process.env.COACH_KERNEL_EQUIPMENT_AUTHORITY_SHADOW_ENABLED === 'on',
    trainingCatalogDbEnabled: process.env.TRAINING_CATALOG_DB_ENABLED === 'on',
    trainingCompletionFeedbackV2Enabled: process.env.TRAINING_COMPLETION_FEEDBACK_V2_ENABLED !== 'off',
    trainingSelectorPolicyV2Enabled: process.env.TRAINING_SELECTOR_POLICY_V2_ENABLED === 'on',
    trainingEnduranceCoherenceV2Enabled: process.env.TRAINING_ENDURANCE_COHERENCE_V2_ENABLED === 'on',
    trainingCalendarCapacityKernelEnabled: process.env.TRAINING_CALENDAR_CAPACITY_KERNEL_ENABLED === 'on',
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
  notificationDelivery: {
    get mode(): NotificationDeliveryMode {
      return parseNotificationDeliveryMode();
    },
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
    nexusPoints: {
      enabled: (process.env.STRIPE_NEXUS_POINTS_ENABLED || 'false') === 'true',
      priceIds: {
        small: process.env.STRIPE_PRICE_ID_POINTS_SMALL || '',
        medium: process.env.STRIPE_PRICE_ID_POINTS_MEDIUM || '',
        large: process.env.STRIPE_PRICE_ID_POINTS_LARGE || '',
      },
      webSuccessUrl: process.env.STRIPE_NEXUS_POINTS_SUCCESS_URL || 'https://nexushub.me/user?nexusPointsCheckout=success',
      webCancelUrl: process.env.STRIPE_NEXUS_POINTS_CANCEL_URL || 'https://nexushub.me/user?nexusPointsCheckout=canceled',
    },
  },
  billing: {
    paywallEnabled: PAYWALL_ENABLED,
    // Hardening pass 2026-04-22: disabling the paywall is only legal in
    // local/test/staging contexts. Production must fail fast instead of
    // silently turning every account into an owner-equivalent user.
    allowUnsafePaywallBypass: PAYWALL_BYPASS_ALLOWED,
  },

  // ── AI Safety ─────────────────────────────────────────────────────
  aiSafety: {
    callTimeoutMs: optionalInt('AI_CALL_TIMEOUT_MS', 30000, { min: 1 }),
    globalDailyLimitUsd: optionalFloat('GLOBAL_DAILY_COST_LIMIT', 10.00, { min: 0 }),
    alertThresholdPercent: optionalFloat('COST_ALERT_THRESHOLD', 0.80, { min: 0, max: 1 }),
  },
} as const;

if (!config.billing.paywallEnabled && !config.billing.allowUnsafePaywallBypass) {
  throw new Error(
    'PAYWALL_ENABLED=false is only allowed in test, development, or staging environments. Refusing unsafe startup.',
  );
}

if (IS_PRODUCTION && (!config.financeEncryption.enabled || !config.financeEncryption.masterKey)) {
  throw new Error(
    'FINANCE_ENCRYPTION_ENABLED=true and FINANCE_ENCRYPTION_KEY are required in production. Generate one with: openssl rand -hex 32',
  );
}

interface ScopedTrainingFlagEntry {
  key: string;
  suffix: string;
  value: string;
}

function scopedTrainingFlagEntries(
  baseKey: string,
  matchesValue: (normalizedValue: string) => boolean,
): ScopedTrainingFlagEntry[] {
  const pattern = new RegExp(`^${baseKey}_((?:USER|TENANT)_[0-9A-Za-z_-]+)$`);
  return Object.entries(process.env).flatMap(([key, rawValue]) => {
    const match = key.match(pattern);
    const value = rawValue?.trim().toLowerCase() ?? '';
    return match && matchesValue(value)
      ? [{ key, suffix: match[1], value }]
      : [];
  });
}

function scopedTrainingValue(baseKey: string, suffix: string): string {
  const exactValue = process.env[`${baseKey}_${suffix}`];
  return (exactValue ?? process.env[baseKey] ?? '').trim().toLowerCase();
}

function scopedTrainingBooleanEnabled(baseKey: string, suffix: string): boolean {
  return scopedTrainingValue(baseKey, suffix) === 'true';
}

function scopedTrainingDecisionFlowEnabled(suffix: string): boolean {
  return scopedTrainingBooleanEnabled('DECISION_FLOW_V1_ENFORCE_ENABLED', suffix)
    || scopedTrainingBooleanEnabled('TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED', suffix);
}

const trainingPublicBetaRaw = process.env.TRAINING_PUBLIC_BETA_V1_ENABLED?.trim().toLowerCase();
const trainingPublicBetaEnabled = trainingPublicBetaRaw === 'true';
const globalTrainingRevisionMode = process.env.TRAINING_PLAN_REVISION_V1_MODE?.trim().toLowerCase();
const scopedTrainingRevisionEnrollments = scopedTrainingFlagEntries(
  'TRAINING_PLAN_REVISION_V1_MODE',
  (value) => value === 'active',
);
const hasScopedTrainingRevisionEnrollment = scopedTrainingRevisionEnrollments.length > 0;
const globalTrainingAdaptationMode = process.env.TRAINING_ADAPTATION_V1_MODE?.trim().toLowerCase();
const scopedTrainingAdaptationEnrollments = scopedTrainingFlagEntries(
  'TRAINING_ADAPTATION_V1_MODE',
  (value) => value === 'active',
);
const globalTrainingM4Allowlist = process.env.TRAINING_PLAN_M4_ALLOWLIST?.trim();
const scopedTrainingM4Allowlists = scopedTrainingFlagEntries(
  'TRAINING_PLAN_M4_ALLOWLIST',
  (value) => Boolean(value),
);
const globalTrainingM4ExplicitUserCapacity = process.env.TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED?.trim().toLowerCase();
const scopedTrainingM4ExplicitUserCapacity = scopedTrainingFlagEntries(
  'TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED',
  (value) => value === 'true',
);
const validTrainingM4Token = /^(?:event_based|continuous|maintenance|return_to_training):(?:running|cycling|swimming|strength|triathlon|hybrid|marathon)$/;
const globalTrainingM4Tokens = (globalTrainingM4Allowlist ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const requiredTrainingPublicBetaM4Tokens = [
  'event_based', 'continuous', 'maintenance', 'return_to_training',
].flatMap((mode) => [
  'running', 'cycling', 'swimming', 'strength', 'triathlon', 'hybrid', 'marathon',
].map((discipline) => `${mode}:${discipline}`));
const globalTrainingM4TokenSet = new Set(globalTrainingM4Tokens);
const trainingPublicBetaBundleComplete = trainingPublicBetaEnabled
  && globalTrainingRevisionMode === 'active'
  && process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED?.trim().toLowerCase() === 'true'
  && globalTrainingAdaptationMode === 'active'
  && process.env.TRAINING_EXERCISE_IDENTITY_V1_MODE?.trim().toLowerCase() === 'active'
  && process.env.TRAINING_EXERCISE_MEDIA_V1_ENABLED?.trim().toLowerCase() === 'true'
  && process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED?.trim().toLowerCase() === 'true'
  && globalTrainingM4Tokens.length === requiredTrainingPublicBetaM4Tokens.length
  && globalTrainingM4TokenSet.size === requiredTrainingPublicBetaM4Tokens.length
  && globalTrainingM4Tokens.every((entry) => validTrainingM4Token.test(entry))
  && requiredTrainingPublicBetaM4Tokens.every((entry) => globalTrainingM4TokenSet.has(entry))
  && (process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY ?? '').length >= 32
  && globalTrainingM4ExplicitUserCapacity !== 'true';
if (IS_PRODUCTION && trainingPublicBetaRaw && trainingPublicBetaRaw !== 'true' && trainingPublicBetaRaw !== 'false') {
  throw new Error('TRAINING_PUBLIC_BETA_V1_ENABLED must be exactly true or false in production.');
}
if (IS_PRODUCTION && trainingPublicBetaEnabled && !trainingPublicBetaBundleComplete) {
  throw new Error(
    'TRAINING_PUBLIC_BETA_V1_ENABLED=true requires the complete global Training v1 bundle, the exact complete 28-entry M4 allowlist, a 32+ character snapshot key, and provisional explicit-user capacity disabled.',
  );
}
if (IS_PRODUCTION && !trainingPublicBetaEnabled && globalTrainingRevisionMode === 'active') {
  throw new Error(
    'Global TRAINING_PLAN_REVISION_V1_MODE=active is forbidden in production; enroll explicit personal accounts with scoped USER or TENANT overrides.',
  );
}
if (IS_PRODUCTION && !trainingPublicBetaEnabled && globalTrainingAdaptationMode === 'active') {
  throw new Error(
    'Global TRAINING_ADAPTATION_V1_MODE=active is forbidden in production; enroll explicit personal accounts with scoped USER or TENANT overrides.',
  );
}
if (IS_PRODUCTION
    && !trainingPublicBetaEnabled
    && process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED?.trim().toLowerCase() === 'true') {
  throw new Error(
    'Global TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED=true is forbidden in production unless the complete Training public-beta bundle is enabled.',
  );
}
if (IS_PRODUCTION && scopedTrainingAdaptationEnrollments.some(({ suffix }) =>
  scopedTrainingValue('TRAINING_PLAN_REVISION_V1_MODE', suffix) !== 'active'
  || !scopedTrainingBooleanEnabled('TRAINING_TYPED_WORKOUT_V1_ENABLED', suffix)
  || !scopedTrainingDecisionFlowEnabled(suffix))) {
  throw new Error(
    'Each scoped TRAINING_ADAPTATION_V1_MODE=active enrollment requires Training revision, typed-workout, and Decision Flow enablement for the same scope.',
  );
}
if (IS_PRODUCTION && !trainingPublicBetaEnabled && globalTrainingM4Allowlist) {
  throw new Error(
    'Global TRAINING_PLAN_M4_ALLOWLIST is forbidden in production; enroll exact mode:discipline combinations with scoped USER or TENANT overrides.',
  );
}
if (IS_PRODUCTION && globalTrainingM4ExplicitUserCapacity === 'true') {
  throw new Error(
    'Global TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED=true is forbidden in production; provisional capacity requires an exact scoped enrollment.',
  );
}
if (IS_PRODUCTION && scopedTrainingM4Allowlists.some(({ value }) =>
  value.split(',').map((entry) => entry.trim().toLowerCase()).some((entry) => !validTrainingM4Token.test(entry)))) {
  throw new Error('TRAINING_PLAN_M4_ALLOWLIST contains an unsupported or wildcard mode:discipline token.');
}
if (IS_PRODUCTION && scopedTrainingM4Allowlists.some(({ suffix }) =>
  scopedTrainingValue('TRAINING_PLAN_REVISION_V1_MODE', suffix) !== 'active'
  || !scopedTrainingBooleanEnabled('TRAINING_TYPED_WORKOUT_V1_ENABLED', suffix)
  || !scopedTrainingDecisionFlowEnabled(suffix))) {
  throw new Error(
    'Each scoped TRAINING_PLAN_M4_ALLOWLIST requires Training revision, typed-workout, and Decision Flow enablement for the same scope.',
  );
}
if (IS_PRODUCTION && scopedTrainingM4ExplicitUserCapacity.some(({ suffix }) =>
  !scopedTrainingValue('TRAINING_PLAN_M4_ALLOWLIST', suffix)
  || scopedTrainingValue('TRAINING_PLAN_REVISION_V1_MODE', suffix) !== 'active'
  || !scopedTrainingBooleanEnabled('TRAINING_TYPED_WORKOUT_V1_ENABLED', suffix)
  || !scopedTrainingDecisionFlowEnabled(suffix))) {
  throw new Error(
    'Each scoped TRAINING_M4_EXPLICIT_USER_CAPACITY_ENABLED enrollment requires an exact M4 allowlist, Training revision, typed-workout, and Decision Flow enablement for the same scope.',
  );
}
if (IS_PRODUCTION && hasScopedTrainingRevisionEnrollment) {
  const snapshotKey = process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY ?? '';
  if (snapshotKey.length < 32) {
    throw new Error(
      'TRAINING_PLAN_REVISION_V1_MODE=active requires a dedicated TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY of at least 32 characters in production.',
    );
  }
  if (scopedTrainingRevisionEnrollments.some(({ suffix }) =>
    !scopedTrainingDecisionFlowEnabled(suffix))) {
    throw new Error(
      'Each scoped TRAINING_PLAN_REVISION_V1_MODE=active enrollment requires Decision Flow enablement for the same scope in production.',
    );
  }
}

if (IS_PRODUCTION && config.backup.enabled && (!config.backup.encrypt || !config.backup.encryptionKey)) {
  throw new Error(
    'BACKUP_ENABLED=true requires BACKUP_ENCRYPT=true and BACKUP_KEY in production. Generate BACKUP_KEY with: openssl rand -hex 32',
  );
}

const apnsCredentialsConfigured = Boolean(
  config.apns.enabled
  && config.apns.teamId
  && config.apns.keyId
  && config.apns.authKey
  && config.apns.bundleId,
);
const resolvedNotificationDeliveryMode = config.notificationDelivery.mode;
if (
  IS_PRODUCTION
  && apnsCredentialsConfigured
  && (process.env.NOTIFICATION_DELIVERY_MODE || '').trim() === ''
) {
  throw new Error(
    'NOTIFICATION_DELIVERY_MODE=apns is required in production when APNs credentials are configured.',
  );
}
if (IS_PRODUCTION && apnsCredentialsConfigured && resolvedNotificationDeliveryMode !== 'apns') {
  throw new Error(
    'NOTIFICATION_DELIVERY_MODE=apns is required in production when APNs credentials are configured.',
  );
}

warnProductionLaunch(
  !process.env.OPERATOR_ALERT_WEBHOOK_URL
    ? 'OPERATOR_ALERT_WEBHOOK_URL is not set; operator alerts will be persisted but not delivered to the on-call webhook.'
    : '',
);
warnProductionLaunch(
  !config.sentry.dsn
    ? 'SENTRY_DSN is not set; production error reporting will rely on local logs only.'
    : '',
);

// Fail-fast: iOS API enabled without a proper JWT secret is a security risk
if (config.ios.enabled && !config.ios.jwtSecret) {
  throw new Error('IOS_API_ENABLED=true but IOS_API_JWT_SECRET is not set. Set a 256-bit secret.');
}
if (config.ios.enabled && !isStrongIosJwtSecret(config.ios.jwtSecret)) {
  throw new Error('IOS_API_JWT_SECRET must be at least 32 bytes and cannot contain known placeholder text.');
}
if (config.ios.enabled && !config.ios.inviteCode) {
  throw new Error('IOS_API_ENABLED=true but IOS_INVITE_CODE is not set.');
}

if (
  process.env.NODE_ENV === 'production'
  && !IS_STAGING
  && isUnsafePublicBind(config.portal.bind)
  && process.env.PORTAL_PUBLIC_BIND_ACK !== PORTAL_PUBLIC_BIND_ACK_VALUE
) {
  throw new Error(
    `PORTAL_BIND=${config.portal.bind} exposes the portal on every interface. Use 127.0.0.1 behind a tunnel/reverse proxy or set PORTAL_PUBLIC_BIND_ACK=${PORTAL_PUBLIC_BIND_ACK_VALUE}.`,
  );
}

if (config.stripe.nexusPoints.enabled) {
  const missingStripeNexusPointsEnv = [
    ['STRIPE_SECRET_KEY', config.stripe.secretKey],
    ['STRIPE_WEBHOOK_SECRET', config.stripe.webhookSecret],
    ['STRIPE_PRICE_ID_POINTS_SMALL', config.stripe.nexusPoints.priceIds.small],
    ['STRIPE_PRICE_ID_POINTS_MEDIUM', config.stripe.nexusPoints.priceIds.medium],
    ['STRIPE_PRICE_ID_POINTS_LARGE', config.stripe.nexusPoints.priceIds.large],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missingStripeNexusPointsEnv.length > 0) {
    throw new Error(
      `STRIPE_NEXUS_POINTS_ENABLED=true but required env vars are missing: ${missingStripeNexusPointsEnv.join(', ')}`,
    );
  }
  if (!config.portal.adminActorSignatureSecret) {
    throw new Error(
      'STRIPE_NEXUS_POINTS_ENABLED requires PORTAL_ADMIN_ACTOR_SIGNATURE_SECRET to be set so admin-issued purchases have signed attribution.',
    );
  }
  if (process.env.NODE_ENV !== 'production' && /^sk_live_/.test(config.stripe.secretKey)) {
    throw new Error(
      'STRIPE_SECRET_KEY appears to be a live key (sk_live_*) but NODE_ENV is not production. Refusing to start to prevent accidental live charges in staging.',
    );
  }
}
