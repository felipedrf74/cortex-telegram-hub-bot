// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { logger } from '../utils/logger';

export interface PortalCredential {
  label: string;
  value: string;
}

export interface PortalCredentialConfig {
  token: string;
  readToken: string;
  writeToken: string;
  adminToken: string;
}

const WEAK_PORTAL_TOKENS = new Set([
  'changeme', 'change-me', 'changeme123', 'admin', 'administrator',
  'password', 'password1', 'passw0rd', 'nexushub', 'nexus-hub',
  'dev', 'develop', 'development', 'test', 'testing', 'local',
  '1234', '12345', '123456', '1234567', '12345678', '123456789',
]);

export function getConfiguredPortalCredentials(config: PortalCredentialConfig): PortalCredential[] {
  return [
    { label: 'PORTAL_TOKEN', value: config.token },
    { label: 'PORTAL_READ_TOKEN', value: config.readToken },
    { label: 'PORTAL_WRITE_TOKEN', value: config.writeToken },
    { label: 'PORTAL_ADMIN_TOKEN', value: config.adminToken },
  ].filter((entry) => entry.value);
}

export function isWeakPortalCredentialValue(value: string): boolean {
  return (
    value.length < 12 ||
    WEAK_PORTAL_TOKENS.has(value.toLowerCase()) ||
    /^(.)\1+$/.test(value)
  );
}

export function validatePortalCredentialStrength(credentials: readonly PortalCredential[]): void {
  for (const credential of credentials) {
    if (!isWeakPortalCredentialValue(credential.value)) continue;

    const msg = `${credential.label} is too weak (length=${credential.value.length}, must be >=12 chars and not a well-known default). Refusing to start the admin portal with a guessable token. Generate a random one: \`openssl rand -hex 32\``;
    logger.fatal(
      { tokenLength: credential.value.length, tokenLabel: credential.label },
      msg,
    );
    throw new Error(msg);
  }
}
