import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];

function executable(path: string, contents: string) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixture() {
  const root = realpathSync(mkdtempSync(join('/tmp', 'nexus-sonar-boundary-')));
  roots.push(root);
  const bin = join(root, 'bin');
  const proc = join(root, 'proc');
  const pm2UserHome = join(root, 'dominguez');
  const pm2Home = join(pm2UserHome, '.pm2');
  const rootNode = join(bin, 'root-node');
  const pm2 = join(bin, 'pm2');
  const control = join(bin, 'nexus-release-promotion-control');
  const runuserCount = join(root, 'runuser-count');
  const dockerRows = join(root, 'docker-rows.tsv');
  const socket = join(root, 'docker.sock');
  const daemonConfig = join(root, 'etc', 'docker', 'daemon.json');
  const subuid = join(root, 'etc', 'subuid');
  const subgid = join(root, 'etc', 'subgid');
  const dockerRoot = join(root, 'var', 'lib', 'docker');
  const usernsRoot = join(dockerRoot, '231072.296608');
  for (const directory of [
    bin,
    join(proc, 'sys', 'kernel', 'random'),
    pm2Home,
    join(root, 'etc', 'docker'),
    usernsRoot,
  ]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(proc, 'meminfo'), 'MemAvailable:   20971520 kB\n');
  writeFileSync(join(proc, 'loadavg'), '0.10 0.20 1.00 1/1 1\n');
  writeFileSync(join(proc, 'vmstat'), 'pswpin 10\npswpout 20\n');
  writeFileSync(
    join(proc, 'sys', 'kernel', 'random', 'boot_id'),
    '11111111-2222-3333-4444-555555555555\n',
  );
  writeFileSync(runuserCount, '0\n');
  writeFileSync(dockerRows, '');
  writeFileSync(
    daemonConfig,
    `${JSON.stringify({
      features: { 'containerd-snapshotter': false },
      'userns-remap': 'default',
    })}\n`,
  );
  writeFileSync(subuid, 'dockremap:231072:65536\nother:400000:65536\n');
  writeFileSync(subgid, 'dockremap:296608:65536\nother:500000:65536\n');

  executable(rootNode, [
    '#!/bin/sh',
    '[ "${1:-}" = --version ] && { echo v22.23.1; exit 0; }',
    'exec "$TEST_REAL_NODE" "$@"',
    '',
  ].join('\n'));
  executable(pm2, '#!/bin/sh\nexit 0\n');
  executable(control, [
    '#!/bin/sh',
    '[ "${1:-}" = assert-root-pm2-ready ] || exit 64',
    'printf "%s\\n" "$TEST_PM2_IDENTITY"',
    '',
  ].join('\n'));
  executable(join(bin, 'id'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const account = args[1] || args[0];
const values = {
  dominguez: {
    uid: process.env.TEST_DOMINGUEZ_UID || '1000',
    gid: process.env.TEST_DOMINGUEZ_GID || '1000',
    groups: process.env.TEST_DOMINGUEZ_GROUPS || '1000 999',
  },
  'nexus-release': {
    uid: process.env.TEST_RELEASE_UID || '995',
    gid: process.env.TEST_RELEASE_GID || '982',
    groups: process.env.TEST_RELEASE_GROUPS || '982',
  },
  dockremap: { uid: '112', gid: '116', groups: '116' },
};
if (args.length === 1 && args[0] === '-u') {
  process.stdout.write('0\\n');
  process.exit(0);
}
if (!values[account]) process.exit(1);
if (args[0] === '-u') process.stdout.write(values[account].uid + '\\n');
else if (args[0] === '-g') process.stdout.write(values[account].gid + '\\n');
else if (args[0] === '-G') process.stdout.write(values[account].groups + '\\n');
process.exit(0);
`);
  executable(join(bin, 'getent'), `#!/usr/bin/env node
const [database, key] = process.argv.slice(2);
const accounts = {
  dominguez: [
    process.env.TEST_DOMINGUEZ_UID || '1000',
    process.env.TEST_DOMINGUEZ_GID || '1000',
    '${pm2UserHome}',
  ],
  'nexus-release': [
    process.env.TEST_RELEASE_UID || '995',
    process.env.TEST_RELEASE_GID || '982',
    '/var/lib/nexus-release',
  ],
  dockremap: ['112', '116', '/var/lib/docker'],
};
if (database === 'passwd' && accounts[key]) {
  const [uid, gid, home] = accounts[key];
  process.stdout.write(key + ':x:' + uid + ':' + gid + '::' + home + ':/usr/sbin/nologin\\n');
  process.exit(0);
}
if (database === 'group' && key === 'docker') {
  process.stdout.write('docker:x:' + (process.env.TEST_DOCKER_GID || '997') + ':\\n');
  process.exit(0);
}
if (database === 'group' && key === 'dockremap') {
  process.stdout.write('dockremap:x:116:\\n');
  process.exit(0);
}
if (database === 'passwd' && key === '999') {
  process.stdout.write('dnsmasq:x:999:65534::/var/lib/misc:/usr/sbin/nologin\\n');
  process.exit(0);
}
if (database === 'group' && key === '999') {
  process.stdout.write('systemd-journal:x:999:dominguez\\n');
  process.exit(0);
}
if (process.env.TEST_MAPPED_COLLISION
    && key === process.env.TEST_MAPPED_COLLISION
    && (database === 'passwd' || database === 'group')) {
  process.stdout.write(
    database === 'passwd'
      ? 'collision:x:' + key + ':65534::/nonexistent:/usr/sbin/nologin\\n'
      : 'collision:x:' + key + ':\\n',
  );
  process.exit(0);
}
process.exit(2);
`);
  executable(join(bin, 'stat'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const joined = args.join(' ');
const target = args.at(-1);
if (joined.includes('%U:%G:%a:%h')) process.stdout.write('root:root:755:1\\n');
else if (joined.includes('%u:%g:%a')) {
  process.stdout.write('0:' + (process.env.TEST_DOCKER_GID || '997') + ':660\\n');
} else if (joined.includes('%u:%g')) {
  if (target === process.env.TEST_USERNS_ROOT) {
    process.stdout.write('231072:296608\\n');
  } else {
    process.stdout.write('0:0\\n');
  }
} else if (joined.includes('%U:%a')) process.stdout.write('dominguez:700\\n');
else if (joined.includes('%U')) process.stdout.write('dominguez\\n');
else if (joined.includes('%a')) {
  process.stdout.write(target === process.env.TEST_USERNS_ROOT ? '700\\n' : '644\\n');
}
else {
  const result = spawnSync('/usr/bin/stat', args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`);
  executable(join(bin, 'runuser'), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const countPath = process.env.TEST_RUNUSER_COUNT;
const count = Number(readFileSync(countPath, 'utf8').trim() || '0') + 1;
writeFileSync(countPath, String(count) + '\\n');
const restart = process.env.TEST_PM2_RESTART_SECOND === '1' && count >= 2 ? 1 : 0;
const rows = ['nexus-hub', 'content-engine', 'nexus-hub-staging', 'content-engine-staging']
  .map(name => ({
    name,
    pm2_env: {
      status: 'online',
      restart_time: restart,
      unstable_restarts: 0,
    },
  }));
process.stdout.write(JSON.stringify(rows));
`);
  executable(join(bin, 'hostname'), '#!/bin/sh\nprintf "serverdominguez\\n"\n');
  executable(join(bin, 'journalctl'), `#!/usr/bin/env node
process.stdout.write(process.env.TEST_KERNEL_JOURNAL || '');
`);
  executable(join(bin, 'systemctl'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'list-unit-files') {
  const type = args.find(value => value.startsWith('--type='))?.slice(7);
  process.stdout.write(type === 'timer'
    ? (process.env.TEST_TIMER_UNIT_FILES || '')
    : (process.env.TEST_SERVICE_UNIT_FILES || ''));
  process.exit(0);
}
if (args[0] === 'list-units') {
  const type = args.find(value => value.startsWith('--type='))?.slice(7);
  process.stdout.write(type === 'timer'
    ? (process.env.TEST_LOADED_TIMERS || '')
    : (process.env.TEST_LOADED_SERVICES || ''));
  process.exit(0);
}
process.exit(1);
`);
  executable(join(bin, 'sleep'), `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.env.TEST_SWAP_AFTER === '1') {
  writeFileSync(process.env.TEST_VMSTAT, 'pswpin 11\\npswpout 20\\n');
}
`);
  executable(join(bin, 'realpath'), `#!/usr/bin/env node
const { realpathSync } = require('node:fs');
process.stdout.write(realpathSync(process.argv.at(-1)) + '\\n');
`);
  executable(join(bin, 'docker'), `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'version') process.exit(0);
if (args[0] === 'info') {
  process.stdout.write(JSON.stringify({
    SecurityOptions: ['name=seccomp', 'name=userns'],
    DriverStatus: [['Backing Filesystem', 'extfs']],
    DockerRootDir: process.env.TEST_DOCKER_ROOT,
  }));
  process.exit(0);
}
if (args[0] === 'ps' && args[1] === '-a') {
  process.stdout.write(readFileSync(process.env.TEST_DOCKER_ROWS, 'utf8'));
  process.exit(0);
}
process.exit(1);
`);
  executable(join(bin, 'getfacl'), `#!/usr/bin/env node
process.stdout.write(process.env.TEST_DOCKER_ACL || 'user::rw-\\ngroup::rw-\\nother::---\\n');
`);

  const identity = {
    ok: true,
    schema: 'nexus.pm2-root-install.v1',
    version: '6.0.14',
    closureDigest: 'a'.repeat(64),
    payloadDigest: 'b'.repeat(64),
    packageLockSha256: 'c'.repeat(64),
    launcher: pm2,
    launcherSha256: 'd'.repeat(64),
    node: {
      path: rootNode,
      version: 'v22.23.1',
      sha256: 'e'.repeat(64),
    },
    entrypoint: '/opt/nexus-release/pm2/6.0.14/node_modules/pm2/bin/pm2',
  };

  const environment = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    NEXUS_RELEASE_TEST_MODE: '1',
    NEXUS_SONAR_PM2_BIN: pm2,
    NEXUS_SONAR_PM2_USER_HOME: pm2UserHome,
    NEXUS_SONAR_PM2_HOME: pm2Home,
    NEXUS_SONAR_PM2_CONTROL: control,
    NEXUS_SONAR_ROOT_NODE_BIN: rootNode,
    NEXUS_SONAR_PROC_ROOT: proc,
    NEXUS_SONAR_DOCKER_SOCKET: socket,
    NEXUS_SONAR_DOCKER_DAEMON_CONFIG: daemonConfig,
    NEXUS_SONAR_SUBUID_FILE: subuid,
    NEXUS_SONAR_SUBGID_FILE: subgid,
    NEXUS_SONAR_RUNUSER_BIN: join(bin, 'runuser'),
    NEXUS_SONAR_SYSTEMCTL_BIN: join(bin, 'systemctl'),
    NEXUS_SONAR_JOURNALCTL_BIN: join(bin, 'journalctl'),
    NEXUS_SONAR_GETENT_BIN: join(bin, 'getent'),
    NEXUS_SONAR_GETFACL_BIN: join(bin, 'getfacl'),
    NEXUS_SONAR_ID_BIN: join(bin, 'id'),
    NEXUS_SONAR_HOSTNAME_BIN: join(bin, 'hostname'),
    NEXUS_SONAR_SLEEP_BIN: join(bin, 'sleep'),
    NEXUS_SONAR_REALPATH_BIN: join(bin, 'realpath'),
    NEXUS_SONAR_DOCKER_BIN: '/nonexistent/docker',
    TEST_REAL_NODE: process.execPath,
    TEST_PM2_IDENTITY: JSON.stringify(identity),
    TEST_RUNUSER_COUNT: runuserCount,
    TEST_VMSTAT: join(proc, 'vmstat'),
    TEST_DOCKER_ROWS: dockerRows,
    TEST_DOCKER_ROOT: dockerRoot,
    TEST_USERNS_ROOT: usernsRoot,
  };
  return {
    root,
    proc,
    socket,
    docker: join(bin, 'docker'),
    dockerRows,
    daemonConfig,
    subuid,
    subgid,
    runuserCount,
    environment,
  };
}

function runBoundary(
  value: ReturnType<typeof fixture>,
  environment: NodeJS.ProcessEnv = {},
  requireDocker = false,
) {
  writeFileSync(value.runuserCount, '0\n');
  return spawnSync(
    'bash',
    [
      'scripts/quality-sonar-preflight.sh',
      '--verify-runtime-boundary-only',
      ...(requireDocker ? [] : ['--allow-docker-absent']),
      '--sample-seconds',
      '1',
    ],
    {
      encoding: 'utf8',
      env: { ...value.environment, ...environment },
    },
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Sonar live runtime boundary', () => {
  it('ships the reviewed fresh-Docker userns daemon contract', () => {
    expect(JSON.parse(readFileSync(
      'ops/sonarqube/docker-daemon.userns.json',
      'utf8',
    ))).toEqual({
      features: { 'containerd-snapshotter': false },
      'userns-remap': 'default',
    });
  });

  it('accepts the live host 999/1000 identities before Docker because container IDs will be remapped', () => {
    const value = fixture();
    const result = runBoundary(value);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      '"dockerAuthority":"not_installed"',
    );
    expect(result.stdout).toContain('sonar_live_capacity_ok');
  });

  it('rejects protected release-account Docker authority before capacity authorization', () => {
    const value = fixture();
    const result = runBoundary(value, {
      TEST_RELEASE_GROUPS: '982 997',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('nexus-release has Docker-group authority');
    expect(result.stdout).not.toContain('sonar_live_capacity_ok');
  });

  it.each([
    {
      name: 'memory',
      prepare: (value: ReturnType<typeof fixture>) => {
        writeFileSync(join(value.proc, 'meminfo'), 'MemAvailable:   8388608 kB\n');
      },
      env: {},
      error: 'MemAvailable is below 16 GiB',
    },
    {
      name: 'load',
      prepare: (value: ReturnType<typeof fixture>) => {
        writeFileSync(join(value.proc, 'loadavg'), '0.10 0.20 6.00 1/1 1\n');
      },
      env: {},
      error: '15-minute load is at or above 6',
    },
    {
      name: 'swap',
      prepare: () => {},
      env: { TEST_SWAP_AFTER: '1' },
      error: 'Live swap pressure blocks Sonar',
    },
    {
      name: 'OOM',
      prepare: () => {},
      env: { TEST_KERNEL_JOURNAL: 'kernel: oom-kill: constraint=NONE\n' },
      error: 'Recent kernel OOM evidence blocks Sonar',
    },
    {
      name: 'PM2 restart',
      prepare: () => {},
      env: { TEST_PM2_RESTART_SECOND: '1' },
      error: '',
    },
  ])('rejects immediate $name pressure', ({ prepare, env, error }) => {
    const value = fixture();
    prepare(value);
    const result = runBoundary(value, env);
    expect(result.status).not.toBe(0);
    if (error) expect(result.stderr).toContain(error);
    expect(result.stdout).not.toContain('sonar_live_capacity_ok');
  });

  it('rejects a known automatic-updater systemd unit', () => {
    const value = fixture();
    const result = runBoundary(value, {
      TEST_SERVICE_UNIT_FILES: 'watchtower.service enabled\n',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Known automatic Docker updater unit is installed: watchtower.service',
    );
  });

  it('requires root-only Docker authority plus a proven userns map and rejects updater containers', () => {
    const value = fixture();
    writeFileSync(value.socket, '');
    const dockerEnvironment = {
      NEXUS_SONAR_DOCKER_BIN: value.docker,
      NEXUS_SONAR_TEST_SOCKET_TYPE_VERIFIED: '1',
    };
    const accepted = runBoundary(value, dockerEnvironment, true);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(
      '"dockerAuthority":"root_socket_userns_remap"',
    );
    expect(accepted.stdout).toContain('"hostUid":232071');
    expect(accepted.stdout).toContain('"hostUid":232072');

    const namedAcl = runBoundary(value, {
      ...dockerEnvironment,
      TEST_DOCKER_ACL:
        'user::rw-\nuser:dominguez:rw-\ngroup::rw-\nmask::rw-\nother::---\n',
    }, true);
    expect(namedAcl.status).not.toBe(0);
    expect(namedAcl.stderr).toContain(
      'Docker socket has a named, masked, or nonstandard ACL',
    );

    writeFileSync(
      value.dockerRows,
      'nexus-watchtower\tcontainrrr/watchtower:latest\n',
    );
    const updater = runBoundary(value, dockerEnvironment, true);
    expect(updater.status).not.toBe(0);
    expect(updater.stderr).toContain(
      'Known automatic Docker updater container is installed',
    );

    writeFileSync(value.dockerRows, '');
    writeFileSync(
      value.daemonConfig,
      `${JSON.stringify({
        features: { 'containerd-snapshotter': true },
        'userns-remap': 'default',
      })}\n`,
    );
    const incompatibleStore = runBoundary(value, dockerEnvironment, true);
    expect(incompatibleStore.status).not.toBe(0);
    expect(incompatibleStore.stderr).toContain(
      'incompatible containerd image store disabled',
    );
  });

  it('rejects overlapping subordinate ranges and mapped host-identity collisions', () => {
    const value = fixture();
    writeFileSync(value.socket, '');
    const dockerEnvironment = {
      NEXUS_SONAR_DOCKER_BIN: value.docker,
      NEXUS_SONAR_TEST_SOCKET_TYPE_VERIFIED: '1',
    };
    writeFileSync(
      value.subuid,
      'dockremap:231072:65536\nother:250000:65536\n',
    );
    const overlap = runBoundary(value, dockerEnvironment, true);
    expect(overlap.status).not.toBe(0);
    expect(overlap.stderr).toContain(
      'subordinate UID map contains overlapping subordinate ranges',
    );

    writeFileSync(
      value.subuid,
      'dockremap:231072:65536\nother:400000:65536\n',
    );
    const collision = runBoundary(value, {
      ...dockerEnvironment,
      TEST_MAPPED_COLLISION: '232071',
    }, true);
    expect(collision.status).not.toBe(0);
    expect(collision.stderr).toContain(
      'Host passwd identity 232071 collides with a mapped container identity',
    );

    const protectedRange = runBoundary(value, {
      ...dockerEnvironment,
      TEST_DOMINGUEZ_UID: '232000',
    }, true);
    expect(protectedRange.status).not.toBe(0);
    expect(protectedRange.stderr).toContain(
      'dominguez overlaps the Docker subordinate UID range',
    );
  });

  it('places the same live gate before installer mutation and immediately before Compose', () => {
    const installer = readFileSync(
      'scripts/quality-sonar-systemd-install.sh',
      'utf8',
    );
    const stack = readFileSync('scripts/quality-sonar-stack.sh', 'utf8');
    const installGate = installer.indexOf(
      'bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh"',
    );
    expect(installGate).toBeGreaterThan(0);
    expect(installer.slice(installGate)).toContain(
      '--verify-runtime-boundary-only',
    );
    expect(installer.slice(installGate)).not.toContain('--allow-docker-absent');
    expect(installer).toContain('--print-userns-map');
    expect(installer).toContain(
      'value?.postgres?.hostUid !== value.subuidBase + 999',
    );
    const beginDirectories = installer.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" begin-directories',
    );
    const createDirectory = installer.indexOf(
      'python3 "$INSTALL_RECOVERY_PROGRAM" create-directory',
    );
    const mappingReopen = installer.lastIndexOf(
      'bash "$SOURCE_ROOT/scripts/quality-sonar-preflight.sh" --print-userns-map',
      beginDirectories,
    );
    expect(mappingReopen).toBeGreaterThan(installGate);
    expect(mappingReopen).toBeLessThan(beginDirectories);
    expect(installGate).toBeLessThan(beginDirectories);
    expect(beginDirectories).toBeLessThan(createDirectory);

    const start = stack.slice(
      stack.indexOf('start_stack() {'),
      stack.lastIndexOf('case "$ACTION"'),
    );
    expect(start.indexOf('verify_prepulled_images')).toBeLessThan(
      start.indexOf('verify_live_runtime_boundary'),
    );
    expect(start.indexOf('verify_live_runtime_boundary')).toBeLessThan(
      start.indexOf('"${compose[@]}" up -d --pull never'),
    );
    expect(start.slice(
      start.indexOf('verify_live_runtime_boundary')
        + 'verify_live_runtime_boundary'.length,
      start.indexOf('"${compose[@]}" up -d --pull never'),
    )).not.toMatch(/\bverify_[A-Za-z0-9_]+\b/);
  });
});

describe('Sonar Compute Engine release-state parser', () => {
  function parse(value: unknown) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'nexus-sonar-ce-')));
    roots.push(root);
    const path = join(root, 'component.json');
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return spawnSync(
      'bash',
      [
        'scripts/quality-sonar-release-state.sh',
        '--project',
        'nexus-hub-backend',
        '--json',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NEXUS_RELEASE_TEST_MODE: '1',
          NEXUS_SONAR_RELEASE_STATE_COMPONENT_FILE: path,
        },
      },
    );
  }

  it.each([
    {
      value: {
        queue: [],
        current: {
          id: 'current-1',
          status: 'IN_PROGRESS',
          componentKey: 'nexus-hub-backend',
        },
      },
      count: '1',
    },
    {
      value: {
        queue: [],
        current: { id: 'current-2', status: 'SUCCESS' },
      },
      count: '0',
    },
    {
      value: {
        queue: [
          { id: 'queued-1', status: 'PENDING' },
          { id: 'queued-2', status: 'IN_PROGRESS' },
        ],
        current: { id: 'current-3', status: 'IN_PROGRESS' },
      },
      count: '3',
    },
  ])('counts exact pending and current activity as $count', ({
    value,
    count,
  }) => {
    const result = parse(value);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(count);
  });

  it.each([
    {
      name: 'duplicate identity',
      value: {
        queue: [{ id: 'same', status: 'PENDING' }],
        current: { id: 'same', status: 'IN_PROGRESS' },
      },
    },
    {
      name: 'unknown current status',
      value: {
        queue: [],
        current: { id: 'current', status: 'PAUSED' },
      },
    },
    {
      name: 'pending current task outside the queue',
      value: {
        queue: [],
        current: { id: 'current', status: 'PENDING' },
      },
    },
    {
      name: 'cross-project task',
      value: {
        queue: [{
          id: 'queued',
          status: 'PENDING',
          componentKey: 'another-project',
        }],
      },
    },
    {
      name: 'missing stable identity',
      value: {
        queue: [{ status: 'PENDING' }],
      },
    },
  ])('fails closed on $name', ({ value }) => {
    const result = parse(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Sonar CE project response is invalid');
  });
});
