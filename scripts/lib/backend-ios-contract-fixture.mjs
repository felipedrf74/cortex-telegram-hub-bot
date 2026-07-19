import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BACKEND_IOS_CONTRACT_FIXTURE_PATH = 'dist/release/backend-ios-contract-fixture.v1.json';
export const BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA = 'nexus.backend-ios-contract-fixtures.v1';
export const BACKEND_IOS_CONTRACT_SUBJECT_SCHEMA = 'nexus.backend-ios-contract-subject.v2';
export const BACKEND_IOS_CONTRACT_FIXTURE_MAX_BYTES = 40 * 1024;
export const BACKEND_IOS_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'dashboard.home.v1', method: 'GET', path: '/api/v1/dashboard/home', decoder: 'HomeViewState',
  }),
  Object.freeze({
    id: 'training.home.v1', method: 'GET', path: '/api/v1/training/home', decoder: 'TrainingHomeViewState',
  }),
  Object.freeze({
    id: 'content.home.v1', method: 'GET', path: '/api/v1/content/home', decoder: 'ContentHomeViewState',
  }),
]);

function fail(message) {
  throw new Error(message);
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the governed schema`);
  }
}

export function validateBackendIosContractFixtureBytes(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0 || bytes.length > BACKEND_IOS_CONTRACT_FIXTURE_MAX_BYTES) {
    fail('backend/iOS contract fixture size is invalid');
  }
  let fixture;
  try {
    fixture = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('backend/iOS contract fixture JSON is invalid');
  }
  exactKeys(fixture, ['schema', 'contracts'], 'backend/iOS contract fixture');
  if (fixture.schema !== BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA
      || !Array.isArray(fixture.contracts)
      || fixture.contracts.length !== BACKEND_IOS_CONTRACTS.length) {
    fail('backend/iOS contract fixture identity is invalid');
  }
  fixture.contracts.forEach((contract, index) => {
    exactKeys(contract, ['id', 'method', 'path', 'decoder', 'payload'], `backend/iOS contract fixture ${index}`);
    const expected = BACKEND_IOS_CONTRACTS[index];
    if (contract.id !== expected.id
        || contract.method !== expected.method
        || contract.path !== expected.path
        || contract.decoder !== expected.decoder
        || !contract.payload
        || typeof contract.payload !== 'object'
        || Array.isArray(contract.payload)) {
      fail(`backend/iOS contract fixture ${index} identity or payload is invalid`);
    }
  });
  const canonicalBytes = Buffer.from(`${JSON.stringify(fixture)}\n`);
  if (!canonicalBytes.equals(bytes)) fail('backend/iOS contract fixture bytes are not canonical');
  return {
    fixture,
    bytes,
    digest: sha256(bytes),
    base64: bytes.toString('base64'),
  };
}

export function backendIosContractDigest({ runtimeSha, artifactDigest, fixtureDigest }) {
  if (!/^[0-9a-f]{40}$/.test(runtimeSha)) fail('backend/iOS contract runtime SHA is invalid');
  if (!/^[0-9a-f]{64}$/.test(artifactDigest)) fail('backend/iOS contract artifact digest is invalid');
  if (!/^[0-9a-f]{64}$/.test(fixtureDigest)) fail('backend/iOS contract fixture digest is invalid');
  return sha256(canonicalJson({
    schema: BACKEND_IOS_CONTRACT_SUBJECT_SCHEMA,
    repository: 'felipedrf74/cortex-telegram-hub-bot',
    runtimeSha,
    artifactDigest,
    fixture: {
      schema: BACKEND_IOS_CONTRACT_FIXTURE_SCHEMA,
      path: BACKEND_IOS_CONTRACT_FIXTURE_PATH,
      digest: fixtureDigest,
    },
  }));
}

export function backendIosContractFixtureIdentity({ bundleRoot, artifact }) {
  const entryMatches = artifact?.files?.filter((entry) => entry?.path === BACKEND_IOS_CONTRACT_FIXTURE_PATH) ?? [];
  if (entryMatches.length !== 1) fail('backend/iOS contract fixture is missing or duplicated in the runtime artifact');
  const fixturePath = path.join(bundleRoot, BACKEND_IOS_CONTRACT_FIXTURE_PATH);
  const stat = fs.lstatSync(fixturePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('backend/iOS contract fixture is not a regular file');
  const validated = validateBackendIosContractFixtureBytes(fs.readFileSync(fixturePath));
  if (entryMatches[0].size !== validated.bytes.length || entryMatches[0].sha256 !== validated.digest) {
    fail('backend/iOS contract fixture differs from the runtime artifact manifest');
  }
  return { ...validated, path: fixturePath, relativePath: BACKEND_IOS_CONTRACT_FIXTURE_PATH };
}
