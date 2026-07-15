#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { globToRegExp, loadTestPolicy, root } from './lib/test-policy.mjs';

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];

function git(args, options = {}) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', ...options });
}

export function extractRelativeImports(source) {
  const imports = new Set();
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) {
    if (match[1].startsWith('.')) imports.add(match[1]);
  }
  return [...imports].sort();
}

export function extractReferencedSourceLiterals(source) {
  const references = new Set();
  const pattern = /['"]((?:\.\.?\/)*src\/[^'"\n]+?\.(?:ts|tsx|js|mjs))['"]/g;
  for (const match of source.matchAll(pattern)) {
    const sourceIndex = match[1].indexOf('src/');
    if (sourceIndex >= 0) references.add(match[1].slice(sourceIndex));
  }
  return [...references].sort();
}

export function isCriticalModule(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

export function buildStrykerInvocation({ config, targets, thresholds }) {
  return {
    args: ['run', config],
    env: {
      NEXUS_MUTATE_FILES: JSON.stringify(targets),
      NEXUS_MUTATION_THRESHOLDS: JSON.stringify(thresholds),
    },
  };
}

export function resolveImportedSourcePaths(testFile, source, exists = fs.existsSync) {
  const resolved = new Set();
  for (const specifier of extractRelativeImports(source)) {
    const base = path.resolve(root, path.dirname(testFile), specifier);
    for (const suffix of SOURCE_EXTENSIONS) {
      const candidate = `${base}${suffix}`;
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if (relative.startsWith('src/') && exists(candidate)) {
        resolved.add(relative);
        break;
      }
    }
  }
  return [...resolved].sort();
}

export function resolveReferencedSourcePaths(testFile, source, exists = fs.existsSync) {
  const resolved = new Set(resolveImportedSourcePaths(testFile, source, exists));
  for (const reference of extractReferencedSourceLiterals(source)) {
    const absolute = path.join(root, reference);
    if (exists(absolute)) resolved.add(reference);
  }
  return [...resolved].sort();
}

export function validateCleanupMapping(mapping, exists = fs.existsSync) {
  if (!mapping || typeof mapping !== 'object') return ['mapping is missing'];
  const errors = [];
  if (!Array.isArray(mapping.replacementTests) || mapping.replacementTests.length === 0) {
    errors.push('replacementTests must contain at least one retained test');
  } else {
    for (const replacement of mapping.replacementTests) {
      if (typeof replacement !== 'string' || !replacement.startsWith('__tests__/') || !replacement.endsWith('.test.ts')) {
        errors.push(`invalid replacement test: ${String(replacement)}`);
      } else if (!exists(path.join(root, replacement))) {
        errors.push(`replacement test does not exist: ${replacement}`);
      }
    }
  }
  if (!Array.isArray(mapping.sources) || mapping.sources.length === 0) {
    errors.push('sources must contain at least one governed repository path');
  } else {
    for (const source of mapping.sources) {
      if (typeof source !== 'string' || path.isAbsolute(source) || source.includes('..')) {
        errors.push(`invalid source path: ${String(source)}`);
      } else if (!exists(path.join(root, source))) {
        errors.push(`source path does not exist: ${source}`);
      }
    }
  }
  if (typeof mapping.reason !== 'string' || mapping.reason.trim().length < 12) {
    errors.push('reason must explain the conversion or merge');
  }
  return errors;
}

export function resolveDeletedTestCleanupMappings(changes, cleanupMappings, exists = fs.existsSync) {
  const mappingByTest = new Map(cleanupMappings.map((mapping) => [mapping.test, mapping]));
  const resolved = [];
  const unmapped = [];
  const invalid = [];

  for (const change of changes) {
    if (!change.status.startsWith('D') || !change.file.startsWith('__tests__/') || !change.file.endsWith('.test.ts')) {
      continue;
    }
    const previousFile = change.previous ?? change.file;
    const mapping = mappingByTest.get(change.file) ?? mappingByTest.get(previousFile);
    if (!mapping) {
      unmapped.push(change.file);
      continue;
    }
    const errors = validateCleanupMapping(mapping, exists);
    if (errors.length > 0) invalid.push({ test: change.file, errors });
    else resolved.push(mapping);
  }

  return {
    resolved: resolved.sort((a, b) => a.test.localeCompare(b.test)),
    unmapped: [...new Set(unmapped)].sort(),
    invalid,
  };
}

function readAtBase(base, file) {
  const result = git(['show', `${base}:${file}`]);
  return result.status === 0 ? result.stdout : '';
}

function parseChangedFiles(base) {
  const result = git(['diff', '--name-status', '--find-renames', base, 'HEAD']);
  if (result.status !== 0) throw new Error(result.stderr || `Unable to diff ${base}..HEAD`);
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [status, first, second] = line.split('\t');
    return { status, file: second ?? first, previous: second ? first : null };
  });
}

export function buildMutationPlan({ base, changes, patterns, cleanupMappings = [] }) {
  const targets = new Set();
  const cleanupTests = [];
  const deletedTestAudit = resolveDeletedTestCleanupMappings(changes, cleanupMappings);
  const mappingByTest = new Map(cleanupMappings.map((mapping) => [mapping.test, mapping]));

  for (const change of changes) {
    if (change.file.startsWith('src/') && !change.status.startsWith('D') && isCriticalModule(change.file, patterns)) {
      targets.add(change.file);
    }
    if (!change.file.startsWith('__tests__/') || !change.file.endsWith('.test.ts')) continue;

    const current = fs.existsSync(path.join(root, change.file))
      ? fs.readFileSync(path.join(root, change.file), 'utf8')
      : '';
    const previousFile = change.previous ?? change.file;
    const previous = readAtBase(base, previousFile);
    if (change.status.startsWith('D') || previous.length > current.length) cleanupTests.push(change.file);

    const mapping = mappingByTest.get(change.file) ?? mappingByTest.get(previousFile);
    const dependencies = new Set(resolveReferencedSourcePaths(change.file, `${current}\n${previous}`));
    for (const source of mapping?.sources ?? []) dependencies.add(source);
    for (const dependency of dependencies) {
      if (isCriticalModule(dependency, patterns)) targets.add(dependency);
    }
  }

  return {
    schema: 'nexus.mutation-plan.v2',
    base,
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    cleanupTests: [...new Set(cleanupTests)].sort(),
    cleanupMappings: deletedTestAudit.resolved,
    unmappedDeletedTests: deletedTestAudit.unmapped,
    invalidCleanupMappings: deletedTestAudit.invalid,
    targets: [...targets].filter((file) => fs.existsSync(path.join(root, file))).sort(),
  };
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const base = valueOf('--base');
  const planOnly = args.includes('--plan');
  if (!base) {
    console.error('Usage: mutation-gate.mjs --base <sha> [--plan]');
    process.exit(64);
  }
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).status !== 0) {
    console.error(`Mutation base does not resolve: ${base}`);
    process.exit(2);
  }

  const policy = loadTestPolicy();
  const changes = parseChangedFiles(base);
  const plan = buildMutationPlan({
    base,
    changes,
    patterns: policy.mutation.criticalModulePatterns,
    cleanupMappings: policy.mutation.cleanupMappings,
  });
  const outputDir = path.join(root, '.local/mutation');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify(plan, null, 2));

  if (plan.unmappedDeletedTests.length > 0 || plan.invalidCleanupMappings.length > 0) {
    console.error('Deleted tests must have a valid source-to-replacement cleanup mapping.');
    process.exit(3);
  }

  if (planOnly || plan.targets.length === 0) {
    if (plan.targets.length === 0) console.log('No changed critical modules resolved; mutation run skipped.');
    return;
  }

  const thresholds = policy.mutation.thresholds;
  const config = path.join(root, 'config/stryker.config.mjs');
  const invocation = buildStrykerInvocation({ config, targets: plan.targets, thresholds });
  const result = spawnSync(
    path.join(root, 'node_modules/.bin/stryker'),
    invocation.args,
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        ...invocation.env,
      },
    },
  );
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
