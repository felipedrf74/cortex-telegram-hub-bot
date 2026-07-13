// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { validateChatConfirmationTokenConfiguration } from './chat-confirmation-token';
import { validateIosJwtConfiguration } from './ios-jwt';

export function validateIosApiSecurityConfiguration(enabled: boolean): void {
  if (!enabled) return;
  validateChatConfirmationTokenConfiguration();
  validateIosJwtConfiguration();
}
