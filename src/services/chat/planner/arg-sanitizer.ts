// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { redactSensitivePromptText } from '../../llm-prompt-safety';

const FORBIDDEN_MODEL_ARG_KEYS = new Set([
  'userid',
  'uid',
  'user',
  'tenantid',
  'tenant',
  'accountid',
  'account',
  'owneruserid',
  'ownerid',
  'owner',
  'proto',
  'prototype',
  'constructor',
  'customerid',
  'subjectid',
  'principalid',
  'memberid',
  'actorid',
  'providertoken',
  'provideraccesstoken',
  'providerrefreshtoken',
  'accesstoken',
  'refreshtoken',
  'oauthtoken',
  'oauthcredentials',
  'oauthcredential',
  'clientsecret',
  'apikey',
  'rawsystemprompt',
  'systemprompt',
  'developerprompt',
  'internalprompt',
  'systeminstructions',
  'reasoning',
  'internalreasoning',
  'debug',
  'debugcard',
  'debugcards',
  'internaldebug',
  'internaldebugcard',
  'nexusanswer',
  'structuredresponse',
  'rawmodeloutput',
  'modeltrace',
  'tooltrace',
]);

export function sanitizePlannerArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizePlannerArgValue(args);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizePlannerArgValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePlannerArgValue(item));
  }
  if (typeof value === 'string') return redactSensitivePromptText(value);
  if (!isRecord(value)) return value;

  const sanitized = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenModelArgKey(key)) continue;
    sanitized[key] = sanitizePlannerArgValue(child);
  }
  return sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function isForbiddenModelArgKey(key: string): boolean {
  return FORBIDDEN_MODEL_ARG_KEYS.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}
