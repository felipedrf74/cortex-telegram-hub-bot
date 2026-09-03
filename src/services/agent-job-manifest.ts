// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';
import type { JobDomain } from '../portal/telemetry';

export type AgentJobProviderUsage = 'none' | 'governed-provider-capable';
export type AgentJobInputEnforcement =
  | 'not-applicable-no-provider'
  | 'runtime-fingerprint'
  | 'report-schedule-ledger'
  | 'output-inventory-gate'
  | 'durable-job-idempotency';

export interface SharedAgentJobRunnerPolicy {
  implementation: 'governed-v1';
  scope: 'platform' | 'tenant-user' | 'platform-or-tenant-user';
  fingerprintGate: 'runner' | 'adapter';
  maxAttempts: number;
  retryBackoffMs: number;
  auditStore: 'agent_job_runs';
  providerAttribution: 'api_usage-run-id';
  outputValidation: 'adapter-required';
}

export interface AgentJobManifestEntry {
  id: string;
  name: string;
  schedule: string;
  scheduleSource?: string;
  domain: JobDomain;
  lifecycle: 'active' | 'paused';
  policyOwner: string;
  jobVersion: string;
  tenantScope: string;
  overlapPolicy: string;
  retryPolicy: string;
  providerUsage: AgentJobProviderUsage;
  providerRouting: string;
  costPolicy: string;
  latencyPolicy: string;
  outputPolicy: string;
  notificationPolicy: string;
  inputFingerprint: {
    enforcement: AgentJobInputEnforcement;
    unchangedInputProviderCalls: 0;
    evidence: string;
    tests: string[];
  };
  sharedRunner?: SharedAgentJobRunnerPolicy;
}

export interface AgentJobManifest {
  schema: 'nexus.agent-job-manifest.v3';
  version: string;
  jobs: AgentJobManifestEntry[];
  eventHandlers: AgentEventHandlerManifestEntry[];
  queuedJobHandlers: AgentQueuedJobHandlerManifestEntry[];
}

interface AgentHandlerGovernance {
  id: string;
  lifecycle: 'active';
  runtimeGroup: string;
  policyOwner: string;
  handlerVersion: string;
  tenantScope: string;
  retryPolicy: string;
  providerUsage: AgentJobProviderUsage;
  providerRouting: string;
  costPolicy: string;
  latencyPolicy: string;
  outputPolicy: string;
  inputFingerprint: AgentJobManifestEntry['inputFingerprint'];
}

export interface AgentEventHandlerManifestEntry extends AgentHandlerGovernance {
  eventType: string;
  routedEventTypes: string[];
  queuedJobTypes: string[];
  directEffects: AgentDirectEventEffectManifestEntry[];
}

export interface AgentDirectEventEffectManifestEntry extends AgentHandlerGovernance {
  eventType: string;
  effect: string;
}

export interface AgentQueuedJobHandlerManifestEntry extends AgentHandlerGovernance {
  jobType: string;
  idempotent: boolean;
}

let cachedManifest: AgentJobManifest | null = null;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEntry(entry: AgentJobManifestEntry): void {
  const required = [
    entry.id,
    entry.name,
    entry.schedule,
    entry.domain,
    entry.policyOwner,
    entry.jobVersion,
    entry.tenantScope,
    entry.overlapPolicy,
    entry.retryPolicy,
    entry.providerRouting,
    entry.costPolicy,
    entry.latencyPolicy,
    entry.outputPolicy,
    entry.notificationPolicy,
    entry.inputFingerprint?.evidence,
  ];
  if (required.some((value) => !nonEmpty(value))) {
    throw new Error(`incomplete AgentJobManifest governance: ${entry.id || 'unknown'}`);
  }
  if (!['active', 'paused'].includes(entry.lifecycle)) {
    throw new Error(`invalid AgentJobManifest lifecycle: ${entry.id}`);
  }
  if (!['secretary', 'triathlon', 'content', 'invoices', 'system'].includes(entry.domain)) {
    throw new Error(`invalid AgentJobManifest domain: ${entry.id}`);
  }
  if (!['none', 'governed-provider-capable'].includes(entry.providerUsage)) {
    throw new Error(`invalid AgentJobManifest provider usage: ${entry.id}`);
  }
  if (!Array.isArray(entry.inputFingerprint.tests)
      || entry.inputFingerprint.unchangedInputProviderCalls !== 0) {
    throw new Error(`invalid AgentJobManifest unchanged-input policy: ${entry.id}`);
  }
  if (entry.providerUsage === 'none'
      && entry.inputFingerprint.enforcement !== 'not-applicable-no-provider') {
    throw new Error(`non-provider job has provider fingerprint enforcement: ${entry.id}`);
  }
  if (entry.providerUsage === 'governed-provider-capable'
      && entry.inputFingerprint.enforcement === 'not-applicable-no-provider') {
    throw new Error(`provider-capable job lacks unchanged-input enforcement: ${entry.id}`);
  }
  if (entry.providerUsage === 'governed-provider-capable'
      && entry.inputFingerprint.tests.length === 0) {
    throw new Error(`provider-capable job lacks unchanged-input test evidence: ${entry.id}`);
  }
  if (entry.sharedRunner) {
    const runner = entry.sharedRunner;
    if (entry.providerUsage !== 'governed-provider-capable'
        || runner.implementation !== 'governed-v1'
        || !['platform', 'tenant-user', 'platform-or-tenant-user'].includes(runner.scope)
        || !['runner', 'adapter'].includes(runner.fingerprintGate)
        || !Number.isSafeInteger(runner.maxAttempts)
        || runner.maxAttempts < 1
        || runner.maxAttempts > 5
        || !Number.isSafeInteger(runner.retryBackoffMs)
        || runner.retryBackoffMs < 0
        || runner.retryBackoffMs > 60_000
        || runner.auditStore !== 'agent_job_runs'
        || runner.providerAttribution !== 'api_usage-run-id'
        || runner.outputValidation !== 'adapter-required') {
      throw new Error(`invalid AgentJobManifest shared runner policy: ${entry.id}`);
    }
  }
}

function validateHandlerEntry(
  entry: AgentHandlerGovernance,
  kind: 'event' | 'direct-event' | 'queued-job',
): void {
  const required = [
    entry.id,
    entry.runtimeGroup,
    entry.policyOwner,
    entry.handlerVersion,
    entry.tenantScope,
    entry.retryPolicy,
    entry.providerRouting,
    entry.costPolicy,
    entry.latencyPolicy,
    entry.outputPolicy,
    entry.inputFingerprint?.evidence,
  ];
  if (required.some((value) => !nonEmpty(value))) {
    throw new Error(`incomplete AgentJobManifest ${kind} handler governance: ${entry.id || 'unknown'}`);
  }
  if (!['none', 'governed-provider-capable'].includes(entry.providerUsage)
      || entry.inputFingerprint.unchangedInputProviderCalls !== 0
      || !Array.isArray(entry.inputFingerprint.tests)) {
    throw new Error(`invalid AgentJobManifest ${kind} provider governance: ${entry.id}`);
  }
  if (entry.providerUsage === 'none'
      && entry.inputFingerprint.enforcement !== 'not-applicable-no-provider') {
    throw new Error(`non-provider ${kind} handler has provider enforcement: ${entry.id}`);
  }
  if (entry.providerUsage === 'governed-provider-capable'
      && (entry.inputFingerprint.enforcement === 'not-applicable-no-provider'
        || entry.inputFingerprint.tests.length === 0)) {
    throw new Error(`provider-capable ${kind} handler lacks unchanged-input enforcement: ${entry.id}`);
  }
}

export function loadAgentJobManifest(): AgentJobManifest {
  if (cachedManifest) return cachedManifest;
  const manifestPath = path.resolve(process.cwd(), 'config/agent-job-manifest.json');
  let parsed: AgentJobManifest;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AgentJobManifest;
  } catch (err) {
    throw new Error(`AgentJobManifest unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.schema !== 'nexus.agent-job-manifest.v3'
      || !nonEmpty(parsed.version)
      || !Array.isArray(parsed.jobs)
      || parsed.jobs.length === 0
      || !Array.isArray(parsed.eventHandlers)
      || parsed.eventHandlers.length === 0
      || !Array.isArray(parsed.queuedJobHandlers)
      || parsed.queuedJobHandlers.length === 0) {
    throw new Error('invalid AgentJobManifest schema');
  }
  const ids = new Set<string>();
  for (const entry of parsed.jobs) {
    validateEntry(entry);
    if (ids.has(entry.id)) throw new Error(`duplicate AgentJobManifest job: ${entry.id}`);
    ids.add(entry.id);
  }
  const eventHandlerIds = new Set<string>();
  for (const entry of parsed.eventHandlers) {
    validateHandlerEntry(entry, 'event');
    if (!nonEmpty(entry.eventType)
        || !Array.isArray(entry.routedEventTypes)
        || !Array.isArray(entry.queuedJobTypes)
        || !Array.isArray(entry.directEffects)
        || eventHandlerIds.has(entry.id)) {
      throw new Error(`invalid AgentJobManifest event handler: ${entry.id}`);
    }
    const directEffectIds = new Set<string>();
    for (const effect of entry.directEffects) {
      validateHandlerEntry(effect, 'direct-event');
      if (!nonEmpty(effect.eventType)
          || !nonEmpty(effect.effect)
          || !entry.routedEventTypes.includes(effect.eventType)
          || directEffectIds.has(effect.id)) {
        throw new Error(`invalid AgentJobManifest direct event effect: ${effect.id}`);
      }
      directEffectIds.add(effect.id);
    }
    eventHandlerIds.add(entry.id);
  }
  const queuedJobHandlerIds = new Set<string>();
  for (const entry of parsed.queuedJobHandlers) {
    validateHandlerEntry(entry, 'queued-job');
    if (!nonEmpty(entry.jobType)
        || typeof entry.idempotent !== 'boolean'
        || queuedJobHandlerIds.has(entry.id)) {
      throw new Error(`invalid AgentJobManifest queued job handler: ${entry.id}`);
    }
    queuedJobHandlerIds.add(entry.id);
  }
  cachedManifest = parsed;
  return parsed;
}

export function getAgentJobManifestEntry(jobId: string): AgentJobManifestEntry {
  const entry = loadAgentJobManifest().jobs.find((job) => job.id === jobId);
  if (!entry) throw new Error(`scheduled job is not governed by AgentJobManifest: ${jobId}`);
  return entry;
}

export function assertAgentEventHandlerRuntimeParity(
  handlers: ReadonlyArray<{ eventType: string }>,
  runtimeGroup = 'event-backbone-default',
  directEffects: ReadonlyArray<{ eventType: string; effect: string }> = [],
): void {
  const manifestHandlers = loadAgentJobManifest().eventHandlers
    .filter((entry) => entry.runtimeGroup === runtimeGroup)
  const expected = manifestHandlers.map((entry) => entry.eventType).sort();
  const actual = handlers.map((handler) => handler.eventType).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`AgentJobManifest event handler runtime parity mismatch for ${runtimeGroup}: expected=${expected.join(',')} actual=${actual.join(',')}`);
  }
  const expectedEffects = manifestHandlers
    .flatMap((entry) => entry.directEffects)
    .map((effect) => `${effect.eventType}:${effect.effect}`)
    .sort();
  const actualEffects = directEffects.map((effect) => `${effect.eventType}:${effect.effect}`).sort();
  if (new Set(actualEffects).size !== actualEffects.length
      || JSON.stringify(actualEffects) !== JSON.stringify(expectedEffects)) {
    throw new Error(`AgentJobManifest direct event effect runtime parity mismatch for ${runtimeGroup}: expected=${expectedEffects.join(',')} actual=${actualEffects.join(',')}`);
  }
}

export function assertAgentQueuedJobHandlerRuntimeParity(
  handlers: ReadonlyArray<{ jobType: string; idempotent?: boolean }>,
  runtimeGroup: string,
): void {
  const expected = loadAgentJobManifest().queuedJobHandlers
    .filter((entry) => entry.runtimeGroup === runtimeGroup)
    .map((entry) => `${entry.jobType}:${entry.idempotent}`)
    .sort();
  const actual = handlers
    .map((handler) => `${handler.jobType}:${handler.idempotent === true}`)
    .sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`AgentJobManifest queued job handler runtime parity mismatch for ${runtimeGroup}: expected=${expected.join(',')} actual=${actual.join(',')}`);
  }
}

export function assertAgentJobRuntimeRegistration(input: {
  id: string;
  name: string;
  runtimeSchedule: string;
  declaredSchedule: string;
  domain: JobDomain;
}): AgentJobManifestEntry {
  const entry = getAgentJobManifestEntry(input.id);
  const mismatches: string[] = [];
  if (entry.name !== input.name) mismatches.push(`name manifest=${entry.name} runtime=${input.name}`);
  if (entry.schedule !== input.declaredSchedule) {
    mismatches.push(`schedule manifest=${entry.schedule} runtime=${input.declaredSchedule}`);
  }
  if (entry.domain !== input.domain) mismatches.push(`domain manifest=${entry.domain} runtime=${input.domain}`);
  if (!nonEmpty(input.runtimeSchedule)) mismatches.push('resolved runtime schedule is empty');
  if (entry.scheduleSource && entry.schedule !== input.declaredSchedule) {
    mismatches.push(`schedule source ${entry.scheduleSource} was not declared`);
  }
  if (mismatches.length > 0) {
    throw new Error(`AgentJobManifest runtime registration mismatch for ${input.id}: ${mismatches.join('; ')}`);
  }
  return entry;
}

export function resetAgentJobManifestForTests(): void {
  cachedManifest = null;
}
