#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = fs.readFileSync(path.join(root, 'src/services/scheduler.ts'), 'utf8');
const jobs = [];
const pattern = /registerJob\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*('[^']*'|[A-Za-z_][A-Za-z0-9_]*)\s*,\s*'([^']+)'/g;
for (const match of source.matchAll(pattern)) {
  const scheduleExpression = match[3].trim();
  jobs.push({
    id: match[1],
    name: match[2],
    schedule: scheduleExpression.startsWith("'") ? scheduleExpression.slice(1, -1) : scheduleExpression,
    domain: match[4],
    lifecycle: 'active',
    tenantScope: 'explicit',
    lockPolicy: 'single-job-tenant',
    retryPolicy: 'bounded-backoff',
    providerRouting: 'shared-router',
    inputFingerprint: { unchangedInputProviderCalls: 0 },
    audit: { cost: true, inputs: 'redacted', outcome: true },
    outputValidation: 'schema-and-scope',
    notifications: 'policy-routed',
  });
}
jobs.sort((left, right) => left.id.localeCompare(right.id));
const manifest = { schema: 'nexus.agent-job-manifest.v1', version: '2026-07-15', jobs };
const output = path.join(root, 'config/agent-job-manifest.json');
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output: 'config/agent-job-manifest.json', jobs: jobs.length }, null, 2));
