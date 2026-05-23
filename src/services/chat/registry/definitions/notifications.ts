// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionDefinition } from '../types';
import { makeRequiredFieldsValidator, STATUS_CARDS } from '../helpers';
import {
  notificationSlotExtractor,
} from '../../../registry-typed-slot-adapters';

export const NOTIFICATION_ACTIONS: ChatActionDefinition[] = [
  {
      skill: 'notifications',
      action: 'notification_explain',
      readableIntents: ['notification explain', 'why this notification', 'por que veio essa notificação', 'explica a notificação'],
      requiredFields: ['topic'],
      optionalFields: [],
      providerDependencies: ['nexus'],
      typedSlotExtractors: [notificationSlotExtractor],
      typedSlotValidators: [makeRequiredFieldsValidator(['topic'])],
      risk: 'read_only',
      confirmationPolicy: 'none',
      executor: 'notifications.explain',
      verifier: 'none',
      supportedCards: STATUS_CARDS,
      examples: [
        {
          text: 'Why did I get the readiness drop notification',
          locale: 'en',
          tags: ['golden'],
          expectedAction: 'notification_explain',
        },
        {
          text: 'Por que recebi a notificação de queda de readiness',
          locale: 'pt',
          tags: ['golden'],
          expectedAction: 'notification_explain',
        },
        {
          // Phase 3 batch 15: PT-BR colloquial "veio" (came) vs "recebi"
          // (received).
          text: 'Por que veio essa notificação',
          locale: 'pt',
          tags: ['golden'],
          expectedAction: 'notification_explain',
        },
        {
          // Phase 14 batch 73 (2026-05-16): Spanish golden example.
          text: 'Por qué recibí esta notificación',
          locale: 'es',
          tags: ['golden'],
          expectedAction: 'notification_explain',
        },
      ],
    },
  {
      skill: 'notifications',
      action: 'notification_update_preference',
      readableIntents: ['notification update preference', 'disable notifications', 'desativa as notificações', 'desliga notificação'],
      requiredFields: ['preference'],
      optionalFields: [],
      providerDependencies: ['nexus'],
      risk: 'safe_write',
      confirmationPolicy: 'confirm',
      executor: 'notifications.updatePreference',
      verifier: 'local_read_back',
      typedSlotExtractors: [notificationSlotExtractor],
      typedSlotValidators: [makeRequiredFieldsValidator(['preference'])],
      supportedCards: STATUS_CARDS,
      examples: [
        {
          text: 'Disable training notifications on weekends',
          locale: 'en',
          tags: ['golden'],
          expectedAction: 'notification_update_preference',
        },
        {
          text: 'Desativa as notificações de treino aos fins de semana',
          locale: 'pt',
          tags: ['golden'],
          expectedAction: 'notification_update_preference',
        },
        {
          // Phase 3 batch 15: PT-BR "Desliga" (BR colloquial for disable).
          text: 'Desliga as notificações de treino no fim de semana',
          locale: 'pt',
          tags: ['golden'],
          expectedAction: 'notification_update_preference',
        },
        {
          // Phase 14 batch 73 (2026-05-16): Spanish golden example.
          text: 'Desactiva las notificaciones de marketing',
          locale: 'es',
          tags: ['golden'],
          expectedAction: 'notification_update_preference',
        },
      ],
    },
  {
      skill: 'notifications',
      action: 'notification_create_intent',
      readableIntents: ['notification create intent', 'create a notification', 'cria uma notificação', 'alert me when'],
      requiredFields: ['title', 'trigger'],
      optionalFields: [],
      providerDependencies: ['nexus'],
      risk: 'safe_write',
      confirmationPolicy: 'confirm',
      executor: 'notifications.createIntent',
      verifier: 'local_read_back',
      typedSlotExtractors: [notificationSlotExtractor],
      typedSlotValidators: [makeRequiredFieldsValidator(['title', 'trigger'])],
      supportedCards: STATUS_CARDS,
      examples: [
        {
          text: 'Create a notification when my Stripe revenue passes 5k this month',
          locale: 'en',
          tags: ['golden'],
          expectedAction: 'notification_create_intent',
        },
        {
          text: 'Cria uma notificação quando a receita da Stripe passar 5 mil este mês',
          locale: 'pt',
          tags: ['golden'],
          expectedAction: 'notification_create_intent',
        },
        {
          // Phase 2 batch 8: bare "create a notification" without a trigger.
          text: 'Create a notification',
          locale: 'en',
          tags: ['ambiguous'],
          condition: 'no_trigger_or_title',
          expectedAction: null,
        },
        {
          // Phase 14 batch 73 (2026-05-16): Spanish golden example.
          text: 'Crea una notificación cuando llegue un correo de Pedro',
          locale: 'es',
          tags: ['golden'],
          expectedAction: 'notification_create_intent',
        },
      ],
    }
];
