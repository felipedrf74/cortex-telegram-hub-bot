// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { normalizeSupportedLang, type Lang } from '../utils/i18n';

/**
 * Canonicalize creator-controlled output selectors without invoking a provider.
 *
 * Missing values may inherit an already-supported request hint. Any explicit
 * retired or unknown value fails closed to English, so historical profile
 * labels can never become prompt instructions for unsupported output.
 */
export function normalizeContentOutputLanguage(
  value: unknown,
  missingValueFallback: Lang = 'en-US',
): Lang {
  const fallback = normalizeSupportedLang(missingValueFallback, 'en-US');
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return normalizeSupportedLang(value, 'en-US');
}
