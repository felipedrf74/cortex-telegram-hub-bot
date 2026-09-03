#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_JOB_MANIFEST_SCHEMA,
  buildAgentJobManifest,
  serializeAgentJobManifest,
} from './generate-agent-job-manifest.mjs';
import {
  CAPABILITY_SKILL_METADATA_OUTPUT,
  buildCapabilitySkillMetadata,
  serializeCapabilitySkillMetadata,
} from './generate-capability-skill-metadata.mjs';
import { validateLocalModelManifest } from './validate-local-model-manifest.mjs';

const root = process.cwd();
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const errors = [];
const capabilityManifest = readJson('config/capability-manifest.json');
const jobManifestPath = path.join(root, 'config/agent-job-manifest.json');
const jobManifestRaw = fs.readFileSync(jobManifestPath, 'utf8');
const jobManifest = JSON.parse(jobManifestRaw);
const expectedCapabilitySkillMetadata = serializeCapabilitySkillMetadata(capabilityManifest);
const capabilitySkillMetadataPath = path.join(root, CAPABILITY_SKILL_METADATA_OUTPUT);
const capabilitySkillMetadataRaw = fs.existsSync(capabilitySkillMetadataPath)
  ? fs.readFileSync(capabilitySkillMetadataPath, 'utf8')
  : null;
if (capabilitySkillMetadataRaw !== expectedCapabilitySkillMetadata) {
  errors.push('generated capability skill metadata is not byte-for-byte equal to CapabilityManifest');
}
const runtimeCapabilityIds = Object.keys(buildCapabilitySkillMetadata(capabilityManifest));

const schedulerSource = fs.readFileSync(path.join(root, 'src/services/scheduler.ts'), 'utf8');
const eventBackboneSource = fs.readFileSync(path.join(root, 'src/services/event-backbone-worker.ts'), 'utf8');
const chatActionFixerSource = fs.readFileSync(path.join(root, 'src/services/chat-action-fixer-worker.ts'), 'utf8');
const trainingCalendarSyncSource = fs.readFileSync(path.join(root, 'src/services/training-plan-calendar-sync-worker.ts'), 'utf8');
const scheduledAgentJobsSource = fs.readFileSync(path.join(root, 'src/services/scheduled-agent-jobs.ts'), 'utf8');
const voiceEvolutionSource = fs.readFileSync(path.join(root, 'src/agents/voice-evolution-agent.ts'), 'utf8');
const generatedJobManifest = buildAgentJobManifest(schedulerSource, eventBackboneSource, chatActionFixerSource, trainingCalendarSyncSource);
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
for (const id of runtimeJobIds) {
  const manifest = jobManifest.jobs.find((entry) => entry.id === id);
  if (manifest?.lifecycle === 'active' && !scheduledJobIds.includes(id)) {
    errors.push(`active registered job has no scheduled callback: ${id}`);
  }
  if (manifest?.lifecycle === 'paused' && scheduledJobIds.includes(id)) {
    errors.push(`paused registered job still has a scheduled callback: ${id}`);
  }
}
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
  if (!['active', 'paused'].includes(job.lifecycle)) {
    errors.push(`job has invalid lifecycle: ${job.id}`);
  }
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
        || !['platform', 'tenant-user', 'platform-or-tenant-user'].includes(job.sharedRunner.scope)
        || !['runner', 'adapter'].includes(job.sharedRunner.fingerprintGate)
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
const expectedSharedRunnerJobIds = [
  'autoresearch',
  'channel_relearn',
  'chat_action_fixer_worker',
  'friday_weekly',
  'garmin_coach',
  'thursday_youtube',
  'tuesday_reels',
  'voice_evolution',
];
if (JSON.stringify(sharedRunnerJobIds) !== JSON.stringify(expectedSharedRunnerJobIds)) {
  errors.push(`shared runner job migration drift: expected=${expectedSharedRunnerJobIds.join(',')} actual=${sharedRunnerJobIds.join(',')}`);
}
for (const [jobId, source, token] of [
  ['channel_relearn', scheduledAgentJobsSource, 'runScheduledChannelRelearn'],
  ['chat_action_fixer_worker', chatActionFixerSource, 'runScheduledChatActionFixerJobs'],
  ['garmin_coach', schedulerSource, 'runScheduledCoachBriefingForTarget'],
  ['voice_evolution', voiceEvolutionSource, 'runScheduledVoiceEvolutionAgent'],
]) {
  if (!schedulerSource.includes(token)
      || !source.includes(token)
      || !source.includes('runGovernedAgentJob')) {
    errors.push(`shared runner runtime wiring missing: ${jobId} (${token})`);
  }
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
validateLocalModelManifest();
console.log(JSON.stringify({
  ok: true,
  capabilities: runtimeCapabilityIds.length,
  generatedCapabilitySkillMetadata: true,
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
