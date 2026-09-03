// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { IANAZone } from 'luxon';

/**
 * Validate and canonicalize an IANA timezone without mutating account state.
 * ICU resolves legacy aliases such as Etc/UTC to the stable identifier UTC,
 * keeping plan cache identity and settings responses consistent.
 */
export function canonicalizeIanaTimezone(value: string | null | undefined): string | null {
  const candidate = String(value ?? '').trim();
  if (!candidate || !IANAZone.isValidZone(candidate)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate })
      .resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}
