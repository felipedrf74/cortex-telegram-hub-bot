#!/usr/bin/env node
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const REQUIRED_MOUNTS = Object.freeze({
  db: Object.freeze({
    '/var/lib/postgresql/data': 'postgresql_data',
  }),
  sonarqube: Object.freeze({
    '/opt/sonarqube/data': 'sonarqube_data',
    '/opt/sonarqube/extensions': 'sonarqube_extensions',
    '/opt/sonarqube/logs': 'sonarqube_logs',
  }),
});

function fail(message) {
  throw new Error(message);
}

function readJsonFile(file, label) {
  if (!path.isAbsolute(file)) fail(`${label} path must be absolute`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a non-symlink regular file`);
  }
  if (stat.size <= 0 || stat.size > MAX_INPUT_BYTES) {
    fail(`${label} has an unsafe size`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function equal(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function projectName(config, label) {
  const value = config?.name;
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)) {
    fail(`${label} Compose project name is missing or unsafe`);
  }
  return value;
}

function volumeDefinitions(config, label) {
  const value = config?.volumes;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} Compose volume definitions are missing`);
  }
  return value;
}

function serviceVolumes(config, service, label) {
  const value = config?.services?.[service]?.volumes;
  if (!Array.isArray(value)) {
    fail(`${label} ${service} volume mappings are missing`);
  }
  return value.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || entry.type !== 'volume'
      || typeof entry.source !== 'string'
      || typeof entry.target !== 'string'
    ) {
      fail(`${label} ${service} contains an unsupported volume mapping`);
    }
    return canonical(entry);
  });
}

function resolvedVolumeName(config, logicalName, label) {
  const definitions = volumeDefinitions(config, label);
  if (!Object.hasOwn(definitions, logicalName)) {
    fail(`${label} volume ${logicalName} is not declared`);
  }
  const definition = definitions[logicalName];
  if (
    definition !== null
    && (typeof definition !== 'object' || Array.isArray(definition))
  ) {
    fail(`${label} volume ${logicalName} has an invalid definition`);
  }
  const explicitName = definition?.name;
  if (explicitName !== undefined) {
    if (typeof explicitName !== 'string' || explicitName.length === 0) {
      fail(`${label} volume ${logicalName} has an invalid resolved name`);
    }
    return explicitName;
  }
  return `${projectName(config, label)}_${logicalName}`;
}

function verifyRequiredMappings(config, label) {
  for (const [service, targets] of Object.entries(REQUIRED_MOUNTS)) {
    const mappings = serviceVolumes(config, service, label);
    if (mappings.length !== Object.keys(targets).length) {
      fail(`${label} ${service} volume mapping count changed`);
    }
    for (const [target, logicalName] of Object.entries(targets)) {
      const matches = mappings.filter(
        (entry) => entry.target === target && entry.source === logicalName,
      );
      if (matches.length !== 1) {
        fail(`${label} ${service} must map ${logicalName} to ${target}`);
      }
      resolvedVolumeName(config, logicalName, label);
    }
  }
}

function verifyRunningMounts(config, service, mounts) {
  if (!Array.isArray(mounts)) fail(`running ${service} mounts are invalid`);
  const targets = REQUIRED_MOUNTS[service];
  for (const [target, logicalName] of Object.entries(targets)) {
    const matches = mounts.filter((entry) => entry?.Destination === target);
    if (matches.length !== 1) {
      fail(`running ${service} does not have exactly one mount at ${target}`);
    }
    const mount = matches[0];
    const expectedName = resolvedVolumeName(config, logicalName, 'current');
    if (mount.Type !== 'volume' || mount.Name !== expectedName) {
      fail(
        `running ${service} mount ${target} uses ${String(mount.Name)} instead of ${expectedName}`,
      );
    }
  }
}

export function verifyVolumeIdentity({
  currentConfig,
  candidateConfig,
  dbMounts,
  sonarqubeMounts,
}) {
  const currentName = projectName(currentConfig, 'current');
  const candidateName = projectName(candidateConfig, 'candidate');
  if (candidateName !== currentName) {
    fail('candidate Compose project name would change');
  }
  if (
    !equal(
      volumeDefinitions(candidateConfig, 'candidate'),
      volumeDefinitions(currentConfig, 'current'),
    )
  ) {
    fail('candidate Compose volume definitions would change');
  }

  verifyRequiredMappings(currentConfig, 'current');
  verifyRequiredMappings(candidateConfig, 'candidate');
  for (const service of Object.keys(REQUIRED_MOUNTS)) {
    if (
      !equal(
        serviceVolumes(candidateConfig, service, 'candidate'),
        serviceVolumes(currentConfig, service, 'current'),
      )
    ) {
      fail(`candidate ${service} volume mappings would change`);
    }
  }

  verifyRunningMounts(currentConfig, 'db', dbMounts);
  verifyRunningMounts(currentConfig, 'sonarqube', sonarqubeMounts);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      fail('expected flag/value arguments');
    }
    const key = flag.slice(2);
    if (values[key] !== undefined) fail(`duplicate argument: ${flag}`);
    values[key] = value;
  }
  for (const key of [
    'current-config',
    'candidate-config',
    'db-mounts',
    'sonarqube-mounts',
  ]) {
    if (!values[key]) fail(`missing --${key}`);
  }
  return values;
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    verifyVolumeIdentity({
      currentConfig: readJsonFile(args['current-config'], 'current config'),
      candidateConfig: readJsonFile(args['candidate-config'], 'candidate config'),
      dbMounts: readJsonFile(args['db-mounts'], 'db mounts'),
      sonarqubeMounts: readJsonFile(args['sonarqube-mounts'], 'sonarqube mounts'),
    });
    process.stdout.write('Sonar Compose project and running volume identity verified\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
