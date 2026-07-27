#!/usr/bin/env node
// Build the offline PM2 runtime closure from the dedicated exact npm lock.
// This trusted builder is run before the maintenance window; production only
// receives the resulting owner-approved archive and never runs npm/network I/O.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  if (index === -1) {
    if (fallback) return fallback;
    throw new Error(`${name} is required`);
  }
  if (!args[index + 1]) throw new Error(`${name} is required`);
  return args[index + 1];
};
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyRoot = path.join(scriptRoot, 'ops', 'pm2');
const output = path.resolve(valueOf('--output'));
const npmBin = path.resolve(valueOf('--npm-bin', path.join(path.dirname(process.execPath), 'npm')));
const sha256 = (body) => crypto.createHash('sha256').update(body).digest('hex');
const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};

if (process.version !== 'v22.23.1') throw new Error('PM2 closure builder requires Node 22.23.1');
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('PM2 closure builder requires the Ubuntu x86-64 release platform');
}
if (!fs.existsSync(npmBin)) throw new Error('PM2 closure builder npm executable is unavailable');
if (fs.existsSync(output)) throw new Error('PM2 closure output already exists');
const outputParent = path.dirname(output);
const outputParentStat = fs.lstatSync(outputParent);
if (!outputParentStat.isDirectory() || outputParentStat.isSymbolicLink()
    || fs.realpathSync.native(outputParent) !== outputParent
    || outputParentStat.uid !== process.getuid()
    || (outputParentStat.mode & 0o077) !== 0) {
  throw new Error('PM2 closure output parent must be canonical and private');
}
const npmVersion = execFileSync(npmBin, ['--version'], { encoding: 'utf8' }).trim();
if (npmVersion !== '10.9.8') throw new Error('PM2 closure builder requires npm 10.9.8');
const packageBody = fs.readFileSync(path.join(policyRoot, 'package.json'));
const lockBody = fs.readFileSync(path.join(policyRoot, 'package-lock.json'));
const packageJson = JSON.parse(packageBody);
const lock = JSON.parse(lockBody);
if (lock.lockfileVersion !== 3
    || lock.packages?.['node_modules/pm2']?.version !== packageJson.dependencies?.pm2
    || packageJson.dependencies?.pm2 !== '6.0.14') {
  throw new Error('PM2 closure policy lock identity is invalid');
}
const lockPackages = [];
for (const [packagePath, identity] of Object.entries(lock.packages ?? {})) {
  if (!packagePath) continue;
  if (identity.resolved?.startsWith('https://')
      && (!identity.integrity || !identity.version)) {
    throw new Error(`PM2 closure lock lacks registry integrity: ${packagePath}`);
  }
  lockPackages.push({
    path: packagePath,
    version: identity.version ?? null,
    resolved: identity.resolved ?? null,
    integrity: identity.integrity ?? null,
  });
}
lockPackages.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-pm2-closure-'));
const installRoot = path.join(temporary, 'install');
const closureRoot = path.join(temporary, 'pm2-closure');
try {
  fs.mkdirSync(installRoot, { mode: 0o700 });
  fs.copyFileSync(path.join(policyRoot, 'package.json'), path.join(installRoot, 'package.json'));
  fs.copyFileSync(path.join(policyRoot, 'package-lock.json'), path.join(installRoot, 'package-lock.json'));
  execFileSync(npmBin, [
    'ci', '--ignore-scripts', '--no-audit', '--no-fund',
  ], {
    cwd: installRoot,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });
  const installedPm2 = JSON.parse(fs.readFileSync(
    path.join(installRoot, 'node_modules', 'pm2', 'package.json'),
    'utf8',
  ));
  if (installedPm2.name !== 'pm2' || installedPm2.version !== packageJson.dependencies.pm2) {
    throw new Error('installed PM2 closure does not match the exact lock');
  }

  const copyTree = (source, destination, filter = () => true) => {
    const sourceStat = fs.lstatSync(source);
    if (sourceStat.isSymbolicLink()) throw new Error(`PM2 closure contains a symlink: ${source}`);
    if (sourceStat.isDirectory()) {
      fs.mkdirSync(destination, { recursive: true, mode: 0o755 });
      for (const name of fs.readdirSync(source).sort()) {
        if (filter(source, name)) copyTree(path.join(source, name), path.join(destination, name), filter);
      }
    } else if (sourceStat.isFile()) {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, sourceStat.mode & 0o111 ? 0o755 : 0o644);
    } else {
      throw new Error(`PM2 closure contains a special entry: ${source}`);
    }
  };
  fs.mkdirSync(closureRoot, { mode: 0o755 });
  fs.copyFileSync(path.join(installRoot, 'package.json'), path.join(closureRoot, 'package.json'));
  fs.copyFileSync(path.join(installRoot, 'package-lock.json'), path.join(closureRoot, 'package-lock.json'));
  fs.chmodSync(path.join(closureRoot, 'package.json'), 0o644);
  fs.chmodSync(path.join(closureRoot, 'package-lock.json'), 0o644);
  const dependenciesRoot = path.join(closureRoot, 'node_modules');
  fs.mkdirSync(dependenciesRoot, { mode: 0o755 });
  for (const name of fs.readdirSync(path.join(installRoot, 'node_modules')).sort()) {
    if (name === '.bin') continue;
    copyTree(
      path.join(installRoot, 'node_modules', name),
      path.join(dependenciesRoot, name),
      (parent, child) => !(path.basename(parent) === 'node_modules' && child === '.bin'),
    );
  }

  const files = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`PM2 closure contains a symlink: ${absolute}`);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isFile()) {
        const body = fs.readFileSync(absolute);
        files.push({
          path: path.relative(closureRoot, absolute).split(path.sep).join('/'),
          size: body.length,
          mode: stat.mode & 0o7777,
          sha256: sha256(body),
        });
      } else throw new Error(`PM2 closure contains a special entry: ${absolute}`);
    }
  };
  walk(closureRoot);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const payload = { schema: 'nexus.pm2-root-closure-payload.v1', files };
  const installedPackages = [];
  for (const identity of lockPackages) {
    const packageRoot = path.join(closureRoot, identity.path);
    if (!fs.existsSync(packageRoot)) {
      if (lock.packages[identity.path]?.optional === true) continue;
      throw new Error(`PM2 npm ci omitted a required locked package: ${identity.path}`);
    }
    const packageIdentity = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    if (packageIdentity.version !== identity.version) {
      throw new Error(`PM2 installed package version differs from lock: ${identity.path}`);
    }
    installedPackages.push({ path: identity.path, version: identity.version });
  }
  const manifest = {
    schema: 'nexus.pm2-root-closure-manifest.v1',
    pm2Version: packageJson.dependencies.pm2,
    nodeVersion: process.version,
    npmVersion,
    packageLockSha256: sha256(lockBody),
    packageLockPackages: lockPackages,
    installedPackages,
    payloadDigest: sha256(canonical(payload)),
    fileCount: files.length,
    files,
  };
  fs.writeFileSync(
    path.join(closureRoot, 'closure-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o644, flag: 'wx' },
  );

  const python = `
import gzip, pathlib, sys, tarfile
source=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2])
with output.open("xb") as raw:
  with gzip.GzipFile(filename="",mode="wb",fileobj=raw,mtime=0) as compressed:
    with tarfile.open(fileobj=compressed,mode="w",format=tarfile.PAX_FORMAT) as archive:
      for item in [source,*sorted(source.rglob("*"))]:
        relative=pathlib.PurePosixPath("pm2-closure") if item==source else pathlib.PurePosixPath("pm2-closure",item.relative_to(source).as_posix())
        info=archive.gettarinfo(str(item),arcname=str(relative))
        info.uid=0;info.gid=0;info.uname="root";info.gname="root";info.mtime=0
        if item.is_dir(): info.mode=0o755;archive.addfile(info)
        else:
          info.mode=0o755 if item.stat().st_mode&0o111 else 0o644
          with item.open("rb") as body: archive.addfile(info,body)
`;
  execFileSync('python3', ['-c', python, closureRoot, output], { stdio: 'inherit' });
  const archiveBody = fs.readFileSync(output);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: 'nexus.pm2-root-closure-build.v1',
    output,
    pm2Version: packageJson.dependencies.pm2,
    npmVersion,
    packageLockSha256: sha256(lockBody),
    archiveSha256: sha256(archiveBody),
    fileCount: files.length + 1,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
