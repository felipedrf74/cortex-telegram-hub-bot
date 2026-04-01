// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  SendInlineButtonsOptions,
  EditMessageOptions,
  InlineButton,
} from './message-adapter';
export { TelegramAdapter } from './telegram-adapter';
export { WhatsAppAdapter } from './whatsapp-adapter';
export type { WhatsAppConfig } from './whatsapp-adapter';
