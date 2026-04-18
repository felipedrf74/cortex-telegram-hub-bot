// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { countEmailsForUser, isGmailConfiguredForUser } from './google-gmail';
import { getUnreadCountForUser, isOutlookMailConfiguredForUser } from './outlook-mail';
import { logger } from '../utils/logger';

export interface UserMailPressureSummary {
  configuredProviders: Array<'outlook' | 'gmail'>;
  outlookUnread: number | null;
  gmailUnread: number | null;
  totalUnread: number;
}

export function isAnyMailConfiguredForUser(userId: number): boolean {
  return isOutlookMailConfiguredForUser(userId) || isGmailConfiguredForUser(userId);
}

export async function getUnreadMailSummaryForUser(userId: number): Promise<UserMailPressureSummary> {
  const outlookConfigured = isOutlookMailConfiguredForUser(userId);
  const gmailConfigured = isGmailConfiguredForUser(userId);

  const [outlookUnread, gmailUnread] = await Promise.all([
    outlookConfigured
      ? getUnreadCountForUser(userId)
          .then((count) => (typeof count === 'number' && count >= 0 ? count : null))
          .catch((err) => {
            logger.warn({ err, userId }, 'Unified mail pressure: Outlook unread count failed');
            return null;
          })
      : Promise.resolve(null),
    gmailConfigured
      ? countEmailsForUser(userId, 'in:inbox is:unread')
          .then((count) => (typeof count === 'number' && count >= 0 ? count : null))
          .catch((err) => {
            logger.warn({ err, userId }, 'Unified mail pressure: Gmail unread count failed');
            return null;
          })
      : Promise.resolve(null),
  ]);

  return {
    configuredProviders: [
      ...(outlookConfigured ? ['outlook' as const] : []),
      ...(gmailConfigured ? ['gmail' as const] : []),
    ],
    outlookUnread,
    gmailUnread,
    totalUnread: [outlookUnread, gmailUnread]
      .filter((value): value is number => typeof value === 'number' && value >= 0)
      .reduce((sum, value) => sum + value, 0),
  };
}
