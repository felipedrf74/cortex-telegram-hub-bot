// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionDefinition } from '../types';
import { makeRequiredFieldsValidator, STATUS_CARDS } from '../helpers';
import { noopSlotExtractor } from '../../../registry-typed-slot-adapters';

export const SECRETARY_REMINDER_ACTIONS: ChatActionDefinition[] = [
  {
    skill: 'secretary_reminders',
    action: 'set_reminder',
    readableIntents: ['set reminder', 'remind me', 'lembrete', 'lembra-me', 'avisa-me'],
    requiredFields: ['message', 'remindAt', 'timezone'],
    optionalFields: ['recurring'],
    providerDependencies: ['nexus'],
    risk: 'safe_write',
    confirmationPolicy: 'confirm',
    executor: 'secretary.reminders.setReminder',
    verifier: 'local_read_back',
    // Slot extraction for this action is owned by the deterministic
    // reminder-intents parser; keep a typed extractor registered so
    // downstream typed-slot consumers do not need a special case.
    typedSlotExtractors: [noopSlotExtractor],
    typedSlotValidators: [makeRequiredFieldsValidator(['message', 'remindAt', 'timezone'])],
    supportedCards: STATUS_CARDS,
    examples: [
      {
        text: 'Remind me at 15:30 to call the dentist',
        locale: 'en',
        tags: ['golden'],
        expectedAction: 'set_reminder',
      },
      {
        text: 'Lembra-me às 15:30 de ligar ao dentista',
        locale: 'pt',
        tags: ['golden'],
        expectedAction: 'set_reminder',
      },
      {
        text: 'Avisa 9:00 reunião com Pedro',
        locale: 'pt',
        tags: ['golden'],
        expectedAction: 'set_reminder',
      },
      {
        text: 'Recuérdame a las 15:30 llamar al dentista',
        locale: 'es',
        tags: ['golden'],
        expectedAction: 'set_reminder',
      },
    ],
  },
];
