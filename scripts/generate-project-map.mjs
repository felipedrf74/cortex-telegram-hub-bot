#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  .filter((file) => fs.existsSync(path.join(root, file)));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
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

const sourceFiles = tracked.filter((file) => file.startsWith('src/') && file.endsWith('.ts'));
const modules = [...new Set(sourceFiles.map((file) => file.split('/').slice(0, 2).join('/')))]
  .sort()
  .map((module) => ({
    path: module,
    owner: ownerFor(module),
    files: sourceFiles.filter((file) => file.startsWith(`${module}/`)).length,
  }));

const routePattern = /\b(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;
const routes = [];
for (const file of sourceFiles.filter((entry) => entry.includes('/api/') || entry.includes('/portal/'))) {
  for (const match of read(file).matchAll(routePattern)) {
    routes.push({ method: match[1].toUpperCase(), path: match[2], source: file, owner: ownerFor(file) });
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
}));
const skills = tracked.filter((file) => file.startsWith('.agents/skills/') && file.endsWith('/SKILL.md'))
  .map((file) => ({ name: file.split('/')[2], source: file, claude: `.claude/skills/${file.split('/')[2]}/SKILL.md` }))
  .sort((left, right) => left.name.localeCompare(right.name));
const tests = tracked.filter((file) => file.startsWith('__tests__/') && /\.test\.ts$/.test(file));
const docs = tracked.filter((file) => file.endsWith('.md')).sort();
const largeAssets = tracked.map((file) => {
  try {
    const size = fs.statSync(path.join(root, file)).size;
    return size >= 250_000 ? { path: file, bytes: size, generated: /compiled|bundle|scaffold|ledger/i.test(file) } : null;
  } catch {
    return null;
  }
}).filter(Boolean).sort((left, right) => right.bytes - left.bytes);

const projectMap = {
  schema: 'nexus.project-map.v1',
  reviewedAt: '2026-07-15',
  navigation: {
    agentBootloader: 'AGENTS.md',
    docsIndex: 'docs/DOCS_INDEX.md',
    releaseState: 'docs/release/release-state.json',
    testPolicy: 'config/test-policy.json',
    capabilityManifest: 'config/capability-manifest.json',
    agentJobManifest: 'config/agent-job-manifest.json',
  },
  modules,
  routes: routes.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method)),
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
  documentation: { count: docs.length, files: docs },
  largeAssets,
};
fs.writeFileSync(path.join(root, 'docs/project-map.json'), `${JSON.stringify(projectMap, null, 2)}\n`);
console.log(JSON.stringify({
  output: 'docs/project-map.json', modules: modules.length, routes: routes.length,
  migrations: migrationFiles.length, capabilities: capabilities.length,
  skills: skills.length, tests: tests.length, docs: docs.length, largeAssets: largeAssets.length,
}, null, 2));
