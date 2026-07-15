#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_JOB_MANIFEST_SCHEMA,
  buildAgentJobManifest,
  serializeAgentJobManifest,
} from './generate-agent-job-manifest.mjs';

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const errors = [];
const capabilityManifest = readJson('config/capability-manifest.json');
const jobManifestPath = path.join(root, 'config/agent-job-manifest.json');
const jobManifestRaw = fs.readFileSync(jobManifestPath, 'utf8');
const jobManifest = JSON.parse(jobManifestRaw);
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
const eventBackboneSource = fs.readFileSync(path.join(root, 'src/services/event-backbone-worker.ts'), 'utf8');
const chatActionFixerSource = fs.readFileSync(path.join(root, 'src/services/chat-action-fixer-worker.ts'), 'utf8');
const generatedJobManifest = buildAgentJobManifest(schedulerSource, eventBackboneSource, chatActionFixerSource);
const generatedJobManifestRaw = serializeAgentJobManifest(generatedJobManifest);
if (jobManifest.schema !== AGENT_JOB_MANIFEST_SCHEMA) {
  errors.push(`agent-job manifest schema drift: expected=${AGENT_JOB_MANIFEST_SCHEMA} actual=${jobManifest.schema}`);
}
if (jobManifestRaw !== generatedJobManifestRaw) {
  errors.push('agent-job manifest is not byte-for-byte equal to generated scheduler metadata');
}
const normalizeSchedule = (token) => token.startsWith("'") ? token.slice(1, -1) : token;
const registrationPattern = /registerJob\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*('[^']*'|[A-Za-z_][A-Za-z0-9_]*)\s*,\s*'([^']+)'/g;
const registrations = [...schedulerSource.matchAll(registrationPattern)].map((match) => ({
  id: match[1],
  name: match[2],
  schedule: normalizeSchedule(match[3].trim()),
  domain: match[4],
}));
const schedules = [...schedulerSource.matchAll(/cron\.schedule\(\s*('[^']*'|[A-Za-z_][A-Za-z0-9_]*)\s*,\s*wrapJob\(\s*'([^']+)'/g)]
  .map((match) => ({ id: match[2], schedule: normalizeSchedule(match[1].trim()) }));
const runtimeJobIds = registrations.map((entry) => entry.id);
const scheduledJobIds = schedules.map((entry) => entry.id);
const manifestJobIds = jobManifest.jobs.map((job) => job.id);
const duplicateIds = (ids) => [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
for (const id of duplicateIds(runtimeJobIds)) errors.push(`duplicate scheduler registration: ${id}`);
for (const id of duplicateIds(scheduledJobIds)) errors.push(`duplicate scheduled callback: ${id}`);
for (const id of duplicateIds(manifestJobIds)) errors.push(`duplicate manifest job: ${id}`);
for (const id of runtimeJobIds) if (!manifestJobIds.includes(id)) errors.push(`scheduler job missing from manifest: ${id}`);
for (const id of manifestJobIds) if (!runtimeJobIds.includes(id)) errors.push(`manifest job missing from scheduler: ${id}`);
for (const id of scheduledJobIds) if (!runtimeJobIds.includes(id)) errors.push(`scheduled callback is unregistered: ${id}`);
for (const id of runtimeJobIds) if (!scheduledJobIds.includes(id)) errors.push(`registered job has no scheduled callback: ${id}`);
for (const registration of registrations) {
  const scheduled = schedules.find((entry) => entry.id === registration.id);
  const manifest = jobManifest.jobs.find((entry) => entry.id === registration.id);
  if (scheduled && scheduled.schedule !== registration.schedule) {
    errors.push(`scheduler cron drift: ${registration.id} registered=${registration.schedule} scheduled=${scheduled.schedule}`);
  }
  if (manifest && manifest.schedule !== registration.schedule) {
    errors.push(`manifest cron drift: ${registration.id} registered=${registration.schedule} manifest=${manifest.schedule}`);
  }
  if (manifest && manifest.name !== registration.name) {
    errors.push(`manifest name drift: ${registration.id} registered=${registration.name} manifest=${manifest.name}`);
  }
  if (manifest && manifest.domain !== registration.domain) {
    errors.push(`manifest domain drift: ${registration.id} registered=${registration.domain} manifest=${manifest.domain}`);
  }
}
for (const job of jobManifest.jobs) {
  for (const field of [
    'policyOwner',
    'jobVersion',
    'tenantScope',
    'overlapPolicy',
    'retryPolicy',
    'providerRouting',
    'costPolicy',
    'latencyPolicy',
    'outputPolicy',
    'notificationPolicy',
  ]) {
    if (typeof job[field] !== 'string' || job[field].trim() === '') errors.push(`job missing ${field}: ${job.id}`);
  }
  if (!['none', 'governed-provider-capable'].includes(job.providerUsage)) {
    errors.push(`job has invalid provider usage: ${job.id}`);
  }
  if (job.inputFingerprint?.unchangedInputProviderCalls !== 0) {
    errors.push(`job can call a model provider for unchanged successful input: ${job.id}`);
  }
  if (job.providerUsage === 'none'
      && job.inputFingerprint?.enforcement !== 'not-applicable-no-provider') {
    errors.push(`non-provider job has provider fingerprint enforcement: ${job.id}`);
  }
  if (job.providerUsage === 'governed-provider-capable') {
    if (!['runtime-fingerprint', 'report-schedule-ledger', 'output-inventory-gate', 'durable-job-idempotency']
      .includes(job.inputFingerprint?.enforcement)) {
      errors.push(`provider-capable job lacks unchanged-input enforcement: ${job.id}`);
    }
    if (!Array.isArray(job.inputFingerprint?.tests) || job.inputFingerprint.tests.length === 0) {
      errors.push(`provider-capable job lacks test evidence: ${job.id}`);
    }
    for (const testPath of job.inputFingerprint?.tests ?? []) {
      if (!fs.existsSync(path.join(root, testPath))) errors.push(`job test evidence is missing: ${job.id}/${testPath}`);
    }
  }
  if (job.sharedRunner) {
    if (job.providerUsage !== 'governed-provider-capable'
        || job.sharedRunner.implementation !== 'governed-v1'
        || !['platform', 'tenant-user'].includes(job.sharedRunner.scope)
        || !Number.isSafeInteger(job.sharedRunner.maxAttempts)
        || job.sharedRunner.maxAttempts < 1
        || job.sharedRunner.maxAttempts > 5
        || !Number.isSafeInteger(job.sharedRunner.retryBackoffMs)
        || job.sharedRunner.retryBackoffMs < 0
        || job.sharedRunner.retryBackoffMs > 60_000
        || job.sharedRunner.auditStore !== 'agent_job_runs'
        || job.sharedRunner.providerAttribution !== 'api_usage-run-id'
        || job.sharedRunner.outputValidation !== 'adapter-required') {
      errors.push(`job has invalid shared runner policy: ${job.id}`);
    }
  }
}
const sharedRunnerJobIds = jobManifest.jobs.filter((job) => job.sharedRunner).map((job) => job.id).sort();
const expectedSharedRunnerJobIds = ['autoresearch', 'friday_weekly', 'thursday_youtube', 'tuesday_reels'];
if (JSON.stringify(sharedRunnerJobIds) !== JSON.stringify(expectedSharedRunnerJobIds)) {
  errors.push(`shared runner job migration drift: expected=${expectedSharedRunnerJobIds.join(',')} actual=${sharedRunnerJobIds.join(',')}`);
}

const handlerIdentity = (entry, kind) => kind === 'event' ? entry.eventType : `${entry.jobType}:${entry.idempotent}`;
for (const [kind, handlers] of [
  ['event', jobManifest.eventHandlers ?? []],
  ['queued-job', jobManifest.queuedJobHandlers ?? []],
]) {
  const identities = handlers.map((entry) => handlerIdentity(entry, kind));
  for (const id of duplicateIds(identities)) errors.push(`duplicate ${kind} handler: ${id}`);
  for (const handler of handlers) {
    for (const field of [
      'id',
      'runtimeGroup',
      'policyOwner',
      'handlerVersion',
      'tenantScope',
      'retryPolicy',
      'providerRouting',
      'costPolicy',
      'latencyPolicy',
      'outputPolicy',
    ]) {
      if (typeof handler[field] !== 'string' || handler[field].trim() === '') {
        errors.push(`${kind} handler missing ${field}: ${handler.id ?? 'unknown'}`);
      }
    }
    if (!['none', 'governed-provider-capable'].includes(handler.providerUsage)) {
      errors.push(`${kind} handler has invalid provider usage: ${handler.id}`);
    }
    if (handler.inputFingerprint?.unchangedInputProviderCalls !== 0) {
      errors.push(`${kind} handler can call a model provider for unchanged successful input: ${handler.id}`);
    }
    if (handler.providerUsage === 'none'
        && handler.inputFingerprint?.enforcement !== 'not-applicable-no-provider') {
      errors.push(`non-provider ${kind} handler has provider enforcement: ${handler.id}`);
    }
    if (handler.providerUsage === 'governed-provider-capable') {
      if (handler.inputFingerprint?.enforcement === 'not-applicable-no-provider') {
        errors.push(`provider-capable ${kind} handler lacks unchanged-input enforcement: ${handler.id}`);
      }
      if (!Array.isArray(handler.inputFingerprint?.tests) || handler.inputFingerprint.tests.length === 0) {
        errors.push(`provider-capable ${kind} handler lacks test evidence: ${handler.id}`);
      }
      for (const testPath of handler.inputFingerprint?.tests ?? []) {
        if (!fs.existsSync(path.join(root, testPath))) errors.push(`${kind} handler test evidence is missing: ${handler.id}/${testPath}`);
      }
    }
  }
}
const directEventEffects = (jobManifest.eventHandlers ?? []).flatMap((handler) => handler.directEffects ?? []);
for (const id of duplicateIds(directEventEffects.map((effect) => effect.id))) {
  errors.push(`duplicate direct event effect: ${id}`);
}
for (const effect of directEventEffects) {
  for (const field of [
    'id',
    'eventType',
    'effect',
    'runtimeGroup',
    'policyOwner',
    'handlerVersion',
    'tenantScope',
    'retryPolicy',
    'providerRouting',
    'costPolicy',
    'latencyPolicy',
    'outputPolicy',
  ]) {
    if (typeof effect[field] !== 'string' || effect[field].trim() === '') {
      errors.push(`direct event effect missing ${field}: ${effect.id ?? 'unknown'}`);
    }
  }
  if (effect.providerUsage !== 'none'
      || effect.inputFingerprint?.enforcement !== 'not-applicable-no-provider'
      || effect.inputFingerprint?.unchangedInputProviderCalls !== 0) {
    errors.push(`direct event effect has invalid provider governance: ${effect.id}`);
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({
  ok: true,
  capabilities: runtimeCapabilityIds.length,
  jobManifestSchema: jobManifest.schema,
  generatedParity: true,
  jobs: runtimeJobIds.length,
  scheduledJobs: scheduledJobIds.length,
  providerCapableJobs: jobManifest.jobs.filter((job) => job.providerUsage === 'governed-provider-capable').length,
  sharedRunnerJobs: sharedRunnerJobIds.length,
  eventHandlers: jobManifest.eventHandlers.length,
  directEventEffects: directEventEffects.length,
  queuedJobHandlers: jobManifest.queuedJobHandlers.length,
}, null, 2));
