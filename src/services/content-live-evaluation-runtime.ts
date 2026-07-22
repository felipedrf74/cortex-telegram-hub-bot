// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';

export const CONTENT_LIVE_EVAL_RUNTIME_FLAG = 'NEXUS_CONTENT_LIVE_EVAL_RUNTIME' as const;
export const CONTENT_LIVE_EVAL_VERIFIER_RUNTIME_FLAG = 'NEXUS_CONTENT_LIVE_EVAL_VERIFIER_RUNTIME' as const;
export const CONTENT_LIVE_EVAL_BACKGROUND_JOBS_FLAG = 'NEXUS_BACKGROUND_JOBS_ENABLED' as const;
export const CONTENT_LIVE_EVAL_DELIVERY_DISABLED_FLAG = 'NEXUS_CONTENT_LIVE_EVAL_DELIVERY_DISABLED' as const;

const DISALLOWED_INTEGRATION_ENV_PATTERNS = [
  /^(?:GOOGLE|OUTLOOK|MICROSOFT|GARMIN|TODOIST|NOTION|STRIPE|APNS|AWS|MINIO|INVOICE)_/,
  /^(?:NEWSAPI|SERPAPI|REDDIT|YOUTUBE)_/,
  /^SENTRY_/,
  /^TELEGRAM_/,
  /^OWNER_TELEGRAM_ID$/,
];

export function isContentLiveEvalRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONTENT_LIVE_EVAL_RUNTIME_FLAG] === '1';
}

export function isContentLiveEvalVerifierRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONTENT_LIVE_EVAL_VERIFIER_RUNTIME_FLAG] === '1';
}

/** The live-evaluation process never parses the repository `.env`. */
export function contentLiveEvalDotenvOptions(env: NodeJS.ProcessEnv = process.env): {
  quiet: true;
  override: boolean;
  path?: string;
} {
  return isContentLiveEvalRuntime(env) || isContentLiveEvalVerifierRuntime(env)
    ? { quiet: true, override: false, path: '/dev/null' }
    : { quiet: true, override: env.NODE_ENV !== 'test' };
}

export function shouldStartContentLiveEvalBackgroundServices(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isContentLiveEvalRuntime(env);
}

function pathWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function approvedRuntimeRoots(env: NodeJS.ProcessEnv): string[] {
  return [
    path.resolve(process.cwd(), '.local', 'content-eval'),
    path.resolve('/tmp'),
    path.resolve('/private/tmp'),
    path.resolve(env.TMPDIR || '/tmp'),
  ];
}

export interface ContentLiveEvalRuntimeSnapshot {
  databasePath: string;
  portalBind: '127.0.0.1' | 'localhost' | '::1';
  portalPort: number;
  contentPort: number;
  backgroundServicesEnabled: false;
  dotenvPath: '/dev/null';
}

/**
 * Re-verifies the effective process environment before Sentry, the database,
 * connectors, provider routers, schedulers, or HTTP listeners are initialized.
 */
export function assertContentLiveEvalRuntimeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ContentLiveEvalRuntimeSnapshot | null {
  if (!isContentLiveEvalRuntime(env)) return null;

  if (env.NODE_ENV !== 'development' || (env.ENV ?? 'development') !== 'development' || env.STAGING === 'true') {
    throw new Error('CONTENT_LIVE_EVAL_RUNTIME_REQUIRES_NON_PRODUCTION');
  }
  if (
    env.CONTENT_LIVE_EVAL_ENABLED !== '1'
    || env.NEXUS_LOCAL_ALLOW_MODEL_CALLS !== '1'
    || env.PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED !== 'true'
  ) {
    throw new Error('CONTENT_LIVE_EVAL_RUNTIME_GOVERNANCE_FLAGS_REQUIRED');
  }
  if (env[CONTENT_LIVE_EVAL_BACKGROUND_JOBS_FLAG] !== '0') {
    throw new Error('CONTENT_LIVE_EVAL_BACKGROUND_SERVICES_MUST_BE_DISABLED');
  }
  if (env.PORTAL_BIND !== '127.0.0.1' && env.PORTAL_BIND !== 'localhost' && env.PORTAL_BIND !== '::1') {
    throw new Error('CONTENT_LIVE_EVAL_LOOPBACK_BIND_REQUIRED');
  }
  if (env[CONTENT_LIVE_EVAL_DELIVERY_DISABLED_FLAG] !== '1') {
    throw new Error('CONTENT_LIVE_EVAL_DELIVERY_MUST_BE_DISABLED');
  }
  if (env.BACKUP_ENABLED !== 'false' || env.PORTAL_ALLOW_LOCAL_BYPASS !== 'true') {
    throw new Error('CONTENT_LIVE_EVAL_LOCAL_SAFETY_FLAGS_REQUIRED');
  }

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (DISALLOWED_INTEGRATION_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      throw new Error(`CONTENT_LIVE_EVAL_CONNECTOR_ENV_FORBIDDEN:${key}`);
    }
  }

  const databasePath = path.resolve(String(env.DATABASE_PATH || ''));
  if (!/^content-live-eval-[a-z0-9._-]+\.db$/i.test(path.basename(databasePath))) {
    throw new Error('CONTENT_LIVE_EVAL_DISPOSABLE_DATABASE_REQUIRED');
  }
  const approvedRoot = approvedRuntimeRoots(env).find((root) => pathWithin(databasePath, root));
  if (!approvedRoot || !fs.existsSync(path.dirname(databasePath))) {
    throw new Error('CONTENT_LIVE_EVAL_APPROVED_RUNTIME_ROOT_REQUIRED');
  }
  const realParent = fs.realpathSync(path.dirname(databasePath));
  const realRoot = fs.existsSync(approvedRoot) ? fs.realpathSync(approvedRoot) : approvedRoot;
  if (!pathWithin(realParent, realRoot)) {
    throw new Error('CONTENT_LIVE_EVAL_DATABASE_ESCAPED_RUNTIME_ROOT');
  }

  const portalPort = Number(env.PORTAL_PORT);
  const contentPort = Number(env.CONTENT_ENGINE_PORT);
  if (!Number.isInteger(portalPort) || portalPort < 1024 || portalPort > 65535) {
    throw new Error('CONTENT_LIVE_EVAL_PORTAL_PORT_INVALID');
  }
  if (!Number.isInteger(contentPort) || contentPort < 1024 || contentPort > 65535 || contentPort === portalPort) {
    throw new Error('CONTENT_LIVE_EVAL_CONTENT_PORT_INVALID');
  }

  return {
    databasePath,
    portalBind: env.PORTAL_BIND,
    portalPort,
    contentPort,
    backgroundServicesEnabled: false,
    dotenvPath: '/dev/null',
  };
}
