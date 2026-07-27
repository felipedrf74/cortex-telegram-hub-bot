#!/usr/bin/env node
// Compute a relocatable, network-independent runtime identity for disaster
// recovery. This is intentionally separate from installedRuntimeDigest: the
// latter proves byte-for-byte staging-to-production parity, while this digest
// proves that the signed artifact can recreate the same governed dependencies
// at a different absolute path.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args.shift() ?? '';
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
};
const root = path.resolve(valueOf('--root', process.cwd()));
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_DEPENDENCY_FILES = 250_000;
const MAX_WHEELS = 10_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_TOTAL_DEPENDENCY_BYTES = 4 * 1024 * 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function assertUnprivilegedExecution() {
  const testOverride = process.env.NODE_ENV === 'test' && args.includes('--allow-test-root');
  if (typeof process.getuid === 'function' && process.getuid() === 0 && !testOverride) {
    fail('recovery runtime identity must run as an unprivileged user');
  }
}

function canonicalJson(input) {
  if (input === null || typeof input !== 'object') return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(input).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(input[key])}`
  )).join(',')}}`;
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeDependencyPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function safeSymlinkTarget(relative, target) {
  if (typeof target !== 'string'
      || target.length === 0
      || target.length > 4096
      || target.includes('\\')
      || /[\u0000-\u001f\u007f]/u.test(target)
      || path.posix.isAbsolute(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
  return resolved !== '..' && !resolved.startsWith('../') && safeDependencyPath(resolved);
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
}

function canonicalDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
    fail(`${label} must be a canonical non-symlink directory`);
  }
}

function regularFile(relative, label = relative, maxBytes = MAX_FILE_BYTES) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    fail(`${label} must be a bounded regular file`);
  }
  return absolute;
}

function fileIdentity(relative) {
  const body = fs.readFileSync(regularFile(relative));
  return { path: relative, size: body.length, sha256: sha256(body) };
}

function validateLock() {
  const packageLockSha256 = sha256(fs.readFileSync(regularFile('package-lock.json')));
  const pythonRequirementsSha256 = sha256(
    fs.readFileSync(regularFile('content-engine/requirements.txt')),
  );
  const lock = JSON.parse(fs.readFileSync(
    regularFile('dist/runtime-dependencies/lock.json'),
    'utf8',
  ));
  exactKeys(lock, ['schema', 'target', 'inputs', 'nodeArchive', 'pythonWheels'], 'runtime dependency lock');
  exactKeys(lock.target, ['os', 'osVersion', 'architecture', 'node', 'python'], 'runtime dependency target');
  exactKeys(lock.inputs, ['packageLockSha256', 'pythonRequirementsSha256'], 'runtime dependency inputs');
  if (lock.schema !== 'nexus.release-runtime-dependencies.v1'
      || process.platform !== 'linux'
      || process.arch !== 'x64'
      || lock.target.os !== 'ubuntu'
      || lock.target.osVersion !== '24.04'
      || lock.target.architecture !== 'x86_64'
      || lock.target.node !== 'v22.23.1'
      || process.version !== lock.target.node
      || !/^Python 3\.12\.\d+$/u.test(lock.target.python ?? '')
      || lock.inputs.packageLockSha256 !== packageLockSha256
      || lock.inputs.pythonRequirementsSha256 !== pythonRequirementsSha256
      || !Array.isArray(lock.pythonWheels)
      || lock.pythonWheels.length === 0
      || lock.pythonWheels.length > MAX_WHEELS) {
    fail('runtime dependency lock or platform identity is invalid');
  }
  const identities = [lock.nodeArchive, ...lock.pythonWheels];
  const seen = new Set();
  let previousWheel = null;
  for (const identity of identities) {
    exactKeys(identity, ['path', 'size', 'sha256'], 'runtime dependency identity');
    const isNode = identity === lock.nodeArchive;
    if (!Number.isSafeInteger(identity.size) || identity.size < 0 || identity.size > MAX_FILE_BYTES
        || !DIGEST.test(identity.sha256 ?? '')
        || seen.has(identity.path)
        || (isNode && identity.path !== 'dist/runtime-dependencies/node_modules.tar.gz')
        || (!isNode && !/^dist\/runtime-dependencies\/python-wheelhouse\/[A-Za-z0-9_.+-]+\.whl$/u.test(identity.path))
        || (!isNode && previousWheel !== null && previousWheel >= identity.path)
        || canonicalJson(fileIdentity(identity.path)) !== canonicalJson(identity)) {
      fail(`runtime dependency payload identity mismatch: ${String(identity.path)}`);
    }
    seen.add(identity.path);
    if (!isNode) previousWheel = identity.path;
  }
  const evidence = JSON.parse(fs.readFileSync(
    regularFile(
      '.network-independent-install.json',
      'network-independent install evidence',
      MAX_JSON_BYTES,
    ),
    'utf8',
  ));
  if (evidence.schema !== 'nexus.network-independent-install.v1'
      || evidence.status !== 'passed'
      || evidence.dependencyLockDigest !== sha256(canonicalJson(lock))
      || evidence.packageLockSha256 !== packageLockSha256
      || evidence.pythonRequirementsSha256 !== pythonRequirementsSha256
      || !Number.isFinite(Date.parse(evidence.installedAt ?? ''))) {
    fail('network-independent install evidence is not bound to the locked payload');
  }
  return { lock, packageLockSha256, pythonRequirementsSha256 };
}

function treeEntries(directory) {
  canonicalDirectory(directory, 'dependency tree');
  const entries = [];
  let totalBytes = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join('/');
      if (!safeDependencyPath(relative)) {
        fail(`dependency tree contains an unsafe path: ${relative}`);
      }
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute);
      else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        if (!safeSymlinkTarget(relative, target)) {
          fail(`dependency tree contains an unsafe symlink: ${relative}`);
        }
        entries.push({ path: relative, type: 'symlink', target });
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) fail(`dependency file exceeds the size limit: ${relative}`);
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_DEPENDENCY_BYTES) {
          fail('dependency tree exceeds the aggregate byte limit');
        }
        const body = fs.readFileSync(absolute);
        entries.push({
          path: relative,
          type: 'file',
          size: body.length,
          executable: Boolean(stat.mode & 0o111),
          sha256: sha256(body),
        });
      } else fail(`unsupported dependency tree entry: ${relative}`);
      if (entries.length > MAX_DEPENDENCY_FILES) {
        fail('dependency tree contains too many entries');
      }
    }
  };
  walk(directory);
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return entries;
}

function verifyNodeArchive(lock) {
  const installed = treeEntries(path.join(root, 'node_modules'));
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-recovery-node-')),
  );
  fs.chmodSync(temporary, 0o700);
  try {
    const python = path.join(root, 'content-engine/.venv/bin/python3.12');
    const program = String.raw`
import pathlib, posixpath, sys, tarfile
archive_path, destination = sys.argv[1:]
max_members = 250_000
max_file_bytes = 1024 * 1024 * 1024
max_total_bytes = 4 * 1024 * 1024 * 1024
members = []
seen = set()
total_bytes = 0
with tarfile.open(archive_path, mode="r:gz") as archive:
    for member in archive:
        if len(members) >= max_members:
            raise SystemExit("node dependency archive contains too many members")
        if (
            not member.name
            or len(member.name) > 4096
            or "\\" in member.name
            or any(ord(character) < 32 or ord(character) == 127 for character in member.name)
        ):
            raise SystemExit("unsafe node dependency archive member")
        name = pathlib.PurePosixPath(member.name)
        normalized_name = posixpath.normpath(member.name)
        if (
            name.is_absolute()
            or ".." in name.parts
            or not name.parts
            or name.parts[0] != "node_modules"
            or normalized_name != member.name.rstrip("/")
            or normalized_name in seen
        ):
            raise SystemExit("unsafe node dependency archive member")
        seen.add(normalized_name)
        if member.isfile():
            if member.size < 0 or member.size > max_file_bytes:
                raise SystemExit("node dependency archive member exceeds the file size limit")
            total_bytes += member.size
            if total_bytes > max_total_bytes:
                raise SystemExit("node dependency archive exceeds the aggregate byte limit")
        elif member.isdir():
            if member.size != 0:
                raise SystemExit("node dependency archive directory declares content")
        elif member.issym():
            if member.size != 0:
                raise SystemExit("node dependency archive symlink declares content")
            if (
                not member.linkname
                or len(member.linkname) > 4096
                or "\\" in member.linkname
                or any(ord(character) < 32 or ord(character) == 127 for character in member.linkname)
            ):
                raise SystemExit("unsafe node dependency archive link")
            target = pathlib.PurePosixPath(member.linkname)
            if target.is_absolute():
                raise SystemExit("absolute node dependency archive link")
            resolved = pathlib.PurePosixPath(posixpath.normpath(str(name.parent / target)))
            if ".." in resolved.parts or not resolved.parts or resolved.parts[0] != "node_modules":
                raise SystemExit("escaping node dependency archive link")
        else:
            raise SystemExit("unsupported node dependency archive member")
        members.append(member)
    archive.extractall(destination, members=members, filter="data")
`;
    execFileSync(
      python,
      ['-c', program, path.join(root, lock.nodeArchive.path), temporary],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const expected = treeEntries(path.join(temporary, 'node_modules'));
    if (canonicalJson(installed) !== canonicalJson(expected)) {
      fail('installed Node dependency tree does not match the locked offline archive');
    }
    return {
      archive: lock.nodeArchive,
      treeDigest: sha256(canonicalJson(installed)),
      entryCount: installed.length,
      totalBytes: installed.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function pythonDistributionIdentity(lock) {
  const python = path.join(root, 'content-engine/.venv/bin/python3.12');
  const interpreter = execFileSync(
    python,
    ['--version'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  if (interpreter !== lock.target.python) {
    fail('installed Python interpreter does not match the locked runtime target');
  }
  const program = String.raw`
from email.parser import Parser
from importlib import metadata
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import zipfile

root = Path(sys.argv[1]).resolve(strict=True)
lock = json.loads(sys.argv[2])
venv_path = root / "content-engine/.venv"
venv = venv_path.resolve(strict=True)
if venv != venv_path or venv_path.is_symlink():
    raise SystemExit("Python virtual environment must be canonical")
site_packages_path = venv / "lib/python3.12/site-packages"
site_packages = site_packages_path.resolve(strict=True)
if site_packages != site_packages_path or site_packages_path.is_symlink():
    raise SystemExit("Python site-packages must be canonical")
root_bytes = os.fsencode(str(root))
replacement = b"NEXUS_RECOVERY_RUNTIME_ROOT"
max_entries = 250_000
max_wheel_entries = 250_000
max_file_bytes = 1024 * 1024 * 1024
max_total_bytes = 4 * 1024 * 1024 * 1024
max_metadata_bytes = 16 * 1024 * 1024
file_count = 0
total_bytes = 0
bounded_paths = set()
wheel_entry_count = 0
wheel_total_bytes = 0

def canonical_name(value):
    return re.sub(r"[-_.]+", "-", value).lower()

def bounded_regular(candidate, label):
    global file_count, total_bytes
    lexical = Path(os.path.abspath(candidate))
    try:
        file_stat = lexical.lstat()
    except FileNotFoundError:
        raise SystemExit(f"{label} is missing")
    if not stat.S_ISREG(file_stat.st_mode) or lexical.is_symlink():
        raise SystemExit(f"{label} is not a regular file")
    absolute = lexical.resolve(strict=True)
    if absolute != lexical:
        raise SystemExit(f"{label} traverses a symlink")
    if file_stat.st_size > max_file_bytes:
        raise SystemExit(f"{label} exceeds the file size limit")
    if absolute not in bounded_paths:
        bounded_paths.add(absolute)
        file_count += 1
        total_bytes += file_stat.st_size
        if file_count > max_entries:
            raise SystemExit("installed Python environment contains too many files")
        if total_bytes > max_total_bytes:
            raise SystemExit("installed Python environment exceeds the aggregate byte limit")
    return absolute, file_stat

def safe_wheel_member(info):
    global wheel_entry_count, wheel_total_bytes
    name = info.filename
    if (
        not name
        or len(name) > 4096
        or "\\" in name
        or any(ord(character) < 32 or ord(character) == 127 for character in name)
    ):
        raise SystemExit("locked wheel contains an unsafe member")
    pure = Path(name)
    if pure.is_absolute() or ".." in pure.parts:
        raise SystemExit("locked wheel contains an unsafe member")
    wheel_entry_count += 1
    if wheel_entry_count > max_wheel_entries:
        raise SystemExit("locked wheelhouse contains too many entries")
    if info.is_dir():
        if info.file_size != 0:
            raise SystemExit("locked wheel directory declares content")
        return
    if info.file_size < 0 or info.file_size > max_file_bytes:
        raise SystemExit("locked wheel member exceeds the file size limit")
    wheel_total_bytes += info.file_size
    if wheel_total_bytes > max_total_bytes:
        raise SystemExit("locked wheelhouse exceeds the aggregate byte limit")

expected = {}
for wheel in lock["pythonWheels"]:
    absolute = root / wheel["path"]
    with zipfile.ZipFile(absolute) as archive:
        infos = archive.infolist()
        member_names = set()
        for info in infos:
            safe_wheel_member(info)
            if info.filename in member_names:
                raise SystemExit("locked wheel contains a duplicate member")
            member_names.add(info.filename)
        metadata_names = [
            info.filename for info in infos
            if not info.is_dir()
            and info.filename.endswith(".dist-info/METADATA")
            and "/" in info.filename
        ]
        if len(metadata_names) != 1:
            raise SystemExit("locked wheel metadata is ambiguous")
        metadata_info = archive.getinfo(metadata_names[0])
        if metadata_info.file_size > max_metadata_bytes:
            raise SystemExit("locked wheel metadata exceeds the size limit")
        parsed = Parser().parsestr(archive.read(metadata_names[0]).decode("utf-8"))
    name = canonical_name(parsed.get("Name", ""))
    version = parsed.get("Version", "")
    if not name or not version or name in expected:
        raise SystemExit("locked wheel distribution identity is invalid")
    expected[name] = {
        "name": name,
        "version": version,
        "wheelPath": wheel["path"],
        "wheelSha256": wheel["sha256"],
    }

installed = {}
for distribution in metadata.distributions(path=[str(site_packages)]):
    name = canonical_name(distribution.metadata.get("Name", ""))
    if not name:
        raise SystemExit("installed Python distribution has no name")
    if name in installed:
        raise SystemExit("installed Python distribution identity is duplicated")
    installed[name] = distribution

extras = set(installed) - set(expected) - {"pip", "setuptools"}
missing = set(expected) - set(installed)
if extras or missing:
    raise SystemExit("installed Python distributions differ from the locked wheelhouse")

rows = []
governed_paths = set()
bootstrap_paths = set()
for name in sorted(expected):
    subject = expected[name]
    distribution = installed[name]
    if distribution.version != subject["version"] or distribution.files is None:
        raise SystemExit("installed Python distribution version or inventory differs from its locked wheel")
    files = []
    seen = set()
    for declared in distribution.files:
        absolute, file_stat = bounded_regular(
            distribution.locate_file(declared),
            "installed Python distribution file",
        )
        try:
            relative = absolute.relative_to(venv).as_posix()
        except ValueError:
            raise SystemExit("installed Python distribution file escapes the virtual environment")
        if relative in seen:
            raise SystemExit("installed Python distribution file is duplicated")
        seen.add(relative)
        governed_paths.add(absolute)
        # RECORD is a path-dependent index whose hashes are derived from the
        # governed files below, so only its bounded regular-file identity is
        # checked and it is excluded from the relocatable semantic digest.
        if relative.endswith(".dist-info/RECORD"):
            continue
        body = absolute.read_bytes().replace(root_bytes, replacement)
        files.append({
            "path": relative,
            "size": len(body),
            "executable": bool(file_stat.st_mode & 0o111),
            "sha256": hashlib.sha256(body).hexdigest(),
        })
    files.sort(key=lambda item: item["path"].encode("utf-16-be"))
    subject["filesDigest"] = hashlib.sha256(
        json.dumps(files, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    subject["fileCount"] = len(files)
    subject["totalBytes"] = sum(item["size"] for item in files)
    rows.append(subject)

for name in ("pip", "setuptools"):
    distribution = installed.get(name)
    if distribution is None or distribution.files is None:
        continue
    for declared in distribution.files:
        absolute, _ = bounded_regular(
            distribution.locate_file(declared),
            "bootstrap Python distribution file",
        )
        try:
            absolute.relative_to(venv)
        except ValueError:
            raise SystemExit("bootstrap Python distribution file escapes the virtual environment")
        bootstrap_paths.add(absolute)

scan_roots = [site_packages, (venv / "bin").resolve(strict=True)]
baseline_bin = {
    "python", "python3", "python3.12", "pip", "pip3", "pip3.12",
    "activate", "activate.csh", "activate.fish", "Activate.ps1",
}
for scan_root in scan_roots:
    try:
        scan_root.relative_to(venv)
    except ValueError:
        raise SystemExit("Python environment inventory root escapes the virtual environment")
    for candidate in scan_root.rglob("*"):
        candidate_stat = candidate.lstat()
        if stat.S_ISDIR(candidate_stat.st_mode):
            continue
        relative = candidate.relative_to(venv)
        if relative.parent == Path("bin") and relative.name in baseline_bin:
            continue
        absolute, _ = bounded_regular(candidate, "installed Python environment file")
        try:
            absolute.relative_to(venv)
        except ValueError:
            raise SystemExit("installed Python environment file escapes the virtual environment")
        if absolute in governed_paths or absolute in bootstrap_paths:
            continue
        if "__pycache__" in relative.parts and relative.suffix == ".pyc":
            source_name = relative.name.split(".cpython-", 1)[0] + ".py"
            source = candidate.parent.parent / source_name
            if source.exists() and (
                source.resolve(strict=True) in governed_paths
                or source.resolve(strict=True) in bootstrap_paths
            ):
                continue
        raise SystemExit(f"untracked installed Python environment file: {relative.as_posix()}")
print(json.dumps(rows, sort_keys=True, separators=(",", ":")))
`;
  const output = execFileSync(
    python,
    ['-c', program, root, JSON.stringify(lock)],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const distributions = JSON.parse(output);
  if (!Array.isArray(distributions) || distributions.length !== lock.pythonWheels.length) {
    fail('installed Python distribution evidence is incomplete');
  }
  return {
    interpreter,
    distributions,
  };
}

function compute() {
  canonicalDirectory(root, 'runtime root');
  const runtimeSha = valueOf('--runtime-sha');
  const artifactDigest = valueOf('--artifact-digest');
  if (!SHA.test(runtimeSha) || !DIGEST.test(artifactDigest)) {
    fail('recovery runtime source identity is invalid');
  }
  const { lock, packageLockSha256, pythonRequirementsSha256 } = validateLock();
  const packageJson = JSON.parse(fs.readFileSync(regularFile('package.json'), 'utf8'));
  const identity = {
    schema: 'nexus.recovery-installed-runtime-identity.v1',
    runtimeSha,
    artifactDigest,
    packageVersion: packageJson.version,
    target: lock.target,
    inputs: { packageLockSha256, pythonRequirementsSha256 },
    dependencyLockDigest: sha256(canonicalJson(lock)),
    node: verifyNodeArchive(lock),
    python: pythonDistributionIdentity(lock),
  };
  const aggregateDigest = sha256(canonicalJson(identity));
  const expected = valueOf('--expect-digest');
  if (expected && aggregateDigest !== expected) {
    fail('relocatable recovery runtime digest mismatch');
  }
  const result = {
    schema: 'nexus.recovery-runtime-attestation.v1',
    identity,
    aggregateDigest,
  };
  const output = valueOf('--output');
  if (output) {
    const absolute = path.resolve(output);
    fs.writeFileSync(absolute, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  if (command === 'compute') {
    assertUnprivilegedExecution();
    compute();
  }
  else fail('Usage: release-recovery-runtime-identity.mjs compute --root <runtime> --runtime-sha <sha> --artifact-digest <sha256> [--expect-digest <sha256>] [--output <file>]');
} catch (error) {
  process.stderr.write(`release_recovery_runtime_identity_failed:${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
