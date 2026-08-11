import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const BOOTSTRAP = path.join(ROOT, 'scripts/remote-start-sanitized-pm2.sh');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(pm2Body: string): {
  root: string;
  remote: string;
  pm2: string;
  bootstrap: string;
  stateView: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'nexus-pm2-sanitizer-'));
  roots.push(root);
  const sudo = path.join(root, 'sudo');
  writeFileSync(sudo, '#!/usr/bin/env bash\n[ "$1" = -n ] && shift\nexec "$@"\n');
  chmodSync(sudo, 0o700);
  const stateView = path.join(root, 'state-view');
  writeFileSync(stateView, `#!/usr/bin/env bash
set -euo pipefail
progress=false
retired=false
[ ! -e "$HOME/var/lib/nexus-release/state/pm2-fallback-retirement.json" ] \
  && [ ! -L "$HOME/var/lib/nexus-release/state/pm2-fallback-retirement.json" ] \
  || progress=true
[ ! -e "$HOME/var/lib/nexus-release/state/pm2-fallback-retired.json" ] \
  && [ ! -L "$HOME/var/lib/nexus-release/state/pm2-fallback-retired.json" ] \
  || retired=true
printf '%s\\n' '{"active":null,"activeReceipt":null,"authoritative":false,"blocked":null,"capturedAt":"2026-08-11T00:00:00.000Z","effective":{"provable":false},"generated":true,"generatedAt":"2026-08-11T00:00:00.000Z","lastRecovery":null,"note":"bounded root view","pm2FallbackRetired":'"$retired"',"pm2FallbackRetirementInProgress":'"$progress"',"predecessor":null,"recent":[],"schema":"nexus.release-state-view.v2","sourceSchemas":{"receipt":"nexus.release-receipt.v3","state":"nexus.release-host-state.v1"}}'
`);
  chmodSync(stateView, 0o700);
  const bootstrap = path.join(root, 'remote-start-sanitized-pm2.sh');
  writeFileSync(bootstrap, readFileSync(BOOTSTRAP, 'utf8')
    .replace('SUDO_BIN=/usr/bin/sudo', `SUDO_BIN=${sudo}`)
    .replace(
      'STATE_VIEW_BIN=/usr/local/sbin/nexus-release-state-view',
      `STATE_VIEW_BIN=${stateView}`,
    ));
  chmodSync(bootstrap, 0o700);
  const remote = path.join(root, 'app');
  mkdirSync(remote);
  writeFileSync(path.join(remote, 'ecosystem.config.js'), 'module.exports = { apps: [] };\n');
  const pm2 = path.join(root, 'pm2');
  writeFileSync(pm2, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "\$1" >> "\$0.log"
${pm2Body}
`);
  chmodSync(pm2, 0o700);
  return { root, remote, pm2, bootstrap, stateView };
}

function run(root: string, remote: string, pm2: string) {
  return spawnSync('bash', [
    path.join(root, 'remote-start-sanitized-pm2.sh'),
    remote,
    pm2,
    'abcdef1',
    'ecosystem.config.js',
    'nexus-hub',
    'NODE_ENV,GIT_COMMIT',
  ], {
    env: {
      HOME: root,
      PATH: process.env.PATH || '/usr/bin:/bin',
    },
    encoding: 'utf8',
  });
}

describe('sanitized PM2 bootstrap', () => {
  it.each([
    'pm2-fallback-retirement.json',
    'pm2-fallback-retired.json',
  ])('refuses %s before invoking PM2', (gate) => {
    const { root, remote, pm2 } = fixture('exit 0');
    const state = path.join(root, 'var/lib/nexus-release/state');
    mkdirSync(state, { recursive: true });
    if (gate === 'pm2-fallback-retired.json') {
      symlinkSync('missing-retired-evidence', path.join(state, gate));
    } else {
      writeFileSync(path.join(state, gate), '{}\n');
    }

    const result = run(root, remote, pm2);

    expect(result.status).toBe(78);
    expect(result.stderr).toContain('barred by fallback retirement evidence');
    expect(() => readFileSync(`${pm2}.log`)).toThrow();
  });

  it('has no caller-controlled gate bypass and rejects an inexact privileged view', () => {
    const { root, remote, pm2, stateView } = fixture('exit 0');
    writeFileSync(stateView, '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"unexpected":true}\'\n');
    chmodSync(stateView, 0o700);

    const result = run(root, remote, pm2);
    expect(result.status).toBe(78);
    expect(result.stderr).toContain('state view contract is invalid');

    const source = readFileSync(BOOTSTRAP, 'utf8');
    expect(source).not.toContain('NEXUS_RELEASE_TEST_MODE');
    expect(source).not.toContain('NEXUS_PM2_TEST_ROOT');
    expect(source).toContain('STATE_VIEW_BIN=/usr/local/sbin/nexus-release-state-view');
    expect(source).toContain('"$SUDO_BIN" -n "$STATE_VIEW_BIN"');
    expect(source).toContain('JSON.stringify(Object.keys(view).sort())');
    expect(source).toContain('view.pm2FallbackRetirementInProgress || view.pm2FallbackRetired');
  });

  it('removes stale module configuration only for apps being recreated', () => {
    const { root, remote, pm2 } = fixture(`
case "\$1" in
  delete|start) exit 0 ;;
  jlist)
    printf '%s\\n' '[{"name":"nexus-hub","pm2_env":{"status":"online","env":{"HOME":"safe","NODE_ENV":"production","GIT_COMMIT":"abcdef1"}}}]'
    ;;
  save)
    mkdir -p "\$PM2_HOME"
    printf '%s\\n' '[]' > "\$PM2_HOME/dump.pm2"
    ;;
  *) exit 1 ;;
esac
`);
    mkdirSync(path.join(root, '.pm2'));
    writeFileSync(
      path.join(root, '.pm2', 'module_conf.json'),
      JSON.stringify({ 'nexus-hub': 'xyz', 'unrelated-module': { enabled: true } }),
    );

    const result = run(root, remote, pm2);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(JSON.parse(readFileSync(path.join(root, '.pm2', 'module_conf.json'), 'utf8'))).toEqual({
      'unrelated-module': { enabled: true },
    });
  });

  it('cleans a partially created multi-app start when PM2 returns nonzero', () => {
    const { root, remote, pm2 } = fixture(`
case "\$1" in
  delete) exit 0 ;;
  start) exit 1 ;;
  *) exit 1 ;;
esac
`);
    mkdirSync(path.join(root, '.pm2'));
    writeFileSync(path.join(root, '.pm2', 'dump.pm2'), '[{"BACKUP_KEY":"old"}]\n');
    writeFileSync(path.join(root, '.pm2', 'dump.pm2.bak'), '[{"BACKUP_KEY":"old"}]\n');

    const result = run(root, remote, pm2);

    expect(result.status).not.toBe(0);
    expect(readFileSync(`${pm2}.log`, 'utf8').trim().split('\n')).toEqual([
      'delete',
      'start',
      'delete',
    ]);
    expect(() => readFileSync(path.join(root, '.pm2', 'dump.pm2'))).toThrow();
    expect(() => readFileSync(path.join(root, '.pm2', 'dump.pm2.bak'))).toThrow();
  });

  it('rejects known secret-bearing names outside the minimal environment allowlist', () => {
    const { root, remote, pm2 } = fixture(`
case "\$1" in
  delete|start) exit 0 ;;
  jlist)
    printf '%s\\n' '[{"name":"nexus-hub","pm2_env":{"status":"online","env":{"HOME":"safe","NODE_ENV":"production","GIT_COMMIT":"abcdef1","BACKUP_KEY":"x","INVOICE_SSH_KEY":"x","IOS_INVITE_CODE":"x","IOS_OWNER_CODE":"x","WAITLIST_IP_SALT":"x"}}}]'
    ;;
  *) exit 1 ;;
esac
`);

    const result = run(root, remote, pm2);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('outside the explicit allowlist');
    expect(readFileSync(`${pm2}.log`, 'utf8').trim().split('\n')).toEqual([
      'delete',
      'start',
      'jlist',
      'delete',
    ]);
    expect(() => readFileSync(path.join(root, '.pm2', 'dump.pm2'))).toThrow();
    expect(() => readFileSync(path.join(root, '.pm2', 'dump.pm2.bak'))).toThrow();
  });

  it('continues to reject opaque numeric environment keys after module cleanup', () => {
    const { root, remote, pm2 } = fixture(`
case "\$1" in
  delete|start) exit 0 ;;
  jlist)
    printf '%s\\n' '[{"name":"nexus-hub","pm2_env":{"status":"online","env":{"HOME":"safe","NODE_ENV":"production","GIT_COMMIT":"abcdef1","0":"x"}}}]'
    ;;
  *) exit 1 ;;
esac
`);

    const result = run(root, remote, pm2);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('outside the explicit allowlist');
    expect(readFileSync(`${pm2}.log`, 'utf8').trim().split('\n')).toEqual([
      'delete',
      'start',
      'jlist',
      'delete',
    ]);
  });

  it('atomically scrubs current and backup resurrection dumps after a clean start', () => {
    const { root, remote, pm2 } = fixture(`
case "\$1" in
  delete|start) exit 0 ;;
  jlist)
    printf '%s\\n' '[{"name":"nexus-hub","pm2_env":{"status":"online","env":{"HOME":"safe","NODE_ENV":"production","GIT_COMMIT":"abcdef1"}}}]'
    ;;
  save)
    mkdir -p "\$PM2_HOME"
    printf '%s\\n' '[{"name":"legacy","BACKUP_KEY":"x","WAITLIST_IP_SALT":"x","PORTAL_PORT":"8200","env":{"BACKUP_KEY":"x","IOS_OWNER_CODE":"x","PORTAL_PORT":"8200"}}]' > "\$PM2_HOME/dump.pm2"
    cp "\$PM2_HOME/dump.pm2" "\$PM2_HOME/dump.pm2.bak"
    ;;
  *) exit 1 ;;
esac
`);

    const result = run(root, remote, pm2);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const filename of ['dump.pm2', 'dump.pm2.bak']) {
      const raw = readFileSync(path.join(root, '.pm2', filename), 'utf8');
      expect(raw).not.toContain('BACKUP_KEY');
      expect(raw).not.toContain('WAITLIST_IP_SALT');
      expect(raw).not.toContain('IOS_OWNER_CODE');
      expect(raw).toContain('PORTAL_PORT');
      expect(JSON.parse(raw)).toBeInstanceOf(Array);
    }
  });

  it('deletes newly started apps and removes resurrection files when dump sanitation fails', () => {
    const { root, remote, pm2 } = fixture(`
case "\$1" in
  delete|start) exit 0 ;;
  jlist)
    printf '%s\\n' '[{"name":"nexus-hub","pm2_env":{"status":"online","env":{"HOME":"safe","NODE_ENV":"production","GIT_COMMIT":"abcdef1"}}}]'
    ;;
  save)
    mkdir -p "\$PM2_HOME"
    printf '%s\\n' '{invalid-json' > "\$PM2_HOME/dump.pm2"
    printf '%s\\n' '{invalid-json' > "\$PM2_HOME/dump.pm2.bak"
    ;;
  *) exit 1 ;;
esac
`);

    const result = run(root, remote, pm2);

    expect(result.status).not.toBe(0);
    expect(readFileSync(`${pm2}.log`, 'utf8').trim().split('\n')).toEqual([
      'delete',
      'start',
      'jlist',
      'save',
      'delete',
    ]);
    expect(() => readFileSync(path.join(root, '.pm2', 'dump.pm2'))).toThrow();
    expect(() => readFileSync(path.join(root, '.pm2', 'dump.pm2.bak'))).toThrow();
  });
});
