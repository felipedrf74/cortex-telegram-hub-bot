import fs from 'node:fs';
import path from 'node:path';

import { fail, sha256 } from './release-canonical.mjs';

const MAX_ENVIRONMENT_FILE_BYTES = 512 * 1024;
const ENVIRONMENT_KEY = /^[A-Z_][A-Z0-9_]*$/;

// The Python service receives only credentials and switches its source actually
// reads. In particular, product-bot, OAuth, calendar, database-encryption and
// release-control credentials have no reason to cross this container boundary.
export const CONTENT_ENGINE_ENVIRONMENT_KEYS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED',
  'INTERNAL_API_SECRET',
  'NEWSAPI_API_KEY',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'SERPAPI_API_KEY',
  'YOUTUBE_API_KEY',
]);

// Compose supplies topology and signed release identity explicitly. Allowing a
// mutable backend env file to repeat any of these values would create a second
// authority whose precedence depends on Compose rendering rules.
export const BACKEND_FORBIDDEN_ENVIRONMENT_KEYS = Object.freeze([
  'BACKUP_DIR',
  'COMPOSE_PROJECT_NAME',
  'CONTENT_ENGINE_BASE_URL',
  'CONTENT_ENGINE_PORT',
  'DATABASE_PATH',
  'ENV',
  'MIGRATIONS_MODE',
  'NEXUS_APP_STAGING',
  'NEXUS_BACKEND_BASE_URL',
  'NEXUS_BACKEND_ENV_FILE',
  'NEXUS_BACKEND_IMAGE',
  'NEXUS_BACKEND_PORT',
  'NEXUS_CONTENT_ENGINE_ENV_FILE',
  'NEXUS_CONTENT_ENGINE_IMAGE',
  'NEXUS_CONTENT_ENGINE_PORT',
  'NEXUS_DATA_DIR',
  'NEXUS_ENV_FILE',
  'NEXUS_RELEASE_BACKEND_DIGEST',
  'NEXUS_RELEASE_ENVIRONMENT',
  'NEXUS_RELEASE_ID',
  'NEXUS_RELEASE_MIGRATION_PLAN',
  'NEXUS_RELEASE_PLAN_DIR',
  'NEXUS_RELEASE_SOURCE_SHA',
  'NODE_ENV',
  'PORTAL_BIND',
  'PORTAL_PORT',
  'PORTAL_PUBLIC_BIND_ACK',
  'STAGING',
]);

// Node and the ELF/Mach-O loaders consume these before the signed application
// entrypoint. A root env file must not make mutable mounted bytes executable or
// replace the container's trust configuration.
export const BACKEND_FORBIDDEN_RUNTIME_PREFIXES = Object.freeze([
  'DYLD_',
  'LD_',
  'NODE_',
]);
export const BACKEND_FORBIDDEN_RUNTIME_KEYS = Object.freeze([
  'OPENSSL_CONF',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
]);

function effectiveIdentity() {
  return {
    uid: typeof process.geteuid === 'function' ? process.geteuid() : process.getuid(),
    gid: typeof process.getegid === 'function' ? process.getegid() : process.getgid(),
  };
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readOwnedEnvironmentFile(file, label) {
  if (typeof file !== 'string'
      || !path.isAbsolute(file)
      || path.normalize(file) !== file
      || file.includes('\0')) {
    fail(`${label} path is not a normalized absolute path`);
  }

  const identity = effectiveIdentity();
  let descriptor;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    fail(`${label} is absent or unsafe`);
  }

  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()
        || before.nlink !== 1
        || before.uid !== identity.uid
        || before.gid !== identity.gid
        || (before.mode & 0o777) !== 0o600
        || before.size < 1
        || before.size > MAX_ENVIRONMENT_FILE_BYTES) {
      fail(`${label} must be an owner-only single-link regular file`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    let pathStat;
    try {
      pathStat = fs.lstatSync(file);
    } catch {
      fail(`${label} path changed while it was read`);
    }
    if (pathStat.isSymbolicLink()
        || !sameFileIdentity(before, after)
        || !sameFileIdentity(after, pathStat)
        || fs.realpathSync(file) !== file) {
      fail(`${label} identity changed while it was read`);
    }
    return { bytes, digest: sha256(bytes) };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseEnvironmentKeys(bytes, label) {
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0 || text.includes('\0')) {
    fail(`${label} is not canonical UTF-8 text`);
  }
  const values = new Map();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].endsWith('\r')
      ? lines[index].slice(0, -1)
      : lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || !ENVIRONMENT_KEY.test(match[1])) {
      fail(`${label} has unsupported syntax at line ${index + 1}`);
    }
    if (values.has(match[1])) {
      fail(`${label} repeats environment key ${match[1]}`);
    }
    // Compose `format: raw` is deliberate: `$`, backslashes and `#` inside a
    // secret must reach the container as literal bytes, never interpolate from
    // the root poller process. Reject dotenv quote/comment syntax whose meaning
    // would change when migrating an older parsed env file to raw semantics.
    if (/^["']/.test(match[2]) || /["']$/.test(match[2]) || /[ \t]#/.test(match[2])) {
      fail(`${label} uses non-canonical raw value syntax for ${match[1]}`);
    }
    values.set(match[1], match[2]);
  }
  return values;
}

function obviouslyEmpty(value) {
  const normalized = String(value ?? '').trim();
  return normalized === '' || normalized === "''" || normalized === '""';
}

/**
 * Verify the two root-owned application env contracts before any Compose
 * render. The first accepted digests are retained for this poll process, so an
 * operator edit cannot give staging and production-switch phases different
 * secret bytes inside one release attempt.
 */
export function createReleaseEnvironmentGate({ policy }) {
  const accepted = new Map();
  const contentAllowed = new Set(CONTENT_ENGINE_ENVIRONMENT_KEYS);
  const backendForbidden = new Set(BACKEND_FORBIDDEN_ENVIRONMENT_KEYS);
  const runtimeForbidden = new Set(BACKEND_FORBIDDEN_RUNTIME_KEYS);

  function verify(environment) {
    const target = policy?.environments?.[environment];
    if (!target) fail(`unknown release environment ${environment}`);
    const backend = readOwnedEnvironmentFile(
      target.backendEnvFile,
      `${environment} backend environment file`,
    );
    const contentEngine = readOwnedEnvironmentFile(
      target.contentEngineEnvFile,
      `${environment} content-engine environment file`,
    );
    const backendValues = parseEnvironmentKeys(
      backend.bytes,
      `${environment} backend environment file`,
    );
    const contentValues = parseEnvironmentKeys(
      contentEngine.bytes,
      `${environment} content-engine environment file`,
    );

    for (const key of backendValues.keys()) {
      if (backendForbidden.has(key)) {
        fail(`${environment} backend environment file repeats Compose authority ${key}`);
      }
      if (runtimeForbidden.has(key)
          || BACKEND_FORBIDDEN_RUNTIME_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        fail(`${environment} backend environment file contains runtime loader control ${key}`);
      }
    }
    for (const key of contentValues.keys()) {
      if (!contentAllowed.has(key)) {
        fail(`${environment} content-engine environment file contains non-engine key ${key}`);
      }
    }
    const backendInternalSecret = backendValues.get('INTERNAL_API_SECRET');
    const contentInternalSecret = contentValues.get('INTERNAL_API_SECRET');
    if (obviouslyEmpty(backendInternalSecret) || obviouslyEmpty(contentInternalSecret)) {
      fail(`${environment} INTERNAL_API_SECRET must be present in both application env files`);
    }
    if (backendInternalSecret !== contentInternalSecret) {
      fail(`${environment} INTERNAL_API_SECRET differs across the application env files`);
    }

    const proof = {
      backendDigest: backend.digest,
      contentEngineDigest: contentEngine.digest,
    };
    const prior = accepted.get(environment);
    if (prior && (prior.backendDigest !== proof.backendDigest
        || prior.contentEngineDigest !== proof.contentEngineDigest)) {
      fail(`${environment} application environment files changed during the release attempt`);
    }
    accepted.set(environment, proof);
    return proof;
  }

  return { verify };
}
