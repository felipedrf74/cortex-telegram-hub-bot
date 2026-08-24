import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { globToRegExp, root as repositoryRoot } from './test-policy.mjs';
import { isProductionMigrationArchivePath } from './migration-safety-policy-classifier.mjs';

export function loadTestGroups(sourceRoot = repositoryRoot) {
  const file = path.join(sourceRoot, 'config/test-groups.json');
  const body = fs.readFileSync(file);
  const policy = JSON.parse(body);
  if (!policy.core?.tests?.length || !policy.groups || Object.keys(policy.groups).length === 0) {
    throw new Error('config/test-groups.json must define core tests and groups');
  }
  for (const name of Object.keys(policy.groups)) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(name)) {
      throw new Error(`invalid test-group key: ${JSON.stringify(name)}`);
    }
  }
  for (const test of policy.core.tests) {
    if (!isCanonicalPolicyPath(test, { testPath: true })) {
      throw new Error(`invalid core test path: ${JSON.stringify(test)}`);
    }
  }
  for (const [name, group] of Object.entries(policy.groups)) {
    for (const field of ['paths', 'tests']) {
      if (!Array.isArray(group[field])) {
        throw new Error(`test group ${name} must define ${field} patterns`);
      }
      for (const pattern of group[field]) {
        if (!isCanonicalPolicyPath(pattern, { allowGlob: true })) {
          throw new Error(`invalid ${name}.${field} path pattern: ${JSON.stringify(pattern)}`);
        }
      }
    }
    if (!Array.isArray(group.contracts)) {
      throw new Error(`test group ${name} must define contract tests`);
    }
    for (const test of group.contracts) {
      if (!isCanonicalPolicyPath(test, { testPath: true })) {
        throw new Error(`invalid ${name}.contracts test path: ${JSON.stringify(test)}`);
      }
    }
  }
  const exactRetirementOwners = new Map();
  for (const [index, mapping] of (policy.retirementMappings ?? []).entries()) {
    const errors = validateRetirementMapping(mapping);
    if (errors.length > 0) {
      throw new Error(`invalid retirement mapping ${index}: ${errors.join('; ')}`);
    }
    for (const test of mapping.test !== undefined ? [mapping.test] : (mapping.tests ?? [])) {
      if (exactRetirementOwners.has(test)) {
        throw new Error(
          `ambiguous exact retirement test ${test}: mappings ${exactRetirementOwners.get(test)}, ${index}`,
        );
      }
      exactRetirementOwners.set(test, index);
    }
  }
  return {
    ...policy,
    digest: createHash('sha256').update(body).digest('hex'),
  };
}

function matches(file, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

export function isCanonicalPolicyPath(value, { allowGlob = false, testPath = false } = {}) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || path.posix.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
    || value.startsWith('-')
    || value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
    || path.posix.normalize(value) !== value
    || (!allowGlob && /[*?]/.test(value))
  ) {
    return false;
  }
  return !testPath || /^__tests__\/[^*?]+\.test\.ts$/.test(value);
}

export function validateRetirementMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') return ['retirement mapping must be an object'];
  const errors = [];
  if (typeof mapping.baseSha !== 'string' || !/^[0-9a-f]{40}$/.test(mapping.baseSha)) {
    errors.push(`invalid retirement base SHA: ${String(mapping.baseSha)}`);
  }
  const hasExactTest = mapping.test !== undefined;
  const hasExactTests = mapping.tests !== undefined;
  const hasPatterns = mapping.testPatterns !== undefined;
  if ([hasExactTest, hasExactTests, hasPatterns].filter(Boolean).length !== 1) {
    errors.push('retirement mapping must declare exactly one of test, tests, or testPatterns');
  }
  if (hasExactTest && !isCanonicalPolicyPath(mapping.test, { testPath: true })) {
    errors.push(`invalid exact retirement test path: ${String(mapping.test)}`);
  }
  if (hasPatterns) {
    if (!Array.isArray(mapping.testPatterns) || mapping.testPatterns.length === 0) {
      errors.push('retirement testPatterns must contain at least one repository-relative pattern');
    } else {
      for (const pattern of mapping.testPatterns) {
        if (
          !isCanonicalPolicyPath(pattern, { allowGlob: true })
          || !pattern.startsWith('__tests__/')
          || !pattern.endsWith('.test.ts')
        ) {
          errors.push(`invalid retirement test pattern: ${String(pattern)}`);
        }
      }
    }
  }
  if (hasExactTests) {
    if (!Array.isArray(mapping.tests) || mapping.tests.length === 0) {
      errors.push('retirement tests must contain at least one exact test path');
    } else {
      for (const test of mapping.tests) {
        if (!isCanonicalPolicyPath(test, { testPath: true })) {
          errors.push(`invalid exact retirement test path: ${String(test)}`);
        }
      }
      if (new Set(mapping.tests).size !== mapping.tests.length) {
        errors.push('retirement tests must not contain duplicate paths');
      }
    }
  }
  const requiredRemovedPaths = mapping.requiredRemovedPaths ?? [];
  const requiredChangedPaths = mapping.requiredChangedPaths ?? [];
  if (!Array.isArray(requiredRemovedPaths) || !Array.isArray(requiredChangedPaths)) {
    errors.push('retirement required paths must be arrays');
  } else {
    if (requiredRemovedPaths.length + requiredChangedPaths.length === 0) {
      errors.push('retirement mapping must require at least one changed owner path');
    }
    for (const pattern of [...requiredRemovedPaths, ...requiredChangedPaths]) {
      if (!isCanonicalPolicyPath(pattern, { allowGlob: true })) {
        errors.push(`invalid retirement owner path pattern: ${String(pattern)}`);
      }
    }
  }
  if (!Array.isArray(mapping.replacementTests) || mapping.replacementTests.length === 0) {
    errors.push('retirement replacementTests must contain at least one exact retained test');
  } else {
    for (const replacement of mapping.replacementTests) {
      if (!isCanonicalPolicyPath(replacement, { testPath: true })) {
        errors.push(`invalid retirement replacement test: ${String(replacement)}`);
      }
    }
  }
  if (mapping.baselineOwnerPaths !== undefined) {
    if (!Array.isArray(mapping.baselineOwnerPaths) || mapping.baselineOwnerPaths.length === 0) {
      errors.push('baselineOwnerPaths must contain at least one exact baseline owner');
    } else {
      for (const owner of mapping.baselineOwnerPaths) {
        if (!isCanonicalPolicyPath(owner)) {
          errors.push(`invalid baseline owner path: ${String(owner)}`);
        }
      }
    }
  }
  if (typeof mapping.reason !== 'string' || mapping.reason.trim().length < 12) {
    errors.push('retirement reason must explain the exact behavior replacement');
  }
  return errors;
}

export function retirementOwnerCandidates(testFile, ...sources) {
  const owners = new Set();
  const add = (candidate) => {
    const normalized = path.posix.normalize(candidate);
    if (
      isCanonicalPolicyPath(normalized)
      && /^(?:src|scripts|ops|config)\//.test(normalized)
    ) {
      owners.add(normalized);
    }
  };
  for (const source of sources) {
    for (const match of String(source).matchAll(
      /(?:from\s*|import\s*\(|require\s*\(|\bimport\s*)\s*['"]([^'"]+)['"]/g,
    )) {
      const specifier = match[1];
      if (specifier.startsWith('.')) {
        const base = path.posix.join(path.posix.dirname(testFile), specifier);
        for (const suffix of ['', '.ts', '.js', '.mjs', '.sh', '/index.ts']) {
          add(`${base}${suffix}`);
        }
      } else {
        add(specifier);
      }
    }
    for (const match of String(source).matchAll(
      /['"]((?:src|scripts|ops|config)\/[^'"]+)['"]/g,
    )) {
      add(match[1]);
    }
  }
  return [...owners].sort();
}

export function resolveRetirementMapping({
  baseSha,
  testFile,
  mappings = [],
  removedPaths = [],
  changedPaths = [],
  ownerPaths = [],
  existsCurrent = (file) => fs.existsSync(path.join(repositoryRoot, file)),
}) {
  const removed = new Set(removedPaths);
  const changed = new Set(changedPaths);
  const matching = [];
  for (const [index, mapping] of mappings.entries()) {
    const errors = validateRetirementMapping(mapping);
    if (errors.length > 0) {
      throw new Error(`invalid retirement mapping ${index}: ${errors.join('; ')}`);
    }
    const matched = mapping.test !== undefined
      ? mapping.test === testFile
      : mapping.tests !== undefined
        ? mapping.tests.includes(testFile)
        : matches(testFile, mapping.testPatterns);
    if (matched) matching.push({ index, mapping });
  }
  if (matching.length > 1) {
    throw new Error(
      `ambiguous retirement mappings for ${testFile}: ${matching.map(({ index }) => index).join(', ')}`,
    );
  }
  if (matching.length === 0) return null;
  const { mapping } = matching[0];
  if (mapping.baseSha !== baseSha) return null;
  const requiredRemovedPaths = mapping.requiredRemovedPaths ?? [];
  const requiredChangedPaths = mapping.requiredChangedPaths ?? [];
  const removedMatchers = requiredRemovedPaths.map(globToRegExp);
  const changedMatchers = requiredChangedPaths.map(globToRegExp);
  const removedPathsMatched = removedMatchers.every((expression) => (
    [...removed].some((candidate) => expression.test(candidate))
  ));
  const changedPathsMatched = changedMatchers.every((expression) => (
    [...changed].some((candidate) => expression.test(candidate))
  ));
  const replacementTests = mapping.replacementTests;
  const replacementsExist = replacementTests.every((replacement) => existsCurrent(replacement));
  const changedOwner = (owner) => (
    (removed.has(owner) && removedMatchers.some((expression) => expression.test(owner)))
    || (changed.has(owner) && changedMatchers.some((expression) => expression.test(owner)))
  );
  const declaredBaselineOwners = mapping.baselineOwnerPaths ?? [];
  const declaredOwnersBound = declaredBaselineOwners.length === 0 || declaredBaselineOwners.every(
    (owner) => ownerPaths.includes(owner) && changedOwner(owner),
  );
  const ownerBound = declaredOwnersBound && (
    mapping.test !== undefined
    || ownerPaths.some(changedOwner)
  );
  if (removedPathsMatched && changedPathsMatched && replacementsExist && ownerBound) {
    return mapping;
  }
  return null;
}

export function groupsForPath(file, policy) {
  let owners = Object.entries(policy.groups)
    .filter(([, group]) => matches(file, [...(group.paths ?? []), ...(group.tests ?? [])]))
    .map(([name]) => name)
    .sort();
  if (owners.length === 0 && /^__tests__\/.+\.test\.ts$/.test(file)) {
    const relative = file
      .replace(/^__tests__\//, '')
      .replace(/\.test\.ts$/, '');
    const [area, ...rest] = relative.split('/');
    const stem = rest.join('/');
    const candidates = [];
    if (area === 'api') {
      candidates.push(`src/api/${stem}.ts`, `src/api/routes/${stem}.ts`);
    } else if (area === 'integration') {
      candidates.push(`src/services/${stem}.ts`, `src/api/routes/${stem}.ts`);
    } else {
      candidates.push(`src/${area}/${stem}.ts`);
    }
    owners = Object.entries(policy.groups)
      .filter(([, group]) => candidates.some((candidate) => matches(candidate, group.paths ?? [])))
      .map(([name]) => name)
      .sort();
  }
  return owners;
}

export function classifyTestGroups(files, policy) {
  const mapped = new Set();
  const unmapped = [];
  for (const file of files) {
    if (!isRelevantPath(file)) continue;
    const owners = groupsForPath(file, policy);
    if (owners.length === 0) unmapped.push(file);
    owners.forEach((owner) => mapped.add(owner));
  }
  return { groups: [...mapped].sort(), unmapped: [...new Set(unmapped)].sort() };
}

export function contractTestsForGroups(groupNames, policy, allTests) {
  const candidates = [
    ...policy.core.tests,
    ...groupNames.flatMap((name) => policy.groups[name]?.contracts ?? []),
  ];
  return [...new Set(candidates)].filter((file) => allTests.includes(file)).sort();
}

const DOCS_ONLY_FORCE_FALSE_PREFIXES = [
  'docs/contracts/',
  'docs/project-map.json',
  'docs/engineering/backend-api-contract-standard.md',
  'docs/TOKEN-QUOTA-CONTRACT.md',
  'docs/release/continuous-deployment.md',
  'docs/release/release-evidence-contract.md',
  'docs/release/evidence/release-manifest-public-key.pem',
  'src/',
  'migrations/',
  '.github/workflows/',
  'config/continuous-deployment.json',
  'ops/local-backup/',
  'ops/nexus-release/',
  'scripts/',
  '__tests__/',
  'package-lock.json',
  'ops/pm2/package-lock.json',
  'content-engine/requirements-lock-tool.txt',
];

function matchesRepositoryPrefix(file, prefix) {
  return prefix.endsWith('/')
    ? file.startsWith(prefix)
    : file === prefix || file.startsWith(`${prefix}/`);
}

function isTokenQuotaContractPath(file) {
  if (!file.startsWith('docs/')) return false;
  return file.slice('docs/'.length).split('/').some((segment) => (
    segment.startsWith('TOKEN-QUOTA')
  ));
}

export function isDocsOnly(files) {
  return files.length > 0 && files.every((file) => {
    const forceFalse = isProductionMigrationArchivePath(file)
      || DOCS_ONLY_FORCE_FALSE_PREFIXES.some((prefix) => (
        matchesRepositoryPrefix(file, prefix)
      ))
      || file.startsWith('Dockerfile')
      || isTokenQuotaContractPath(file);
    if (forceFalse) return false;
    return file.startsWith('docs/')
      || file.startsWith('.agents/')
      || file.startsWith('.claude/')
      || ['AGENTS.md', 'CHANGELOG.md', 'CLAUDE.md', 'README.md'].includes(file);
  });
}

export function isRelevantPath(file) {
  if (isProductionMigrationArchivePath(file)) return true;
  if (
    file.startsWith('docs/')
    || file.startsWith('.agents/')
    || file.startsWith('.claude/')
    || file.startsWith('.codex/')
    || file.startsWith('.qa-queue/')
    || file === 'knowledge/1,000 Viral Hooks (PBL) (1).pdf'
    || file === 'knowledge/Storytelling Structures.docx'
    || ['AGENTS.md', 'CHANGELOG.md', 'CLAUDE.md', 'LICENSE', 'README.md', 'Cortex_Documentation.docx'].includes(file)
  ) {
    return false;
  }
  return true;
}
