// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const IOS_JWT_EXPIRY_PATTERN = /^(\d+(?:\.\d+)?)(s|m|h|d)$/i;

/**
 * Parse the supported JWT lifetime syntax without relying on jsonwebtoken's
 * permissive string coercion. Returning whole seconds gives startup, signing,
 * session persistence, and rotation tooling one fail-closed contract.
 */
export function parseIosJwtExpirySeconds(raw: string): number {
  const match = raw.trim().match(IOS_JWT_EXPIRY_PATTERN);
  if (!match) {
    throw new Error('IOS_JWT_EXPIRY must use an explicit positive s, m, h, or d duration');
  }
  const value = Number(match[1]);
  const multiplier = ({ s: 1, m: 60, h: 3600, d: 86400 } as const)[
    match[2].toLowerCase() as 's' | 'm' | 'h' | 'd'
  ];
  const seconds = value * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error('IOS_JWT_EXPIRY must resolve to a positive whole number of seconds');
  }
  return seconds;
}
