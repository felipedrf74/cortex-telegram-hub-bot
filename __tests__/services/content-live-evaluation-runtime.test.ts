import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
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
