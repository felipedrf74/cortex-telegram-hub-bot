#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_JOB_MANIFEST_SCHEMA = 'nexus.agent-job-manifest.v3';
export const AGENT_JOB_MANIFEST_VERSION = '2026-07-15.5';

const GEMINI_ONE_SHOT_PROVIDER_ROUTE = 'gemini-primary-openai-fallback-anthropic-gated-last-resort';

const noProvider = (policyOwner, tenantScope, overrides = {}) => ({
  policyOwner,
  jobVersion: '1.0.0',
  tenantScope,
  overlapPolicy: 'runtime-process-lock',
  retryPolicy: 'next-scheduled-run',
  providerUsage: 'none',
  providerRouting: 'not-applicable-no-model-provider',
  costPolicy: 'no-model-provider-cost',
  latencyPolicy: 'callback-owned-no-model-budget',
  outputPolicy: 'job-specific-validated-write',
  notificationPolicy: 'job-specific',
  inputFingerprint: {
    enforcement: 'not-applicable-no-provider',
    unchangedInputProviderCalls: 0,
    evidence: 'source-audit:no-model-provider-boundary',
    tests: [],
  },
  ...overrides,
});

const providerCapable = (policyOwner, tenantScope, inputFingerprint, overrides = {}) => ({
  policyOwner,
  jobVersion: '1.0.0',
  tenantScope,
  overlapPolicy: 'runtime-process-lock',
  retryPolicy: 'next-scheduled-run',
  providerUsage: 'governed-provider-capable',
  providerRouting: 'budgeted-provider-route',
  costPolicy: 'ai-cost-guardrail',
  latencyPolicy: 'provider-route-bounded',
  outputPolicy: 'schema-and-scope-before-durable-write',
  notificationPolicy: 'job-specific',
  inputFingerprint: {
    ...inputFingerprint,
    unchangedInputProviderCalls: 0,
  },
  ...overrides,
});

const sharedGovernedRunner = (scope, overrides = {}) => ({
  sharedRunner: {
    implementation: 'governed-v1',
    scope,
    maxAttempts: 1,
    retryBackoffMs: 0,
    auditStore: 'agent_job_runs',
    providerAttribution: 'api_usage-run-id',
    outputValidation: 'adapter-required',
    ...overrides,
  },
});

const noProviderHandler = (policyOwner, tenantScope, overrides = {}) => ({
  policyOwner,
  handlerVersion: '1.0.0',
  tenantScope,
  retryPolicy: 'durable-queue-bounded-retry',
  providerUsage: 'none',
  providerRouting: 'not-applicable-no-model-provider',
  costPolicy: 'no-model-provider-cost',
  latencyPolicy: 'handler-owned-no-model-budget',
  outputPolicy: 'job-specific-validated-write',
  inputFingerprint: {
    enforcement: 'not-applicable-no-provider',
    unchangedInputProviderCalls: 0,
    evidence: 'source-audit:no-model-provider-boundary',
    tests: [],
  },
  ...overrides,
});

const providerCapableHandler = (policyOwner, tenantScope, inputFingerprint, overrides = {}) => ({
  policyOwner,
  handlerVersion: '1.0.0',
  tenantScope,
  retryPolicy: 'durable-queue-bounded-retry',
  providerUsage: 'governed-provider-capable',
  providerRouting: 'budgeted-provider-route',
  costPolicy: 'ai-cost-guardrail',
  latencyPolicy: 'provider-route-bounded',
  outputPolicy: 'schema-and-scope-before-durable-write',
  inputFingerprint: {
    ...inputFingerprint,
    unchangedInputProviderCalls: 0,
  },
  ...overrides,
});

// This is intentionally an explicit 53-job audit, not a domain-wide default.
// Adding a scheduler registration without a reviewed policy makes generation
// fail. Provider usage means model-provider capability; calendar, mail, task,
// Garmin, and invoice integrations remain described by their job policies but
// are not mislabeled as model-provider jobs.
export const JOB_POLICIES = Object.freeze({
  amazon_collection: noProvider('finance', 'owner-integration-profile', { retryPolicy: 'collector-bounded-retry' }),
  autoresearch: providerCapable('ai-quality', 'platform-evaluation-target', {
    enforcement: 'runtime-fingerprint',
    evidence: 'prompt-config-eval fingerprint reuses prior valid score',
    tests: [
      '__tests__/services/autoresearch-preflight.test.ts',
      '__tests__/services/agent-job-runner.test.ts',
    ],
  }, {
    providerRouting: 'gemini-or-openai-primary-anthropic-fallback',
    costPolicy: 'evaluate-only-target-budget',
    ...sharedGovernedRunner('platform'),
  }),
  channel_relearn: providerCapable('content', 'eligible-content-tenant-and-reviewed-platform-scope', {
    enforcement: 'runtime-fingerprint',
    evidence: 'channel video fingerprint skips analysis and synthesis when unchanged',
    tests: ['__tests__/services/channel-learner-relearn-gate.test.ts'],
  }, { providerRouting: GEMINI_ONE_SHOT_PROVIDER_ROUTE, costPolicy: 'content-automation-budget' }),
  chat_action_fixer_worker: providerCapable('chat-reliability', 'durable-queue-tenant-user', {
    enforcement: 'durable-job-idempotency',
    evidence: 'tenant/user/job-type/idempotency key and completed-state exclusion',
    tests: ['__tests__/services/chat-action-fixer-worker.test.ts'],
  }, {
    retryPolicy: 'durable-queue-max-3-with-backoff',
    providerRouting: 'anthropic-only-cost-guarded',
    costPolicy: 'ai-cost-guardrail:chat_action_fixer',
    latencyPolicy: 'provider-timeout-30000ms',
  }),
  chat_action_plan_expiry: noProvider('chat-reliability', 'platform-tenant-scoped-rows'),
  chat_action_run_retention: noProvider('chat-reliability', 'platform-tenant-scoped-rows'),
  chat_action_run_zombie_reaper: noProvider('chat-reliability', 'durable-queue-tenant-user', { retryPolicy: 'next-scheduled-run-after-lease-reap' }),
  chat_v2_auto_revert_eval: noProvider('chat-core-v2', 'active-chat-v2-tenant-loop', { outputPolicy: 'deterministic-policy-and-audited-mode-write' }),
  chat_v2_gate_check: noProvider('chat-core-v2', 'platform-shadow-metrics'),
  classify_shadow_prune: noProvider('chat-core-v2', 'platform-retention'),
  conflict_detection: noProvider('secretary', 'active-tenant-loop', { outputPolicy: 'tenant-scoped-decision-intent' }),
  daily_briefing: noProvider('secretary', 'report-ledger-active-tenant', { retryPolicy: 'report-dispatch-next-tick' }),
  db_backup: noProvider('operations', 'platform-database', { scheduleSource: 'config.backup.time', outputPolicy: 'verified-backup-artifact' }),
  db_restore_test: noProvider('operations', 'platform-database', { outputPolicy: 'restore-integrity-result' }),
  decision_center_smoke_cleanup: noProvider('decision-center', 'platform-tenant-scoped-rows'),
  decision_daily_attention: noProvider('decision-center', 'active-tenant-loop', { outputPolicy: 'daily-idempotent-tenant-materialization' }),
  decision_expiry: noProvider('decision-center', 'platform-tenant-scoped-rows'),
  decision_handled_history_backfill: noProvider('decision-center', 'platform-tenant-scoped-rows'),
  decision_ledger_retention_prune: noProvider('decision-center', 'platform-retention'),
  decision_metrics_rollup: noProvider('decision-center', 'platform-daily-rollup'),
  decision_source_supersession: noProvider('decision-center', 'platform-tenant-scoped-rows'),
  dst_watchdog: noProvider('operations', 'registered-job-runtime', { outputPolicy: 'bounded-three-hour-recovery-window' }),
  end_of_day: noProvider('secretary', 'report-ledger-active-tenant', { retryPolicy: 'report-dispatch-next-tick' }),
  event_backbone_cleanup: noProvider('event-backbone', 'platform-retention'),
  event_backbone_worker: noProvider('event-backbone', 'durable-event-and-job-tenant-user', { retryPolicy: 'durable-queue-bounded-with-leases' }),
  expire_signals: noProvider('content', 'platform-signal-retention'),
  fiscal_bundle: noProvider('finance', 'active-fiscal-profile-tenant', { retryPolicy: 'next-due-check-with-durable-delivery-state' }),
  fossa_email: noProvider('secretary', 'owner-mailbox', { retryPolicy: 'next-scheduled-run' }),
  friday_weekly: providerCapable('content', 'eligible-active-tenant-loop', {
    enforcement: 'output-inventory-gate',
    evidence: 'rollout-independent seven-day pending inventory requests only missing output and skips when full',
    tests: [
      '__tests__/services/scheduler-user-scope.test.ts',
      '__tests__/services/content-workflow-user-scope.test.ts',
      '__tests__/services/agent-job-runner.test.ts',
    ],
  }, {
    providerRouting: 'grounded-provider-fallback-route',
    costPolicy: 'content-automation-budget',
    ...sharedGovernedRunner('tenant-user'),
  }),
  garmin_coach: providerCapable('training', 'report-ledger-active-tenant', {
    enforcement: 'report-schedule-ledger',
    evidence: 'tenant/local-date coach report claim prevents duplicate scheduled analysis',
    tests: ['__tests__/services/report-schedule-dispatcher.test.ts'],
  }, {
    retryPolicy: 'report-dispatch-next-tick-on-released-transient-claim',
    providerRouting: GEMINI_ONE_SHOT_PROVIDER_ROUTE,
    costPolicy: 'ai-cost-guardrail:coach_analysis',
  }),
  garmin_keepalive: noProvider('training', 'owner-garmin-identity', { retryPolicy: 'next-scheduled-run-with-auth-refresh' }),
  garmin_tenant_isolation_watcher: noProvider('training', 'configured-garmin-tenant'),
  integration_health: noProvider('operations', 'configured-integration-identities', { outputPolicy: 'redacted-integration-health-records' }),
  invoice_collection: noProvider('finance', 'active-filing-profile-tenant', { retryPolicy: 'collector-bounded-retry' }),
  invoice_queue: noProvider('finance', 'durable-invoice-queue-tenant', { retryPolicy: 'durable-queue-bounded-retry' }),
  midnight_cleanup: noProvider('operations', 'platform-retention'),
  nexus_points_expiry: noProvider('billing', 'platform-tenant-scoped-ledger'),
  notification_release: noProvider('notifications', 'durable-notification-tenant-user', { retryPolicy: 'delivery-policy-retry-and-dead-letter' }),
  operator_alert_delivery: noProvider('operations', 'durable-operator-alert-queue', { retryPolicy: 'delivery-retry-and-dead-letter' }),
  performance_agent: noProvider('content', 'user-scoped-channel-targets', { outputPolicy: 'fail-closed-paused-until-tenant-scoped-signals' }),
  pipeline_agent: noProvider('content', 'platform-content-signal-scope', { outputPolicy: 'deterministic-signal-contract' }),
  reaction_radar: noProvider('content', 'reviewed-platform-reference-channels', { costPolicy: 'external-youtube-quota-only', outputPolicy: 'deterministic-scored-signal-contract' }),
  reminders: noProvider('secretary', 'due-reminder-tenant-user', { retryPolicy: 'next-minute-until-delivery-succeeds' }),
  secretary_agenda_sync: noProvider('secretary', 'active-tenant-loop', { outputPolicy: 'source-revision-and-provider-readback-gated' }),
  seo_agent: noProvider('content', 'user-scoped-channel-targets', { outputPolicy: 'fail-closed-paused-until-tenant-scoped-storage' }),
  shared_list: noProvider('secretary', 'active-tenant-loop', { outputPolicy: 'notification-dedupe-key' }),
  task_sync: noProvider('tasks', 'active-and-pending-task-tenant-user', { retryPolicy: 'provider-mutation-ledger-bounded-retry', outputPolicy: 'content-hash-and-provider-link-idempotency' }),
  thursday_youtube: providerCapable('content', 'eligible-active-tenant-loop', {
    enforcement: 'output-inventory-gate',
    evidence: 'rollout-independent seven-day pending inventory requests only missing output and skips when full',
    tests: [
      '__tests__/services/scheduler-user-scope.test.ts',
      '__tests__/services/content-workflow-user-scope.test.ts',
      '__tests__/services/agent-job-runner.test.ts',
    ],
  }, {
    providerRouting: 'grounded-provider-fallback-route',
    costPolicy: 'content-automation-budget',
    ...sharedGovernedRunner('tenant-user'),
  }),
  training_plan_adjust: noProvider('training', 'active-plan-tenant-loop', { outputPolicy: 'deterministic-threshold-adjustment' }),
  tuesday_reels: providerCapable('content', 'eligible-active-tenant-loop', {
    enforcement: 'output-inventory-gate',
    evidence: 'rollout-independent seven-day pending inventory requests only missing output and skips when full',
    tests: [
      '__tests__/services/scheduler-user-scope.test.ts',
      '__tests__/services/content-workflow-user-scope.test.ts',
      '__tests__/services/agent-job-runner.test.ts',
    ],
  }, {
    providerRouting: 'grounded-provider-fallback-route',
    costPolicy: 'content-automation-budget',
    ...sharedGovernedRunner('tenant-user'),
  }),
  uber_collection: noProvider('finance', 'owner-integration-profile', { retryPolicy: 'collector-bounded-retry' }),
  voice_evolution: providerCapable('content', 'eligible-content-tenant-loop', {
    enforcement: 'runtime-fingerprint',
    evidence: 'tenant-scoped analytics fingerprint is persisted only after validated output',
    tests: ['__tests__/agents/voice-evolution-multi-tenant.test.ts'],
  }, { providerRouting: GEMINI_ONE_SHOT_PROVIDER_ROUTE, costPolicy: 'content-automation-budget' }),
  weekly_review: noProvider('secretary', 'report-ledger-active-tenant', { retryPolicy: 'report-dispatch-next-tick' }),
});

export const EVENT_HANDLER_POLICIES = Object.freeze({
  '*': noProviderHandler('event-backbone', 'durable-event-tenant-user', {
    id: 'default_event_router',
    runtimeGroup: 'event-backbone-default',
    retryPolicy: 'event-outbox-max-3-with-backoff',
    outputPolicy: 'allowlisted-projection-and-tenant-scoped-queue-enqueue',
  }),
});

export const DIRECT_EVENT_EFFECT_POLICIES = Object.freeze({
  record_training_learning_observation: noProviderHandler('product-learning', 'durable-event-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    retryPolicy: 'event-outbox-max-3-with-backoff',
    outputPolicy: 'validated-redacted-learning-observation-upsert',
  }),
});

export const QUEUED_JOB_HANDLER_POLICIES = Object.freeze({
  project_read_models: noProviderHandler('app-read-models', 'durable-queue-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    outputPolicy: 'tenant-scoped-summary-projection-and-decision-audit',
  }),
  deliver_notification: noProviderHandler('notifications', 'durable-queue-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    retryPolicy: 'delivery-policy-plus-queue-max-attempts',
    outputPolicy: 'delivery-ledger-and-product-decision-audit',
  }),
  training_summary_projector: noProviderHandler('training', 'durable-queue-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    outputPolicy: 'tenant-scoped-training-home-week-projection',
  }),
  content_radar_scan_stub_or_existing: noProviderHandler('content', 'durable-queue-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    outputPolicy: 'intentional-no-op-foundation-handler',
  }),
  content_topic_secretary_sync: noProviderHandler('content', 'durable-queue-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    retryPolicy: 'queue-max-5-for-enqueued-content-sync',
    outputPolicy: 'validated-topic-id-tenant-scoped-secretary-sync',
  }),
  sync_calendar_safe_mock: noProviderHandler('secretary', 'durable-queue-tenant-user', {
    runtimeGroup: 'event-backbone-default',
    outputPolicy: 'intentional-no-external-call-foundation-handler',
  }),
  chat_action_fixer_review: providerCapableHandler('chat-reliability', 'durable-queue-tenant-user', {
    enforcement: 'durable-job-idempotency',
    evidence: 'tenant/user/job-type/idempotency key and completed-state exclusion',
    tests: ['__tests__/services/chat-action-fixer-worker.test.ts'],
  }, {
    runtimeGroup: 'chat-action-fixer',
    retryPolicy: 'durable-queue-max-3-with-backoff',
    providerRouting: 'anthropic-only-cost-guarded',
    costPolicy: 'ai-cost-guardrail:chat_action_fixer',
    latencyPolicy: 'provider-timeout-30000ms',
  }),
});

function normalizeSchedule(scheduleToken) {
  return scheduleToken.startsWith("'") ? scheduleToken.slice(1, -1) : scheduleToken;
}

function extractArrayBody(source, exportName) {
  const match = source.match(new RegExp(`export const ${exportName}:[^=]+\\=\\s*\\[([\\s\\S]*?)\\n\\];`));
  if (!match) throw new Error(`Cannot locate runtime handler registry: ${exportName}`);
  return match[1];
}

function parseSingleQuotedValues(block) {
  return [...block.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function buildEventHandlers(eventBackboneSource) {
  const handlerBody = extractArrayBody(eventBackboneSource, 'defaultEventHandlers');
  const eventTypes = [...handlerBody.matchAll(/eventType:\s*'([^']+)'/g)].map((match) => match[1]);
  const projectableBlock = eventBackboneSource.match(/const PROJECTABLE_EVENT_TYPES\s*=\s*new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
  const routedEventTypes = parseSingleQuotedValues(projectableBlock).sort();
  const queuedJobTypes = [...new Set([...handlerBody.matchAll(/jobType:\s*'([^']+)'/g)].map((match) => match[1]))].sort();
  const directEffectsBlock = eventBackboneSource.match(/export const DEFAULT_EVENT_DIRECT_EFFECTS\s*=\s*\[([\s\S]*?)\]\s*as const;/)?.[1];
  if (!directEffectsBlock) throw new Error('Cannot locate runtime direct event effect registry');
  const directEffects = [...directEffectsBlock.matchAll(/eventType:\s*'([^']+)'\s*,\s*effect:\s*'([^']+)'/g)]
    .map((match) => {
      const eventType = match[1];
      const effect = match[2];
      const policy = DIRECT_EVENT_EFFECT_POLICIES[effect];
      if (!policy) throw new Error(`AgentJobManifest policy missing for direct event effect: ${effect}`);
      return {
        id: `${effect}:${eventType}`,
        eventType,
        effect,
        lifecycle: 'active',
        ...policy,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const registeredLearningEffects = directEffects
    .filter((entry) => entry.effect === 'record_training_learning_observation').length;
  const runtimeLearningCalls = [...eventBackboneSource.matchAll(/recordTrainingLearningObservation\(\{/g)].length;
  if (runtimeLearningCalls < registeredLearningEffects) {
    throw new Error(`Product-learning direct event effects are not all called at runtime: registered=${registeredLearningEffects} calls=${runtimeLearningCalls}`);
  }
  const discoveredEffects = new Set(directEffects.map((entry) => entry.effect));
  const unusedEffects = Object.keys(DIRECT_EVENT_EFFECT_POLICIES).filter((effect) => !discoveredEffects.has(effect));
  if (unusedEffects.length > 0) {
    throw new Error(`Direct event effect policies have no runtime registration: ${unusedEffects.join(', ')}`);
  }
  const handlers = eventTypes.map((eventType) => {
    const policy = EVENT_HANDLER_POLICIES[eventType];
    if (!policy) throw new Error(`AgentJobManifest policy missing for event handler: ${eventType}`);
    return {
      id: policy.id,
      eventType,
      lifecycle: 'active',
      routedEventTypes: eventType === '*'
        ? [...new Set([...routedEventTypes, ...directEffects.map((effect) => effect.eventType)])].sort()
        : [eventType],
      queuedJobTypes,
      directEffects: eventType === '*' ? directEffects : directEffects.filter((effect) => effect.eventType === eventType),
      ...policy,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const discovered = new Set(eventTypes);
  const unused = Object.keys(EVENT_HANDLER_POLICIES).filter((eventType) => !discovered.has(eventType));
  if (unused.length > 0) throw new Error(`Event handler policies have no runtime handler: ${unused.join(', ')}`);
  return handlers;
}

function buildQueuedJobHandlers(eventBackboneSource, chatActionFixerSource) {
  const handlerBody = extractArrayBody(eventBackboneSource, 'defaultJobHandlers');
  const handlers = [...handlerBody.matchAll(/jobType:\s*'([^']+)'[\s\S]*?idempotent:\s*(true|false)/g)]
    .map((match) => ({ jobType: match[1], idempotent: match[2] === 'true', runtimeGroup: 'event-backbone-default' }));
  const chatFixerJobType = chatActionFixerSource.match(/CHAT_ACTION_FIXER_JOB_TYPE\s*=\s*'([^']+)'/)?.[1];
  if (!chatFixerJobType) throw new Error('Cannot locate chat action fixer queued job type');
  handlers.push({ jobType: chatFixerJobType, idempotent: true, runtimeGroup: 'chat-action-fixer' });
  const generated = handlers.map((handler) => {
    const policy = QUEUED_JOB_HANDLER_POLICIES[handler.jobType];
    if (!policy) throw new Error(`AgentJobManifest policy missing for queued job handler: ${handler.jobType}`);
    if (policy.runtimeGroup !== handler.runtimeGroup) {
      throw new Error(`Queued job runtime group drift: ${handler.jobType}`);
    }
    return {
      id: handler.jobType,
      jobType: handler.jobType,
      lifecycle: 'active',
      idempotent: handler.idempotent,
      ...policy,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const discovered = new Set(generated.map((handler) => handler.jobType));
  const unused = Object.keys(QUEUED_JOB_HANDLER_POLICIES).filter((jobType) => !discovered.has(jobType));
  if (unused.length > 0) throw new Error(`Queued job policies have no runtime handler: ${unused.join(', ')}`);
  return generated;
}

export function buildAgentJobManifest(source, eventBackboneSource, chatActionFixerSource) {
  const jobs = [];
  const pattern = /registerJob\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*('[^']*'|[A-Za-z_][A-Za-z0-9_]*)\s*,\s*'([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    const id = match[1];
    const policy = JOB_POLICIES[id];
    if (!policy) throw new Error(`AgentJobManifest policy missing for scheduler job: ${id}`);
    jobs.push({
      id,
      name: match[2],
      schedule: normalizeSchedule(match[3].trim()),
      domain: match[4],
      lifecycle: 'active',
      ...policy,
    });
  }
  jobs.sort((left, right) => left.id.localeCompare(right.id));
  const discovered = new Set(jobs.map((job) => job.id));
  const unusedPolicies = Object.keys(JOB_POLICIES).filter((id) => !discovered.has(id));
  if (unusedPolicies.length > 0) {
    throw new Error(`AgentJobManifest policies have no scheduler registration: ${unusedPolicies.join(', ')}`);
  }
  return {
    schema: AGENT_JOB_MANIFEST_SCHEMA,
    version: AGENT_JOB_MANIFEST_VERSION,
    jobs,
    eventHandlers: buildEventHandlers(eventBackboneSource),
    queuedJobHandlers: buildQueuedJobHandlers(eventBackboneSource, chatActionFixerSource),
  };
}

export function serializeAgentJobManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const root = process.cwd();
  const source = fs.readFileSync(path.join(root, 'src/services/scheduler.ts'), 'utf8');
  const eventBackboneSource = fs.readFileSync(path.join(root, 'src/services/event-backbone-worker.ts'), 'utf8');
  const chatActionFixerSource = fs.readFileSync(path.join(root, 'src/services/chat-action-fixer-worker.ts'), 'utf8');
  const manifest = buildAgentJobManifest(source, eventBackboneSource, chatActionFixerSource);
  const serialized = serializeAgentJobManifest(manifest);
  const relativeOutput = 'config/agent-job-manifest.json';
  const output = path.join(root, relativeOutput);

  if (process.argv.includes('--check')) {
    const checkedIn = fs.readFileSync(output, 'utf8');
    if (checkedIn !== serialized) {
      console.error(`${relativeOutput} is stale; run node scripts/generate-agent-job-manifest.mjs`);
      process.exit(1);
    }
    console.log(JSON.stringify({
      ok: true,
      output: relativeOutput,
      schema: manifest.schema,
      jobs: manifest.jobs.length,
      eventHandlers: manifest.eventHandlers.length,
      directEventEffects: manifest.eventHandlers.reduce((count, handler) => count + handler.directEffects.length, 0),
      queuedJobHandlers: manifest.queuedJobHandlers.length,
    }, null, 2));
    return;
  }

  fs.writeFileSync(output, serialized);
  console.log(JSON.stringify({
    output: relativeOutput,
    schema: manifest.schema,
    jobs: manifest.jobs.length,
    eventHandlers: manifest.eventHandlers.length,
    directEventEffects: manifest.eventHandlers.reduce((count, handler) => count + handler.directEffects.length, 0),
    queuedJobHandlers: manifest.queuedJobHandlers.length,
  }, null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) main();
