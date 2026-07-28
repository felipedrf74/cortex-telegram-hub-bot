#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cleanGitEnv, resolveExactCommit } from './lib/git-ref.mjs';
import {
  globToRegExp,
  loadTestPolicy,
  resolveTestDisposition,
  root,
} from './lib/test-policy.mjs';
import {
  loadTestGroups,
  resolveRetirementMapping,
  retirementOwnerCandidates,
} from './lib/test-groups.mjs';
import {
  gitMergeBaseArgs,
  gitNameStatusDiffArgs,
  gitNameStatusRecordsToChanges,
  parseGitNameStatusRecordsZ,
} from './lib/git-changed-paths.mjs';

const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];
const MUTATION_SCOPES = new Set(['test-cleanup', 'changed-critical']);
const STRYKER_MUTATION_TARGET = /^([^:]+):([1-9]\d*)-([1-9]\d*)$/;
const MAX_MUTATION_RANGE_LINES = 12;
const TEST_FUNCTIONS = new Set(['it', 'test']);
const TEST_MODIFIERS = new Set([
  'concurrent',
  'each',
  'fails',
  'only',
  'runIf',
  'skip',
  'skipIf',
  'todo',
]);
const ASSERTION_FUNCTIONS = new Set(['assert', 'expect', 'expectTypeOf']);
const MUTATION_STATUSES = new Set(['Killed', 'Survived', 'Timeout', 'NoCoverage']);
const DETECTED_MUTATION_STATUSES = new Set(['Killed', 'Timeout']);
const requireFromMutationGate = createRequire(import.meta.url);
let ts;
let printer;

function loadTypeScriptEvidenceRuntime() {
  if (ts && printer) return;
  try {
    ts = requireFromMutationGate('typescript');
  } catch (error) {
    if (
      error?.code === 'MODULE_NOT_FOUND'
      && String(error.message).includes('typescript')
    ) {
      const unavailable = new Error(
        'TypeScript test-evidence analysis requires installed dependencies; '
        + 'run it only after npm ci',
        { cause: error },
      );
      unavailable.code = 'NEXUS_TYPESCRIPT_EVIDENCE_UNAVAILABLE';
      throw unavailable;
    }
    throw error;
  }
  printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
}

function git(args, options = {}) {
  const { env: overrides = {}, ...spawnOptions } = options;
  return spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    ...spawnOptions,
    env: { ...cleanGitEnv(), ...overrides },
  });
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

function canonicalNode(node, sourceFile) {
  loadTypeScriptEvidenceRuntime();
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, ' ').trim();
}

function normalizeEvidenceLiterals(value) {
  return value
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, '<string>')
    .replace(/\b(?:0[xob][\da-f]+|\d+(?:\.\d+)?)\b/gi, '<number>');
}

function calleeIdentity(expression) {
  if (ts.isIdentifier(expression)) return { root: expression.text, modifiers: [] };
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = calleeIdentity(expression.expression);
    return parent ? { root: parent.root, modifiers: [...parent.modifiers, expression.name.text] } : null;
  }
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    const parent = calleeIdentity(expression.expression);
    return parent
      ? { root: parent.root, modifiers: [...parent.modifiers, expression.argumentExpression.text] }
      : null;
  }
  if (ts.isCallExpression(expression)) return calleeIdentity(expression.expression);
  if (ts.isTaggedTemplateExpression(expression)) return calleeIdentity(expression.tag);
  return null;
}

function isTestDeclarationCall(node) {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isCallExpression(node.parent) && node.parent.expression === node) return false;
  const identity = calleeIdentity(node.expression);
  return Boolean(
    identity
    && TEST_FUNCTIONS.has(identity.root)
    && identity.modifiers.every((modifier) => TEST_MODIFIERS.has(modifier)),
  );
}

function isAssertionExpression(expression) {
  if (!expression) return false;
  if (
    ts.isAwaitExpression(expression)
    || ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isNonNullExpression(expression)
  ) {
    return isAssertionExpression(expression.expression);
  }
  if (!ts.isCallExpression(expression)) return false;
  const identity = calleeIdentity(expression.expression);
  return Boolean(identity && ASSERTION_FUNCTIONS.has(identity.root));
}

function assertionRootCall(expression) {
  let current = expression;
  while (
    ts.isAwaitExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  if (ts.isCallExpression(current)) {
    const directAssertionCallee = (callee) => {
      if (ts.isIdentifier(callee)) return ASSERTION_FUNCTIONS.has(callee.text);
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        return directAssertionCallee(callee.expression);
      }
      return false;
    };
    if (directAssertionCallee(current.expression)) return current;
    return assertionRootCall(current.expression);
  }
  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return assertionRootCall(current.expression);
  }
  return null;
}

function assertionFingerprint(expression, sourceFile) {
  let current = expression;
  while (
    ts.isAwaitExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression;
  if (!ts.isCallExpression(current)) return canonicalNode(current, sourceFile);
  const identity = calleeIdentity(current.expression);
  const rootCall = assertionRootCall(current);
  const root = identity?.root ?? '<assertion>';
  const subjectArguments = rootCall?.arguments.slice(0, 1) ?? current.arguments.slice(0, 1);
  const subject = subjectArguments.map((argument) => canonicalNode(argument, sourceFile)
    .replace(/^[A-Za-z_$][\w$]*(?=\.|\[|$)/, '<subject>')).join(',');
  return `${root}(${subject})::${identity?.modifiers.join('.') ?? ''}`;
}

function hasRemovedEvidence(previousEvidence, currentEvidence) {
  const remaining = new Map();
  for (const evidence of currentEvidence) remaining.set(evidence, (remaining.get(evidence) ?? 0) + 1);
  for (const evidence of previousEvidence) {
    const count = remaining.get(evidence) ?? 0;
    if (count === 0) return true;
    remaining.set(evidence, count - 1);
  }
  return false;
}

function hasEvidenceCardinalityDecrease(previousEvidence, currentEvidence) {
  return previousEvidence.length > currentEvidence.length
    || new Set(previousEvidence).size > new Set(currentEvidence).size;
}

function buildVariableInitializerIndex(sourceFile) {
  const index = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer
    ) {
      const declarations = index.get(node.name.text) ?? [];
      declarations.push({ position: node.pos, initializer: node.initializer });
      index.set(node.name.text, declarations);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return index;
}

function initializerFor(identifier, variableInitializers) {
  const declarations = variableInitializers.get(identifier.text) ?? [];
  return [...declarations]
    .filter(({ position }) => position < identifier.pos)
    .sort((left, right) => right.position - left.position)[0]?.initializer ?? null;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionFingerprint(expression, sourceFile, variableInitializers, seen = new Set()) {
  const current = unwrapExpression(expression);
  const dependencies = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && !seen.has(node.text)) {
      const initializer = initializerFor(node, variableInitializers);
      if (initializer) {
        dependencies.push(`${node.text}=(${expressionFingerprint(
          initializer,
          sourceFile,
          variableInitializers,
          new Set(seen).add(node.text),
        )})`);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(current);
  return [canonicalNode(current, sourceFile), ...dependencies.sort()].join('|');
}

function resolveEachRows(node, sourceFile, variableInitializers) {
  const expression = node.expression;
  const identity = calleeIdentity(expression);
  if (!identity?.modifiers.includes('each')) return [];

  let table = null;
  if (ts.isCallExpression(expression)) table = expression.arguments[0] ?? null;
  else if (ts.isTaggedTemplateExpression(expression)) table = expression.template;
  if (!table) return [];
  let resolved = unwrapExpression(table);
  const seen = new Set();
  while (ts.isIdentifier(resolved) && !seen.has(resolved.text)) {
    seen.add(resolved.text);
    const initializer = initializerFor(resolved, variableInitializers);
    if (!initializer) break;
    resolved = unwrapExpression(initializer);
  }
  if (ts.isArrayLiteralExpression(resolved)) {
    return resolved.elements.map((row) => expressionFingerprint(row, sourceFile, variableInitializers));
  }
  if (ts.isNoSubstitutionTemplateLiteral(resolved) || ts.isTemplateExpression(resolved)) {
    return resolved.getText(sourceFile).slice(1, -1).split(/\r?\n/)
      .map((row) => row.trim().replace(/\s+/g, ' ')).filter(Boolean);
  }
  return [expressionFingerprint(resolved, sourceFile, variableInitializers)];
}

function controlFlowFingerprint(node, sourceFile) {
  const structural = (expression) => normalizeEvidenceLiterals(canonicalNode(expression, sourceFile));
  if (ts.isIfStatement(node)) return `if:${structural(node.expression)}`;
  if (ts.isConditionalExpression(node)) return `conditional:${structural(node.condition)}`;
  if (ts.isWhileStatement(node)) return `while:${structural(node.expression)}`;
  if (ts.isDoStatement(node)) return `do:${structural(node.expression)}`;
  if (ts.isForStatement(node)) {
    return `for:${[node.initializer, node.condition, node.incrementor]
      .map((part) => part ? structural(part) : '')
      .join(';')}`;
  }
  if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    return `for:${structural(node.initializer)}:${structural(node.expression)}`;
  }
  if (ts.isSwitchStatement(node)) return `switch:${structural(node.expression)}`;
  if (ts.isCaseClause(node)) return `case:${structural(node.expression)}`;
  return null;
}

export function extractTestEvidence(source, fileName = 'mutation-gate-input.test.ts') {
  loadTypeScriptEvidenceRuntime();
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const variableInitializers = buildVariableInitializerIndex(sourceFile);

  let declarationCount = 0;
  const assertions = [];
  const eachRows = [];
  const controlFlow = [];
  const visit = (node, insideTest = false) => {
    const testDeclaration = isTestDeclarationCall(node);
    if (testDeclaration) {
      declarationCount += 1;
      const title = node.arguments[0] ? canonicalNode(node.arguments[0], sourceFile) : '<anonymous>';
      for (const row of resolveEachRows(node, sourceFile, variableInitializers)) {
        eachRows.push(`${title}:${row}`);
      }
    }
    const assertionExpression = ts.isExpressionStatement(node)
      ? node.expression
      : ts.isReturnStatement(node)
        ? node.expression
        : ts.isArrowFunction(node) && !ts.isBlock(node.body)
          ? node.body
        : null;
    if (assertionExpression && isAssertionExpression(assertionExpression)) {
      assertions.push(assertionFingerprint(assertionExpression, sourceFile));
      return;
    }
    const flowFingerprint = insideTest ? controlFlowFingerprint(node, sourceFile) : null;
    if (flowFingerprint) controlFlow.push(flowFingerprint);
    ts.forEachChild(node, (child) => visit(child, insideTest || testDeclaration));
  };
  visit(sourceFile);

  return {
    declarationCount,
    assertions: assertions.sort(),
    eachRows: eachRows.sort(),
    controlFlow: controlFlow.sort(),
    parseDiagnostics: sourceFile.parseDiagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      start: diagnostic.start ?? null,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    })),
  };
}

export function countTestDeclarations(source) {
  return extractTestEvidence(source).declarationCount;
}

export function isTestCleanupChange(change, current, previous) {
  if (change.status.startsWith('D')) return true;
  if (change.status.startsWith('A')) return false;
  const currentEvidence = extractTestEvidence(current, change.file ?? 'current.test.ts');
  const previousEvidence = extractTestEvidence(previous, change.previous ?? change.file ?? 'previous.test.ts');
  return currentEvidence.parseDiagnostics.length > 0
    || previousEvidence.parseDiagnostics.length > 0
    || previousEvidence.declarationCount > currentEvidence.declarationCount
    || hasRemovedEvidence(previousEvidence.assertions, currentEvidence.assertions)
    || hasEvidenceCardinalityDecrease(previousEvidence.eachRows, currentEvidence.eachRows)
    || hasEvidenceCardinalityDecrease(previousEvidence.controlFlow, currentEvidence.controlFlow);
}

export function parseMutationTarget(target) {
  if (typeof target !== 'string') return null;
  const match = STRYKER_MUTATION_TARGET.exec(target);
  if (!match) return null;
  const startLine = Number(match[2]);
  const endLine = Number(match[3]);
  if (startLine > endLine) return null;
  return { file: match[1], startLine, endLine };
}

export function parseAddedLines(diff) {
  const lines = new Set();
  for (const line of String(diff).split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
  }
  return lines;
}

export function coalesceMutationLineTargets(file, lineNumbers) {
  const lines = [...new Set(lineNumbers)]
    .filter((line) => Number.isSafeInteger(line) && line >= 1)
    .sort((left, right) => left - right);
  const targets = [];
  let start = null;
  let end = null;
  for (const line of lines) {
    if (start === null) {
      start = line;
      end = line;
    } else if (line === end + 1) {
      end = line;
    } else {
      targets.push(`${file}:${start}-${end}`);
      start = line;
      end = line;
    }
  }
  if (start !== null) targets.push(`${file}:${start}-${end}`);
  return targets;
}

export function buildWeeklyMutationSelection(
  plan,
  readDiff = (base, file) => {
    const result = git(['diff', '--unified=0', '--no-color', base, 'HEAD', '--', file]);
    if (result.status !== 0) {
      throw new Error(result.stderr || `Unable to resolve changed mutation lines for ${file}`);
    }
    return result.stdout;
  },
) {
  if (plan?.scope !== 'changed-critical') {
    return {
      ...plan,
      mutationBatches: plan?.targets?.length > 0
        ? [{
            index: 0,
            sources: [...plan.governedSources],
            targets: [...plan.targets],
          }]
        : [],
    };
  }
  const targets = [];
  const selection = [];
  const mutationBatches = [];
  const ownerTestFilesBySource = new Map(
    (plan.ownerTestMappings ?? []).map((mapping) => [mapping.source, mapping.testFiles]),
  );
  for (const [index, source] of plan.governedSources.entries()) {
    const addedLines = [...parseAddedLines(readDiff(plan.base, source))]
      .sort((left, right) => left - right);
    // A deletion-only critical edit has no new-line range. Preserve the prior
    // fail-closed full-file behavior instead of silently dropping that source.
    const sourceTargets = addedLines.length > 0
      ? coalesceMutationLineTargets(source, addedLines)
      : [source];
    const ownerTestFiles = ownerTestFilesBySource.get(source) ?? [];
    targets.push(...sourceTargets);
    selection.push({
      source,
      addedLines: addedLines.length,
      ranges: sourceTargets.length,
      fallback: addedLines.length === 0 ? 'full-file-deletion-only' : null,
      ownerTestFiles,
    });
    mutationBatches.push({
      index,
      sources: [source],
      targets: sourceTargets,
      ...(ownerTestFiles.length > 0 ? { testFiles: ownerTestFiles } : {}),
    });
  }
  return {
    ...plan,
    targets,
    weeklySelection: selection,
    mutationBatches,
  };
}

export function resolveEmptyRangeFallback({ generatedMutants, targets, sources }) {
  if (
    generatedMutants === 0
    && Array.isArray(targets)
    && targets.length > 0
    && targets.every((target) => parseMutationTarget(target) !== null)
    && Array.isArray(sources)
    && sources.length === 1
  ) {
    return {
      reason: 'full-file-no-generated-mutants',
      targets: [sources[0]],
    };
  }
  return null;
}

function mutationTargetPattern(target) {
  return typeof target === 'object' && target !== null ? target.pattern : null;
}

function mutationRangesOverlap(left, right) {
  return left.file === right.file
    && left.startLine <= right.endLine
    && right.startLine <= left.endLine;
}

function validateOwnerTestSelector(target) {
  const hasExactName = typeof target.ownerTestName === 'string' && target.ownerTestName.trim().length > 0;
  const hasNamePattern = typeof target.ownerTestNamePattern === 'string'
    && target.ownerTestNamePattern.trim().length > 0;
  if (hasExactName === hasNamePattern) {
    return [`mutation target must declare exactly one ownerTestName or ownerTestNamePattern: ${target.pattern}`];
  }
  if (hasExactName && target.ownerTestName.trim().length < 20) {
    return [`mutation target ownerTestName is insufficiently specific: ${target.pattern}`];
  }
  if (hasNamePattern) {
    if (target.ownerTestNamePattern.trim().length < 12) {
      return [`mutation target ownerTestNamePattern is insufficiently specific: ${target.pattern}`];
    }
    try {
      new RegExp(target.ownerTestNamePattern);
    } catch {
      return [`mutation target ownerTestNamePattern is invalid: ${target.pattern}`];
    }
  }
  return [];
}

function ownerTestNameMatches(testName, target) {
  if (typeof target.ownerTestName === 'string') return testName === target.ownerTestName;
  return new RegExp(target.ownerTestNamePattern).test(testName);
}

function readGovernedMutationSource(candidate) {
  const sourceRoot = process.env.NEXUS_MUTATION_SOURCE_ROOT;
  if (sourceRoot === undefined) return fs.readFileSync(candidate, 'utf8');

  const relative = path.relative(root, path.resolve(candidate));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Mutation source escaped the Stryker sandbox: ${candidate}`);
  }
  return fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
}

export function validateGovernedMutationTarget(
  target,
  mapping,
  exists = fs.existsSync,
  readSource = readGovernedMutationSource,
) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return ['mutation target must be a structured ownership entry'];
  }
  const errors = [];
  const parsed = parseMutationTarget(target.pattern);
  if (!parsed) return [`invalid mutation target pattern: ${String(target.pattern)}`];
  if (parsed.endLine - parsed.startLine + 1 > MAX_MUTATION_RANGE_LINES) {
    errors.push(`mutation target range exceeds ${MAX_MUTATION_RANGE_LINES} lines: ${target.pattern}`);
  }

  const sources = new Set(Array.isArray(mapping.sources) ? mapping.sources : []);
  const replacements = new Set(Array.isArray(mapping.replacementTests) ? mapping.replacementTests : []);
  const absoluteSource = path.join(root, parsed.file);
  if (!sources.has(parsed.file)) {
    errors.push(`mutation target source is not governed by mapping.sources: ${parsed.file}`);
  }
  if (!exists(absoluteSource)) {
    errors.push(`mutation target source does not exist: ${parsed.file}`);
  } else {
    const lines = readSource(absoluteSource).split(/\r?\n/);
    if (parsed.endLine > lines.length) {
      errors.push(`mutation target line range exceeds ${parsed.file} (${lines.length} lines): ${target.pattern}`);
    } else if (typeof target.anchor !== 'string' || target.anchor.trim().length < 3) {
      errors.push(`mutation target anchor is missing: ${target.pattern}`);
    } else {
      const selectedLines = lines.slice(parsed.startLine - 1, parsed.endLine).join('\n');
      const anchorOccurrences = selectedLines.split(target.anchor).length - 1;
      if (anchorOccurrences === 0) {
        errors.push(`mutation target anchor is absent from selected lines: ${target.pattern}`);
      } else if (anchorOccurrences !== 1) {
        errors.push(`mutation target anchor must occur exactly once in selected lines: ${target.pattern}`);
      }
    }
  }
  if (typeof target.behavior !== 'string' || target.behavior.trim().length < 20) {
    errors.push(`mutation target behavior is missing: ${target.pattern}`);
  }
  if (!Number.isInteger(target.minimumMutants) || target.minimumMutants < 1) {
    errors.push(`mutation target minimumMutants must be a positive integer: ${target.pattern}`);
  }
  if (typeof target.replacementTest !== 'string' || !replacements.has(target.replacementTest)) {
    errors.push(`mutation target replacementTest is not retained by the cleanup mapping: ${target.pattern}`);
  } else if (!exists(path.join(root, target.replacementTest))) {
    errors.push(`mutation target replacementTest does not exist: ${target.replacementTest}`);
  }
  errors.push(...validateOwnerTestSelector(target));
  return errors;
}

export function validateMutationException(
  exception,
  exists = fs.existsSync,
  now = Date.now(),
  criticalModulePatterns = [],
) {
  if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
    return ['mutation exception must be an object'];
  }
  const errors = [];
  if (
    typeof exception.file !== 'string'
    || !exception.file.startsWith('src/')
    || path.isAbsolute(exception.file)
    || exception.file.includes('..')
  ) {
    errors.push(`invalid mutation exception file: ${String(exception.file)}`);
  } else if (!exists(path.join(root, exception.file))) {
    errors.push(`mutation exception file does not exist: ${exception.file}`);
  } else if (!isCriticalModule(exception.file, criticalModulePatterns)) {
    errors.push(`mutation exception file is outside governed critical module patterns: ${exception.file}`);
  }
  if (typeof exception.owner !== 'string' || exception.owner.trim().length < 3) {
    errors.push(`mutation exception owner is missing: ${String(exception.file)}`);
  }
  if (typeof exception.reason !== 'string' || exception.reason.trim().length < 20) {
    errors.push(`mutation exception reason is insufficient: ${String(exception.file)}`);
  }
  if (typeof exception.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exception.expires)) {
    errors.push(`mutation exception expiry is invalid: ${String(exception.file)}`);
  } else {
    const expiresAt = Date.parse(`${exception.expires}T23:59:59.999Z`);
    const normalized = Number.isFinite(expiresAt)
      ? new Date(expiresAt).toISOString().slice(0, 10)
      : null;
    if (normalized !== exception.expires) {
      errors.push(`mutation exception expiry is invalid: ${String(exception.file)}`);
    } else if (expiresAt <= now) {
      errors.push(`mutation exception expiry is not in the future: ${String(exception.file)}`);
    }
  }
  return errors;
}

export function validateMutationOwnerTestMapping(
  mapping,
  exists = fs.existsSync,
  criticalModulePatterns = [],
  testPolicy = loadTestPolicy(),
) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return ['mutation owner-test mapping must be an object'];
  }
  const errors = [];
  if (
    typeof mapping.source !== 'string'
    || !mapping.source.startsWith('src/')
    || path.isAbsolute(mapping.source)
    || mapping.source.includes('..')
  ) {
    errors.push(`invalid mutation owner source: ${String(mapping.source)}`);
  } else if (!exists(path.join(root, mapping.source))) {
    errors.push(`mutation owner source does not exist: ${mapping.source}`);
  } else if (!isCriticalModule(mapping.source, criticalModulePatterns)) {
    errors.push(`mutation owner source is outside governed critical module patterns: ${mapping.source}`);
  }
  if (!Array.isArray(mapping.testFiles) || mapping.testFiles.length === 0) {
    errors.push(`mutation owner testFiles must contain at least one retained test: ${String(mapping.source)}`);
  } else {
    const seen = new Set();
    for (const testFile of mapping.testFiles) {
      if (
        typeof testFile !== 'string'
        || !testFile.startsWith('__tests__/')
        || !testFile.endsWith('.test.ts')
        || path.isAbsolute(testFile)
        || testFile.includes('..')
      ) {
        errors.push(`invalid mutation owner test file: ${String(testFile)}`);
      } else if (seen.has(testFile)) {
        errors.push(`duplicate mutation owner test file: ${testFile}`);
      } else if (!exists(path.join(root, testFile))) {
        errors.push(`mutation owner test file does not exist: ${testFile}`);
      } else {
        const resolution = resolveTestDisposition(testFile, testPolicy);
        if (resolution === null) {
          errors.push(`mutation owner test file has no policy disposition: ${testFile}`);
        } else if (resolution.disposition !== 'keep') {
          errors.push(
            `mutation owner test file must have keep disposition, found ${resolution.disposition}: ${testFile}`,
          );
        }
      }
      seen.add(testFile);
    }
  }
  if (typeof mapping.reason !== 'string' || mapping.reason.trim().length < 20) {
    errors.push(`mutation owner reason is insufficient: ${String(mapping.source)}`);
  }
  return errors;
}

export function buildStrykerInvocation({ config, targets, thresholds, testFiles, scope = 'changed-critical' }) {
  const env = {
    NEXUS_MUTATE_FILES: JSON.stringify(targets),
    NEXUS_MUTATION_THRESHOLDS: JSON.stringify(thresholds),
    NEXUS_MUTATION_SCOPE: scope,
  };
  if (testFiles?.length > 0) {
    env.NEXUS_MUTATION_TEST_FILES = JSON.stringify(testFiles);
  }
  return {
    args: ['run', config],
    env,
  };
}

export function buildStrykerEnvironment(baseEnvironment, invocationEnvironment) {
  const environment = {
    ...baseEnvironment,
    NODE_ENV: 'test',
    NEXUS_MUTATION_SOURCE_ROOT: root,
    ...invocationEnvironment,
  };
  if (!Object.hasOwn(invocationEnvironment, 'NEXUS_MUTATION_TEST_FILES')) {
    delete environment.NEXUS_MUTATION_TEST_FILES;
  }
  return environment;
}

export function validateMutationExecutionReport(
  report,
  { targets, testFiles = [] },
) {
  const errors = [];
  const config = report?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return ['Stryker report is missing its effective config'];
  }
  if (JSON.stringify(config.mutate) !== JSON.stringify(targets)) {
    errors.push('Stryker report mutate targets differ from the batch execution targets');
  }
  if (testFiles.length > 0) {
    if (JSON.stringify(config.testFiles) !== JSON.stringify(testFiles)) {
      errors.push('Stryker report testFiles differ from the batch owner-test mapping');
    }
  } else if (config.testFiles !== undefined) {
    errors.push('Stryker report unexpectedly narrows an unmapped batch with testFiles');
  }
  if (config.concurrency !== 1) {
    errors.push(`Stryker report concurrency must be 1, found ${String(config.concurrency)}`);
  }
  if (config.testRunner !== 'vitest') {
    errors.push(`Stryker report testRunner must be vitest, found ${String(config.testRunner)}`);
  }
  if (
    config.vitest?.related !== true
    || config.vitest?.configFile !== 'config/vitest.stryker.config.ts'
  ) {
    errors.push('Stryker report Vitest binding differs from the governed sequential config');
  }
  return errors;
}

function normalizedReportPath(file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(root, file);
  return path.relative(root, absolute).split(path.sep).join('/');
}

export function validateMutationReport(
  report,
  { governedSources, governedRanges = [], minimumScore = 70 },
) {
  const errors = [];
  const summaries = [];
  const rangeSummaries = [];
  const files = report && typeof report === 'object' && report.files && typeof report.files === 'object'
    ? report.files
    : null;
  if (!files) {
    return {
      valid: false,
      totalMutants: 0,
      minimumMutants: 0,
      sources: [],
      ranges: [],
      errors: ['Stryker JSON report is missing its files map'],
    };
  }
  const fileByPath = new Map(
    Object.entries(files).map(([file, details]) => [normalizedReportPath(file), details]),
  );
  const testsByFile = new Map(
    Object.entries(report.testFiles ?? {}).map(([file, details]) => [
      normalizedReportPath(file),
      Array.isArray(details?.tests)
        ? details.tests.map((test) => ({ id: String(test.id), name: String(test.name ?? '') }))
        : [],
    ]),
  );
  let totalMutants = 0;

  for (const source of [...new Set(governedSources)].sort()) {
    const details = fileByPath.get(normalizedReportPath(source));
    if (!details || !Array.isArray(details.mutants)) {
      errors.push(`governed source is missing from Stryker report: ${source}`);
      continue;
    }
    const unknownStatuses = [...new Set(details.mutants
      .filter((mutant) => !MUTATION_STATUSES.has(mutant?.status))
      .map((mutant) => String(mutant?.status ?? '<missing>')))]
      .sort();
    for (const status of unknownStatuses) {
      errors.push(`governed source contains unscored mutation status ${status}: ${source}`);
    }
    const mutants = details.mutants.filter((mutant) => MUTATION_STATUSES.has(mutant?.status));
    totalMutants += mutants.length;
    const noCoverage = mutants.filter((mutant) => mutant.status === 'NoCoverage').length;
    const detected = mutants.filter((mutant) => DETECTED_MUTATION_STATUSES.has(mutant.status)).length;
    const score = mutants.length === 0 ? 0 : (detected / mutants.length) * 100;
    summaries.push({ source, mutants: mutants.length, detected, noCoverage, score });
    if (mutants.length === 0) errors.push(`governed source has no scored mutants: ${source}`);
    if (noCoverage > 0) errors.push(`governed source contains ${noCoverage} NoCoverage mutant(s): ${source}`);
    if (score < minimumScore) {
      errors.push(`governed source mutation score ${score.toFixed(2)} is below ${minimumScore}: ${source}`);
    }
  }

  const parsedRanges = [];
  const seenRangePatterns = new Set();
  for (const range of governedRanges) {
    const parsed = parseMutationTarget(range.pattern);
    if (!parsed || !Number.isInteger(range.minimumMutants) || range.minimumMutants < 1) {
      errors.push(`invalid governed mutation range in report policy: ${String(range.pattern)}`);
      continue;
    }
    if (seenRangePatterns.has(range.pattern)) {
      errors.push(`duplicate governed mutation range in report policy: ${range.pattern}`);
    }
    seenRangePatterns.add(range.pattern);
    if (parsed.endLine - parsed.startLine + 1 > MAX_MUTATION_RANGE_LINES) {
      errors.push(`governed mutation range exceeds ${MAX_MUTATION_RANGE_LINES} lines: ${range.pattern}`);
    }
    errors.push(...validateOwnerTestSelector(range));
    parsedRanges.push({ ...range, ...parsed });
  }
  for (let leftIndex = 0; leftIndex < parsedRanges.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < parsedRanges.length; rightIndex += 1) {
      const left = parsedRanges[leftIndex];
      const right = parsedRanges[rightIndex];
      if (left.pattern !== right.pattern && mutationRangesOverlap(left, right)) {
        errors.push(`governed mutation ranges overlap: ${left.pattern} and ${right.pattern}`);
      }
    }
  }

  for (const range of parsedRanges) {
    const details = fileByPath.get(normalizedReportPath(range.file));
    const ownerTests = testsByFile.get(normalizedReportPath(range.replacementTest));
    if (!ownerTests || ownerTests.length === 0) {
      errors.push(`governed replacement test is missing from Stryker report: ${range.replacementTest}`);
    }
    const ownerSelectorIsValid = validateOwnerTestSelector(range).length === 0;
    const matchingOwnerTests = ownerSelectorIsValid
      ? (ownerTests ?? []).filter((test) => ownerTestNameMatches(test.name, range))
      : [];
    if (ownerSelectorIsValid && matchingOwnerTests.length === 0) {
      errors.push(`governed behavior owner test is missing from Stryker report: ${range.pattern}`);
    } else if (matchingOwnerTests.length > 1) {
      errors.push(`governed behavior owner test is ambiguous in Stryker report: ${range.pattern}`);
    }
    const ownerTestIds = new Set(matchingOwnerTests.map(({ id }) => id));
    const mutants = Array.isArray(details?.mutants)
      ? details.mutants.filter((mutant) => {
        if (!MUTATION_STATUSES.has(mutant?.status)) return false;
        const startLine = mutant?.location?.start?.line;
        const endLine = mutant?.location?.end?.line;
        return Number.isInteger(startLine)
          && Number.isInteger(endLine)
          && startLine >= range.startLine
          && endLine <= range.endLine;
      })
      : [];
    const noCoverage = mutants.filter((mutant) => mutant.status === 'NoCoverage').length;
    const detected = mutants.filter((mutant) => DETECTED_MUTATION_STATUSES.has(mutant.status)).length;
    const ownerKilled = mutants.filter((mutant) => (
      mutant.status === 'Killed'
      && Array.isArray(mutant.killedBy)
      && mutant.killedBy.some((id) => ownerTestIds?.has(String(id)))
    )).length;
    const score = mutants.length === 0 ? 0 : (detected / mutants.length) * 100;
    rangeSummaries.push({
      pattern: range.pattern,
      replacementTest: range.replacementTest,
      ownerTestName: range.ownerTestName ?? null,
      ownerTestNamePattern: range.ownerTestNamePattern ?? null,
      matchedOwnerTestName: matchingOwnerTests[0]?.name ?? null,
      minimumMutants: range.minimumMutants,
      mutants: mutants.length,
      detected,
      ownerKilled,
      noCoverage,
      score,
    });
    if (mutants.length < range.minimumMutants) {
      errors.push(
        `governed range mutant total ${mutants.length} is below floor ${range.minimumMutants}: ${range.pattern}`,
      );
    }
    if (noCoverage > 0) {
      errors.push(`governed range contains ${noCoverage} NoCoverage mutant(s): ${range.pattern}`);
    }
    if (score < minimumScore) {
      errors.push(`governed range mutation score ${score.toFixed(2)} is below ${minimumScore}: ${range.pattern}`);
    }
    if (ownerKilled < range.minimumMutants) {
      errors.push(
        `governed range owner-killed total ${ownerKilled} is below floor ${range.minimumMutants}: ${range.pattern}`,
      );
    }
  }

  const rangedSources = new Set(parsedRanges.map((range) => range.file));
  const fullFileSources = [...new Set(governedSources)].filter((source) => !rangedSources.has(source));
  const minimumMutants = parsedRanges.reduce((sum, range) => sum + range.minimumMutants, 0)
    + fullFileSources.length;
  if (minimumMutants < 1) errors.push('mutation plan-derived mutant floor must be at least one');
  if (totalMutants < minimumMutants) {
    errors.push(`governed mutant total ${totalMutants} is below plan-derived floor ${minimumMutants}`);
  }
  return {
    valid: errors.length === 0,
    totalMutants,
    minimumMutants,
    sources: summaries,
    ranges: rangeSummaries,
    errors,
  };
}

export function mergeMutationReports(reports) {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error('at least one mutation report is required');
  }
  const mergedFiles = new Map();
  const mergedTestFiles = new Map();
  const merged = {
    ...reports[0],
    files: {},
    testFiles: {},
  };
  for (const [reportIndex, report] of reports.entries()) {
    if (!report || typeof report !== 'object' || !report.files || typeof report.files !== 'object') {
      throw new Error(`mutation batch ${reportIndex} is missing its files map`);
    }
    const canonicalTestIdByBatchId = new Map();
    const batchCanonicalTestIds = new Set();
    for (const [file, details] of Object.entries(report.testFiles ?? {})) {
      const normalized = normalizedReportPath(file);
      const tests = Array.isArray(details?.tests) ? details.tests : [];
      const canonicalTests = tests.map((test) => {
        const batchId = String(test?.id);
        const name = String(test?.name ?? '');
        const canonicalId = JSON.stringify([normalized, name]);
        if (batchCanonicalTestIds.has(canonicalId)) {
          throw new Error(`mutation batch ${reportIndex} repeats logical test: ${normalized} ${name}`);
        }
        batchCanonicalTestIds.add(canonicalId);
        const priorCanonicalId = canonicalTestIdByBatchId.get(batchId);
        if (priorCanonicalId !== undefined && priorCanonicalId !== canonicalId) {
          throw new Error(`mutation batch ${reportIndex} repeats test id ${batchId} for different tests`);
        }
        canonicalTestIdByBatchId.set(batchId, canonicalId);
        return { ...test, id: canonicalId, name };
      });
      const prior = mergedTestFiles.get(normalized);
      if (prior !== undefined && prior.source !== details?.source) {
        throw new Error(`mutation batches disagree on retained test source: ${normalized}`);
      }
      const testById = new Map((prior?.tests ?? []).map((test) => [String(test.id), test]));
      for (const test of canonicalTests) {
        const existing = testById.get(test.id);
        if (existing !== undefined && existing.name !== test.name) {
          throw new Error(`mutation batches disagree on retained test identity: ${normalized}`);
        }
        testById.set(test.id, existing ?? test);
      }
      mergedTestFiles.set(normalized, {
        ...(prior ?? details),
        tests: [...testById.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
      });
    }
    const rewriteTestIds = (ids, label) => {
      if (!Array.isArray(ids)) return ids;
      return ids.map((id) => {
        const canonicalId = canonicalTestIdByBatchId.get(String(id));
        if (canonicalId === undefined) {
          throw new Error(`mutation batch ${reportIndex} ${label} references unknown test id ${String(id)}`);
        }
        return canonicalId;
      });
    };
    for (const [file, details] of Object.entries(report.files)) {
      const normalized = normalizedReportPath(file);
      if (mergedFiles.has(normalized)) {
        throw new Error(`mutation batches repeat governed source: ${normalized}`);
      }
      mergedFiles.set(normalized, {
        ...details,
        mutants: Array.isArray(details?.mutants)
          ? details.mutants.map((mutant) => ({
            ...mutant,
            ...(Array.isArray(mutant?.coveredBy)
              ? { coveredBy: rewriteTestIds(mutant.coveredBy, 'coveredBy') }
              : {}),
            ...(Array.isArray(mutant?.killedBy)
              ? { killedBy: rewriteTestIds(mutant.killedBy, 'killedBy') }
              : {}),
          }))
          : details?.mutants,
      });
    }
  }
  merged.files = Object.fromEntries([...mergedFiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
  merged.testFiles = Object.fromEntries([...mergedTestFiles.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
  return merged;
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

export function validateCleanupMapping(
  mapping,
  exists = fs.existsSync,
  readSource = readGovernedMutationSource,
) {
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
  if (mapping.mutationTargets !== undefined) {
    if (!Array.isArray(mapping.mutationTargets) || mapping.mutationTargets.length === 0) {
      errors.push('mutationTargets must contain at least one governed ownership entry');
    } else {
      const parsedTargets = [];
      const seenPatterns = new Set();
      for (const target of mapping.mutationTargets) {
        errors.push(...validateGovernedMutationTarget(target, mapping, exists, readSource));
        const pattern = mutationTargetPattern(target);
        const parsed = parseMutationTarget(pattern);
        if (!parsed) continue;
        if (seenPatterns.has(pattern)) {
          errors.push(`duplicate governed mutation range: ${pattern}`);
          continue;
        }
        seenPatterns.add(pattern);
        const overlap = parsedTargets.find((prior) => mutationRangesOverlap(prior, parsed));
        if (overlap) {
          errors.push(`governed mutation ranges overlap: ${overlap.pattern} and ${pattern}`);
        }
        parsedTargets.push({ ...parsed, pattern });
      }
    }
  }
  if (typeof mapping.reason !== 'string' || mapping.reason.trim().length < 12) {
    errors.push('reason must explain the conversion or merge');
  }
  return errors;
}

export function resolveDeletedTestCleanupMappings(
  changes,
  cleanupMappings,
  exists = fs.existsSync,
  readSource = readGovernedMutationSource,
  retirementMappings = [],
  readRetiredTestSource = () => '',
  baseSha = null,
) {
  const mappingByTest = new Map(cleanupMappings.map((mapping) => [mapping.test, mapping]));
  const resolved = [];
  const retirements = [];
  const unmapped = [];
  const invalid = [];
  const removedPaths = changes
    .filter((change) => change.status.startsWith('D'))
    .map((change) => change.previous ?? change.file);
  const changedPaths = changes
    .filter((change) => !change.status.startsWith('D'))
    .map((change) => change.file);
  const existsCurrent = (file) => exists(path.join(root, file));

  for (const change of changes) {
    const previousFile = change.previous ?? change.file;
    if (
      !change.status.startsWith('D')
      || !previousFile.startsWith('__tests__/')
      || !previousFile.endsWith('.test.ts')
    ) {
      continue;
    }
    const retirement = resolveRetirementMapping({
      baseSha,
      testFile: previousFile,
      mappings: retirementMappings,
      removedPaths,
      changedPaths,
      ownerPaths: retirementOwnerCandidates(previousFile, readRetiredTestSource(previousFile)),
      existsCurrent,
    });
    if (retirement) {
      retirements.push({
        test: previousFile,
        currentTest: change.status.startsWith('R') ? change.file : null,
        status: change.status,
        reason: retirement.reason.trim(),
        replacementTests: [...new Set(retirement.replacementTests)].sort(),
      });
      continue;
    }
    const mapping = mappingByTest.get(change.file) ?? mappingByTest.get(previousFile);
    if (!mapping) {
      unmapped.push(previousFile);
      continue;
    }
    const errors = validateCleanupMapping(mapping, exists, readSource);
    if (errors.length > 0) invalid.push({ test: previousFile, errors });
    else resolved.push(mapping);
  }

  return {
    resolved: resolved.sort((a, b) => a.test.localeCompare(b.test)),
    retirements: retirements.sort((a, b) => a.test.localeCompare(b.test)),
    unmapped: [...new Set(unmapped)].sort(),
    invalid,
  };
}

function readAtBase(base, file) {
  const result = git(['show', `${base}:${file}`]);
  return result.status === 0 ? result.stdout : '';
}

function parseChangedFiles(base) {
  const mergeBase = git(gitMergeBaseArgs(base));
  if (mergeBase.status !== 0 || !/^[0-9a-f]{40}\n?$/.test(mergeBase.stdout)) {
    throw new Error(mergeBase.stderr || `Unable to resolve merge base for ${base}...HEAD`);
  }
  const exactBase = mergeBase.stdout.trim();
  const result = git(gitNameStatusDiffArgs(exactBase));
  if (result.status !== 0) throw new Error(result.stderr || `Unable to diff ${exactBase}...HEAD`);
  return {
    base: exactBase,
    changes: gitNameStatusRecordsToChanges(parseGitNameStatusRecordsZ(result.stdout)),
  };
}

export function buildMutationPlan({
  base,
  changes,
  patterns,
  scope = 'changed-critical',
  cleanupMappings = [],
  retirementMappings = [],
  mutationExceptions = [],
  ownerTestMappings = [],
  testPolicy = loadTestPolicy(),
  exists = fs.existsSync,
  readCurrent = (file) => (
    exists(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : ''
  ),
  readPrevious = readAtBase,
  readSource = readGovernedMutationSource,
  now = Date.now(),
}) {
  if (!MUTATION_SCOPES.has(scope)) {
    throw new Error(`Unsupported mutation scope: ${scope}`);
  }
  const candidateTargets = new Map();
  const addCandidateTarget = (file, mutationTargets = []) => {
    if (mutationTargets.length === 0) {
      candidateTargets.set(file, null);
      return;
    }
    if (candidateTargets.get(file) === null) return;
    const existingTargets = candidateTargets.get(file) ?? new Set();
    for (const target of mutationTargets) existingTargets.add(target);
    candidateTargets.set(file, existingTargets);
  };
  const cleanupTests = [];
  const unmappedRetainedCleanupTests = [];
  const testEvidenceParseDiagnostics = [];
  const governedRangeByPattern = new Map();
  const deletedTestAudit = resolveDeletedTestCleanupMappings(
    changes,
    cleanupMappings,
    exists,
    readSource,
    retirementMappings,
    (file) => readPrevious(base, file),
    base,
  );
  const invalidCleanupMappings = [...deletedTestAudit.invalid];
  const mappingByTest = new Map(cleanupMappings.map((mapping) => [mapping.test, mapping]));
  const retiredTests = new Set(deletedTestAudit.retirements.map((retirement) => retirement.test));
  const retirementRemovedPaths = changes
    .filter((change) => change.status.startsWith('D'))
    .map((change) => change.previous ?? change.file);
  const retirementChangedPaths = changes
    .filter((change) => !change.status.startsWith('D'))
    .map((change) => change.file);
  const existsCurrent = (file) => exists(path.join(root, file));

  for (const change of changes) {
    if (
      scope === 'changed-critical'
      && change.file.startsWith('src/')
      && !change.status.startsWith('D')
      && isCriticalModule(change.file, patterns)
    ) {
      addCandidateTarget(change.file);
    }
    const previousFile = change.previous ?? change.file;
    if (
      (!change.file.startsWith('__tests__/') || !change.file.endsWith('.test.ts'))
      && (!previousFile.startsWith('__tests__/') || !previousFile.endsWith('.test.ts'))
    ) {
      continue;
    }
    const current = readCurrent(change.file);
    const previous = readPrevious(base, previousFile);
    const currentDiagnostics = extractTestEvidence(current, change.file).parseDiagnostics;
    const previousDiagnostics = extractTestEvidence(previous, previousFile).parseDiagnostics;
    if (currentDiagnostics.length > 0 || previousDiagnostics.length > 0) {
      testEvidenceParseDiagnostics.push({
        test: change.file,
        current: currentDiagnostics,
        previous: previousDiagnostics,
      });
    }
    const protectsRemovedAssertions = change.status.startsWith('R')
      || isTestCleanupChange(change, current, previous);
    if (protectsRemovedAssertions) cleanupTests.push(change.file);

    // Pull requests that remove assertions mutate only the explicitly mapped
    // source ranges owned by those cleaned-up tests. Direct production edits
    // belong to the optional changed-critical lane and must not expand this
    // targeted cleanup gate.
    if (scope !== 'test-cleanup' || !protectsRemovedAssertions) continue;
    if (
      !retiredTests.has(previousFile)
      && (change.status.startsWith('M') || change.status.startsWith('R'))
    ) {
      const retirement = resolveRetirementMapping({
        baseSha: base,
        testFile: previousFile,
        mappings: retirementMappings,
        removedPaths: retirementRemovedPaths,
        changedPaths: retirementChangedPaths,
        ownerPaths: retirementOwnerCandidates(previousFile, previous),
        existsCurrent,
      });
      if (retirement) {
        deletedTestAudit.retirements.push({
          test: previousFile,
          currentTest: change.file,
          status: change.status,
          reason: retirement.reason.trim(),
          replacementTests: [...new Set(retirement.replacementTests)].sort(),
        });
        retiredTests.add(previousFile);
      }
    }
    if (retiredTests.has(previousFile)) continue;

    const exactMapping = mappingByTest.get(change.file) ?? mappingByTest.get(previousFile);
    const mappings = exactMapping ? [exactMapping] : [];
    if (mappings.length === 0) {
      if (!change.status.startsWith('D')) unmappedRetainedCleanupTests.push(previousFile);
      continue;
    }
    for (const mapping of mappings) {
      const mappingErrors = validateCleanupMapping(mapping, exists, readSource);
      if (mappingErrors.length > 0) {
        invalidCleanupMappings.push({
          test: change.file,
          mapping: mapping.test,
          errors: mappingErrors,
        });
        continue;
      }
      // A declared cleanup mapping is authoritative: mocked imports and source
      // literals in deleted QA suites are fixtures, not behavior ownership.
      const dependencies = new Set(mapping.sources);
      for (const dependency of dependencies) {
        const governedMutationTargets = (mapping.mutationTargets ?? [])
          .filter((target) => parseMutationTarget(mutationTargetPattern(target))?.file === dependency);
        if (governedMutationTargets.length === 0) {
          invalidCleanupMappings.push({
            test: change.file,
            mapping: mapping.test,
            errors: [`cleanup source requires a governed mutation range: ${dependency}`],
          });
          continue;
        }
        const acceptedTargetPatterns = [];
        for (const target of governedMutationTargets) {
          const priorOwner = governedRangeByPattern.get(target.pattern);
          if (
            priorOwner
            && (
              priorOwner.replacementTest !== target.replacementTest
              || priorOwner.mappingTest !== mapping.test
            )
          ) {
            invalidCleanupMappings.push({
              test: change.file,
              mapping: mapping.test,
              errors: [`governed mutation range has conflicting owners: ${target.pattern}`],
            });
            continue;
          }
          const parsedTarget = parseMutationTarget(target.pattern);
          const overlappingOwner = [...governedRangeByPattern.values()].find((candidate) => {
            const parsedCandidate = parseMutationTarget(candidate.pattern);
            return candidate.mappingTest !== mapping.test
              && parsedCandidate
              && parsedTarget
              && mutationRangesOverlap(parsedCandidate, parsedTarget);
          });
          if (overlappingOwner) {
            invalidCleanupMappings.push({
              test: change.file,
              mapping: mapping.test,
              errors: [`governed mutation ranges overlap across mappings: ${overlappingOwner.pattern} and ${target.pattern}`],
            });
            continue;
          }
          governedRangeByPattern.set(target.pattern, { ...target, mappingTest: mapping.test });
          acceptedTargetPatterns.push(target.pattern);
        }
        if (acceptedTargetPatterns.length > 0) addCandidateTarget(dependency, acceptedTargetPatterns);
      }
    }
  }

  const exceptionByFile = new Map();
  const invalidMutationExemptions = [];
  const expiredMutationExemptions = [];
  for (const exception of mutationExceptions) {
    const errors = validateMutationException(exception, exists, now, patterns);
    if (exceptionByFile.has(exception?.file)) {
      errors.push(`duplicate mutation exception for file: ${String(exception?.file)}`);
    }
    if (errors.length > 0) {
      invalidMutationExemptions.push({ file: exception?.file ?? null, errors });
      if (errors.some((error) => error.includes('expiry is not in the future'))) {
        expiredMutationExemptions.push({ file: exception?.file ?? null, expires: exception?.expires ?? null });
      }
      continue;
    }
    exceptionByFile.set(exception.file, exception);
  }
  const ownerTestMappingBySource = new Map();
  const invalidOwnerTestMappings = [];
  for (const mapping of ownerTestMappings) {
    const errors = validateMutationOwnerTestMapping(mapping, exists, patterns, testPolicy);
    if (ownerTestMappingBySource.has(mapping?.source)) {
      errors.push(`duplicate mutation owner source: ${String(mapping?.source)}`);
    }
    if (errors.length > 0) {
      invalidOwnerTestMappings.push({ source: mapping?.source ?? null, errors });
      continue;
    }
    ownerTestMappingBySource.set(mapping.source, {
      source: mapping.source,
      testFiles: [...new Set(mapping.testFiles)].sort(),
      reason: mapping.reason.trim(),
    });
  }
  const excludedTargets = [];
  const targets = [];
  for (const [file, sourceTargets] of [...candidateTargets.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!exists(path.join(root, file))) continue;
    // Mutation exemptions are governed independently from coverage ratchets.
    // Cleanup protection is never exempted, and weekly exemptions require
    // their own explicit owner/reason/expiry in mutation.exceptions.
    const exception = scope === 'changed-critical' ? exceptionByFile.get(file) : null;
    if (!exception) {
      targets.push(...(sourceTargets === null ? [file] : [...sourceTargets].sort()));
      continue;
    }
    excludedTargets.push({
      file,
      owner: exception.owner,
      reason: exception.reason,
      expires: exception.expires,
    });
  }

  const governedRanges = targets
    .map((target) => governedRangeByPattern.get(target))
    .filter(Boolean)
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
  const retirementReplacementTests = deletedTestAudit.retirements
    .flatMap((retirement) => retirement.replacementTests);
  const testFiles = scope === 'test-cleanup'
    ? [...new Set([
        ...governedRanges.map(({ replacementTest }) => replacementTest),
        ...retirementReplacementTests,
      ])]
      .filter((file) => exists(path.join(root, file)))
      .sort()
    : [];
  const governedSources = [...new Set(targets.map((target) => (
    parseMutationTarget(target)?.file ?? target
  )))].sort();
  const rangedSources = new Set(governedRanges.map(({ pattern }) => parseMutationTarget(pattern)?.file));
  const minimumMutants = governedRanges.reduce((sum, range) => sum + range.minimumMutants, 0)
    + governedSources.filter((source) => !rangedSources.has(source)).length;

  return {
    schema: 'nexus.mutation-plan.v5',
    base,
    head: resolveExactCommit(root, 'HEAD'),
    scope,
    cleanupTests: [...new Set(cleanupTests)].sort(),
    cleanupMappings: deletedTestAudit.resolved,
    retirementMappings: deletedTestAudit.retirements
      .sort((left, right) => left.test.localeCompare(right.test)),
    unmappedDeletedTests: deletedTestAudit.unmapped,
    unmappedRetainedCleanupTests: [...new Set(unmappedRetainedCleanupTests)].sort(),
    testEvidenceParseDiagnostics,
    invalidCleanupMappings,
    excludedTargets,
    invalidMutationExemptions,
    expiredMutationExemptions,
    ownerTestMappings: [...ownerTestMappingBySource.values()]
      .sort((left, right) => left.source.localeCompare(right.source)),
    invalidOwnerTestMappings,
    targets,
    governedSources,
    governedRanges,
    minimumMutants,
    testFiles,
  };
}

export function mutationPlanExitCode(plan) {
  return [
    plan?.unmappedDeletedTests,
    plan?.unmappedRetainedCleanupTests,
    plan?.testEvidenceParseDiagnostics,
    plan?.invalidCleanupMappings,
    plan?.invalidMutationExemptions,
    plan?.expiredMutationExemptions,
    plan?.invalidOwnerTestMappings,
  ].some((issues) => Array.isArray(issues) && issues.length > 0) ? 3 : 0;
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const base = valueOf('--base');
  const scope = valueOf('--scope') ?? 'changed-critical';
  const planOnly = args.includes('--plan');
  if (!base) {
    console.error('Usage: mutation-gate.mjs --base <sha> [--scope test-cleanup|changed-critical] [--plan]');
    process.exit(64);
  }
  if (!MUTATION_SCOPES.has(scope)) {
    console.error(`Unsupported mutation scope: ${scope}`);
    process.exit(64);
  }
  const exactBase = resolveExactCommit(root, base);
  if (!exactBase) {
    console.error(`Mutation base does not resolve: ${base}`);
    process.exit(2);
  }

  const policy = loadTestPolicy();
  const groupPolicy = loadTestGroups();
  const changeSet = parseChangedFiles(exactBase);
  const preliminaryPlan = buildMutationPlan({
    base: changeSet.base,
    changes: changeSet.changes,
    patterns: policy.mutation.criticalModulePatterns,
    scope,
    cleanupMappings: policy.mutation.cleanupMappings,
    retirementMappings: groupPolicy.retirementMappings ?? [],
    mutationExceptions: policy.mutation.exceptions,
    ownerTestMappings: policy.mutation.ownerTestMappings ?? [],
    testPolicy: policy,
  });
  const plan = buildWeeklyMutationSelection(preliminaryPlan);
  const outputDir = path.join(root, '.local/mutation');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  console.log(JSON.stringify(plan, null, 2));

  const planExitCode = mutationPlanExitCode(plan);
  if (planExitCode !== 0) {
    console.error('Mutation mappings and exceptions must be valid and fail-closed.');
    process.exit(planExitCode);
  }

  if (planOnly || plan.targets.length === 0) {
    if (plan.targets.length === 0) console.log('No changed critical modules resolved; mutation run skipped.');
    return;
  }

  const thresholds = policy.mutation.thresholds;
  const config = path.join(root, 'config/stryker.config.mjs');
  const reportPath = path.join(outputDir, 'mutation-report.json');
  const batchesDir = path.join(outputDir, 'batches');
  const batchStatePath = path.join(outputDir, 'batch-state.json');
  fs.rmSync(reportPath, { force: true });
  fs.rmSync(batchesDir, { recursive: true, force: true });
  fs.mkdirSync(batchesDir, { recursive: true });
  const batchState = {
    schema: 'nexus.mutation-batch-state.v1',
    base: plan.base,
    head: plan.head,
    scope,
    status: 'in_progress',
    batches: plan.mutationBatches.map((batch) => ({
      ...batch,
      status: 'pending',
      report: `batches/${String(batch.index).padStart(3, '0')}-report.json`,
    })),
  };
  const writeBatchState = () => {
    fs.writeFileSync(batchStatePath, `${JSON.stringify(batchState, null, 2)}\n`);
  };
  writeBatchState();

  const reports = [];
  for (const batch of batchState.batches) {
    batch.status = 'running';
    writeBatchState();
    const batchThresholds = plan.mutationBatches.length > 1
      ? { ...thresholds, break: 0 }
      : thresholds;
    let report;
    let executionTargets = [...batch.targets];
    while (true) {
      fs.rmSync(reportPath, { force: true });
      const invocation = buildStrykerInvocation({
        config,
        targets: executionTargets,
        thresholds: batchThresholds,
        testFiles: batch.testFiles ?? plan.testFiles,
        scope,
      });
      const result = spawnSync(
        path.join(root, 'node_modules/.bin/stryker'),
        invocation.args,
        {
          cwd: root,
          stdio: 'inherit',
          env: buildStrykerEnvironment(process.env, invocation.env),
        },
      );
      if (result.status !== 0) {
        batch.status = 'failed';
        batch.exitStatus = result.status ?? null;
        batch.signal = result.signal ?? null;
        batchState.status = 'failed';
        writeBatchState();
        process.exit(result.status ?? 1);
      }

      try {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch (error) {
        batch.status = 'failed';
        batch.error = error instanceof Error ? error.message : String(error);
        batchState.status = 'failed';
        writeBatchState();
        console.error(`Unable to read fresh Stryker JSON report: ${batch.error}`);
        process.exit(4);
      }
      const executionBindingErrors = validateMutationExecutionReport(report, {
        targets: executionTargets,
        testFiles: batch.testFiles ?? plan.testFiles,
      });
      if (executionBindingErrors.length > 0) {
        batch.status = 'failed';
        batch.errors = executionBindingErrors;
        batchState.status = 'failed';
        writeBatchState();
        console.error(executionBindingErrors.join('\n'));
        process.exit(4);
      }
      const generatedMutants = Object.values(report.files ?? {})
        .reduce((sum, details) => sum + (Array.isArray(details?.mutants) ? details.mutants.length : 0), 0);
      const fallback = resolveEmptyRangeFallback({
        generatedMutants,
        targets: executionTargets,
        sources: batch.sources,
      });
      if (fallback) {
        const emptyRangeReport = `batches/${String(batch.index).padStart(3, '0')}-empty-range-report.json`;
        fs.renameSync(reportPath, path.join(outputDir, emptyRangeReport));
        batch.emptyRangeReport = emptyRangeReport;
        batch.fallback = fallback.reason;
        executionTargets = fallback.targets;
        batch.status = 'running-full-file-fallback';
        writeBatchState();
        continue;
      }
      break;
    }
    const batchReportPath = path.join(outputDir, batch.report);
    fs.renameSync(reportPath, batchReportPath);
    reports.push(report);
    batch.status = 'complete';
    batch.executedTargets = executionTargets;
    batch.mutants = Object.values(report.files ?? {})
      .reduce((sum, details) => sum + (Array.isArray(details?.mutants) ? details.mutants.length : 0), 0);
    writeBatchState();
  }

  let report;
  try {
    report = mergeMutationReports(reports);
  } catch (error) {
    batchState.status = 'failed';
    batchState.error = error instanceof Error ? error.message : String(error);
    writeBatchState();
    console.error(`Unable to merge Stryker batch reports: ${batchState.error}`);
    process.exit(4);
  }
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const reportValidation = validateMutationReport(report, {
    governedSources: plan.governedSources,
    governedRanges: plan.governedRanges,
    minimumScore: thresholds.break,
  });
  fs.writeFileSync(
    path.join(outputDir, 'report-validation.json'),
    `${JSON.stringify(reportValidation, null, 2)}\n`,
  );
  console.log(JSON.stringify(reportValidation, null, 2));
  if (!reportValidation.valid) {
    batchState.status = 'failed';
    batchState.error = 'governed-source integrity validation failed';
    writeBatchState();
    console.error('Stryker report failed governed-source integrity validation.');
    process.exit(4);
  }
  batchState.status = 'complete';
  writeBatchState();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
