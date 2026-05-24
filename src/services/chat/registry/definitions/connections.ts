// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionDefinition } from '../types';
import { makeRequiredFieldsValidator, STATUS_CARDS } from '../helpers';
import {
  connectionsSlotExtractor,
} from '../../../registry-typed-slot-adapters';

export const CONNECTIONS_ACTIONS: ChatActionDefinition[] = [
  {
      skill: 'connections',
      action: 'connections_status',
      readableIntents: ['connections status', 'connection status', 'integration status', 'estado das conexões', 'estado da integração'],
      requiredFields: [],
      optionalFields: [],
      providerDependencies: ['nexus'],
      risk: 'read_only',
      confirmationPolicy: 'none',
      executor: 'connections.status',
      verifier: 'none',
      typedSlotExtractors: [connectionsSlotExtractor],
      typedSlotValidators: [makeRequiredFieldsValidator([])],
      supportedCards: STATUS_CARDS,
      examples: [
        {
          text: 'Show my Google Calendar connection status',
          locale: 'en',
          tags: ['golden'],
          expectedSlots: { provider: 'google' },
          expectedAction: 'connections_status',
        },
        {
          text: 'Como está minha conexão com o Outlook?',
          locale: 'pt',
          tags: ['golden'],
          expectedSlots: { provider: 'outlook' },
          expectedAction: 'connections_status',
        },
        {
          // Phase 3 batch 15: PT-BR "tá" contraction.
          text: 'Como tá a conexão com o Outlook',
          locale: 'pt',
          tags: ['golden'],
          expectedSlots: { provider: 'outlook' },
          expectedAction: 'connections_status',
        },
        {
          // Phase 14 batch 73 (2026-05-16): Spanish golden example.
          text: 'Cómo está mi conexión con Google',
          locale: 'es',
          tags: ['golden'],
          expectedSlots: { provider: 'google' },
          expectedAction: 'connections_status',
        },
      ],
    },
  {
      skill: 'connections',
      action: 'connections_retry_sync',
      readableIntents: ['connections retry sync', 'retry sync', 'sincronizar novamente', 'reconnect provider sync'],
      requiredFields: ['provider'],
      optionalFields: [],
      providerDependencies: ['nexus'],
      risk: 'safe_write',
      confirmationPolicy: 'confirm',
      executor: 'connections.retrySync',
      verifier: 'local_read_back',
      typedSlotExtractors: [connectionsSlotExtractor],
      typedSlotValidators: [makeRequiredFieldsValidator(['provider'])],
      supportedCards: STATUS_CARDS,
      examples: [
        {
          text: 'Retry sync for Google Calendar',
          locale: 'en',
          tags: ['golden'],
          expectedSlots: { provider: 'google' },
          expectedAction: 'connections_retry_sync',
        },
        {
          text: 'Sincronizar novamente a conexão do Garmin',
          locale: 'pt',
          tags: ['golden'],
          expectedSlots: { provider: 'garmin' },
          expectedAction: 'connections_retry_sync',
        },
        {
          // Phase 14 batch 73 (2026-05-16): Spanish golden example.
          text: 'Reconecta Garmin',
          locale: 'es',
          tags: ['golden'],
          expectedSlots: { provider: 'garmin' },
          expectedAction: 'connections_retry_sync',
        },
      ],
    },
  {
      skill: 'connections',
      action: 'connections_reconnect_guidance',
      readableIntents: ['connections reconnect guidance', 'how do I reconnect', 'como reconectar', 'reauth guidance'],
      requiredFields: ['provider'],
      optionalFields: [],
      providerDependencies: ['nexus'],
      risk: 'read_only',
      confirmationPolicy: 'none',
      executor: 'connections.reconnectGuidance',
      verifier: 'none',
      typedSlotExtractors: [connectionsSlotExtractor],
      typedSlotValidators: [makeRequiredFieldsValidator(['provider'])],
      supportedCards: STATUS_CARDS,
      examples: [
        {
          text: 'How do I reconnect Garmin?',
          locale: 'en',
          tags: ['golden'],
          expectedSlots: { provider: 'garmin' },
          expectedAction: 'connections_reconnect_guidance',
        },
        {
          text: 'Como reconectar minha conta do Google?',
          locale: 'pt',
          tags: ['golden'],
          expectedSlots: { provider: 'google' },
          expectedAction: 'connections_reconnect_guidance',
        },
        {
          // Phase 14 batch 73 (2026-05-16): Spanish golden example.
          text: 'Cómo me reconecto a Garmin',
          locale: 'es',
          tags: ['golden'],
          expectedSlots: { provider: 'garmin' },
          expectedAction: 'connections_reconnect_guidance',
        },
      ],
    }
];
