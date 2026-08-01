// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readDeployedReleaseIdentity } from '../../src/services/release-runtime-identity';

const repoRoot = path.resolve(__dirname, '../..');
const configPath = path.join(repoRoot, 'ecosystem.release.config.js');
const requireConfig = createRequire(__filename);
const releaseSha = 'a'.repeat(40);
const releaseArtifactDigest = 'b'.repeat(64);

/**
 * The non-secret routing policy the release config re-attests into PM2 state.
 * Written verbatim into the temporary protected `.env`; the config throws on any
 * missing name, so a new policy variable fails this suite loudly instead of
 * silently shipping an unattested app environment.
 */
const POLICY_ENVIRONMENT = {
  OLLAMA_ENABLED: 'true',
  AI_CLASSIFY_PRIMARY: 'gemini',
  LOCAL_LLM_CLASSIFY_SHADOW: 'true',
  CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'shadow',
  LOCAL_LLM_EVALUATION_MODE: 'false',
  AI_SCRIPT_GENERATION_REQUIRE_LOCAL: 'false',
  AI_SCRIPT_GENERATION_FALLBACK: 'approved_cloud_reasoning',
  AI_LOCAL_REASONING_FALLBACK: 'approved_cloud_reasoning',
  CLOUD_REASONING_FALLBACK_ENABLED: 'true',
  CLOUD_REASONING_REQUIRE_APPROVED_MODEL: 'true',
  CLOUD_REASONING_ON_UNAPPROVED_MODEL: 'fail_visibly',
  CLOUD_REASONING_PRIVACY_MODE: 'never',
  CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA: 'false',
  CLOUD_REASONING_PROVIDER: 'gemini',
  CLOUD_REASONING_MODEL: 'gemini-2.5-pro',
  APPROVED_REASONING_MODELS: 'gemini-2.5-pro,claude-sonnet-4-6',
  OLLAMA_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  OLLAMA_CLASSIFIER_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  CHAT_CORE_V2_LOCAL_CHAT_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off',
};

interface Pm2App {
  name: string;
  env?: Record<string, string>;
}

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'nexus-release-ecosystem-'));
  writeFileSync(
    path.join(baseDir, '.env'),
    `${Object.entries(POLICY_ENVIRONMENT)
      .map(([name, value]) => `${name}=${value}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete requireConfig.cache[configPath];
  rmSync(baseDir, { recursive: true, force: true });
});

/**
 * The config reads the protected `.env` and resolves the role at require time
 * and is then memoized by CommonJS, so every case has to evict the cache entry
 * before requiring it again.
 */
function loadReleaseApps(role: string): Pm2App[] {
  vi.stubEnv('NEXUS_RELEASE_DIR', repoRoot);
  vi.stubEnv('NEXUS_RELEASE_BASE_DIR', baseDir);
  vi.stubEnv('NEXUS_RELEASE_ROLE', role);
  vi.stubEnv('NEXUS_RELEASE_SHA', releaseSha);
  vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', releaseArtifactDigest);
  delete requireConfig.cache[configPath];
  return (requireConfig(configPath) as { apps: Pm2App[] }).apps;
}

describe('release ecosystem config release identity', () => {
  it.each([
    ['staging', 'nexus-hub-staging', 'content-engine-staging'],
    ['production', 'nexus-hub', 'content-engine'],
  ])(
    'forwards the whole attested release identity to every %s app',
    (role, backendName, contentName) => {
      const apps = loadReleaseApps(role);
      const backend = apps.find((app) => app.name === backendName);
      const content = apps.find((app) => app.name === contentName);

      expect(backend?.env).toMatchObject({
        NEXUS_RELEASE_ROLE: role,
        NEXUS_RELEASE_SHA: releaseSha,
        NEXUS_RELEASE_ARTIFACT_SHA256: releaseArtifactDigest,
      });
      expect(content?.env).toMatchObject({
        NEXUS_RELEASE_ROLE: role,
        NEXUS_RELEASE_SHA: releaseSha,
        NEXUS_RELEASE_ARTIFACT_SHA256: releaseArtifactDigest,
      });
    },
  );

  it.each([['staging'], ['production']])(
    'lets a %s app attest itself through the canonical runtime identity reader',
    (role) => {
      // The deployed process reads the identity from its own environment. When
      // the config drops a field the read fails closed, which silently disables
      // every identity-bound shadow telemetry record on the server.
      for (const app of loadReleaseApps(role)) {
        expect(readDeployedReleaseIdentity(app.env ?? {})).toEqual({
          runtimeSha: releaseSha,
          artifactDigest: releaseArtifactDigest,
          role,
        });
      }
    },
  );

  it('defaults to the staging role and still forwards it explicitly', () => {
    vi.stubEnv('NEXUS_RELEASE_DIR', repoRoot);
    vi.stubEnv('NEXUS_RELEASE_BASE_DIR', baseDir);
    vi.stubEnv('NEXUS_RELEASE_ROLE', '');
    vi.stubEnv('NEXUS_RELEASE_SHA', releaseSha);
    vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', releaseArtifactDigest);
    delete requireConfig.cache[configPath];
    const apps = (requireConfig(configPath) as { apps: Pm2App[] }).apps;

    expect(apps.map((app) => app.name)).toEqual(['nexus-hub-staging', 'content-engine-staging']);
    for (const app of apps) {
      expect(app.env?.NEXUS_RELEASE_ROLE).toBe('staging');
    }
  });

  it('refuses a role the runtime identity reader could never attest', () => {
    expect(() => loadReleaseApps('development')).toThrow(
      'NEXUS_RELEASE_ROLE must be staging or production, received development',
    );
  });

  it('substitutes the unattested literal rather than inventing a release identity', () => {
    vi.stubEnv('NEXUS_RELEASE_DIR', repoRoot);
    vi.stubEnv('NEXUS_RELEASE_BASE_DIR', baseDir);
    vi.stubEnv('NEXUS_RELEASE_ROLE', 'production');
    vi.stubEnv('NEXUS_RELEASE_SHA', '');
    vi.stubEnv('NEXUS_RELEASE_ARTIFACT_SHA256', '');
    delete requireConfig.cache[configPath];
    const apps = (requireConfig(configPath) as { apps: Pm2App[] }).apps;

    for (const app of apps) {
      expect(app.env?.NEXUS_RELEASE_SHA).toBe('unknown');
      expect(app.env?.NEXUS_RELEASE_ARTIFACT_SHA256).toBe('unknown');
      expect(readDeployedReleaseIdentity(app.env ?? {})).toBeNull();
    }
  });
});
