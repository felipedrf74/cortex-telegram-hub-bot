// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  registerReplyWaiter as registerAmazonReplyWaiter,
  resolveReply as resolveAmazonReply,
} from './amazon-collector';
import {
  registerReplyWaiter as registerUberReplyWaiter,
  resolveReply as resolveUberReply,
} from './uber-collector';
import {
  createNotificationIntent,
  type NotificationEvaluationResult,
} from './notification-orchestrator';
import { logger } from '../utils/logger';

export type ScraperMfaSource = 'amazon' | 'uber';

export interface ScraperMfaReplyInput {
  userId: number;
  tenantId: number;
  source: ScraperMfaSource;
  code: string;
}

export interface ScraperMfaReplyResult {
  accepted: boolean;
  source: ScraperMfaSource;
}

export interface ScraperMfaChallengeNotificationInput {
  userId: number;
  tenantId: number;
  source: ScraperMfaSource;
}

export interface ScraperMfaInteractiveCallbacks {
  sendMessage: (message: string) => Promise<void>;
  sendScreenshot: (buffer: Buffer) => Promise<void>;
  waitForReply: (timeoutMs: number) => Promise<string>;
}

const SOURCE_LABELS: Record<ScraperMfaSource, string> = {
  amazon: 'Amazon',
  uber: 'Uber',
};

export function normalizeScraperMfaSource(value: unknown): ScraperMfaSource | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'amazon') return 'amazon';
  if (normalized === 'uber') return 'uber';
  return null;
}

export function normalizeScraperMfaCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim();
  if (!code || code.length > 256) return null;
  return code;
}

export function submitScraperMfaReply(input: ScraperMfaReplyInput): ScraperMfaReplyResult {
  const accepted = input.source === 'amazon'
    ? resolveAmazonReply(input.userId, input.code)
    : resolveUberReply(input.userId, input.code);

  return {
    accepted,
    source: input.source,
  };
}

export async function notifyScraperMfaChallenge(
  input: ScraperMfaChallengeNotificationInput,
): Promise<NotificationEvaluationResult> {
  const label = SOURCE_LABELS[input.source];
  const deadline = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  return createNotificationIntent({
    userId: input.userId,
    tenantId: input.tenantId,
    sourceSkill: 'finance',
    type: 'approval_required',
    priority: 'time_sensitive',
    relatedEntityId: `${input.source}-scraper-mfa`,
    relatedEntityType: 'invoice_scraper_mfa',
    title: `${label} needs verification`,
    body: `${label} needs a verification code to continue invoice collection.`,
    sensitiveBody: `${label} needs a verification code to continue invoice collection for this account.`,
    actionButtons: [
      {
        id: 'enter_scraper_mfa_code',
        label: 'Enter code',
        style: 'primary',
        deeplink: `nexus://finance/invoices/scraper-mfa?source=${input.source}`,
        mutating: false,
      },
    ],
    deeplink: `nexus://finance/invoices/scraper-mfa?source=${input.source}`,
    expiresAt: deadline,
    decisionDeadline: deadline,
    quietHoursPolicy: 'allow_time_sensitive',
    dedupeKey: `finance:scraper-mfa:${input.tenantId}:${input.userId}:${input.source}`,
    requiresUserAction: true,
    deliveryPolicy: 'push_allowed',
    privacyPolicy: 'financial',
    decisionContext: {
      entityTitle: `${label} invoice collection`,
      providerName: label,
      sourceState: 'mfa_pending',
      reasonCodes: ['scraper_mfa_required'],
      visibilityScope: 'user_private',
    },
    visibilityScope: 'user_private',
  });
}

export function createScraperMfaInteractiveCallbacks(
  input: ScraperMfaChallengeNotificationInput,
): ScraperMfaInteractiveCallbacks {
  return {
    sendMessage: async () => {
      await notifyScraperMfaChallenge(input);
    },
    sendScreenshot: async (buffer: Buffer) => {
      logger.info(
        {
          userId: input.userId,
          tenantId: input.tenantId,
          source: input.source,
          screenshotBytes: buffer.length,
        },
        'Scraper MFA screenshot captured for app-side verification flow',
      );
    },
    waitForReply: (timeoutMs: number) => (
      input.source === 'amazon'
        ? registerAmazonReplyWaiter(input.userId, timeoutMs)
        : registerUberReplyWaiter(input.userId, timeoutMs)
    ),
  };
}
