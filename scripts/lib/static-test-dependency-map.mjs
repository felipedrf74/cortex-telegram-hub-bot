import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CODE_EXTENSIONS = Object.freeze([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
]);
const RESOLUTION_EXTENSIONS = Object.freeze([...CODE_EXTENSIONS, '.json']);

function posix(value) {
  return value.split(path.sep).join('/');
}

function cleanGitEnv() {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return env;
}

function git(sourceRoot, gitArgs) {
  return execFileSync('git', gitArgs, {
    cwd: sourceRoot,
    env: cleanGitEnv(),
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function trackedFiles(sourceRoot) {
  return git(sourceRoot, ['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .map(posix)
    .sort();
}

export function changedFilesSince(sourceRoot, base) {
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) {
    throw new Error('static dependency selection requires an exact base SHA');
  }
  return [...new Set(git(sourceRoot, [
    'diff', '--no-ext-diff', '--no-renames', '--name-only',
    '--diff-filter=ACDMRTUXB', `${base}...HEAD`,
  ]).split(/\r?\n/).map(posix).filter(Boolean))].sort();
}

function removedTestFilesSince(sourceRoot, base) {
  return [...new Set(git(sourceRoot, [
    'diff', '--no-ext-diff', '--no-renames', '--name-only',
    '--diff-filter=D', `${base}...HEAD`, '--', '__tests__',
  ]).split(/\r?\n/).map(posix).filter((file) => /^__tests__\/.+\.test\.ts$/.test(file)))].sort();
}

function importSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:(?:type\s+)?[\w$*{},\s]{0,4096}?\sfrom\s*)?['"]([^'"\n]+)['"]/g,
    /\b(?:import|require(?:\.resolve)?)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\b(?:vi|jest)\.(?:mock|doMock|unmock)\s*\(\s*['"]([^'"\n]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

function skipQuoted(source, start, quote) {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index + 1;
  }
  return source.length;
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source.startsWith('//', index)) {
      index = source.indexOf('\n', index + 2);
      if (index === -1) return source.length;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      if (end === -1) return source.length;
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function hasNonLiteralModuleLoad(source) {
  const identifier = /[A-Za-z0-9_$]/;
  for (let index = 0; index < source.length;) {
    if (source.startsWith('//', index)) {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', index)) {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (source[index] === "'" || source[index] === '"' || source[index] === '`') {
      index = skipQuoted(source, index, source[index]);
      continue;
    }
    const keyword = source.startsWith('require', index)
      ? 'require'
      : source.startsWith('import', index)
        ? 'import'
        : null;
    if (!keyword
        || (index > 0 && identifier.test(source[index - 1]))
        || identifier.test(source[index + keyword.length] ?? '')) {
      index += 1;
      continue;
    }
    let cursor = skipTrivia(source, index + keyword.length);
    if (keyword === 'require' && source[cursor] === '.') {
      cursor = skipTrivia(source, cursor + 1);
      if (!source.startsWith('resolve', cursor)) {
        index += keyword.length;
        continue;
      }
      cursor = skipTrivia(source, cursor + 'resolve'.length);
    }
    if (source[cursor] !== '(') {
      index += keyword.length;
      continue;
    }
    cursor = skipTrivia(source, cursor + 1);
    if (source[cursor] !== "'" && source[cursor] !== '"') return true;
    index = skipQuoted(source, cursor, source[cursor]);
  }
  return false;
}

function resolutionCandidates(importer, specifier) {
  if (!specifier.startsWith('.')) return [];
  const base = posix(path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)));
  if (base === '..' || base.startsWith('../') || path.posix.isAbsolute(base)) return [];
  const extension = path.posix.extname(base);
  const candidates = [base];
  if (!extension) {
    for (const suffix of RESOLUTION_EXTENSIONS) candidates.push(`${base}${suffix}`);
    for (const suffix of RESOLUTION_EXTENSIONS) candidates.push(`${base}/index${suffix}`);
  } else if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    for (const suffix of ['.ts', '.tsx', '.mts', '.cts']) {
      candidates.push(`${base.slice(0, -extension.length)}${suffix}`);
    }
  }
  return [...new Set(candidates)];
}

function resolveSpecifier(importer, specifier, repositoryFiles) {
  return resolutionCandidates(importer, specifier)
    .find((candidate) => repositoryFiles.has(candidate)) ?? null;
}

export function staticTestDependencyImpact(sourceRoot, base) {
  const changed = changedFilesSince(sourceRoot, base);
  const tracked = trackedFiles(sourceRoot);
  const trackedSet = new Set(tracked);
  const removedTestFiles = removedTestFilesSince(sourceRoot, base);
  const repositoryFiles = new Set([...tracked, ...changed]);
  const reverseDependencies = new Map();
  const nonLiteralImporters = new Set();

  for (const importer of tracked) {
    if (!CODE_EXTENSIONS.includes(path.posix.extname(importer))) continue;
    const absolute = path.join(sourceRoot, ...importer.split('/'));
    if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) continue;
    const source = fs.readFileSync(absolute, 'utf8');
    if (hasNonLiteralModuleLoad(source)) nonLiteralImporters.add(importer);
    for (const specifier of importSpecifiers(source)) {
      const dependency = resolveSpecifier(importer, specifier, repositoryFiles);
      if (!dependency) continue;
      const importers = reverseDependencies.get(dependency) ?? new Set();
      importers.add(importer);
      reverseDependencies.set(dependency, importers);
    }
  }

  const affectedTests = new Set();
  const unresolvedProductionFiles = [];
  const nonLiteralTests = [...nonLiteralImporters]
    .filter((file) => /^__tests__\/.+\.test\.ts$/.test(file));
  const hasUnknownProductionTopology = [...nonLiteralImporters]
    .some((file) => /^src\/.+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file));
  for (const seed of changed) {
    const queue = [seed];
    const affected = new Set([seed]);
    while (queue.length > 0) {
      const dependency = queue.shift();
      for (const importer of reverseDependencies.get(dependency) ?? []) {
        if (affected.has(importer)) continue;
        affected.add(importer);
        queue.push(importer);
      }
    }
    const tests = [...new Set([
      ...[...affected].filter((file) => (
        /^__tests__\/.+\.test\.ts$/.test(file) && trackedSet.has(file)
      )),
      ...(/^src\/.+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(seed) ? nonLiteralTests : []),
    ])];
    for (const test of tests) affectedTests.add(test);
    if (/^src\/.+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(seed)
        && (tests.length === 0 || nonLiteralImporters.has(seed) || hasUnknownProductionTopology)) {
      unresolvedProductionFiles.push(seed);
    }
  }
  return {
    changedFiles: changed,
    tests: [...affectedTests].sort(),
    removedTestFiles,
    unresolvedProductionFiles: [...new Set(unresolvedProductionFiles)].sort(),
    nonLiteralImporters: [...nonLiteralImporters].sort(),
  };
}
