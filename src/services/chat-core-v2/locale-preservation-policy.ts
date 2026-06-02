// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Locale } from './response-contracts';

export interface LocalePreservationVerdict {
  ok: boolean;
  expectedLocale: ChatCoreV2Locale;
  actualLocale: ChatCoreV2Locale;
  reasonCode?: 'composer_locale_mismatch';
}

export function validateResponseLocalePreservation(input: {
  expectedLocale: ChatCoreV2Locale;
  actualLocale: ChatCoreV2Locale;
}): LocalePreservationVerdict {
  if (input.expectedLocale === input.actualLocale) {
    return {
      ok: true,
      expectedLocale: input.expectedLocale,
      actualLocale: input.actualLocale,
    };
  }
  return {
    ok: false,
    expectedLocale: input.expectedLocale,
    actualLocale: input.actualLocale,
    reasonCode: 'composer_locale_mismatch',
  };
}
