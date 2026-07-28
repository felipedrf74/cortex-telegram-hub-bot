import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertApplicationDrillRuntimeEnvironment,
  assertContentLiveEvalRuntimeEnvironment,
  contentLiveEvalDotenvOptions,
  shouldStartContentLiveEvalBackgroundServices,
} from '../../src/services/content-live-evaluation-runtime';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function safeEnv(): NodeJS.ProcessEnv {
  const runtimeRoot = mkdtempSync(path.join(tmpdir(), 'content-live-eval-runtime-'));
  temporaryDirectories.push(runtimeRoot);
  chmodSync(runtimeRoot, 0o700);
  return {
    NEXUS_CONTENT_LIVE_EVAL_RUNTIME: '1',
    NEXUS_BACKGROUND_JOBS_ENABLED: '0',
    NODE_ENV: 'development',
    ENV: 'development',
    STAGING: 'false',
    CONTENT_LIVE_EVAL_ENABLED: '1',
    NEXUS_LOCAL_ALLOW_MODEL_CALLS: '1',
    PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED: 'true',
    PORTAL_BIND: '127.0.0.1',
    PORTAL_PORT: '18200',
    CONTENT_ENGINE_PORT: '18102',
    TMPDIR: tmpdir(),
    DATABASE_PATH: path.join(runtimeRoot, 'content-live-eval-unit.db'),
    NEXUS_CONTENT_LIVE_EVAL_DELIVERY_DISABLED: '1',
    BACKUP_ENABLED: 'false',
    PORTAL_ALLOW_LOCAL_BYPASS: 'true',
    OPENAI_API_KEY: 'provider-key-is-allowed-at-this-boundary',
  };
}

function safeDrillEnv(): NodeJS.ProcessEnv {
  const created = mkdtempSync(path.join(tmpdir(), 'application-drill-runtime-'));
  const runtimeRoot = realpathSync(created);
  temporaryDirectories.push(runtimeRoot);
  chmodSync(runtimeRoot, 0o700);
  const dataRoot = path.join(runtimeRoot, 'data');
  const databasePath = path.join(dataRoot, 'bot.db');
  mkdirSync(dataRoot, { mode: 0o700 });
  writeFileSync(databasePath, 'restored-database', { mode: 0o600 });
  const token = 'a'.repeat(64);
  return {
    NEXUS_APPLICATION_DRILL_RUNTIME: '1',
    NEXUS_APPLICATION_DRILL_ROOT: runtimeRoot,
    NEXUS_BACKGROUND_JOBS_ENABLED: '0',
    NEXUS_LOCAL_ALLOW_MODEL_CALLS: '0',
    NODE_ENV: 'development',
    ENV: 'development',
    STAGING: 'false',
    PORTAL_BIND: '127.0.0.1',
    PORTAL_ENABLED: 'true',
    PORTAL_PORT: '19200',
    CONTENT_ENGINE_PORT: '19201',
    CONTENT_ENGINE_ENABLED: 'false',
    OLLAMA_ENABLED: 'false',
    ANTHROPIC_ENABLED: 'false',
    DATABASE_PATH: databasePath,
    TELEGRAM_LEGACY_DELIVERY: 'false',
    TELEGRAM_BOT_TOKEN: 'application-drill-disabled',
    BACKUP_ENABLED: 'false',
    WEBHOOKS_ENABLED: 'false',
    NOTIFICATION_DELIVERY_MODE: 'mock',
    PORTAL_ALLOW_LOCAL_BYPASS: 'false',
    PORTAL_ALLOW_LEGACY_FALLBACK: 'false',
    PORTAL_REQUIRE_SESSION_AUTH: 'false',
    PORTAL_READ_TOKEN: token,
    HEALTH_TOKEN: token,
    HEALTH_ALLOW_UNAUTHENTICATED: 'false',
    IOS_API_ENABLED: 'false',
    IOS_WS_ENABLED: 'false',
  };
}

describe('Content live-evaluation runtime isolation', () => {
  it('disables dotenv override and every background-service initializer', () => {
    const env = safeEnv();
    expect(contentLiveEvalDotenvOptions(env)).toEqual({ quiet: true, override: false, path: '/dev/null' });
    expect(shouldStartContentLiveEvalBackgroundServices(env)).toBe(false);
    expect(assertContentLiveEvalRuntimeEnvironment(env)).toMatchObject({
      portalBind: '127.0.0.1',
      backgroundServicesEnabled: false,
      dotenvPath: '/dev/null',
    });
  });

  it('also disables repository dotenv loading in the release verifier process', () => {
    expect(contentLiveEvalDotenvOptions({
      NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME: '1',
      NODE_ENV: 'development',
    })).toEqual({ quiet: true, override: false, path: '/dev/null' });
  });

  it.each([
    ['SENTRY_DSN', 'https://telemetry.invalid/1'],
    ['GOOGLE_REFRESH_TOKEN', 'calendar-token'],
    ['OUTLOOK_CLIENT_SECRET', 'mail-secret'],
    ['GARMIN_PASSWORD', 'wearable-secret'],
    ['TODOIST_CLIENT_SECRET', 'task-secret'],
    ['INVOICE_MINIO_SECRET_ACCESS_KEY', 'object-store-secret'],
    ['APNS_KEY_ID', 'push-key'],
    ['TELEGRAM_BOT_TOKEN', 'legacy-token'],
    ['TELEGRAM_ALLOWED_USER_IDS', '100000001'],
  ])('fails before startup when inherited connector env %s is present', (key, value) => {
    const env = safeEnv();
    env[key] = value;
    expect(() => assertContentLiveEvalRuntimeEnvironment(env)).toThrow(`CONTENT_LIVE_EVAL_CONNECTOR_ENV_FORBIDDEN:${key}`);
  });

  it('rejects a root-env-shaped database override and any attempt to re-enable jobs', () => {
    const databaseOverride = safeEnv();
    databaseOverride.DATABASE_PATH = '/srv/nexus/data/bot.db';
    expect(() => assertContentLiveEvalRuntimeEnvironment(databaseOverride)).toThrow('CONTENT_LIVE_EVAL_DISPOSABLE_DATABASE_REQUIRED');

    const jobsEnabled = safeEnv();
    jobsEnabled.NEXUS_BACKGROUND_JOBS_ENABLED = '1';
    expect(() => assertContentLiveEvalRuntimeEnvironment(jobsEnabled)).toThrow('CONTENT_LIVE_EVAL_BACKGROUND_SERVICES_MUST_BE_DISABLED');
  });

  it('requires the transport-neutral delivery-disable guard', () => {
    const env = safeEnv();
    delete env.NEXUS_CONTENT_LIVE_EVAL_DELIVERY_DISABLED;
    expect(() => assertContentLiveEvalRuntimeEnvironment(env)).toThrow('CONTENT_LIVE_EVAL_DELIVERY_MUST_BE_DISABLED');
  });
});

describe('Application restore-drill runtime isolation', () => {
  it('disables dotenv, background work, providers, and local auth bypass', () => {
    const env = safeDrillEnv();
    expect(contentLiveEvalDotenvOptions(env)).toEqual({ quiet: true, override: false, path: '/dev/null' });
    expect(shouldStartContentLiveEvalBackgroundServices(env)).toBe(false);
    expect(assertApplicationDrillRuntimeEnvironment(env)).toMatchObject({
      databasePath: env.DATABASE_PATH,
      portalBind: '127.0.0.1',
      portalPort: 19200,
      backgroundServicesEnabled: false,
      dotenvPath: '/dev/null',
    });
  });

  it.each([
    ['SENTRY_DSN', 'https://telemetry.invalid/1'],
    ['AWS_ACCESS_KEY_ID', 'object-store-key'],
    ['GOOGLE_REFRESH_TOKEN', 'calendar-token'],
    ['APNS_KEY_ID', 'push-key'],
  ])('rejects inherited connector or telemetry env %s', (key, value) => {
    const env = safeDrillEnv();
    env[key] = value;
    expect(() => assertApplicationDrillRuntimeEnvironment(env))
      .toThrow(`APPLICATION_DRILL_CONNECTOR_ENV_FORBIDDEN:${key}`);
  });

  it('requires the restored scratch DB, meaningful auth, and disabled model access', () => {
    const escapedDatabase = safeDrillEnv();
    escapedDatabase.DATABASE_PATH = '/srv/nexus/data/bot.db';
    expect(() => assertApplicationDrillRuntimeEnvironment(escapedDatabase))
      .toThrow('APPLICATION_DRILL_RESTORED_DATABASE_REQUIRED');

    const bypassedAuth = safeDrillEnv();
    bypassedAuth.PORTAL_ALLOW_LOCAL_BYPASS = 'true';
    expect(() => assertApplicationDrillRuntimeEnvironment(bypassedAuth))
      .toThrow('APPLICATION_DRILL_LOCAL_AUTH_BYPASS_FORBIDDEN');

    const providerEnabled = safeDrillEnv();
    providerEnabled.OLLAMA_ENABLED = 'true';
    expect(() => assertApplicationDrillRuntimeEnvironment(providerEnabled))
      .toThrow('APPLICATION_DRILL_PROVIDER_ACCESS_MUST_BE_DISABLED');

    const mismatchedHealthCredential = safeDrillEnv();
    mismatchedHealthCredential.HEALTH_TOKEN = 'b'.repeat(64);
    expect(() => assertApplicationDrillRuntimeEnvironment(mismatchedHealthCredential))
      .toThrow('APPLICATION_DRILL_READ_TOKEN_REQUIRED');

    const iosEnabled = safeDrillEnv();
    iosEnabled.IOS_API_ENABLED = 'true';
    expect(() => assertApplicationDrillRuntimeEnvironment(iosEnabled))
      .toThrow('APPLICATION_DRILL_IOS_SURFACE_MUST_BE_DISABLED');
  });
});
