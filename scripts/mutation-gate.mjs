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

export function isCriticalModule(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
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

export function buildMutationPlan({ base, changes, patterns }) {
  const targets = new Set();
  const cleanupTests = [];

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

    for (const dependency of resolveImportedSourcePaths(change.file, `${current}\n${previous}`)) {
      if (isCriticalModule(dependency, patterns)) targets.add(dependency);
    }
  }

  return {
    schema: 'nexus.mutation-plan.v1',
    base,
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    cleanupTests: [...new Set(cleanupTests)].sort(),
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
  });
  const outputDir = path.join(root, '.local/mutation');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify(plan, null, 2));

  if (planOnly || plan.targets.length === 0) {
    if (plan.targets.length === 0) console.log('No changed critical modules resolved; mutation run skipped.');
    return;
  }

  const thresholds = policy.mutation.thresholds;
  const config = path.join(root, 'config/stryker.config.mjs');
  const result = spawnSync(
    path.join(root, 'node_modules/.bin/stryker'),
    ['run', config, `--thresholds.high=${thresholds.high}`, `--thresholds.low=${thresholds.low}`, `--thresholds.break=${thresholds.break}`],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NEXUS_MUTATE_FILES: JSON.stringify(plan.targets),
      },
    },
  );
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
