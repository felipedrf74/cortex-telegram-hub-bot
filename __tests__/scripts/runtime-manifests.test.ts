import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getCapabilityManifestEntry,
  getRestrictedPlanCapabilityIds,
  loadCapabilityManifest,
} from '../../src/services/capability-manifest';
import { FREE_TIER_ALLOWED_SKILLS, BETA_TIER_ALLOWED_SKILLS } from '../../src/services/entitlement';
import { QUESTIONNAIRE_SKILL_MAP, SKILL_ONBOARDING_MAP } from '../../src/services/onboarding';
import { SKILL_METADATA } from '../../src/services/chat/registry';
import { getChatSkillCapabilityRegistry } from '../../src/services/chat-skill-capability-registry';
import {
  assertAgentEventHandlerRuntimeParity,
  assertAgentJobRuntimeRegistration,
  assertAgentQueuedJobHandlerRuntimeParity,
  loadAgentJobManifest,
} from '../../src/services/agent-job-manifest';

describe('runtime manifests', () => {
  it('keeps capability and scheduled-job registries in parity with runtime sources', () => {
    const result = JSON.parse(execFileSync(process.execPath, ['scripts/validate-runtime-manifests.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }));
    expect(result).toMatchObject({
      ok: true,
      capabilities: 8,
      jobManifestSchema: 'nexus.agent-job-manifest.v3',
      generatedParity: true,
      providerCapableJobs: 8,
      sharedRunnerJobs: 8,
      eventHandlers: 1,
      directEventEffects: 2,
      queuedJobHandlers: 7,
    });
    expect(result).toMatchObject({ jobs: 53, scheduledJobs: 53 });
  });

  it('keeps AgentJobManifest byte-identical to generated names, domains, schedules, and policies', () => {
    const manifestPath = path.resolve('config/agent-job-manifest.json');
    const before = fs.readFileSync(manifestPath, 'utf8');
    const result = JSON.parse(execFileSync(process.execPath, ['scripts/generate-agent-job-manifest.mjs', '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }));
    expect(result).toMatchObject({
      ok: true,
      output: 'config/agent-job-manifest.json',
      schema: 'nexus.agent-job-manifest.v3',
      jobs: 53,
      eventHandlers: 1,
      directEventEffects: 2,
      queuedJobHandlers: 7,
    });
    expect(fs.readFileSync(manifestPath, 'utf8')).toBe(before);

    const manifest = JSON.parse(before);
    expect(manifest.schema).toBe('nexus.agent-job-manifest.v3');
    expect(manifest.jobs).toHaveLength(53);
    for (const job of manifest.jobs) {
      expect(job).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        domain: expect.any(String),
        schedule: expect.any(String),
      });
      expect(job.name.trim()).not.toBe('');
      expect(job.domain.trim()).not.toBe('');
      expect(job.schedule.trim()).not.toBe('');
    }
  });

  it('classifies every job and gives every provider-capable job zero-call unchanged-input enforcement', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve('config/agent-job-manifest.json'), 'utf8'));
    const providerCapable = manifest.jobs
      .filter((job: any) => job.providerUsage === 'governed-provider-capable')
      .map((job: any) => job.id)
      .sort();
    expect(providerCapable).toEqual([
      'autoresearch',
      'channel_relearn',
      'chat_action_fixer_worker',
      'friday_weekly',
      'garmin_coach',
      'thursday_youtube',
      'tuesday_reels',
      'voice_evolution',
    ]);
    expect(manifest.jobs.every((job: any) => ['none', 'governed-provider-capable'].includes(job.providerUsage))).toBe(true);
    expect(manifest.jobs.every((job: any) => job.inputFingerprint.enforcement !== 'pending')).toBe(true);
    expect(manifest.jobs.every((job: any) => job.inputFingerprint.unchangedInputProviderCalls === 0)).toBe(true);
    expect(manifest.jobs
      .filter((job: any) => job.providerUsage === 'none')
      .every((job: any) => job.inputFingerprint.enforcement === 'not-applicable-no-provider')).toBe(true);
    expect(manifest.jobs
      .filter((job: any) => job.providerUsage === 'governed-provider-capable')
      .every((job: any) => job.inputFingerprint.tests.length > 0)).toBe(true);

    const jobsById = Object.fromEntries(manifest.jobs.map((job: any) => [job.id, job]));
    for (const id of ['channel_relearn', 'garmin_coach', 'voice_evolution']) {
      expect(jobsById[id].providerRouting).toBe(
        'gemini-primary-openai-fallback-anthropic-gated-last-resort',
      );
    }
    expect(manifest.jobs
      .filter((job: any) => job.sharedRunner)
      .map((job: any) => job.id)
      .sort()).toEqual([
      'autoresearch',
      'channel_relearn',
      'chat_action_fixer_worker',
      'friday_weekly',
      'garmin_coach',
      'thursday_youtube',
      'tuesday_reels',
      'voice_evolution',
    ]);
    for (const id of ['friday_weekly', 'thursday_youtube', 'tuesday_reels']) {
      expect(jobsById[id].sharedRunner).toEqual({
        implementation: 'governed-v1',
        scope: 'tenant-user',
        fingerprintGate: 'runner',
        maxAttempts: 1,
        retryBackoffMs: 0,
        auditStore: 'agent_job_runs',
        providerAttribution: 'api_usage-run-id',
        outputValidation: 'adapter-required',
      });
    }
    expect(jobsById.autoresearch.sharedRunner).toMatchObject({
      implementation: 'governed-v1',
      scope: 'platform',
      fingerprintGate: 'runner',
      maxAttempts: 1,
    });
    expect(jobsById.channel_relearn.sharedRunner).toMatchObject({
      scope: 'platform-or-tenant-user',
      fingerprintGate: 'adapter',
    });
    for (const id of ['chat_action_fixer_worker', 'garmin_coach', 'voice_evolution']) {
      expect(jobsById[id].sharedRunner).toMatchObject({
        scope: 'tenant-user',
        fingerprintGate: 'adapter',
      });
    }
  });

  it('fails closed when runtime registration drifts from the exact manifest identity', () => {
    expect(loadAgentJobManifest().jobs).toHaveLength(53);
    expect(() => assertAgentJobRuntimeRegistration({
      id: 'tuesday_reels',
      name: 'Tuesday Reel Topics',
      runtimeSchedule: '17 9 * * 2',
      declaredSchedule: '17 9 * * 2',
      domain: 'content',
    })).not.toThrow();
    expect(() => assertAgentJobRuntimeRegistration({
      id: 'tuesday_reels',
      name: 'Drifted name',
      runtimeSchedule: '17 9 * * 2',
      declaredSchedule: '17 9 * * 2',
      domain: 'content',
    })).toThrow(/runtime registration mismatch.*name/);
    expect(() => assertAgentJobRuntimeRegistration({
      id: 'db_backup',
      name: 'Database Backup',
      runtimeSchedule: '30 2 * * *',
      declaredSchedule: 'backupCron',
      domain: 'system',
    })).not.toThrow();
    expect(() => assertAgentJobRuntimeRegistration({
      id: 'db_backup',
      name: 'Database Backup',
      runtimeSchedule: '30 2 * * *',
      declaredSchedule: '30 2 * * *',
      domain: 'system',
    })).toThrow(/runtime registration mismatch.*schedule/);
  });

  it('fails closed when event or durable queued-job runtime handler registries drift', () => {
    const manifest = loadAgentJobManifest();
    expect(manifest.eventHandlers).toHaveLength(1);
    expect(manifest.queuedJobHandlers).toHaveLength(7);
    expect(manifest.eventHandlers[0]).toMatchObject({
      id: 'default_event_router',
      eventType: '*',
      providerUsage: 'none',
    });
    expect(manifest.eventHandlers[0].routedEventTypes).toContain('training.plan_revision.activated.v1');
    expect(manifest.eventHandlers[0].routedEventTypes).toContain('training.adaptation.rejected.v1');
    expect(manifest.eventHandlers[0].directEffects).toEqual([
      expect.objectContaining({
        id: 'record_training_learning_observation:training.adaptation.rejected.v1',
        eventType: 'training.adaptation.rejected.v1',
        providerUsage: 'none',
      }),
      expect.objectContaining({
        id: 'record_training_learning_observation:training.plan_revision.activated.v1',
        eventType: 'training.plan_revision.activated.v1',
        providerUsage: 'none',
      }),
    ]);
    const directEffects = [
      {
        eventType: 'training.plan_revision.activated.v1',
        effect: 'record_training_learning_observation',
      },
      {
        eventType: 'training.adaptation.rejected.v1',
        effect: 'record_training_learning_observation',
      },
    ];
    expect(() => assertAgentEventHandlerRuntimeParity([{ eventType: '*' }], 'event-backbone-default', directEffects)).not.toThrow();
    expect(() => assertAgentEventHandlerRuntimeParity([{ eventType: 'drifted.event' }], 'event-backbone-default', directEffects))
      .toThrow(/event handler runtime parity mismatch/);
    expect(() => assertAgentEventHandlerRuntimeParity([{ eventType: '*' }], 'event-backbone-default', []))
      .toThrow(/direct event effect runtime parity mismatch/);

    const defaultQueuedHandlers = [
      'project_read_models',
      'deliver_notification',
      'training_summary_projector',
      'content_radar_scan_stub_or_existing',
      'content_topic_secretary_sync',
      'sync_calendar_safe_mock',
    ].map((jobType) => ({ jobType, idempotent: true }));
    expect(() => assertAgentQueuedJobHandlerRuntimeParity(defaultQueuedHandlers, 'event-backbone-default')).not.toThrow();
    expect(() => assertAgentQueuedJobHandlerRuntimeParity(defaultQueuedHandlers.slice(1), 'event-backbone-default'))
      .toThrow(/queued job handler runtime parity mismatch/);
    expect(() => assertAgentQueuedJobHandlerRuntimeParity([
      { jobType: 'chat_action_fixer_review', idempotent: true },
    ], 'chat-action-fixer')).not.toThrow();
    expect(manifest.queuedJobHandlers
      .filter((handler) => handler.providerUsage === 'governed-provider-capable')
      .map((handler) => handler.jobType)).toEqual(['chat_action_fixer_review']);
  });

  it('loads governed capability metadata through the runtime registry', () => {
    expect(loadCapabilityManifest().capabilities).toHaveLength(8);
    expect(getCapabilityManifestEntry('training')).toMatchObject({
      id: 'triathlon',
      lifecycle: 'active',
      owner: 'training',
      memoryScope: 'tenant-user',
      providerPolicy: 'routed',
    });
  });

  it('keeps restricted-plan, onboarding, and chat registries mapped to the capability manifest', () => {
    const manifest = loadCapabilityManifest();
    expect([...FREE_TIER_ALLOWED_SKILLS].sort()).toEqual([...getRestrictedPlanCapabilityIds('free')].sort());
    expect([...BETA_TIER_ALLOWED_SKILLS].sort()).toEqual([...getRestrictedPlanCapabilityIds('beta')].sort());

    const manifestIds = manifest.capabilities.map((entry) => entry.id).sort();
    expect(Object.keys(SKILL_ONBOARDING_MAP).sort()).toEqual(manifestIds);
    for (const entry of manifest.capabilities) {
      const mapped = SKILL_ONBOARDING_MAP[entry.id];
      const normalized = mapped == null ? [] : Array.isArray(mapped) ? mapped : [mapped];
      expect(normalized).toEqual(entry.onboardingQuestionnaires);
    }
    const expectedQuestionnaireOwners = Object.fromEntries(manifest.capabilities.flatMap((entry) => (
      entry.onboardingQuestionnaires.map((questionnaire) => [questionnaire, entry.id])
    )));
    expect(QUESTIONNAIRE_SKILL_MAP).toEqual(expectedQuestionnaireOwners);

    const manifestChatActions = [...new Set(manifest.capabilities.flatMap((entry) => entry.chatActionSkills))].sort();
    expect(manifestChatActions).toEqual(Object.keys(SKILL_METADATA).sort());
    const manifestChatOwners = [...new Set(manifest.capabilities.flatMap((entry) => entry.chatOwnerSkills))].sort();
    const runtimeChatOwners = getChatSkillCapabilityRegistry()
      .map((entry) => entry.skill)
      .filter((skill) => skill !== 'owner_admin')
      .sort();
    expect(manifestChatOwners).toEqual(runtimeChatOwners);
  });
});
