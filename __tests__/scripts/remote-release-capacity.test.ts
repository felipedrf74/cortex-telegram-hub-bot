import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/remote-release-capacity.sh');
const operator = path.resolve('scripts/release-operator.sh');
const promotion = path.resolve('scripts/promote-exact-release.sh');

describe('remote release host capacity gate', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-release-capacity-'));
    fs.writeFileSync(path.join(fixtureRoot, 'meminfo'), [
      'MemTotal:       33554432 kB',
      'MemAvailable:   13631488 kB',
      'SwapTotal:       8388608 kB',
      'SwapFree:        8388608 kB',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtureRoot, 'loadavg'), '0.30 0.40 0.50 1/100 123\n');
    fs.writeFileSync(path.join(fixtureRoot, 'df-blocks'), [
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      'fixture 100000000 1000000 50000000 2% /fixture',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtureRoot, 'df-inodes'), [
      'Filesystem Inodes IUsed IFree IUse% Mounted on',
      'fixture 1000000 10000 990000 1% /fixture',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtureRoot, 'journal.log'), 'kernel boot complete\n');
    const pm2 = [
      { name: 'nexus-hub', pm2_env: { status: 'online', restart_time: 3, unstable_restarts: 0 } },
      { name: 'content-engine', pm2_env: { status: 'online', restart_time: 1, unstable_restarts: 0 } },
      { name: 'nexus-hub-staging', pm2_env: { status: 'online', restart_time: 2, unstable_restarts: 0 } },
      { name: 'content-engine-staging', pm2_env: { status: 'online', restart_time: 1, unstable_restarts: 0 } },
    ];
    fs.writeFileSync(path.join(fixtureRoot, 'pm2-before.json'), JSON.stringify(pm2));
    fs.writeFileSync(path.join(fixtureRoot, 'pm2-after.json'), JSON.stringify(pm2));
    fs.writeFileSync(path.join(fixtureRoot, 'vmstat-before'), 'pswpin 10\npswpout 20\n');
    fs.writeFileSync(path.join(fixtureRoot, 'vmstat-after'), 'pswpin 10\npswpout 20\n');
    fs.writeFileSync(path.join(fixtureRoot, 'sonar-in-progress.json'), '{"paging":{"total":0},"tasks":[]}\n');
    fs.writeFileSync(path.join(fixtureRoot, 'sonar-pending.json'), '{"paging":{"total":0},"tasks":[]}\n');
  });

  afterEach(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  function run(role: 'staging' | 'production' = 'production') {
    const baseDir = role === 'staging'
      ? '/srv/nexus-release/staging'
      : '/srv/nexus-release/production';
    return spawnSync('bash', [
      script,
      '--role', role,
      '--base-dir', baseDir,
      '--pm2-bin', '/fixture/pm2',
      '--sample-seconds', '0',
      '--fixture-root', fixtureRoot,
    ], {
      encoding: 'utf8',
      env: { ...process.env, NEXUS_RELEASE_TEST_MODE: '1' },
    });
  }

  it('accepts a quiet host with at least twelve GiB available and no active CE work', () => {
    const result = run();

    expect(result.status, result.stderr).toBe(0);
    const evidence = JSON.parse(result.stdout);
    expect(evidence.schema).toBe('nexus.release-host-capacity.v1');
    expect(evidence.ok).toBe(true);
    expect(evidence.thresholds.memoryAvailableGiB).toBe(12);
    expect(evidence.observed.sonarActiveTasks).toBe(0);
  });

  it('fails closed on pressure, swap, OOM, restart drift, and an active Sonar task', () => {
    fs.writeFileSync(path.join(fixtureRoot, 'meminfo'), [
      'MemTotal:       33554432 kB',
      'MemAvailable:    8388608 kB',
      'SwapTotal:       8388608 kB',
      'SwapFree:        7340032 kB',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(fixtureRoot, 'loadavg'), '6.00 6.00 6.00 1/100 123\n');
    fs.writeFileSync(path.join(fixtureRoot, 'journal.log'), 'Out of memory: Killed process 42\n');
    fs.writeFileSync(path.join(fixtureRoot, 'pm2-after.json'), JSON.stringify([
      { name: 'nexus-hub', pm2_env: { status: 'online', restart_time: 4, unstable_restarts: 0 } },
      { name: 'content-engine', pm2_env: { status: 'online', restart_time: 1, unstable_restarts: 0 } },
      { name: 'nexus-hub-staging', pm2_env: { status: 'online', restart_time: 2, unstable_restarts: 0 } },
      { name: 'content-engine-staging', pm2_env: { status: 'online', restart_time: 1, unstable_restarts: 0 } },
    ]));
    fs.writeFileSync(path.join(fixtureRoot, 'vmstat-after'), 'pswpin 12\npswpout 23\n');
    fs.writeFileSync(path.join(fixtureRoot, 'sonar-pending.json'), '{"paging":{"total":1},"tasks":[{}]}\n');

    const result = run();

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).reasons).toEqual(expect.arrayContaining([
      'memory_available_below_12_gib',
      'sustained_swap_in_observed',
      'sustained_swap_out_observed',
      'load15_at_or_above_6',
      'kernel_oom_observed_last_30_minutes',
      'pm2_restart_observed:nexus-hub',
      'sonar_ce_task_active',
    ]));
  });

  it('blocks a staging release when either staging PM2 service restarts or is not online', () => {
    fs.writeFileSync(path.join(fixtureRoot, 'pm2-after.json'), JSON.stringify([
      { name: 'nexus-hub', pm2_env: { status: 'online', restart_time: 3, unstable_restarts: 0 } },
      { name: 'content-engine', pm2_env: { status: 'online', restart_time: 1, unstable_restarts: 0 } },
      { name: 'nexus-hub-staging', pm2_env: { status: 'online', restart_time: 3, unstable_restarts: 0 } },
      { name: 'content-engine-staging', pm2_env: { status: 'stopped', restart_time: 1, unstable_restarts: 0 } },
    ]));

    const result = run('staging');

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).reasons).toEqual(expect.arrayContaining([
      'pm2_restart_observed:nexus-hub-staging',
      'pm2_process_not_stably_online:content-engine-staging',
    ]));
  });

  it('allows historically allocated swap when sampled pswpin and pswpout stay flat', () => {
    fs.writeFileSync(path.join(fixtureRoot, 'meminfo'), [
      'MemTotal:       33554432 kB',
      'MemAvailable:   13631488 kB',
      'SwapTotal:       8388608 kB',
      'SwapFree:        7340032 kB',
      '',
    ].join('\n'));

    const result = run();

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).observed).toMatchObject({
      swapUsedKiB: 1048576,
      pswpinDelta: 0,
      pswpoutDelta: 0,
    });
  });

  it('fails closed when Sonar responds but the narrow root-owned state helper is unavailable', () => {
    fs.writeFileSync(path.join(fixtureRoot, 'sonar-helper-unavailable'), 'unavailable\n');

    const result = run();

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).reasons).toContain('sonar_release_state_helper_unavailable');
  });

  it('does not allow production callers to inject fixture evidence', () => {
    const result = spawnSync('bash', [
      script,
      '--role', 'staging',
      '--base-dir', '/srv/nexus-release/staging',
      '--pm2-bin', '/fixture/pm2',
      '--sample-seconds', '0',
      '--fixture-root', fixtureRoot,
    ], { encoding: 'utf8' });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('capacity fixtures are test-only');
  });

  it('rejects a role-mismatched or non-canonical live release base', () => {
    for (const baseDir of [
      '/srv/nexus-release/production',
      '/srv/nexus-release/staging-extra',
      '/home/dominguez/unrelated-release',
    ]) {
      const result = spawnSync('bash', [
        script,
        '--role', 'staging',
        '--base-dir', baseDir,
        '--pm2-bin', '/fixture/pm2',
        '--sample-seconds', '0',
        '--fixture-root', fixtureRoot,
      ], {
        encoding: 'utf8',
        env: { ...process.env, NEXUS_RELEASE_TEST_MODE: '1' },
      });

      expect(result.status, baseDir).toBe(64);
      expect(result.stderr).toContain('unsafe release capacity base path');
    }
  });

  it('runs capacity and the fixed rollback freshness gate before release mutation', () => {
    const operatorSource = fs.readFileSync(operator, 'utf8');
    const promotionSource = fs.readFileSync(promotion, 'utf8');
    const staging = operatorSource.indexOf('  staging)');
    const stagingRollback = operatorSource.indexOf('validate_rollback_drill_freshness', staging);
    const stagingCapacity = operatorSource.indexOf('remote-release-capacity.sh', staging);
    const stagingCopy = operatorSource.indexOf('rsync -az --delete', staging);
    const promotionRollback = promotionSource.indexOf('rollback-drill-check.mjs');
    const promotionLock = promotionSource.indexOf('release_acquire_remote_lock');
    const productionCapacity = promotionSource.indexOf('remote-release-capacity.sh');
    const legacyStop = promotionSource.indexOf("<<'REMOTE_STOP'");

    expect(stagingRollback).toBeGreaterThan(staging);
    expect(stagingCapacity).toBeGreaterThan(stagingRollback);
    expect(stagingCapacity).toBeLessThan(stagingCopy);
    expect(promotionRollback).toBeGreaterThan(-1);
    expect(promotionRollback).toBeLessThan(promotionLock);
    expect(productionCapacity).toBeGreaterThan(promotionLock);
    expect(productionCapacity).toBeLessThan(legacyStop);
    expect(operatorSource).toContain('--max-age-days 30');
    expect(promotionSource.slice(promotionRollback, promotionLock)).toContain('--release-gate');
  });
});
