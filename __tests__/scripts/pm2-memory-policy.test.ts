import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');

type Pm2App = {
  name: string;
  max_memory_restart: string;
  node_args?: string;
};

function loadConfig(file: string, env: NodeJS.ProcessEnv = process.env): Pm2App[] {
  const configPath = join(ROOT, file);
  const output = execFileSync(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(require(process.argv[1]).apps))',
    configPath,
  ], { encoding: 'utf8', env });
  return JSON.parse(output) as Pm2App[];
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
  it('keeps total RSS at least 256 MiB above V8 old space in every runtime config', () => {
    const variants = [
      loadConfig('ecosystem.config.js'),
      loadConfig('ecosystem.staging.config.js'),
      loadConfig('ecosystem.release.config.js', {
        ...process.env,
        NEXUS_RELEASE_DIR: ROOT,
        NEXUS_RELEASE_ROLE: 'production',
      }),
      loadConfig('ecosystem.release.config.js', {
        ...process.env,
        NEXUS_RELEASE_DIR: ROOT,
        NEXUS_RELEASE_ROLE: 'staging',
      }),
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
    expect(loadConfig('ecosystem.staging.config.js').find((app) => app.name === 'content-engine-staging')?.max_memory_restart).toBe('300M');

    const releaseProduction = loadConfig('ecosystem.release.config.js', {
      ...process.env,
      NEXUS_RELEASE_DIR: ROOT,
      NEXUS_RELEASE_ROLE: 'production',
    });
    const releaseStaging = loadConfig('ecosystem.release.config.js', {
      ...process.env,
      NEXUS_RELEASE_DIR: ROOT,
      NEXUS_RELEASE_ROLE: 'staging',
    });
    expect(releaseProduction.find((app) => app.name === 'content-engine')?.max_memory_restart).toBe('500M');
    expect(releaseStaging.find((app) => app.name === 'content-engine-staging')?.max_memory_restart).toBe('300M');
  });

  it('observes a full 60-second stability boundary by default in every canonical release path', () => {
    const readiness = readFileSync(join(ROOT, 'scripts', 'remote-release-readiness.sh'), 'utf8');
    const staging = readFileSync(join(ROOT, 'scripts', 'release-operator.sh'), 'utf8');
    const production = readFileSync(join(ROOT, 'scripts', 'promote-exact-release.sh'), 'utf8');

    expect(readiness).toContain("'') STABILITY_SECONDS=60 ;;");
    expect(staging).toContain('${NEXUS_RELEASE_STAGING_STABILITY_SECONDS:-60}');
    expect(production).toContain('${NEXUS_RELEASE_PRODUCTION_STABILITY_SECONDS:-60}');
  });
});
