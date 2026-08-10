#!/usr/bin/env node
// ─────────────────────────────────────────────────────
// vi-mock-completeness-lint.mjs
//
// Scan every Vitest test file for `vi.mock('<path>', factory)` calls
// whose factory does NOT expose every export the real module exposes.
// Partial mocks are the proximate cause of the v4.14.119 unified-calendar
// pollution bug that forced `singleFork: true` in vitest.config.ts.
// Once this lint is clean, `singleFork: true` can be safely lifted.
//
// Usage:
//   node scripts/vi-mock-completeness-lint.mjs
//   node scripts/vi-mock-completeness-lint.mjs --json
//   node scripts/vi-mock-completeness-lint.mjs --json --strict
//   node scripts/vi-mock-completeness-lint.mjs --files <comma-list>
//
// Strict mode exits 1 if any partial mock is found. Default mode is a
// soft report — it prints findings and exits 0 so it can be wired into
// CI as a non-gating check during the soak window.
//
// Detected patterns (at least one must match a vi.mock call):
//   vi.mock('<rel-path>', () => ({ a: ..., b: ... }))
//   vi.mock('<rel-path>', () => { return { ... } })
//   vi.mock('<rel-path>', async () => ({ ... }))
//
// Patterns intentionally OUT of scope (false-positive risk):
//   - vi.mock('<rel-path>') with no factory (full auto-mock)
//   - vi.mock with factory using vi.importActual (already complete)
//   - vi.doMock / dynamic imports
//
// Real-module exports are detected by parsing for:
//   export function NAME(
//   export const NAME =
//   export class NAME
//   export default ...
//   export { NAME, NAME2 } from '...'
//   export type / interface / enum
//
// Naive grep parser — chosen over a TS compiler API integration because
// (a) zero dependencies, (b) fast, (c) the surface this lints (a few
// dozen real modules) is small enough that a strict regex finds 99 % of
// real exports without needing the TS AST.
// ─────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluateViMockStrictFindings,
  parseViMockStrictBaseline,
  passesViMockStrictGate,
} from './lib/vi-mock-strict-allowances.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, '__tests__');
const SRC_DIR = path.join(ROOT, 'src');
const BASELINE_PATH = path.join(__dirname, '.vi-mock-baseline.txt');

const args = new Set(process.argv.slice(2));
const STRICT = args.has('--strict');
const JSON_OUT = args.has('--json');
const filesArgIdx = process.argv.indexOf('--files');
const explicitFiles =
  filesArgIdx >= 0 ? process.argv[filesArgIdx + 1].split(',').filter(Boolean) : null;

const findings = [];

function walk(dir, into = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, into);
    else if (/\.test\.tsx?$|\.spec\.tsx?$/.test(entry.name)) into.push(full);
  }
  return into;
}

function listTestFiles() {
  if (explicitFiles) return explicitFiles.map((f) => path.resolve(ROOT, f));
  if (!fs.existsSync(TESTS_DIR)) return [];
  return walk(TESTS_DIR);
}

// ── parse a TS source file's named exports ────────────
// Distinguish RUNTIME exports (functions, classes, const, let, var, default,
// non-const enum) from TYPE-ONLY exports (type, interface, const enum).
// `vi.mock` factories only need to provide runtime exports — TS erases the
// rest at compile time.
function parseExports(srcAbsPath) {
  let src;
  try {
    src = fs.readFileSync(srcAbsPath, 'utf8');
  } catch {
    return null;
  }
  const runtime = new Set();
  const typeOnly = new Set();
  let hasDefault = false;
  let hasReExport = false;

  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const lines = stripped.split('\n');
  for (const raw of lines) {
    const line = raw.trim();

    // export type { ... } from '...'  → all type-only
    const typeNamedMatch = line.match(/^export\s+type\s*\{([^}]+)\}/);
    if (typeNamedMatch) {
      for (const part of typeNamedMatch[1].split(',')) {
        const asMatch = part.match(/\s+as\s+([A-Za-z_$][\w$]*)/);
        const name = asMatch
          ? asMatch[1]
          : part.trim().split(/\s+/)[0].replace(/[^A-Za-z_$\w]/g, '');
        if (name && name !== 'default') typeOnly.add(name);
      }
      if (/from\s+['"][^'"]+['"]/.test(line)) hasReExport = true;
      continue;
    }

    // export { a, b as c, type Foo } from '...'  OR  export { a, b }
    // The `type X` prefix marks individual specifiers as type-only.
    const namedMatch = line.match(/^export\s*\{([^}]+)\}/);
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const tok = part.trim();
        if (!tok) continue;
        const isTypeSpecifier = /^type\s+/.test(tok);
        const cleaned = tok.replace(/^type\s+/, '');
        const asMatch = cleaned.match(/\s+as\s+([A-Za-z_$][\w$]*)/);
        const name = asMatch
          ? asMatch[1]
          : cleaned.split(/\s+/)[0].replace(/[^A-Za-z_$\w]/g, '');
        if (!name) continue;
        if (name === 'default') {
          hasDefault = true;
        } else if (isTypeSpecifier) {
          typeOnly.add(name);
        } else {
          runtime.add(name);
        }
      }
      if (/from\s+['"][^'"]+['"]/.test(line)) hasReExport = true;
      continue;
    }

    // export * from '...'  /  export * as X from '...'
    if (/^export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from/.test(line)) {
      const ns = line.match(/^export\s*\*\s*as\s+([A-Za-z_$][\w$]*)/);
      if (ns) runtime.add(ns[1]);
      hasReExport = true;
      continue;
    }

    // export default ...
    if (/^export\s+default\b/.test(line)) {
      hasDefault = true;
      const m = line.match(/^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/);
      if (m) runtime.add(m[1]);
      continue;
    }

    // Type-only categories first (more specific patterns)
    let m;
    if ((m = line.match(/^export\s+type\s+([A-Za-z_$][\w$]*)/))) {
      typeOnly.add(m[1]);
      continue;
    }
    if ((m = line.match(/^export\s+interface\s+([A-Za-z_$][\w$]*)/))) {
      typeOnly.add(m[1]);
      continue;
    }
    if ((m = line.match(/^export\s+const\s+enum\s+([A-Za-z_$][\w$]*)/))) {
      typeOnly.add(m[1]);
      continue;
    }
    // enum X (without `const`) has runtime value
    if ((m = line.match(/^export\s+enum\s+([A-Za-z_$][\w$]*)/))) {
      runtime.add(m[1]);
      continue;
    }
    if ((m = line.match(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) {
      runtime.add(m[1]);
      continue;
    }
    if ((m = line.match(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
      runtime.add(m[1]);
      continue;
    }
    if ((m = line.match(/^export\s+abstract\s+class\s+([A-Za-z_$][\w$]*)/)) ||
        (m = line.match(/^export\s+class\s+([A-Za-z_$][\w$]*)/))) {
      runtime.add(m[1]);
      continue;
    }
  }

  return {
    runtimeExports: [...runtime].sort(),
    typeOnlyExports: [...typeOnly].sort(),
    hasDefault,
    hasReExport,
  };
}

// ── parse a test file's vi.mock(...) calls ────────────
// We can't use a simple regex for the whole call because the factory body
// contains nested `()`, `{}`, strings, and template literals. Instead:
//   1. Locate every `vi.mock(` token.
//   2. From the opening `(`, track paren / brace / string depth to find
//      the matching closing `)` of the entire vi.mock call.
//   3. Inside that range, split on the first top-level `,` to separate
//      the path argument from the factory argument.
function findViMockCalls(src) {
  const calls = [];
  const tag = 'vi.mock(';
  let i = 0;
  while ((i = src.indexOf(tag, i)) !== -1) {
    // Confirm this is a real call (not, e.g., `// vi.mock(`). We check the
    // char before is not part of an identifier and not preceded by a single-
    // line comment opener on the same line. Cheap heuristic.
    const prev = i > 0 ? src[i - 1] : '\n';
    if (/[A-Za-z_$0-9]/.test(prev)) {
      i += tag.length;
      continue;
    }
    // Skip if the entire line is a // comment
    const lineStart = src.lastIndexOf('\n', i) + 1;
    const lineSoFar = src.slice(lineStart, i);
    if (/(^|\s)\/\//.test(lineSoFar)) {
      i += tag.length;
      continue;
    }

    const openParen = i + tag.length - 1; // index of the `(`
    const close = matchClosingParen(src, openParen);
    if (close < 0) {
      i = openParen + 1;
      continue;
    }
    const inside = src.slice(openParen + 1, close);
    const split = splitTopLevelComma(inside);
    if (split.length < 1) {
      i = close + 1;
      continue;
    }
    const pathArg = split[0].trim();
    const factoryArg = split.length > 1 ? split.slice(1).join(',').trim() : '';
    const pathMatch = pathArg.match(/^(['"`])([^'"`]+)\1$/);
    if (!pathMatch) {
      i = close + 1;
      continue;
    }
    const lineNum = src.slice(0, i).split('\n').length;
    calls.push({ path: pathMatch[2], factoryArg, lineNum });
    i = close + 1;
  }
  return calls;
}

function matchClosingParen(src, openIdx) {
  let depth = 0;
  let inStr = null;
  let templateDepth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (inStr === '`' && c === '$' && src[i + 1] === '{') {
        templateDepth++;
        i++;
        inStr = null; // we're now inside template-expression context, treat as code
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') {
      depth--;
      if (c === ')' && depth === 0) return i;
      if (templateDepth > 0 && c === '}' && depth === 1) {
        templateDepth--;
        inStr = '`';
      }
    }
  }
  return -1;
}

function splitTopLevelComma(src) {
  const out = [];
  let buf = '';
  let depth = 0;
  let inStr = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      buf += c;
      if (c === '\\') { buf += src[++i] || ''; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; buf += c; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    if (c === ',' && depth === 0) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function extractFactoryReturnKeys(factoryRaw) {
  // Common shapes:
  //   () => ({ a: ..., b: ... })          — direct object return
  //   () => { return { a: ..., b: ... } } — explicit return
  //   () => ({ default: foo })            — default-only
  //
  // We find the FIRST top-level `{` after a `(` or `return ` and brace-match
  // to its closing `}`, then split on commas at brace-depth 0 inside it.
  const src = factoryRaw.trim();

  // Find the start of the object literal we should inspect
  let openIdx = -1;
  // Direct: `({ ... })`
  if (src.startsWith('(')) {
    let depth = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === '{' && depth === 1) {
        openIdx = i;
        break;
      }
    }
  } else if (src.startsWith('{')) {
    // Block factory — look for the first `return {`
    const ret = src.indexOf('return');
    if (ret >= 0) {
      const after = src.slice(ret + 6);
      const braceRel = after.indexOf('{');
      if (braceRel >= 0) openIdx = ret + 6 + braceRel;
    }
  }
  if (openIdx < 0) return null;

  // Brace-match to find the close
  let closeIdx = -1;
  let depth = 0;
  let inString = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;

  const inner = src.slice(openIdx + 1, closeIdx);
  // Split on commas at brace/paren/bracket depth 0
  const keys = [];
  let buf = '';
  let bd = 0;
  let inS = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (inS) {
      buf += c;
      if (c === '\\') {
        buf += inner[++i];
        continue;
      }
      if (c === inS) inS = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inS = c;
      buf += c;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') bd++;
    else if (c === '}' || c === ')' || c === ']') bd--;
    if (c === ',' && bd === 0) {
      const tok = buf.trim();
      if (tok) keys.push(tok);
      buf = '';
      continue;
    }
    buf += c;
  }
  if (buf.trim()) keys.push(buf.trim());

  // Each tok is like `name: ...`, `name`, `...spread`, `[expr]: ...`, `'literal'`
  const exposed = new Set();
  let hasSpread = false;
  let hasDefault = false;
  for (const tok of keys) {
    if (/^\s*\.\.\./.test(tok)) {
      hasSpread = true;
      continue;
    }
    // skip computed keys [expr]: ...
    if (/^\s*\[/.test(tok)) continue;
    // string-literal keys 'foo': ...
    const strMatch = tok.match(/^\s*['"]([^'"]+)['"]\s*:/);
    if (strMatch) {
      const k = strMatch[1];
      if (k === 'default') hasDefault = true;
      else exposed.add(k);
      continue;
    }
    const nameMatch = tok.match(/^\s*([A-Za-z_$][\w$]*)\s*[:,}=\s]/) ||
                      tok.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
    if (nameMatch) {
      const name = nameMatch[1];
      if (name === 'default') hasDefault = true;
      else exposed.add(name);
    }
  }
  return { exposed: [...exposed].sort(), hasSpread, hasDefault };
}

// ── resolve a vi.mock relative path against the real source module ──
function resolveMockPath(testAbsPath, mockArg) {
  if (mockArg.startsWith('.')) {
    const baseDir = path.dirname(testAbsPath);
    const guess = path.resolve(baseDir, mockArg);
    return tryExtensions(guess);
  }
  // Bare-package or scoped — out of scope
  return null;
}

function tryExtensions(p) {
  const candidates = [
    p,
    p + '.ts',
    p + '.tsx',
    p + '.js',
    path.join(p, 'index.ts'),
    path.join(p, 'index.tsx'),
    path.join(p, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {}
  }
  return null;
}

// ── lint per test file ────────────────────────────────
function lintFile(absPath) {
  let src;
  try {
    src = fs.readFileSync(absPath, 'utf8');
  } catch {
    return;
  }

  const calls = findViMockCalls(src);
  for (const call of calls) {
    const mockPath = call.path;
    if (!call.factoryArg) continue; // vi.mock with no factory = full auto-mock
    // Skip async factories that use vi.importActual (treated as complete)
    if (/vi\.importActual/.test(call.factoryArg)) continue;

    const realAbs = resolveMockPath(absPath, mockPath);
    if (!realAbs) continue; // bare-package or unresolvable; out of scope

    const realExports = parseExports(realAbs);
    if (!realExports) continue;
    const factoryKeys = extractFactoryReturnKeys(call.factoryArg);
    if (!factoryKeys) {
      findings.push({
        severity: 'unparseable',
        test: path.relative(ROOT, absPath),
        line: call.lineNum,
        mockPath,
        realModule: path.relative(ROOT, realAbs),
        message: `Factory body could not be parsed; manual review needed.`,
      });
      continue;
    }

    if (factoryKeys.hasSpread) {
      // ...vi.importActual or ...rest spread is treated as full-coverage signal
      continue;
    }

    const runtimeSet = new Set(realExports.runtimeExports);
    const typeOnlySet = new Set(realExports.typeOnlyExports);
    const exposedSet = new Set(factoryKeys.exposed);

    // Only RUNTIME exports need to be in the factory — TS erases types.
    const missing = [...runtimeSet].filter((k) => !exposedSet.has(k));
    // Extra keys: anything in the factory NOT in the real module. We allow
    // common test-helper names (suffix _, prefix __mock, ALL_CAPS sentinel).
    const isHelperKey = (k) =>
      /^_/.test(k) || /^__/.test(k) || k.endsWith('Mock') || /^MOCK_/.test(k);
    const extra = [...exposedSet]
      .filter((k) => !runtimeSet.has(k) && !typeOnlySet.has(k))
      .filter((k) => !isHelperKey(k));
    const defaultMismatch = realExports.hasDefault && !factoryKeys.hasDefault;

    if (missing.length || defaultMismatch) {
      findings.push({
        severity: 'partial-mock',
        test: path.relative(ROOT, absPath),
        line: call.lineNum,
        mockPath,
        realModule: path.relative(ROOT, realAbs),
        runtimeExports: [...runtimeSet].sort(),
        typeOnlyExports: [...typeOnlySet].sort(),
        factoryKeys: [...exposedSet].sort(),
        missing: missing.sort(),
        extra: extra.sort(),
        defaultMismatch,
        hasReExport: realExports.hasReExport,
      });
    }
  }
}

const tests = listTestFiles();
for (const t of tests) lintFile(t);

const summary = {
  generatedAt: new Date().toISOString(),
  testFilesScanned: tests.length,
  partialMockCount: findings.filter((f) => f.severity === 'partial-mock').length,
  unparseableCount: findings.filter((f) => f.severity === 'unparseable').length,
  affectedRealModules: [
    ...new Set(findings.map((f) => f.realModule)),
  ].sort(),
  affectedTestFiles: [...new Set(findings.map((f) => f.test))].sort(),
};

function readStrictBaseline() {
  if (explicitFiles) return { partialMockCount: 0, allowances: [] };
  if (!fs.existsSync(BASELINE_PATH)) return { partialMockCount: 0, allowances: [] };
  return parseViMockStrictBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'));
}

// Aggregate by real-module to spot the most-mocked modules
const byModule = new Map();
for (const f of findings) {
  if (f.severity !== 'partial-mock') continue;
  const entry = byModule.get(f.realModule) || {
    module: f.realModule,
    timesMocked: 0,
    distinctTestFiles: new Set(),
    runtimeExportCount: f.runtimeExports?.length ?? 0,
    typicalMissing: f.missing,
  };
  entry.timesMocked++;
  entry.distinctTestFiles.add(f.test);
  byModule.set(f.realModule, entry);
}
const topModules = [...byModule.values()]
  .map((e) => ({ ...e, distinctTestFiles: e.distinctTestFiles.size }))
  .sort((a, b) => b.timesMocked - a.timesMocked)
  .slice(0, 25);

const TOP_ONLY = args.has('--top');
const strictBaseline = STRICT ? readStrictBaseline() : null;
const strictEvaluation = strictBaseline
  ? evaluateViMockStrictFindings(findings, strictBaseline)
  : null;

if (JSON_OUT) {
  console.log(JSON.stringify({
    summary: strictEvaluation ? { ...summary, strictEvaluation } : summary,
    topModules,
    findings,
  }, null, 2));
} else {
  console.log(`# vi.mock completeness lint`);
  console.log();
  console.log(`Test files scanned: ${summary.testFilesScanned}`);
  console.log(`Partial mocks: ${summary.partialMockCount}`);
  console.log(`Unparseable factories: ${summary.unparseableCount}`);
  console.log(`Affected real modules: ${summary.affectedRealModules.length}`);
  console.log(`Affected test files: ${summary.affectedTestFiles.length}`);
  if (STRICT) {
    console.log(`Strict scoped allowances: ${strictEvaluation.allowedCount} partial mocks`);
    console.log(`Strict evaluated partial mocks: ${strictEvaluation.evaluatedPartialMockCount}`);
    console.log(`Strict baseline: ${strictBaseline.partialMockCount} partial mocks`);
    for (const exceeded of strictEvaluation.exceededAllowances) {
      console.log(
        `Strict allowance exceeded: ${exceeded.realModule} ${exceeded.count} > ${exceeded.maximum}`,
      );
    }
  }
  console.log();
  if (findings.length === 0) {
    console.log('✅ No partial mocks detected. `singleFork: true` is safe to lift.');
  } else {
    console.log(`## Top-25 most-mocked modules with partial coverage`);
    console.log();
    console.log('| Real module | Times mocked | Distinct test files | Runtime exports |');
    console.log('| --- | ---: | ---: | ---: |');
    for (const m of topModules) {
      console.log(`| \`${m.module}\` | ${m.timesMocked} | ${m.distinctTestFiles} | ${m.runtimeExportCount} |`);
    }
    console.log();
    if (TOP_ONLY) {
      console.log(`(use --json for the full per-call list)`);
    } else {
      console.log(`## Per-call findings`);
      console.log();
      for (const f of findings) {
        console.log(`---`);
        console.log(`[${f.severity}] ${f.test}:${f.line || '?'} → mocks ${f.mockPath} (${f.realModule})`);
        if (f.severity === 'unparseable') {
          console.log(`    ${f.message}`);
        } else {
          if (f.missing.length) console.log(`    missing runtime keys: ${f.missing.join(', ')}`);
          if (f.extra.length) console.log(`    extra (mock-only) keys: ${f.extra.join(', ')}`);
          if (f.defaultMismatch) console.log(`    real module has default export, factory does not`);
          if (f.hasReExport) console.log(`    note: real module has re-exports — keys list may be incomplete`);
        }
      }
    }
  }
}

if (STRICT) {
  if (!passesViMockStrictGate(strictBaseline, strictEvaluation)) process.exit(1);
}
