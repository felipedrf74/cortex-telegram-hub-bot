// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export type {
  MessageAdapter,
  SendTextOptions,
  SendFileOptions,
  SendInlineButtonsOptions,
  EditMessageOptions,
  SendPhotoOptions,
  SendVoiceOptions,
  InlineButton,
} from './message-adapter';
export { TelegramAdapter } from './telegram-adapter';
export { IOSAdapter } from './ios-adapter';
export type { CollectedMessage } from './ios-adapter';
