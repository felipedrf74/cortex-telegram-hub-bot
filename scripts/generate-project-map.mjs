#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  DOCUMENTATION_POLICY_PATH,
  resolveDocumentationInventory,
} from './lib/documentation-policy.mjs';
import { projectMapFreshnessProjection } from './lib/project-map-freshness.mjs';
import { projectMapSourceDigest } from './lib/project-map-source-digest.mjs';

const root = process.cwd();
const defaultOutput = 'docs/project-map.json';
const args = process.argv.slice(2);
const check = args.includes('--check');
const stdout = args.includes('--stdout');
const outputIndex = args.indexOf('--output');
const output = outputIndex === -1 ? defaultOutput : args[outputIndex + 1];

if (!output || (check && stdout)) {
  console.error('Usage: generate-project-map.mjs [--check | --stdout] [--output <path>]');
  process.exit(64);
}

const outputPath = path.isAbsolute(output) ? output : path.join(root, output);
const outputRelative = path.relative(root, outputPath).split(path.sep).join('/');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
})
  .trim().split('\n').filter(Boolean)
  // Audit the proposed filesystem, while excluding the generated output from
  // its own input digest and large-file inventory.
  .filter((file) => file !== defaultOutput
    && file !== outputRelative
    && fs.existsSync(path.join(root, file)))
  .sort();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const baseCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const baseCommitTimestamp = execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const ownerFor = (file) => {
  if (file.includes('training')) return 'training';
  if (file.includes('content')) return 'content';
  if (file.includes('finance') || file.includes('invoice')) return 'finance';
  if (file.includes('cooking')) return 'cooking';
  if (file.includes('auth') || file.includes('security')) return 'security';
  if (file.includes('release') || file.startsWith('.github/')) return 'release';
  if (file.includes('scheduler') || file.includes('agent')) return 'agents';
  return 'backend';
};

function sourceDigest(files) {
  return projectMapSourceDigest(root, files);
}

function resolveImport(importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const unresolved = path.resolve(root, path.dirname(importer), specifier);
  for (const candidate of [`${unresolved}.ts`, path.join(unresolved, 'index.ts')]) {
    if (fs.existsSync(candidate)) return path.relative(root, candidate).split(path.sep).join('/');
  }
  return null;
}

function namedFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current))
        && ts.isVariableDeclaration(current.parent)
        && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    current = current.parent;
  }
  return '<top-level>';
}

function stringArgument(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function calleeIdentifier(node) {
  if (!ts.isCallExpression(node)) return null;
  return ts.isIdentifier(node.expression) ? node.expression.text : null;
}

function joinRoutePath(...parts) {
  const segments = parts
    .filter((part) => typeof part === 'string' && part.length > 0 && part !== '/')
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function analyzeSource(file) {
  const source = read(file);
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bindings = new Map();
  const localFunctions = new Set();
  const routes = [];
  const pendingEdges = [];
  const variableMounts = new Map();
  const constantDeclarations = new Map();

  function collectDeclarations(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constantDeclarations.set(node.name.text, node.initializer);
    }
    if (ts.isVariableDeclaration(node)
        && ts.isObjectBindingPattern(node.name)
        && node.initializer
        && ts.isCallExpression(node.initializer)
        && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'require') {
      const target = resolveImport(file, stringArgument(node.initializer.arguments[0]) ?? '');
      if (target) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            bindings.set(element.name.text, {
              file: target,
              symbol: element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text,
            });
          }
        }
      }
    }
    ts.forEachChild(node, collectDeclarations);
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)
        && statement.importClause?.namedBindings
        && ts.isNamedImports(statement.importClause.namedBindings)) {
      const target = resolveImport(file, statement.moduleSpecifier.text);
      if (!target) continue;
      for (const element of statement.importClause.namedBindings.elements) {
        bindings.set(element.name.text, { file: target, symbol: element.propertyName?.text ?? element.name.text });
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) localFunctions.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)
            && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          localFunctions.add(declaration.name.text);
        }
      }
    }
  }
  collectDeclarations(sourceFile);

  function staticString(node, resolving = new Set()) {
    if (!node) return null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return staticString(node.expression, resolving);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      const expressionValue = staticString(node.expression, resolving);
      if (expressionValue !== null) return expressionValue;
      if (ts.isLiteralTypeNode(node.type) && ts.isStringLiteral(node.type.literal)) {
        return node.type.literal.text;
      }
      return null;
    }
    if (ts.isSatisfiesExpression(node)) return staticString(node.expression, resolving);
    if (ts.isIdentifier(node)) {
      if (resolving.has(node.text)) return null;
      const declaration = constantDeclarations.get(node.text);
      if (!declaration) return null;
      const next = new Set(resolving);
      next.add(node.text);
      return staticString(declaration, next);
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const expressionValue = staticString(span.expression, resolving);
        if (expressionValue === null) return null;
        value += expressionValue + span.literal.text;
      }
      return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticString(node.left, resolving);
      const right = staticString(node.right, resolving);
      return left === null || right === null ? null : left + right;
    }
    return null;
  }

  const bindingFor = (symbol) => bindings.get(symbol)
    ?? (localFunctions.has(symbol) ? { file, symbol } : null);
  const hostKeyFor = (node) => `${file}#${namedFunction(node)}`;

  function visit(node) {
    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ['get', 'post', 'put', 'patch', 'delete'].includes(node.expression.name.text)) {
      const receiver = node.expression.expression.getText(sourceFile);
      const localPath = staticString(node.arguments[0]);
      // F15: `v<n>` accepts versioned sub-router locals. `mountCoachV2Routes`
      // names its sub-router `v2`, which matched none of `router` / `app` /
      // `*Router`, so all six Coach V2 routes were silently dropped at
      // collection — the mount edge resolved fine, the receiver name did not.
      // The allow-list stays narrow on purpose: it exists to keep unrelated
      // `.get(...)` calls (http clients, Maps) out of the route table.
      if (localPath !== null && /^(?:router|app|v\d+|[A-Za-z][A-Za-z0-9]*Router)$/.test(receiver)) {
        routes.push({
          method: node.expression.name.text.toUpperCase(),
          localPath,
          handler: namedFunction(node),
        });
      }
    }

    if (ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'use') {
      const prefix = staticString(node.arguments[0]);
      if (prefix !== null) {
        const hostKey = hostKeyFor(node);
        for (const argument of node.arguments.slice(1)) {
          if (ts.isIdentifier(argument)) {
            variableMounts.set(`${hostKey}|${argument.text}`, prefix);
          }
          const targetSymbol = calleeIdentifier(argument);
          const target = targetSymbol ? bindingFor(targetSymbol) : null;
          if (target) pendingEdges.push({ hostKey, targetKey: `${target.file}#${target.symbol}`, prefix });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  function collectRegistrarEdges(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const target = bindingFor(node.expression.text);
      const firstArgument = node.arguments[0];
      if (target && firstArgument && ts.isIdentifier(firstArgument)) {
        const hostKey = hostKeyFor(node);
        if (firstArgument.text === 'app' || firstArgument.text === 'router') {
          pendingEdges.push({ hostKey, targetKey: `${target.file}#${target.symbol}`, prefix: '' });
        } else {
          const prefix = variableMounts.get(`${hostKey}|${firstArgument.text}`);
          if (prefix !== undefined) {
            pendingEdges.push({ hostKey, targetKey: `${target.file}#${target.symbol}`, prefix });
          }
        }
      }
    }
    ts.forEachChild(node, collectRegistrarEdges);
  }
  collectRegistrarEdges(sourceFile);
  return { routes, edges: pendingEdges };
}

const sourceFiles = tracked.filter((file) => file.startsWith('src/') && file.endsWith('.ts'));
const modules = [...new Set(sourceFiles.map((file) => file.split('/').slice(0, 2).join('/')))]
  .sort()
  .map((module) => ({
    path: module,
    owner: ownerFor(module),
    files: sourceFiles.filter((file) => file === module || file.startsWith(`${module}/`)).length,
  }));

const routeSourceFiles = sourceFiles.filter((entry) => entry.includes('/api/') || entry.includes('/portal/'));
const analyses = new Map(routeSourceFiles.map((file) => [file, analyzeSource(file)]));
const mounts = new Map([
  ['src/portal/server.ts#createPortalServer', new Set(['/'])],
  ['src/api/router.ts#createApiRouter', new Set(['/api/v1'])],
]);
const edges = [...analyses.values()].flatMap((analysis) => analysis.edges);
let changed = true;
while (changed) {
  changed = false;
  for (const edge of edges) {
    const hostMounts = mounts.get(edge.hostKey);
    if (!hostMounts) continue;
    const targetMounts = mounts.get(edge.targetKey) ?? new Set();
    for (const hostMount of hostMounts) {
      const mounted = joinRoutePath(hostMount, edge.prefix);
      if (!targetMounts.has(mounted)) {
        targetMounts.add(mounted);
        changed = true;
      }
    }
    mounts.set(edge.targetKey, targetMounts);
  }
}

const routes = [];
for (const [file, analysis] of analyses) {
  for (const route of analysis.routes) {
    const exactMounts = mounts.get(`${file}#${route.handler}`);
    const fileMounts = [...mounts.entries()]
      .filter(([key]) => key.startsWith(`${file}#`))
      .flatMap(([, values]) => [...values]);
    const resolvedMounts = exactMounts && exactMounts.size > 0
      ? [...exactMounts]
      : [...new Set(fileMounts)].length === 1
        ? [...new Set(fileMounts)]
        : file.startsWith('src/portal/')
          ? ['/']
          : [];
    if (resolvedMounts.length === 0) {
      routes.push({
        method: route.method,
        path: route.localPath,
        localPath: route.localPath,
        mountPath: null,
        source: file,
        owner: ownerFor(file),
      });
      continue;
    }
    for (const mountPath of resolvedMounts) {
      routes.push({
        method: route.method,
        path: joinRoutePath(mountPath, route.localPath),
        localPath: route.localPath,
        mountPath,
        source: file,
        owner: ownerFor(file),
      });
    }
  }
}

const migrationFiles = tracked.filter((file) => /^migrations\/\d{3}_.+\.sql$/.test(file)).sort();
const migrationDigest = sha256(JSON.stringify(migrationFiles.map((file) => ({ file, sha256: sha256(read(file)) }))));
const capabilityManifest = JSON.parse(read('config/capability-manifest.json'));
const capabilities = capabilityManifest.capabilities.map((entry) => ({
  id: entry.id,
  version: entry.version,
  lifecycle: entry.lifecycle,
  owner: entry.owner,
  requiredTier: entry.requiredTier,
  schemas: entry.schemas,
}));
const skills = tracked.filter((file) => file.startsWith('.agents/skills/') && file.endsWith('/SKILL.md'))
  .map((file) => ({ name: file.split('/')[2], source: file, claude: `.claude/skills/${file.split('/')[2]}/SKILL.md` }))
  .sort((left, right) => left.name.localeCompare(right.name));
const tests = tracked.filter((file) => file.startsWith('__tests__/') && /\.test\.ts$/.test(file));
const docs = tracked.filter((file) => file.endsWith('.md')).sort();
const documentationInventory = resolveDocumentationInventory({ repoRoot: root, files: docs });
if (documentationInventory.issues.length > 0) {
  const issue = documentationInventory.issues[0];
  throw new Error(`Documentation governance failed for ${issue.file}: ${issue.message}`);
}
const documentationStatusCounts = Object.fromEntries(
  [...new Set(documentationInventory.records.map((record) => record.status))]
    .sort()
    .map((status) => [
      status,
      documentationInventory.records.filter((record) => record.status === status).length,
    ]),
);
const largeAssets = tracked.map((file) => {
  try {
    const size = fs.statSync(path.join(root, file)).size;
    return size >= 250_000 ? { path: file, bytes: size, generated: /compiled|bundle|scaffold|ledger/i.test(file) } : null;
  } catch {
    return null;
  }
}).filter(Boolean).sort((left, right) => right.bytes - left.bytes);

const projectMap = {
  schema: 'nexus.project-map.v3',
  generatedFrom: {
    generator: 'scripts/generate-project-map.mjs',
    generatorVersion: 4,
    authoritativeFreshness: 'sourceDigest',
    sourceDigestAlgorithm: 'sha256-path-git-mode-content-v2',
    sourceDigest: sourceDigest(tracked),
    baseCommit,
    baseCommitTimestamp,
    trackedFiles: tracked.length,
    sourceFiles: sourceFiles.length,
  },
  navigation: {
    agentBootloader: 'AGENTS.md',
    docsIndex: 'docs/DOCS_INDEX.md',
    releaseState: 'docs/release/release-state.json',
    testPolicy: 'config/test-policy.json',
    capabilityManifest: 'config/capability-manifest.json',
    agentJobManifest: 'config/agent-job-manifest.json',
    documentationPolicy: DOCUMENTATION_POLICY_PATH,
  },
  modules,
  routes: routes.sort((left, right) => left.path.localeCompare(right.path)
    || left.method.localeCompare(right.method) || left.source.localeCompare(right.source)),
  migrations: { count: migrationFiles.length, latest: migrationFiles.at(-1) ?? null, digest: migrationDigest, files: migrationFiles },
  capabilities,
  skills,
  tests: {
    files: tests.length,
    policy: 'config/test-policy.json',
    inventoryArtifact: '.local/test-inventory/test-inventory.json',
    topLevelOwners: Object.fromEntries([...new Set(tests.map((file) => file.split('/')[1]))].sort().map((owner) => [
      owner, tests.filter((file) => file.split('/')[1] === owner).length,
    ])),
  },
  documentation: {
    policy: DOCUMENTATION_POLICY_PATH,
    policySchema: documentationInventory.policy.schema,
    policyVersion: documentationInventory.policy.version,
    count: documentationInventory.records.length,
    active: documentationInventory.records.filter((record) => record.active).length,
    statusCounts: documentationStatusCounts,
    files: documentationInventory.records,
  },
  largeAssets,
};
const serialized = `${JSON.stringify(projectMap, null, 2)}\n`;
const summary = {
  output: outputRelative,
  schema: projectMap.schema,
  sourceDigest: projectMap.generatedFrom.sourceDigest,
  modules: modules.length,
  routes: routes.length,
  unresolvedRouteMounts: routes.filter((route) => route.mountPath === null).length,
  migrations: migrationFiles.length,
  capabilities: capabilities.length,
  skills: skills.length,
  tests: tests.length,
  docs: docs.length,
  largeAssets: largeAssets.length,
};

if (stdout) {
  process.stdout.write(serialized);
} else if (check) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (projectMapFreshnessProjection(current) !== projectMapFreshnessProjection(serialized)) {
    console.error(`Project map drift: run npm run project:map and commit ${outputRelative}.`);
    // Name the divergence so an environment-dependent input is diagnosable
    // from the failing log instead of guesswork (values stay bounded).
    try {
      const committed = JSON.parse(current);
      const regenerated = JSON.parse(serialized);
      for (const key of ['sourceDigest', 'trackedFiles', 'sourceFiles']) {
        if (JSON.stringify(committed.generatedFrom?.[key]) !== JSON.stringify(regenerated.generatedFrom?.[key])) {
          console.error(`  generatedFrom.${key}: committed=${JSON.stringify(committed.generatedFrom?.[key])} regenerated=${JSON.stringify(regenerated.generatedFrom?.[key])}`);
        }
      }
      const keys = new Set([...Object.keys(committed), ...Object.keys(regenerated)]);
      for (const key of keys) {
        if (key === 'generatedFrom') continue;
        const left = JSON.stringify(committed[key]);
        const right = JSON.stringify(regenerated[key]);
        if (left !== right) {
          console.error(`  ${key}: differs (committed ${String(left).length} chars vs regenerated ${String(right).length} chars)`);
          if (String(left).length < 600 && String(right).length < 600) {
            console.error(`    committed=${left}`);
            console.error(`    regenerated=${right}`);
          }
        }
      }
    } catch {
      console.error('  (divergence detail unavailable: unparseable map)');
    }
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...summary }, null, 2));
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized);
  console.log(JSON.stringify(summary, null, 2));
}
