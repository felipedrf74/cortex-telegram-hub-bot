import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  describe,
  expect,
  it,
} from 'vitest';

const ROOT = join(__dirname, '..', '..');

type Pm2App = {
  name: string;
  max_memory_restart: string;
  node_args?: string;
  script?: string;
  env?: Record<string, string>;
  error_file?: string;
  out_file?: string;
};

const releaseBase = mkdtempSync(join(tmpdir(), 'nexus-release-pm2-policy-'));
const expectedPolicy = {
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
  CLOUD_SCRIPT_STANDARD_PROVIDER: 'openai',
  CLOUD_SCRIPT_STANDARD_MODEL: 'gpt-5.6-luna',
  CLOUD_SCRIPT_STANDARD_SERVICE_TIER: 'flex',
  CLOUD_SCRIPT_SCHEDULED_PROVIDER: 'openai',
  CLOUD_SCRIPT_SCHEDULED_MODEL: 'gpt-5.6-luna',
  CLOUD_SCRIPT_SCHEDULED_SERVICE_TIER: 'batch',
  CLOUD_SCRIPT_PRIORITY_PROVIDER: 'openai',
  CLOUD_SCRIPT_PRIORITY_MODEL: 'gpt-5.6-luna',
  CLOUD_SCRIPT_PRIORITY_SERVICE_TIER: 'priority',
  OLLAMA_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  OLLAMA_CLASSIFIER_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  CHAT_CORE_V2_LOCAL_CHAT_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: 'qwen2.5:3b-instruct-q4_K_M',
  CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off',
};
writeFileSync(
  join(releaseBase, '.env'),
  `${Object.entries(expectedPolicy).map(([name, value]) => `${name}=${value}`).join('\n')}\nFAKE_SECRET=must-not-reach-pm2\n`,
  { mode: 0o600 },
);
afterAll(() => rmSync(releaseBase, { recursive: true, force: true }));

function releaseEnvironment(role: 'production' | 'staging'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NEXUS_RELEASE_DIR: ROOT,
    NEXUS_RELEASE_BASE_DIR: releaseBase,
    NEXUS_RELEASE_ROLE: role,
  };
}

function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Pm2App[] {
  const configPath = join(ROOT, file);
  const output = execFileSync(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).apps))',
    configPath,
  ], { encoding: 'utf8', env });
  return JSON.parse(output) as Pm2App[];
}

function loadConfigWithoutBase(
  file: string,
  role: 'production' | 'staging' = 'staging',
) {
  const configPath = join(ROOT, file);
  const env = {
    ...process.env,
    NEXUS_RELEASE_DIR: ROOT,
    NEXUS_RELEASE_ROLE: role,
  };
  delete env.NEXUS_RELEASE_BASE_DIR;
  return spawnSync(process.execPath, [
    '-e',
    'require(process.argv[1]);',
    configPath,
  ], { encoding: 'utf8', env });
}

function mebibytes(value: string): number {
  const match = /^(\d+)(M|G)$/u.exec(value);
  if (!match) throw new Error(`unsupported PM2 memory value: ${value}`);
  return Number(match[1]) * (match[2] === 'G' ? 1024 : 1);
}

function oldSpaceMebibytes(args: string | undefined): number {
  const match = /(?:^|\s)--max-old-space-size=(\d+)(?:\s|$)/u.exec(args ?? '');
  if (!match) throw new Error(`missing V8 old-space limit: ${args ?? ''}`);
  return Number(match[1]);
}

describe('PM2 backend memory policy', () => {
  it('requires an explicit release base instead of guessing a machine-specific path', () => {
    for (const [file, role] of [
      ['ecosystem.release.config.js', 'production'],
      ['ecosystem.release.config.js', 'staging'],
      ['ecosystem.staging.config.js', 'staging'],
    ] as const) {
      const result = loadConfigWithoutBase(file, role);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('NEXUS_RELEASE_BASE_DIR is required');
    }
  });

  it('keeps total RSS at least 256 MiB above V8 old space in every runtime config', () => {
    const variants = [
      loadConfig('ecosystem.config.js'),
      loadConfig('ecosystem.staging.config.js', releaseEnvironment('staging')),
      loadConfig('ecosystem.release.config.js', releaseEnvironment('production')),
      loadConfig('ecosystem.release.config.js', releaseEnvironment('staging')),
    ];

    for (const apps of variants) {
      const backend = apps.find((app) => app.name.startsWith('nexus-hub'));
      expect(backend).toBeDefined();
      expect(backend?.max_memory_restart).toBe('1G');
      expect(mebibytes(backend!.max_memory_restart) - oldSpaceMebibytes(backend?.node_args)).toBeGreaterThanOrEqual(256);
    }
  });

  it('does not expand Content Engine memory limits', () => {
    expect(loadConfig('ecosystem.config.js').find((app) => app.name === 'content-engine')?.max_memory_restart).toBe('500M');
    expect(loadConfig(
      'ecosystem.staging.config.js',
      releaseEnvironment('staging'),
    ).find((app) => app.name === 'content-engine-staging')?.max_memory_restart).toBe('300M');

    const releaseProduction = loadConfig(
      'ecosystem.release.config.js',
      releaseEnvironment('production'),
    );
    const releaseStaging = loadConfig(
      'ecosystem.release.config.js',
      releaseEnvironment('staging'),
    );
    expect(releaseProduction.find((app) => app.name === 'content-engine')?.max_memory_restart).toBe('500M');
    expect(releaseStaging.find((app) => app.name === 'content-engine-staging')?.max_memory_restart).toBe('300M');
  });

  it('attests only the explicit non-secret routing policy in PM2 state', () => {
    const backend = loadConfig(
      'ecosystem.release.config.js',
      releaseEnvironment('production'),
    ).find((app) => app.name === 'nexus-hub');

    expect(backend?.env).toMatchObject(expectedPolicy);
    expect(backend?.env).not.toHaveProperty('FAKE_SECRET');
  });

  it('fails closed when the protected routing policy is incomplete', () => {
    const incompleteBase = mkdtempSync(join(tmpdir(), 'nexus-release-pm2-incomplete-'));
    try {
      writeFileSync(join(incompleteBase, '.env'), 'OLLAMA_ENABLED=true\n', { mode: 0o600 });
      const result = spawnSync(process.execPath, [
        '-e',
        'require(process.argv[1])',
        join(ROOT, 'ecosystem.release.config.js'),
      ], {
        encoding: 'utf8',
        env: {
          ...releaseEnvironment('production'),
          NEXUS_RELEASE_BASE_DIR: incompleteBase,
        },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        'protected release environment has an invalid or missing AI_CLASSIFY_PRIMARY',
      );
    } finally {
      rmSync(incompleteBase, { recursive: true, force: true });
    }
  });

  it('observes the full 60-second production stability boundary', () => {
    const transaction = readFileSync(
      join(ROOT, 'scripts', 'remote-user-release-transaction.sh'),
      'utf8',
    );
    const staging = readFileSync(join(ROOT, 'scripts', 'release-operator.sh'), 'utf8');
    const production = readFileSync(join(ROOT, 'scripts', 'promote-exact-release.sh'), 'utf8');

    expect(transaction).toContain('STABILITY_SECONDS="${7:-60}"');
    expect(staging).toContain('${NEXUS_RELEASE_STAGING_STABILITY_SECONDS:-15}');
    expect(production).toContain('${NEXUS_RELEASE_PRODUCTION_STABILITY_SECONDS:-60}');
  });
});
