#!/usr/bin/env node
/**
 * Capture PM2 6.0.14 state without invoking connect()/auto-spawn, compare it
 * with the exact signed release configuration, and emit a stripped
 * resurrection file containing only the launch semantics Nexus permits.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

process.umask(0o077);

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const SELF = fileURLToPath(import.meta.url);
const POLICY_ENVIRONMENT_NAMES = Object.freeze([
  'OLLAMA_ENABLED',
  'AI_CLASSIFY_PRIMARY',
  'LOCAL_LLM_CLASSIFY_SHADOW',
  'CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE',
  'LOCAL_LLM_EVALUATION_MODE',
  'AI_SCRIPT_GENERATION_REQUIRE_LOCAL',
  'AI_SCRIPT_GENERATION_FALLBACK',
  'AI_LOCAL_REASONING_FALLBACK',
  'CLOUD_REASONING_FALLBACK_ENABLED',
  'CLOUD_REASONING_REQUIRE_APPROVED_MODEL',
  'CLOUD_REASONING_ON_UNAPPROVED_MODEL',
  'CLOUD_REASONING_PRIVACY_MODE',
  'CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA',
  'CLOUD_REASONING_PROVIDER',
  'CLOUD_REASONING_MODEL',
  'APPROVED_REASONING_MODELS',
  'OLLAMA_MODEL',
  'OLLAMA_CLASSIFIER_MODEL',
  'CHAT_CORE_V2_LOCAL_CHAT_MODEL',
  'CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL',
  'CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL',
]);
const COMMON_CONFIG_KEYS = Object.freeze([
  'name', 'script', 'cwd', 'exec_mode', 'instances', 'autorestart', 'watch',
  'max_memory_restart', 'env', 'error_file', 'out_file', 'merge_logs',
  'restart_delay', 'kill_timeout',
]);
const BACKEND_CONFIG_KEYS = Object.freeze([
  ...COMMON_CONFIG_KEYS, 'node_args', 'exp_backoff_restart_delay',
  'max_restarts', 'min_uptime', 'listen_timeout',
]);
const CONTENT_CONFIG_KEYS = Object.freeze([...COMMON_CONFIG_KEYS, 'args', 'interpreter']);
const RAW_ENV_INTERNAL_KEYS = Object.freeze([
  'PM2_JSON_PROCESSING', 'PM2_USAGE', 'PM2_DAEMON_TITLE', 'PWD', 'unique_id',
]);
const FORBIDDEN_ENVIRONMENT = /^(?:NODE_OPTIONS|NODE_PATH|PYTHON(?:PATH|HOME|INSPECT|STARTUP|BREAKPOINT)|LD_PRELOAD|LD_LIBRARY_PATH)$/u;

const fail = (message) => {
  throw new Error(message);
};
const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) {
    fail(`${label} keys differ from the pinned release policy`);
  }
};
const parseArgs = (items) => {
  const result = {};
  for (let index = 0; index < items.length; index += 2) {
    const name = items[index];
    const value = items[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(`invalid capture argument: ${name ?? ''}`);
    }
    if (Object.hasOwn(result, name)) fail(`duplicate capture argument: ${name}`);
    result[name] = value;
  }
  return result;
};
const requireArg = (args, name) => {
  const value = args[name];
  if (!value) fail(`${name} is required`);
  return value;
};
const readBounded = (file, maximum = MAX_CAPTURE_BYTES) => {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) {
      fail(`unsafe or unbounded file: ${file}`);
    }
    const body = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < body.length) {
      const count = fs.readSync(descriptor, body, offset, body.length - offset, offset);
      if (count < 1) fail(`short read: ${file}`);
      offset += count;
    }
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      fail(`file changed while it was read: ${file}`);
    }
    return { body, stat: before };
  } finally {
    fs.closeSync(descriptor);
  }
};
const safeRootFile = (file, modes, label) => {
  const { body, stat } = readBounded(file, MAX_CONFIG_BYTES);
  if (stat.uid !== rootUid || stat.gid !== rootGid || !modes.includes(stat.mode & 0o7777)) {
    fail(`${label} is not root-owned and read-only`);
  }
  return body;
};
const safeReleaseFile = (file, workerGid, label) => {
  const { body, stat } = readBounded(file, MAX_CONFIG_BYTES);
  if (stat.uid !== rootUid || stat.gid !== workerGid || (stat.mode & 0o022) !== 0) {
    fail(`${label} is not root-owned and worker-read-only`);
  }
  return body;
};
const safeEnvironmentFile = (file, workerGid) => {
  const { body, stat } = readBounded(file, MAX_CONFIG_BYTES);
  if (stat.uid !== rootUid || stat.gid !== workerGid || (stat.mode & 0o7777) !== 0o440) {
    fail('protected release environment must be root:worker mode 0440');
  }
  return body;
};
const parseJson = (body, label) => {
  try {
    return JSON.parse(body);
  } catch {
    fail(`${label} is not valid JSON`);
  }
};
const same = (left, right) => canonical(left) === canonical(right);
const requireExact = (actual, expected, label) => {
  if (!same(actual, expected)) fail(`${label} differs from the signed release configuration`);
};

if (process.argv[2] === '__evaluate') {
  const configPath = process.argv[3];
  if (!configPath || !path.isAbsolute(configPath)) fail('absolute config path is required');
  const require = createRequire(import.meta.url);
  const result = require(configPath);
  const body = Buffer.from(JSON.stringify(result));
  if (body.length > MAX_CONFIG_BYTES) fail('evaluated PM2 configuration is too large');
  process.stdout.write(body);
  process.exit(0);
}

const args = parseArgs(process.argv.slice(2));
const pm2Root = path.resolve(requireArg(args, '--pm2-root'));
const pm2Home = path.resolve(requireArg(args, '--pm2-home'));
const installAttestation = path.resolve(requireArg(args, '--install-attestation'));
const output = path.resolve(requireArg(args, '--output'));
const metadataOutput = path.resolve(requireArg(args, '--metadata-output'));
const nodeBin = path.resolve(requireArg(args, '--node-bin'));
const setprivBin = path.resolve(requireArg(args, '--setpriv-bin'));
const envBin = path.resolve(requireArg(args, '--env-bin'));
const workerHome = path.resolve(requireArg(args, '--worker-home'));
const daemonTitle = requireArg(args, '--daemon-title');
const workerUid = Number(requireArg(args, '--worker-uid'));
const workerGid = Number(requireArg(args, '--worker-gid'));
const expectedDaemonPid = Number(requireArg(args, '--expected-daemon-pid'));
const expectedControlGroup = requireArg(args, '--expected-control-group');
const testMode = process.env.NEXUS_RELEASE_TEST_MODE === '1'
  && args['--allow-test-owner'] === '1';
const rootUid = testMode ? process.getuid() : 0;
const rootGid = testMode ? process.getgid() : 0;
if (!testMode && process.geteuid() !== 0) fail('PM2 authority capture requires root');
if (!Number.isSafeInteger(workerUid) || workerUid < 1
    || !Number.isSafeInteger(workerGid) || workerGid < 1) {
  fail('worker identity is invalid');
}
if (!Number.isSafeInteger(expectedDaemonPid) || expectedDaemonPid < 1
    || !/^\/system\.slice\/(?:pm2-dominguez|nexus-release-pm2-recovery-daemon)\.service$/u
      .test(expectedControlGroup)) {
  fail('root systemd PM2 daemon authority is invalid');
}
if (daemonTitle !== `NexusPM2:${path.dirname(path.dirname(pm2Root))}`) {
  fail('PM2 daemon title does not bind the exact closure');
}

const roles = [
  {
    role: 'production',
    base: path.resolve(requireArg(args, '--production-base')),
    runtime: path.resolve(requireArg(args, '--production-runtime')),
    sha: requireArg(args, '--production-sha'),
  },
  {
    role: 'staging',
    base: path.resolve(requireArg(args, '--staging-base')),
    runtime: path.resolve(requireArg(args, '--staging-runtime')),
    sha: requireArg(args, '--staging-sha'),
  },
];
for (const item of roles) {
  if (!/^[a-f0-9]{40}$/u.test(item.sha)) fail(`invalid ${item.role} runtime SHA`);
  if (path.dirname(item.runtime) !== path.join(item.base, 'releases')) {
    fail(`${item.role} runtime is not a direct release child`);
  }
}

const outputParent = fs.realpathSync.native(path.dirname(output));
if (outputParent !== path.dirname(output)
    || path.dirname(metadataOutput) !== outputParent
    || fs.existsSync(output) || fs.existsSync(metadataOutput)) {
  fail('capture outputs must be absent in one canonical staging directory');
}
const outputParentStat = fs.lstatSync(outputParent);
if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink()
    || outputParentStat.uid !== rootUid || (outputParentStat.mode & 0o077) !== 0) {
  fail('capture output parent is not private');
}

const attestationBody = safeRootFile(
  installAttestation,
  testMode ? [0o600] : [0o600],
  'PM2 install attestation',
);
const attestation = parseJson(attestationBody, 'PM2 install attestation');
const packagePath = path.join(pm2Root, 'package.json');
const packageBody = safeRootFile(packagePath, [0o644], 'PM2 package identity');
const packageIdentity = parseJson(packageBody, 'PM2 package identity');
if (attestation.schema !== 'nexus.pm2-root-install.v1'
    || attestation.version !== '6.0.14'
    || attestation.closureRoot !== path.dirname(path.dirname(pm2Root))
    || attestation.entrypoint !== path.join(pm2Root, 'bin', 'pm2')
    || attestation.node?.path !== nodeBin
    || attestation.node?.version !== 'v22.23.1'
    || packageIdentity.name !== 'pm2' || packageIdentity.version !== '6.0.14'
    || !/^[a-f0-9]{64}$/u.test(attestation.closureDigest ?? '')
    || !/^[a-f0-9]{64}$/u.test(attestation.node?.sha256 ?? '')) {
  fail('PM2 root installation identity is invalid');
}
if (fs.realpathSync.native(nodeBin) !== nodeBin
    || fs.lstatSync(nodeBin).uid !== rootUid
    || (fs.lstatSync(nodeBin).mode & 0o022) !== 0
    || sha256(readBounded(nodeBin, 128 * 1024 * 1024).body) !== attestation.node.sha256) {
  fail('pinned Node identity is unsafe');
}

const evaluateRole = (item) => {
  const configPath = path.join(item.runtime, 'ecosystem.release.config.js');
  const environmentPath = path.join(item.base, '.env');
  const configBody = safeReleaseFile(configPath, workerGid, `${item.role} PM2 config`);
  const environmentBody = safeEnvironmentFile(environmentPath, workerGid);
  const childEnvironment = [
    `HOME=${workerHome}`,
    `PM2_HOME=${pm2Home}`,
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `NEXUS_RELEASE_DIR=${item.runtime}`,
    `NEXUS_RELEASE_BASE_DIR=${item.base}`,
    `NEXUS_RELEASE_ROLE=${item.role}`,
    `NEXUS_RELEASE_SHA=${item.sha}`,
    `SENTRY_RELEASE=${item.sha}`,
  ];
  const command = testMode
    ? [envBin, '-i', ...childEnvironment, nodeBin, SELF, '__evaluate', configPath]
    : [
      setprivBin, `--reuid=${workerUid}`, `--regid=${workerGid}`, '--init-groups',
      '--no-new-privs', envBin, '-i', ...childEnvironment,
      nodeBin, SELF, '__evaluate', configPath,
    ];
  const evaluation = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    maxBuffer: MAX_CONFIG_BYTES,
    timeout: 10_000,
    windowsHide: true,
  });
  if (evaluation.status !== 0 || evaluation.signal || evaluation.error
      || Buffer.byteLength(evaluation.stdout ?? '') > MAX_CONFIG_BYTES) {
    fail(`${item.role} PM2 config evaluation failed`);
  }
  const value = parseJson(Buffer.from(evaluation.stdout), `${item.role} PM2 config evaluation`);
  if (!value || typeof value !== 'object' || !Array.isArray(value.apps)
      || value.apps.length !== 2 || Object.keys(value).some((key) => key !== 'apps')) {
    fail(`${item.role} PM2 config must contain exactly two apps`);
  }
  return {
    ...item,
    configPath,
    environmentPath,
    configSha256: sha256(configBody),
    environmentSha256: sha256(environmentBody),
    apps: value.apps,
  };
};
const evaluatedRoles = roles.map(evaluateRole);

const stringEnvironment = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} env is invalid`);
  const result = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)
        || typeof entry !== 'string' || entry.length > 2048
        || /[\u0000]/u.test(entry) || FORBIDDEN_ENVIRONMENT.test(name)) {
      fail(`${label} contains a forbidden environment entry`);
    }
    result[name] = entry;
  }
  return result;
};
const mb = (value) => {
  const match = /^([1-9][0-9]*)([GMK])?$/u.exec(String(value));
  if (!match) fail('invalid max_memory_restart');
  const multiplier = match[2] === 'G' ? 1024 ** 3
    : match[2] === 'M' ? 1024 ** 2 : match[2] === 'K' ? 1024 : 1;
  return Number(match[1]) * multiplier;
};
const buildCanonicalApps = (item) => {
  const staging = item.role === 'staging';
  const backendName = staging ? 'nexus-hub-staging' : 'nexus-hub';
  const contentName = staging ? 'content-engine-staging' : 'content-engine';
  const backend = item.apps.find((app) => app?.name === backendName);
  const content = item.apps.find((app) => app?.name === contentName);
  if (!backend || !content || new Set(item.apps.map((app) => app?.name)).size !== 2) {
    fail(`${item.role} PM2 app identities are not exact`);
  }
  exactKeys(backend, BACKEND_CONFIG_KEYS, `${item.role} backend config`);
  exactKeys(content, CONTENT_CONFIG_KEYS, `${item.role} content config`);
  const backendPort = staging ? '8201' : '8200';
  const contentPort = staging ? '8101' : '8100';
  const expectedBackendEnvKeys = [
    'NODE_ENV', 'STAGING', 'PORTAL_PORT', 'CONTENT_ENGINE_PORT',
    'NEXUS_BACKEND_BASE_URL', 'NEXUS_BACKEND_PORT', 'DATABASE_PATH',
    'NEXUS_RELEASE_SHA', 'GIT_COMMIT', ...POLICY_ENVIRONMENT_NAMES,
  ];
  const expectedContentEnvKeys = [
    'ENV', 'PYTHONDONTWRITEBYTECODE', 'CONTENT_ENGINE_PORT',
    'NEXUS_BACKEND_BASE_URL', 'NEXUS_BACKEND_PORT',
    'NEXUS_RELEASE_SHA', 'GIT_COMMIT',
  ];
  const backendConfigEnv = stringEnvironment(backend.env, `${item.role} backend`);
  const contentConfigEnv = stringEnvironment(content.env, `${item.role} content`);
  exactKeys(backendConfigEnv, expectedBackendEnvKeys, `${item.role} backend env`);
  exactKeys(contentConfigEnv, expectedContentEnvKeys, `${item.role} content env`);
  const releaseEnvironment = {
    HOME: workerHome,
    PM2_HOME: pm2Home,
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    NEXUS_RELEASE_DIR: item.runtime,
    NEXUS_RELEASE_BASE_DIR: item.base,
    NEXUS_RELEASE_ROLE: item.role,
    NEXUS_RELEASE_SHA: item.sha,
    SENTRY_RELEASE: item.sha,
  };
  const backendExpected = {
    name: backendName,
    script: 'dist/index.js',
    cwd: item.runtime,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    node_args: '--max-old-space-size=768',
    error_file: path.join(item.base, 'logs/error.log'),
    out_file: path.join(item.base, 'logs/out.log'),
    merge_logs: true,
    exp_backoff_restart_delay: 5000,
    max_restarts: 15,
    min_uptime: 60000,
    restart_delay: 10000,
    kill_timeout: 10000,
    listen_timeout: 60000,
  };
  for (const [name, value] of Object.entries(backendExpected)) requireExact(backend[name], value, `${backendName}.${name}`);
  requireExact(backendConfigEnv.NODE_ENV, item.role, `${backendName}.env.NODE_ENV`);
  requireExact(backendConfigEnv.STAGING, staging ? 'true' : 'false', `${backendName}.env.STAGING`);
  requireExact(backendConfigEnv.PORTAL_PORT, backendPort, `${backendName}.env.PORTAL_PORT`);
  requireExact(backendConfigEnv.CONTENT_ENGINE_PORT, contentPort, `${backendName}.env.CONTENT_ENGINE_PORT`);
  requireExact(backendConfigEnv.NEXUS_BACKEND_BASE_URL, `http://127.0.0.1:${backendPort}`, `${backendName}.env.NEXUS_BACKEND_BASE_URL`);
  requireExact(backendConfigEnv.NEXUS_BACKEND_PORT, backendPort, `${backendName}.env.NEXUS_BACKEND_PORT`);
  requireExact(backendConfigEnv.DATABASE_PATH, path.join(item.base, 'data/bot.db'), `${backendName}.env.DATABASE_PATH`);
  requireExact(backendConfigEnv.NEXUS_RELEASE_SHA, item.sha, `${backendName}.env.NEXUS_RELEASE_SHA`);
  requireExact(backendConfigEnv.GIT_COMMIT, item.sha, `${backendName}.env.GIT_COMMIT`);
  const contentExpected = {
    name: contentName,
    script: path.join(item.runtime, 'content-engine/.venv/bin/python3.12'),
    args: 'main.py',
    cwd: path.join(item.runtime, 'content-engine'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: staging ? '300M' : '500M',
    error_file: path.join(item.base, 'logs/content-engine-error.log'),
    out_file: path.join(item.base, 'logs/content-engine-out.log'),
    merge_logs: true,
    restart_delay: 5000,
    kill_timeout: 5000,
  };
  for (const [name, value] of Object.entries(contentExpected)) requireExact(content[name], value, `${contentName}.${name}`);
  requireExact(contentConfigEnv, {
    ENV: item.role,
    PYTHONDONTWRITEBYTECODE: '1',
    CONTENT_ENGINE_PORT: contentPort,
    NEXUS_BACKEND_BASE_URL: `http://127.0.0.1:${backendPort}`,
    NEXUS_BACKEND_PORT: backendPort,
    NEXUS_RELEASE_SHA: item.sha,
    GIT_COMMIT: item.sha,
  }, `${contentName}.env`);
  const common = (name, cwd, executable, interpreter, env, memory, logs) => ({
    name,
    namespace: 'default',
    pm_exec_path: executable,
    pm_cwd: cwd,
    exec_interpreter: interpreter,
    exec_mode: 'fork_mode',
    autorestart: true,
    autostart: true,
    watch: false,
    max_memory_restart: memory,
    env: { ...releaseEnvironment, ...env },
    pm_out_log_path: logs.out,
    pm_err_log_path: logs.error,
    pm_pid_path: path.join(pm2Home, 'pids', `${name}.pid`),
    merge_logs: true,
    status: 'online',
    vizion: false,
    windowsHide: true,
  });
  const backendCanonical = {
    ...common(
      backendName,
      item.runtime,
      path.join(item.runtime, 'dist/index.js'),
      'node',
      backendConfigEnv,
      mb('1G'),
      { out: backendExpected.out_file, error: backendExpected.error_file },
    ),
    node_args: ['--max-old-space-size=768'],
    exp_backoff_restart_delay: 5000,
    max_restarts: 15,
    min_uptime: 60000,
    restart_delay: 10000,
    kill_timeout: 10000,
    listen_timeout: 60000,
  };
  const contentCanonical = {
    ...common(
      contentName,
      contentExpected.cwd,
      contentExpected.script,
      'none',
      contentConfigEnv,
      mb(contentExpected.max_memory_restart),
      { out: contentExpected.out_file, error: contentExpected.error_file },
    ),
    node_args: [],
    args: ['main.py'],
    restart_delay: 5000,
    kill_timeout: 5000,
  };
  return [backendCanonical, contentCanonical];
};
const canonicalApps = evaluatedRoles.flatMap(buildCanonicalApps);

const pidFile = path.join(pm2Home, 'pm2.pid');
const daemonSnapshot = () => {
  const { body, stat } = readBounded(pidFile, 64);
  if (stat.uid !== workerUid || stat.gid !== workerGid || stat.nlink !== 1) {
    fail('PM2 daemon PID file identity is unsafe');
  }
  const pid = Number(body.toString('utf8').trim());
  if (!Number.isSafeInteger(pid) || pid !== expectedDaemonPid) {
    fail('PM2 daemon PID differs from root systemd authority');
  }
  if (process.platform !== 'linux') {
    if (!testMode) fail('PM2 authority capture requires Linux procfs');
    return { pid, startTime: 'test', title: 'test' };
  }
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const uidMatch = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu.exec(status);
  if (!uidMatch || uidMatch.slice(1).some((entry) => Number(entry) !== workerUid)) {
    fail('PM2 daemon does not run as the release worker');
  }
  if (fs.realpathSync.native(`/proc/${pid}/exe`) !== nodeBin) {
    fail('PM2 daemon does not use the pinned Node runtime');
  }
  const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  if (cmdline[0] !== daemonTitle) fail('PM2 daemon title differs from the pinned closure');
  const controlGroups = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n');
  if (!controlGroups.some((entry) => entry.endsWith(expectedControlGroup))) {
    fail('PM2 daemon is outside the root systemd authority');
  }
  const daemonEnvironment = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
    .split('\0').filter(Boolean).map((entry) => entry.slice(0, entry.indexOf('=')));
  if (daemonEnvironment.some((name) => FORBIDDEN_ENVIRONMENT.test(name))) {
    fail('PM2 daemon inherited a forbidden execution environment');
  }
  const statFields = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim().split(/\s+/u);
  if (!statFields[21]) fail('PM2 daemon start time is unavailable');
  return {
    pid,
    startTime: statFields[21],
    title: daemonTitle,
    controlGroup: expectedControlGroup,
  };
};
const beforeDaemon = daemonSnapshot();
for (const socketName of ['rpc.sock', 'pub.sock']) {
  const socket = fs.lstatSync(path.join(pm2Home, socketName));
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== workerUid) {
    fail(`PM2 ${socketName} identity is unsafe`);
  }
}

const stagingRoot = fs.mkdtempSync(path.join(outputParent, '.pm2-raw-'));
fs.chmodSync(stagingRoot, 0o700);
const rawDump = path.join(stagingRoot, 'dump.pm2');
const rawBackup = path.join(stagingRoot, 'dump.pm2.bak');
let pm2;
try {
  process.env.HOME = workerHome;
  process.env.PM2_HOME = pm2Home;
  process.env.PM2_PROGRAMMATIC = 'true';
  process.env.PM2_SILENT = 'true';
  process.env.PM2_DUMP_FILE_PATH = rawDump;
  process.env.PM2_DUMP_BACKUP_FILE_PATH = rawBackup;
  delete process.env.NODE_OPTIONS;
  delete process.env.NODE_PATH;
  delete process.env.PM2_NODE_OPTIONS;
  const require = createRequire(path.join(pm2Root, 'package.json'));
  const constants = require(path.join(pm2Root, 'constants.js'));
  constants.DUMP_FILE_PATH = rawDump;
  constants.DUMP_BACKUP_FILE_PATH = rawBackup;
  pm2 = require(pm2Root);
  if (pm2?._conf?.DAEMON_RPC_PORT !== path.join(pm2Home, 'rpc.sock')
      || pm2?._conf?.DAEMON_PUB_PORT !== path.join(pm2Home, 'pub.sock')
      || pm2?.Client?.rpc_socket_file !== path.join(pm2Home, 'rpc.sock')
      || pm2?.Client?.pub_socket_file !== path.join(pm2Home, 'pub.sock')) {
    fail('PM2 client socket identity differs from the worker daemon');
  }
  const alive = await new Promise((resolve) => pm2.Client.pingDaemon(resolve));
  if (alive !== true) fail('PM2 daemon is unavailable; auto-spawn is forbidden');
  await new Promise((resolve, reject) => {
    pm2.Client.launchRPC((error) => error ? reject(error) : resolve());
  });
  await new Promise((resolve, reject) => {
    pm2.dump((error) => error ? reject(error) : resolve());
  });
  await new Promise((resolve) => pm2.Client.disconnectRPC(() => resolve()));
  pm2 = undefined;
  const afterDaemon = daemonSnapshot();
  requireExact(afterDaemon, beforeDaemon, 'PM2 daemon identity');
  const { body: rawBody, stat: rawStat } = readBounded(rawDump);
  if (rawStat.uid !== rootUid || rawStat.gid !== rootGid
      || (rawStat.mode & 0o077) !== 0) {
    fail('captured PM2 dump is not root-private');
  }
  const rawApps = parseJson(rawBody, 'captured PM2 dump');
  if (!Array.isArray(rawApps) || rawApps.length !== 4) fail('captured PM2 dump is not exact');
  const schema = parseJson(
    safeRootFile(path.join(pm2Root, 'lib/API/schema.json'), [0o644], 'PM2 schema'),
    'PM2 schema',
  );
  const schemaKeys = new Set(Object.entries(schema).flatMap(([name, definition]) => [
    name,
    ...([].concat(definition?.alias ?? []).filter((entry) => typeof entry === 'string')),
  ]));
  const intendedSchemaKeys = new Set([
    'name', 'namespace', 'args', 'exec_interpreter', 'node_args',
    'max_memory_restart', 'restart_delay', 'exp_backoff_restart_delay',
    'wait_ready', 'instances', 'kill_timeout', 'listen_timeout', 'merge_logs',
    'vizion', 'autostart', 'autorestart', 'watch', 'max_restarts', 'min_uptime',
  ]);
  for (const expected of canonicalApps) {
    const matches = rawApps.filter((entry) => entry?.name === expected.name);
    if (matches.length !== 1) fail(`captured PM2 app identity is not exact: ${expected.name}`);
    const observed = matches[0];
    for (const key of Object.keys(observed)) {
      if (schemaKeys.has(key) && !intendedSchemaKeys.has(key)) {
        fail(`captured PM2 app has an unapproved execution field: ${expected.name}.${key}`);
      }
      if (FORBIDDEN_ENVIRONMENT.test(key)) {
        fail(`captured PM2 app has a forbidden flattened environment: ${expected.name}.${key}`);
      }
    }
    for (const [key, value] of Object.entries({
      name: expected.name,
      namespace: expected.namespace,
      pm_exec_path: expected.pm_exec_path,
      pm_cwd: expected.pm_cwd,
      exec_interpreter: expected.exec_interpreter,
      exec_mode: expected.exec_mode,
      node_args: expected.node_args,
      args: expected.args,
      max_memory_restart: expected.max_memory_restart,
      restart_delay: expected.restart_delay,
      exp_backoff_restart_delay: expected.exp_backoff_restart_delay,
      kill_timeout: expected.kill_timeout,
      listen_timeout: expected.listen_timeout,
      merge_logs: expected.merge_logs,
      autorestart: expected.autorestart,
      watch: expected.watch,
      max_restarts: expected.max_restarts,
      min_uptime: expected.min_uptime,
      pm_out_log_path: expected.pm_out_log_path,
      pm_err_log_path: expected.pm_err_log_path,
    })) {
      if (value === undefined) {
        if (observed[key] !== undefined) fail(`captured PM2 app has unexpected ${expected.name}.${key}`);
      } else {
        requireExact(observed[key], value, `${expected.name}.${key}`);
      }
    }
    if (observed.instances !== undefined) fail(`captured PM2 dump retained instances: ${expected.name}`);
    const observedEnvironment = observed.env;
    if (!observedEnvironment || typeof observedEnvironment !== 'object'
        || Array.isArray(observedEnvironment)) {
      fail(`captured PM2 app environment is invalid: ${expected.name}`);
    }
    const permittedObservedEnvironment = new Set([
      ...Object.keys(expected.env),
      ...RAW_ENV_INTERNAL_KEYS,
      expected.name,
    ]);
    for (const [name, value] of Object.entries(observedEnvironment)) {
      if (FORBIDDEN_ENVIRONMENT.test(name) || !permittedObservedEnvironment.has(name)) {
        fail(`captured PM2 environment is not exact: ${expected.name}.${name}`);
      }
      if (Object.hasOwn(expected.env, name)) {
        requireExact(value, expected.env[name], `${expected.name}.env.${name}`);
      }
    }
    for (const [name, value] of Object.entries(expected.env)) {
      requireExact(observedEnvironment[name], value, `${expected.name}.env.${name}`);
      requireExact(observed[name], value, `${expected.name}.${name}`);
    }
  }
  const canonicalBody = Buffer.from(`${JSON.stringify(canonicalApps, null, 2)}\n`);
  if (canonicalBody.length > MAX_CAPTURE_BYTES) fail('canonical PM2 dump exceeds its bound');
  const outputFd = fs.openSync(
    output,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(outputFd, canonicalBody);
    fs.fchmodSync(outputFd, 0o600);
    if (!testMode) fs.fchownSync(outputFd, 0, 0);
    fs.fsyncSync(outputFd);
  } finally {
    fs.closeSync(outputFd);
  }
  const metadata = {
    schema: 'nexus.pm2-authority-capture.v1',
    daemon: beforeDaemon,
    rawDumpSha256: sha256(rawBody),
    canonicalDumpSha256: sha256(canonicalBody),
    pm2: {
      version: attestation.version,
      closureRoot: attestation.closureRoot,
      closureDigest: attestation.closureDigest,
      nodePath: attestation.node.path,
      nodeSha256: attestation.node.sha256,
    },
    roles: Object.fromEntries(evaluatedRoles.map((item) => [
      item.role,
      {
        base: item.base,
        runtime: item.runtime,
        runtimeSha: item.sha,
        configPath: item.configPath,
        configSha256: item.configSha256,
        environmentPath: item.environmentPath,
        environmentSha256: item.environmentSha256,
      },
    ])),
    capturedAt: new Date().toISOString(),
  };
  const metadataFd = fs.openSync(
    metadataOutput,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fs.writeFileSync(metadataFd, `${JSON.stringify(metadata, null, 2)}\n`);
    fs.fchmodSync(metadataFd, 0o600);
    if (!testMode) fs.fchownSync(metadataFd, 0, 0);
    fs.fsyncSync(metadataFd);
  } finally {
    fs.closeSync(metadataFd);
  }
  const directoryFd = fs.openSync(outputParent, 'r');
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: metadata.schema,
    canonicalDumpSha256: metadata.canonicalDumpSha256,
    daemonPid: beforeDaemon.pid,
  })}\n`);
} finally {
  try {
    if (pm2?.Client?.client_sock) {
      await new Promise((resolve) => pm2.Client.disconnectRPC(() => resolve()));
    }
  } catch {
    // The capture itself will fail; this best-effort close does not alter PM2.
  }
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}
