// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Default in-process handlers for the SQLite event backbone.
 *
 * Scheduler/PM2 can call these helpers later. Tests also exercise them
 * directly so the queue foundation has a real idempotent handler contract.
 */

import { enqueueJob, processPendingJobs, type JobHandler } from './background-job-queue';
import { processPendingEvents, type EventHandler } from './event-outbox';
import { projectSummaryReadModelsForUser } from './app-summary-read-models';
import { recordProductDecision } from './product-decision-log';

const PROJECTABLE_EVENT_TYPES = new Set([
  'auth.user.logged_in',
  'chat.message.created',
  'secretary.agenda_item.created',
  'secretary.agenda_item.updated',
  'secretary.conflict.detected',
  'secretary.reflow.suggested',
  'training.plan.created',
  'training.plan.updated',
  'training.session.updated',
  'training.feedback.recorded',
  'content.profile.updated',
  'content.idea.created',
  'content.idea.updated',
  'content.script.updated',
  'cooking.meal_plan.updated',
  'finance.expense.created',
  'notification.intent.created',
  'notification.item.updated',
]);

export const defaultEventHandlers: EventHandler[] = [
  {
    eventType: '*',
    handle(event) {
      if (!event.userId || !PROJECTABLE_EVENT_TYPES.has(event.eventType)) return;
      enqueueJob({
        tenantId: event.tenantId,
        userId: event.userId,
        jobType: 'project_read_models',
        payload: {
          eventId: event.eventId,
          eventType: event.eventType,
          sourceSkill: event.sourceSkill,
        },
        priority: 30,
        idempotencyKey: `project_read_models:${event.eventId}`,
        correlationId: event.correlationId,
        causationEventId: event.eventId,
      });
    },
  },
];

export const defaultJobHandlers: JobHandler[] = [
  {
    jobType: 'project_read_models',
    handle(job) {
      if (!job.userId) return;
      const projected = projectSummaryReadModelsForUser({
        tenantId: job.tenantId,
        userId: job.userId,
      });
      recordProductDecision({
        tenantId: job.tenantId,
        userId: job.userId,
        sourceSkill: 'system',
        entityType: 'app_summary_read_model',
        entityId: job.jobId,
        decisionType: 'read_model_projection',
        inputsSummary: {
          jobType: job.jobType,
          summaries: projected.map((summary) => summary.summaryType),
        },
        decision: { projectedCount: projected.length },
        explanationCode: 'read_models_projected_from_event',
        correlationId: job.correlationId,
        eventId: job.causationEventId,
      });
    },
  },
  {
    jobType: 'deliver_notification',
    handle() {
      // Notification delivery is still synchronously evaluated by the
      // Secretary Notification Orchestrator. The queued record provides a
      // durable retry hook for the next phase without sending extra pushes.
    },
  },
  {
    jobType: 'training_summary_projector',
    handle(job) {
      if (!job.userId) return;
      projectSummaryReadModelsForUser({ tenantId: job.tenantId, userId: job.userId, summaryTypes: ['training', 'home', 'week'] });
    },
  },
  {
    jobType: 'content_radar_scan_stub_or_existing',
    handle() {
      // Intentionally no provider call in local/job foundation mode.
    },
  },
  {
    jobType: 'sync_calendar_safe_mock',
    handle() {
      // Intentionally no external calendar call in local/job foundation mode.
    },
  },
];

export async function runEventBackboneOnce(): Promise<{
  events: Awaited<ReturnType<typeof processPendingEvents>>;
  jobs: Awaited<ReturnType<typeof processPendingJobs>>;
}> {
  const events = await processPendingEvents(defaultEventHandlers);
  const jobs = await processPendingJobs(defaultJobHandlers);
  return { events, jobs };
}
