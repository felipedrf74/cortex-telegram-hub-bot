#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const errors = [];
const capabilityManifest = readJson('config/capability-manifest.json');
const jobManifest = readJson('config/agent-job-manifest.json');
const skillSource = fs.readFileSync(path.join(root, 'src/skills/skill-config.ts'), 'utf8');
const defaultBlock = skillSource.match(/export const DEFAULT_SKILLS[\s\S]*?=\s*\{([\s\S]*?)\n\};/)?.[1] ?? '';
const runtimeCapabilityIds = [...defaultBlock.matchAll(/^\s*([a-z_]+):\s*[A-Z0-9_]+_SKILL,/gm)].map((match) => match[1]);
const manifestById = new Map(capabilityManifest.capabilities.map((entry) => [entry.id, entry]));
for (const id of runtimeCapabilityIds) {
  const entry = manifestById.get(id);
  if (!entry) errors.push(`capability missing from manifest: ${id}`);
  const symbol = id === 'decision_center' ? 'DECISION_CENTER' : id.toUpperCase();
  const block = skillSource.match(new RegExp(`const ${symbol}_SKILL:[\\s\\S]*?=\\s*\\{([\\s\\S]*?)\\n\\};`))?.[1] ?? '';
  const version = block.match(/version:\s*'([^']+)'/)?.[1];
  const tier = block.match(/requiredTier:\s*'([^']+)'/)?.[1] ?? 'pro';
  if (entry && entry.version !== version) errors.push(`capability version drift: ${id} manifest=${entry.version} runtime=${version}`);
  if (entry && entry.requiredTier !== tier) errors.push(`capability tier drift: ${id} manifest=${entry.requiredTier} runtime=${tier}`);
}
for (const id of manifestById.keys()) if (!runtimeCapabilityIds.includes(id)) errors.push(`manifest capability missing at runtime: ${id}`);

const schedulerSource = fs.readFileSync(path.join(root, 'src/services/scheduler.ts'), 'utf8');
const runtimeJobIds = [...schedulerSource.matchAll(/registerJob\(\s*'([^']+)'/g)].map((match) => match[1]);
const manifestJobIds = jobManifest.jobs.map((job) => job.id);
for (const id of runtimeJobIds) if (!manifestJobIds.includes(id)) errors.push(`scheduler job missing from manifest: ${id}`);
for (const id of manifestJobIds) if (!runtimeJobIds.includes(id)) errors.push(`manifest job missing from scheduler: ${id}`);
for (const job of jobManifest.jobs) {
  if (job.inputFingerprint?.unchangedInputProviderCalls !== 0) errors.push(`job can call provider for unchanged input: ${job.id}`);
  for (const field of ['tenantScope', 'lockPolicy', 'retryPolicy', 'providerRouting', 'outputValidation']) {
    if (!job[field]) errors.push(`job missing ${field}: ${job.id}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, capabilities: runtimeCapabilityIds.length, jobs: runtimeJobIds.length }, null, 2));
