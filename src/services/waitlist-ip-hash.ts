// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

export type WaitlistIpSaltSource = 'configured' | 'ephemeral';

export interface WaitlistIpSaltResolution {
  salt: string;
  source: WaitlistIpSaltSource;
  persistent: boolean;
  warning?: string;
}

const EPHEMERAL_IP_SALT = crypto.randomBytes(16).toString('hex');
let warnedAboutEphemeralSalt = false;

export function resolveWaitlistIpSalt(
  configuredSalt: string | undefined | null,
  fallbackSalt: string = EPHEMERAL_IP_SALT,
): WaitlistIpSaltResolution {
  const normalized = typeof configuredSalt === 'string' ? configuredSalt.trim() : '';
  if (normalized) {
    return {
      salt: normalized,
      source: 'configured',
      persistent: true,
    };
  }

  return {
    salt: fallbackSalt,
    source: 'ephemeral',
    persistent: false,
    warning: 'WAITLIST_IP_SALT is not configured; waitlist IP hashes rotate on process restart.',
  };
}

export function getWaitlistIpSalt(): string {
  const resolution = resolveWaitlistIpSalt(config.waitlist.ipSalt);
  if (!resolution.persistent && config.waitlist.warnOnEphemeralIpSalt && !warnedAboutEphemeralSalt) {
    warnedAboutEphemeralSalt = true;
    logger.warn({ source: resolution.source }, resolution.warning);
  }
  return resolution.salt;
}

export function hashWaitlistIpAddress(ip: string, salt: string = getWaitlistIpSalt()): string {
  return crypto.createHash('sha256').update(salt + ip).digest('hex').slice(0, 16);
}

/** Test-only: reset the one-shot warning guard between module-isolated runs. */
export function _resetWaitlistIpSaltWarningForTests(): void {
  warnedAboutEphemeralSalt = false;
}
