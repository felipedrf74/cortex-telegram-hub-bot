// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';

import {
  confirmationCopy,
  confirmationTitle,
} from '../../../../src/services/chat/executor/response-copy';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
} from '../../../../src/services/chat/types';

const BASE_INPUT: ChatPlannerInput = {
  text: 'confirm the requested action',
  userId: 77,
  tenantId: 77,
  conversationId: 'conv-confirmation-copy',
  messageId: 'msg-confirmation-copy',
  channel: 'ios',
  locale: 'en-US',
  timezone: 'UTC',
  nowIso: '2026-07-28T12:00:00.000Z',
  persistRuns: false,
};

function step(
  action: ChatPlanStep['action'],
  args: Record<string, unknown> = {},
): ChatPlanStep {
  return {
    stepId: `step-${action}`,
    skill: action === 'schedule_event'
      ? 'secretary_calendar'
      : action === 'cooking_substitute_ingredient'
        ? 'cooking'
        : action === 'send_email'
          ? 'mail'
          : 'tasks',
    type: action,
    action,
    risk: action === 'send_email' ? 'external_side_effect' : 'safe_write',
    provider: 'nexus',
    args,
    requiredArgsPresent: true,
    idempotencyKey: `idem-${action}`,
    verification: { required: false, method: 'none' },
  };
}

function plan(planStep: ChatPlanStep, locale: string): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: '77',
    tenantId: '77',
    conversationId: 'conv-confirmation-copy',
    messageId: 'msg-confirmation-copy',
    locale,
    timezone: 'UTC',
    channel: 'ios',
    createdAt: '2026-07-28T12:00:00.000Z',
    planner: 'deterministic',
    steps: [planStep],
    requiresConfirmation: true,
    confidence: 1,
  };
}

function copy(
  locale: string,
  action: ChatPlanStep['action'],
  args: Record<string, unknown> = {},
  text = BASE_INPUT.text,
): string {
  return confirmationCopy(
    plan(step(action, args), locale),
    { ...BASE_INPUT, locale, text },
  );
}

describe('chat confirmation copy locale matrix', () => {
  it('covers Spanish calendar previews with and without outbound invites', () => {
    const baseArgs = {
      title: 'Revisión semanal',
      startDateTime: '2026-07-29T09:00:00.000Z',
      endDateTime: '2026-07-29T10:00:00.000Z',
    };

    expect(copy('es-419', 'schedule_event', {
      ...baseArgs,
      provider: 'outlook_calendar',
      attendees: ['ana@example.test'],
    })).toContain('Esto puede enviar una invitación a 1 participante(s).');

    expect(copy('es-ES', 'schedule_event', {
      ...baseArgs,
      provider: 'google_calendar',
      attendees: [],
    })).toBe(
      '¿Confirmas que quieres crear “Revisión semanal” en Google Calendar el miércoles, 29 de julio, de 09:00 a 10:00?',
    );
  });

  it.each([
    ['pt-BR', 'create_task', 'criar'],
    ['pt-PT', 'delete_task', 'apagar'],
    ['pt-BR', 'complete_task', 'concluir'],
    ['pt-PT', 'update_task', 'alterar'],
    ['es-419', 'create_task', 'crear'],
    ['es-ES', 'delete_task', 'eliminar'],
    ['es-419', 'complete_task', 'completar'],
    ['es-ES', 'update_task', 'actualizar'],
    ['en-US', 'create_task', 'create'],
    ['en-GB', 'delete_task', 'delete'],
    ['en-US', 'complete_task', 'complete'],
    ['en-GB', 'update_task', 'change'],
  ] as const)('uses the correct %s verb for %s', (locale, action, verb) => {
    expect(copy(locale, action, { title: 'Quarterly review' })).toContain(`${verb} `);
  });

  it('uses taskId and request-text fallbacks when a task title is absent', () => {
    expect(copy('es-419', 'update_task', { taskId: 'task-42' }))
      .toContain('“task-42”');
    expect(copy('en-US', 'update_task', {}, 'Update the smoke task'))
      .toContain('“Update the smoke task”');
  });

  it('localizes reminders and covers message/request-text selection', () => {
    const remindAt = '2026-07-29T09:30:00.000Z';
    expect(copy('es-419', 'set_reminder', { message: 'Revisar el plan', remindAt }))
      .toBe('¿Confirmas que quieres crear el recordatorio “Revisar el plan” para el 29/07 09:30?');
    expect(copy('es-ES', 'set_reminder', { remindAt }, 'Revisar la bandeja'))
      .toContain('“Revisar la bandeja”');
  });

  it('localizes cooking substitutions with explicit and fallback arguments', () => {
    expect(copy('es-419', 'cooking_substitute_ingredient', {
      originalIngredient: 'leche',
      suggestedIngredient: 'bebida de avena',
      mealType: 'desayuno',
      date: '2026-07-29',
    })).toContain(
      'cambiar leche por bebida de avena en desayuno del 2026-07-29',
    );

    expect(copy('es-ES', 'cooking_substitute_ingredient'))
      .toContain('cambiar ingredient por replacement en meal del the selected day');
  });

  it.each([
    ['pt-BR', 'send_email', 'antes de enviar esta ação'],
    ['pt-PT', 'connections_retry_sync', 'antes de executar esta ação'],
    ['es-419', 'send_email', 'antes de enviar esta acción'],
    ['es-ES', 'connections_retry_sync', 'antes de ejecutar esta acción'],
    ['en-US', 'send_email', 'before I send this action'],
    ['en-GB', 'connections_retry_sync', 'before I run this action'],
  ] as const)('localizes the generic %s confirmation for %s', (locale, action, expected) => {
    expect(copy(locale, action)).toContain(expected);
  });

  it.each([
    ['pt-BR', 'Confirmação necessária'],
    ['es-419', 'Confirmación necesaria'],
    ['en-US', 'Confirmation needed'],
  ] as const)('localizes the confirmation title for %s', (locale, expected) => {
    expect(confirmationTitle({ ...BASE_INPUT, locale })).toBe(expected);
  });
});
