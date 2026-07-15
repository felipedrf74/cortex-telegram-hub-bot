import fs from 'node:fs';
import path from 'node:path';

export const DOCUMENTATION_POLICY_PATH = 'config/documentation-policy.json';
export const DOCUMENTATION_POLICY_SCHEMA_PATH = 'config/documentation-policy.schema.json';
export const DOCUMENTATION_POLICY_SCHEMA = 'nexus.documentation-policy.v1';

const METADATA_KEYS = new Set(['status', 'owner', 'reviewedOn', 'reviewIntervalDays']);
const POLICY_KEYS = new Set([
  '$schema',
  'schema',
  'version',
  'statusDefinitions',
  'defaults',
  'rules',
  'exceptions',
]);
const RULE_KEYS = new Set(['id', 'glob', 'metadata']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedRepoPath(value) {
  return value.split(path.sep).join('/');
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
    ? null
    : parsed;
}

function dueDate(reviewedOn, reviewIntervalDays) {
  const parsed = parseIsoDate(reviewedOn);
  if (!parsed) return null;
  parsed.setUTCDate(parsed.getUTCDate() + reviewIntervalDays);
  return parsed.toISOString().slice(0, 10);
}

function globToRegExp(glob) {
  let expression = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          expression += '(?:.*/)?';
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      expression += '[^/]';
      continue;
    }
    expression += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${expression}$`);
}

function metadataValidationErrors(metadata, label, statusDefinitions, { partial = true } = {}) {
  const errors = [];
  if (!isPlainObject(metadata)) return [`${label} must be an object`];
  for (const key of Object.keys(metadata)) {
    if (!METADATA_KEYS.has(key)) errors.push(`${label}.${key} is not supported`);
  }
  if (!partial || Object.hasOwn(metadata, 'status')) {
    if (typeof metadata.status !== 'string' || !Object.hasOwn(statusDefinitions, metadata.status)) {
      errors.push(`${label}.status must name a configured status`);
    }
  }
  if (!partial || Object.hasOwn(metadata, 'owner')) {
    if (typeof metadata.owner !== 'string' || metadata.owner.trim().length === 0) {
      errors.push(`${label}.owner must be a non-empty string`);
    }
  }
  if (!partial || Object.hasOwn(metadata, 'reviewedOn')) {
    if (!parseIsoDate(metadata.reviewedOn)) errors.push(`${label}.reviewedOn must be YYYY-MM-DD`);
  }
  if (!partial || Object.hasOwn(metadata, 'reviewIntervalDays')) {
    if (!Number.isInteger(metadata.reviewIntervalDays)
        || metadata.reviewIntervalDays < 1
        || metadata.reviewIntervalDays > 730) {
      errors.push(`${label}.reviewIntervalDays must be an integer from 1 through 730`);
    }
  }
  return errors;
}

export function validateDocumentationPolicy(policy) {
  const errors = [];
  if (!isPlainObject(policy)) throw new Error('Documentation policy must be an object.');
  for (const key of Object.keys(policy)) {
    if (!POLICY_KEYS.has(key)) errors.push(`${key} is not supported`);
  }
  if (policy.$schema !== './documentation-policy.schema.json') {
    errors.push('$schema must reference ./documentation-policy.schema.json');
  }
  if (policy.schema !== DOCUMENTATION_POLICY_SCHEMA) {
    errors.push(`schema must be ${DOCUMENTATION_POLICY_SCHEMA}`);
  }
  if (typeof policy.version !== 'string' || policy.version.trim().length === 0) {
    errors.push('version must be a non-empty string');
  }
  if (!isPlainObject(policy.statusDefinitions) || Object.keys(policy.statusDefinitions).length === 0) {
    errors.push('statusDefinitions must be a non-empty object');
  }
  const statusDefinitions = isPlainObject(policy.statusDefinitions) ? policy.statusDefinitions : {};
  for (const [status, definition] of Object.entries(statusDefinitions)) {
    if (!/^[a-z][a-z-]*$/.test(status)) errors.push(`statusDefinitions.${status} has an invalid name`);
    if (!isPlainObject(definition) || typeof definition.active !== 'boolean') {
      errors.push(`statusDefinitions.${status}.active must be boolean`);
    } else if (Object.keys(definition).some((key) => key !== 'active')) {
      errors.push(`statusDefinitions.${status} contains unsupported fields`);
    }
  }
  errors.push(...metadataValidationErrors(policy.defaults, 'defaults', statusDefinitions));

  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    errors.push('rules must be a non-empty array');
  }
  const ruleIds = new Set();
  for (const [index, rule] of (Array.isArray(policy.rules) ? policy.rules : []).entries()) {
    const label = `rules[${index}]`;
    if (!isPlainObject(rule)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) errors.push(`${label}.${key} is not supported`);
    }
    if (typeof rule.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(rule.id)) {
      errors.push(`${label}.id must be a kebab-case identifier`);
    } else if (ruleIds.has(rule.id)) {
      errors.push(`${label}.id duplicates ${rule.id}`);
    } else {
      ruleIds.add(rule.id);
    }
    if (typeof rule.glob !== 'string'
        || !rule.glob.endsWith('.md')
        || rule.glob.startsWith('/')
        || rule.glob.split('/').includes('..')) {
      errors.push(`${label}.glob must be a repository-relative Markdown glob`);
    }
    errors.push(...metadataValidationErrors(rule.metadata, `${label}.metadata`, statusDefinitions));
  }

  if (!isPlainObject(policy.exceptions)) errors.push('exceptions must be an object');
  for (const [file, metadata] of Object.entries(isPlainObject(policy.exceptions) ? policy.exceptions : {})) {
    if (!file.endsWith('.md')
        || file.startsWith('/')
        || file.split('/').includes('..')
        || /[*?\[\]]/.test(file)) {
      errors.push(`exceptions.${file} must be an exact repository-relative Markdown path`);
    }
    errors.push(...metadataValidationErrors(metadata, `exceptions.${file}`, statusDefinitions));
  }

  if (errors.length > 0) throw new Error(`Invalid documentation policy: ${errors.join('; ')}`);
  return policy;
}

export function readDocumentationPolicy(repoRoot) {
  const policyPath = path.join(repoRoot, DOCUMENTATION_POLICY_PATH);
  const schemaPath = path.join(repoRoot, DOCUMENTATION_POLICY_SCHEMA_PATH);
  if (!fs.existsSync(policyPath)) throw new Error(`${DOCUMENTATION_POLICY_PATH} is missing`);
  if (!fs.existsSync(schemaPath)) throw new Error(`${DOCUMENTATION_POLICY_SCHEMA_PATH} is missing`);
  return validateDocumentationPolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')));
}

function canonicalPathFor(repoRoot, file) {
  const absolute = path.join(repoRoot, file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isSymbolicLink()) return file;
  const target = path.resolve(path.dirname(absolute), fs.readlinkSync(absolute));
  const relative = normalizedRepoPath(path.relative(repoRoot, target));
  return relative.startsWith('../') || relative === '..' ? null : relative;
}

export function resolveDocumentationInventory({
  repoRoot,
  files,
  policy = readDocumentationPolicy(repoRoot),
  asOf = new Date().toISOString().slice(0, 10),
}) {
  validateDocumentationPolicy(policy);
  if (!parseIsoDate(asOf)) throw new Error('Documentation inventory asOf must be YYYY-MM-DD.');
  const markdownFiles = [...new Set(files)].sort();
  const markdownSet = new Set(markdownFiles);
  const rules = policy.rules.map((rule) => ({ ...rule, matcher: globToRegExp(rule.glob) }));
  const issues = [];
  const records = [];

  for (const exception of Object.keys(policy.exceptions)) {
    if (!markdownSet.has(exception)) {
      issues.push({
        type: 'document-governance-stale-exception',
        file: exception,
        message: 'Documentation-policy exception does not match a tracked Markdown file.',
      });
    }
  }

  for (const file of markdownFiles) {
    const matchingRules = rules.filter((rule) => rule.matcher.test(file));
    const exception = policy.exceptions[file];
    if (matchingRules.length === 0 && !exception) {
      issues.push({
        type: 'document-governance-missing',
        file,
        message: 'Tracked Markdown has no documentation-policy rule or explicit exception.',
      });
      continue;
    }
    const metadata = Object.assign(
      {},
      policy.defaults,
      ...matchingRules.map((rule) => rule.metadata),
      exception ?? {},
    );
    const validation = metadataValidationErrors(
      metadata,
      `resolved metadata for ${file}`,
      policy.statusDefinitions,
      { partial: false },
    );
    if (validation.length > 0) {
      issues.push({ type: 'document-governance-invalid', file, message: validation.join('; ') });
      continue;
    }
    const reviewDueOn = dueDate(metadata.reviewedOn, metadata.reviewIntervalDays);
    const active = policy.statusDefinitions[metadata.status].active;
    if (active && metadata.reviewedOn > asOf) {
      issues.push({
        type: 'document-governance-invalid',
        file,
        message: `Review date ${metadata.reviewedOn} is later than audit date ${asOf}.`,
      });
    }
    if (active && reviewDueOn < asOf) {
      issues.push({
        type: 'document-governance-expired',
        file,
        message: `Review expired ${reviewDueOn}; last reviewed ${metadata.reviewedOn}.`,
      });
    }
    const canonicalPath = canonicalPathFor(repoRoot, file);
    if (canonicalPath === null
        || !markdownSet.has(canonicalPath)
        || !fs.existsSync(path.join(repoRoot, canonicalPath))) {
      issues.push({
        type: 'document-governance-invalid',
        file,
        message: 'Canonical document path resolves outside the repository or does not exist.',
      });
      continue;
    }
    if (metadata.status === 'mirror' && canonicalPath === file) {
      issues.push({
        type: 'document-governance-invalid',
        file,
        message: 'Mirror document must resolve to a distinct tracked canonical Markdown path.',
      });
      continue;
    }
    records.push({
      path: file,
      status: metadata.status,
      active,
      owner: metadata.owner,
      reviewedOn: metadata.reviewedOn,
      reviewDueOn,
      canonicalPath,
    });
  }

  return { policy, records, issues };
}
