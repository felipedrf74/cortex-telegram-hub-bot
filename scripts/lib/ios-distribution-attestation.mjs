import {
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, sha256 } from './release-artifact-manifest.mjs';

export const IOS_DISTRIBUTION_ATTESTATION_FILE = 'ios-distribution-attestation.json';
export const IOS_DISTRIBUTION_PUBLIC_KEY_PATH = 'docs/release/evidence/ios-distribution-public-key.b64';
export const IOS_DISTRIBUTION_REPOSITORY = 'felipedrf74/nexus-hub-ios';
export const IOS_DISTRIBUTION_SOURCE_REF = 'refs/heads/main';
export const IOS_DISTRIBUTION_BUNDLE_ID = 'me.nexushub.app';
export const IOS_DISTRIBUTION_TEAM_ID = 'B6885R8NWM';
export const IOS_DISTRIBUTION_CONFIGURATION = 'Release';
export const IOS_DISTRIBUTION_WORKFLOW = 'App Store Release';
export const IOS_DISTRIBUTION_WORKFLOW_ID = '20e0adf7-2854-4207-98eb-8f3b5afcac60';
export const IOS_DISTRIBUTION_ASC_TEAM_PATH_ID = '502b7720-ce21-4a3a-bced-bf176ed4a127';
export const IOS_DISTRIBUTION_APP_APPLE_ID = '6762022696';
export const IOS_DISTRIBUTION_START_CONDITIONS = Object.freeze(['manual', 'manual_rebuild']);

const ENVELOPE_SCHEMA = 'nexus.ios-distribution-attestation.v2';
const PAYLOAD_SCHEMA = 'nexus.ios-distribution-attestation-payload.v2';
const KEY_ID = 'ios-distribution-signing-2026-07';
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const TREE_SEMANTICS = 'nexus.canonical-tree.v1';
const FILE_SEMANTICS = 'nexus.raw-file.v1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields do not match the trusted schema`);
  }
  return value;
}

function validateDigest(value, semantics, label) {
  exactKeys(value, ['algorithm', 'semantics', 'value'], label);
  if (value.algorithm !== 'sha256'
      || !semantics.includes(value.semantics)
      || !/^[0-9a-f]{64}$/.test(value.value ?? '')) {
    fail(`${label} is invalid`);
  }
}

function validateArtifactBlock(block, {
  label, artifactSemantics, release, signingKind, expectedBuildNumber,
}) {
  exactKeys(block, [
    'artifactDigest', 'appDigest', 'infoPlistDigest', 'executableDigest',
    'identity', 'pathKind', 'signing',
  ], `${label} artifact`);
  validateDigest(block.artifactDigest, artifactSemantics, `${label} artifact digest`);
  validateDigest(block.appDigest, [TREE_SEMANTICS], `${label} app digest`);
  validateDigest(block.infoPlistDigest, [FILE_SEMANTICS], `${label} Info.plist digest`);
  validateDigest(block.executableDigest, [FILE_SEMANTICS], `${label} executable digest`);
  exactKeys(block.identity, ['bundleId', 'marketingVersion', 'buildNumber'], `${label} identity`);
  if (block.identity.bundleId !== release.bundleId
      || block.identity.marketingVersion !== release.marketingVersion
      || block.identity.buildNumber !== expectedBuildNumber) {
    fail(`${label} app identity does not match release identity`);
  }
  exactKeys(block.signing, [
    'kind', 'identifier', 'teamIdentifier', 'cdHash', 'authorities',
    'entitlementsSha256', 'verification',
  ], `${label} signing identity`);
  if (block.signing.identifier !== release.bundleId
      || block.signing.verification !== 'codesign-deep-strict'
      || !/^[0-9a-f]{40,64}$/.test(block.signing.cdHash ?? '')
      || !/^[0-9a-f]{64}$/.test(block.signing.entitlementsSha256 ?? '')
      || !Array.isArray(block.signing.authorities)) {
    fail(`${label} signing identity is invalid`);
  }
  if (signingKind === 'ad-hoc') {
    if (block.signing.kind !== 'ad-hoc'
        || block.signing.teamIdentifier !== null
        || block.signing.authorities.length !== 0) {
      fail(`${label} signing identity must describe a verified ad-hoc archive`);
    }
    return;
  }
  if (signingKind !== 'apple-distribution'
      || block.signing.kind !== 'apple-distribution'
      || block.signing.teamIdentifier !== release.teamId
      || block.signing.authorities.length < 3
      || !new RegExp(
        `^Apple Distribution: .+ \\(${IOS_DISTRIBUTION_TEAM_ID}\\)$`,
      ).test(block.signing.authorities[0] ?? '')
      || !block.signing.authorities.includes(
        'Apple Worldwide Developer Relations Certification Authority',
      )
      || !block.signing.authorities.some((authority) => (
        /^Apple Root CA(?: - G[2-9])?$/.test(authority)
      ))
      || block.signing.authorities.some((authority) => (
        typeof authority !== 'string'
        || !(new RegExp('^Apple Distribution: .+ \\([A-Z0-9]{10}\\)$').test(authority)
          || authority === 'Apple Worldwide Developer Relations Certification Authority'
          || /^Apple Root CA(?: - G[2-9])?$/.test(authority))
      ))) {
    fail(`${label} signing identity is invalid`);
  }
}

function readPinnedPublicKey(trustedRoot) {
  const publicKeyPath = path.join(trustedRoot, IOS_DISTRIBUTION_PUBLIC_KEY_PATH);
  const stat = fs.lstatSync(publicKeyPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('trusted iOS distribution public key is not a regular file');
  }
  const encoded = fs.readFileSync(publicKeyPath, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    fail('trusted iOS distribution public key is malformed');
  }
  const raw = Buffer.from(encoded, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== encoded) {
    fail('trusted iOS distribution public key is malformed');
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

export function validateIosDistributionAttestation({
  attestation,
  iosSha,
  buildNumber,
  trustedRoot,
  nowMs = Date.now(),
}) {
  exactKeys(attestation, [
    'schema', 'keyId', 'signatureAlgorithm', 'payload', 'signature',
  ], 'iOS distribution attestation envelope');
  if (attestation.schema !== ENVELOPE_SCHEMA
      || attestation.keyId !== KEY_ID
      || attestation.signatureAlgorithm !== 'ed25519'
      || typeof attestation.signature !== 'string'
      || !/^[A-Za-z0-9+/]{86}==$/.test(attestation.signature)) {
    fail('iOS distribution attestation envelope identity is invalid');
  }
  const signature = Buffer.from(attestation.signature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== attestation.signature) {
    fail('iOS distribution attestation signature is malformed');
  }

  const payload = exactKeys(attestation.payload, [
    'schema', 'generatedAt', 'expiresAt', 'source', 'release', 'archive',
    'distribution', 'toolchain', 'ci',
  ], 'iOS distribution attestation payload');
  if (payload.schema !== PAYLOAD_SCHEMA) {
    fail('iOS distribution attestation payload schema is invalid');
  }
  const source = exactKeys(payload.source, [
    'repository', 'commit', 'tree', 'ref', 'clean',
  ], 'iOS distribution source');
  if (source.repository !== IOS_DISTRIBUTION_REPOSITORY
      || source.ref !== IOS_DISTRIBUTION_SOURCE_REF
      || source.clean !== true
      || !/^[0-9a-f]{40}$/.test(source.commit ?? '')
      || !/^[0-9a-f]{40}$/.test(source.tree ?? '')
      || source.commit !== iosSha) {
    fail('iOS distribution source identity is invalid or mismatched');
  }

  const release = exactKeys(payload.release, [
    'bundleId', 'teamId', 'marketingVersion', 'sourceBuildNumber',
    'distributedBuildNumber', 'configuration',
  ], 'iOS distribution release identity');
  if (release.bundleId !== IOS_DISTRIBUTION_BUNDLE_ID
      || release.teamId !== IOS_DISTRIBUTION_TEAM_ID
      || release.configuration !== IOS_DISTRIBUTION_CONFIGURATION
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.marketingVersion ?? '')
      || release.sourceBuildNumber !== String(buildNumber)
      || !/^[1-9][0-9]*$/.test(release.distributedBuildNumber ?? '')) {
    fail('iOS distribution release identity is invalid or mismatched');
  }

  validateArtifactBlock(payload.archive, {
    label: 'iOS archive',
    artifactSemantics: [TREE_SEMANTICS],
    release,
    signingKind: 'ad-hoc',
    expectedBuildNumber: release.sourceBuildNumber,
  });
  validateArtifactBlock(payload.distribution, {
    label: 'iOS distribution',
    artifactSemantics: [TREE_SEMANTICS, FILE_SEMANTICS],
    release,
    signingKind: 'apple-distribution',
    expectedBuildNumber: release.distributedBuildNumber,
  });
  if (payload.archive.pathKind !== 'xcarchive-directory'
      || !['ipa-file', 'signed-export-directory'].includes(payload.distribution.pathKind)
      || (payload.distribution.pathKind === 'ipa-file'
        && payload.distribution.artifactDigest.semantics !== FILE_SEMANTICS)
      || (payload.distribution.pathKind === 'signed-export-directory'
        && payload.distribution.artifactDigest.semantics !== TREE_SEMANTICS)) {
    fail('iOS distribution artifact path/digest semantics are invalid');
  }

  const toolchain = exactKeys(payload.toolchain, [
    'developerDir', 'xcodeVersion', 'xcodeBuild', 'sdkName', 'hostVersion', 'hostBuild',
    'archiveXcode', 'archiveXcodeBuild', 'archiveSDK', 'archiveHostBuild',
  ], 'iOS distribution toolchain identity');
  if (Object.values(toolchain).some((value) => typeof value !== 'string' || !value)
      || toolchain.xcodeBuild !== toolchain.archiveXcodeBuild
      || toolchain.sdkName !== toolchain.archiveSDK
      || toolchain.hostBuild !== toolchain.archiveHostBuild) {
    fail('iOS distribution toolchain identity is invalid or mismatched');
  }

  const ci = exactKeys(payload.ci, [
    'provider', 'buildId', 'buildNumber', 'buildUrl', 'workflow', 'workflowId',
    'startCondition', 'action',
  ], 'iOS distribution CI identity');
  const buildIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const buildIdValid = typeof ci.buildId === 'string' && buildIdPattern.test(ci.buildId);
  let buildUrlValid = false;
  if (buildIdValid && typeof ci.buildUrl === 'string') {
    try {
      const buildUrl = new URL(ci.buildUrl);
      const expectedPath = new RegExp(
        `^/teams/${IOS_DISTRIBUTION_ASC_TEAM_PATH_ID}`
          + `/apps/${IOS_DISTRIBUTION_APP_APPLE_ID}/ci/(?:builds|groups)/${ci.buildId}/?$`,
        'i',
      );
      buildUrlValid = buildUrl.protocol === 'https:'
        && buildUrl.hostname === 'appstoreconnect.apple.com'
        && !buildUrl.port
        && !buildUrl.username
        && !buildUrl.password
        && !buildUrl.search
        && !buildUrl.hash
        && expectedPath.test(buildUrl.pathname);
    } catch {
      buildUrlValid = false;
    }
  }
  if (ci.provider !== 'xcode-cloud'
      || ci.action !== 'archive'
      || ci.workflow !== IOS_DISTRIBUTION_WORKFLOW
      || ci.workflowId !== IOS_DISTRIBUTION_WORKFLOW_ID
      || !IOS_DISTRIBUTION_START_CONDITIONS.includes(ci.startCondition)
      || !buildIdValid
      || typeof ci.buildNumber !== 'string' || !/^[1-9][0-9]*$/.test(ci.buildNumber)
      || ci.buildNumber !== release.distributedBuildNumber
      || !buildUrlValid) {
    fail('iOS distribution CI identity is invalid or mismatched');
  }

  const generatedAtMs = Date.parse(payload.generatedAt ?? '');
  const expiresAtMs = Date.parse(payload.expiresAt ?? '');
  const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  if (!canonicalTimestamp.test(payload.generatedAt ?? '')
      || !canonicalTimestamp.test(payload.expiresAt ?? '')
      || !Number.isFinite(generatedAtMs) || !Number.isFinite(expiresAtMs)
      || generatedAtMs > nowMs + 5 * 60_000
      || expiresAtMs <= nowMs
      || expiresAtMs <= generatedAtMs
      || expiresAtMs - generatedAtMs > MAX_LIFETIME_MS) {
    fail('iOS distribution attestation timing is invalid');
  }

  let signatureValid = false;
  try {
    signatureValid = cryptoVerify(
      null,
      Buffer.from(canonicalJson(payload)),
      readPinnedPublicKey(trustedRoot),
      signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) fail('iOS distribution attestation signature is invalid');

  return {
    binding: {
      result: 'passed',
      attestationDigest: sha256(canonicalJson(attestation)),
      payloadDigest: sha256(canonicalJson(payload)),
      sourceCommit: source.commit,
      sourceTree: source.tree,
      release: {
        bundleId: release.bundleId,
        teamId: release.teamId,
        marketingVersion: release.marketingVersion,
        sourceBuildNumber: release.sourceBuildNumber,
        distributedBuildNumber: release.distributedBuildNumber,
        configuration: release.configuration,
      },
      archive: {
        artifactDigest: payload.archive.artifactDigest.value,
        appDigest: payload.archive.appDigest.value,
      },
      exportedArtifact: {
        artifactDigest: payload.distribution.artifactDigest.value,
        artifactSemantics: payload.distribution.artifactDigest.semantics,
        appDigest: payload.distribution.appDigest.value,
      },
      toolchain: {
        xcodeVersion: toolchain.xcodeVersion,
        xcodeBuild: toolchain.xcodeBuild,
        sdkName: toolchain.sdkName,
      },
      ci: {
        buildId: ci.buildId,
        buildNumber: ci.buildNumber,
        workflow: ci.workflow,
        workflowId: ci.workflowId,
      },
    },
    payload,
  };
}
