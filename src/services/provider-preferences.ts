// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { isConnected } from './oauth-store';
import { isGoogleCalendarConfigured } from './google-calendar';
import { isOutlookCalendarConfigured } from './outlook-calendar';
import type { CalendarSource } from './unified-calendar';
import { isProviderPreferencesV1Enabled } from './runtime-flags';

export type PrimaryMailProvider = 'auto' | 'gmail' | 'outlook';
export type PrimaryCalendarProvider = 'auto' | 'google' | 'outlook';

export interface ProviderPreferenceAvailability {
  mail: {
    gmail: boolean;
    outlook: boolean;
  };
  calendar: {
    google: boolean;
    outlook: boolean;
  };
}

export interface ProviderPreferences {
  userId: number;
  tenantId: number;
  primaryMailProvider: PrimaryMailProvider;
  primaryCalendarProvider: PrimaryCalendarProvider;
  featureEnabled: boolean;
  availability: ProviderPreferenceAvailability;
  warnings: string[];
  warningCodes: string[];
}

export interface CalendarPreferenceResolution {
  source: CalendarSource | null;
  requested: PrimaryCalendarProvider;
  warningCode: string | null;
  warning: string | null;
  availability: ProviderPreferenceAvailability['calendar'];
}

export interface MailPreferenceResolution {
  sources: Array<'gmail' | 'outlook'>;
  requested: PrimaryMailProvider;
  warningCode: string | null;
  warning: string | null;
  availability: ProviderPreferenceAvailability['mail'];
}

const MAIL_VALUES = new Set(['auto', 'gmail', 'outlook']);
const CALENDAR_VALUES = new Set(['auto', 'google', 'outlook']);

export function normalizePrimaryMailProvider(value: unknown): PrimaryMailProvider | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return MAIL_VALUES.has(normalized) ? normalized as PrimaryMailProvider : null;
}

export function normalizePrimaryCalendarProvider(value: unknown): PrimaryCalendarProvider | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return CALENDAR_VALUES.has(normalized) ? normalized as PrimaryCalendarProvider : null;
}

export function ensureProviderPreferencesTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS user_provider_preferences (
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      primary_mail_provider TEXT NOT NULL DEFAULT 'auto'
        CHECK (primary_mail_provider IN ('auto', 'gmail', 'outlook')),
      primary_calendar_provider TEXT NOT NULL DEFAULT 'auto'
        CHECK (primary_calendar_provider IN ('auto', 'google', 'outlook')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_provider_preferences_scope
      ON user_provider_preferences(user_id, tenant_id);
  `);
}

export function getProviderAvailability(userId: number): ProviderPreferenceAvailability {
  return {
    mail: {
      gmail: safeConnected(userId, 'google'),
      outlook: safeConnected(userId, 'outlook'),
    },
    calendar: {
      google: safeGoogleCalendar(userId),
      outlook: safeOutlookCalendar(userId),
    },
  };
}

export function getProviderPreferences(userId: number, tenantId = userId): ProviderPreferences {
  const row = readStoredProviderPreferences(userId, tenantId);
  const primaryMailProvider = normalizePrimaryMailProvider(row?.primary_mail_provider) ?? 'auto';
  const primaryCalendarProvider = normalizePrimaryCalendarProvider(row?.primary_calendar_provider) ?? 'auto';
  const availability = getProviderAvailability(userId);
  const featureEnabled = isProviderPreferencesV1Enabled(process.env, { userId, tenantId });
  const { warningCodes, warnings } = providerPreferenceWarnings(primaryMailProvider, primaryCalendarProvider, availability);
  return {
    userId,
    tenantId,
    primaryMailProvider,
    primaryCalendarProvider,
    featureEnabled,
    availability,
    warningCodes,
    warnings,
  };
}

function readStoredProviderPreferences(userId: number, tenantId: number): any | null {
  try {
    ensureProviderPreferencesTables();
    return getDb().prepare(`
      SELECT primary_mail_provider, primary_calendar_provider
        FROM user_provider_preferences
       WHERE user_id = ? AND tenant_id = ?
    `).get(userId, tenantId) as any;
  } catch (err) {
    if (err instanceof Error && err.message.includes('Database not initialized')) {
      return null;
    }
    throw err;
  }
}

export function setProviderPreferences(
  userId: number,
  tenantId: number,
  input: { primaryMailProvider?: PrimaryMailProvider; primaryCalendarProvider?: PrimaryCalendarProvider },
): ProviderPreferences {
  ensureProviderPreferencesTables();
  const current = getProviderPreferences(userId, tenantId);
  const nextMail = input.primaryMailProvider ?? current.primaryMailProvider;
  const nextCalendar = input.primaryCalendarProvider ?? current.primaryCalendarProvider;
  getDb().prepare(`
    INSERT INTO user_provider_preferences (
      user_id, tenant_id, primary_mail_provider, primary_calendar_provider, created_at, updated_at
    ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, tenant_id) DO UPDATE SET
      primary_mail_provider = excluded.primary_mail_provider,
      primary_calendar_provider = excluded.primary_calendar_provider,
      updated_at = datetime('now')
  `).run(userId, tenantId, nextMail, nextCalendar);
  return getProviderPreferences(userId, tenantId);
}

export function resolveCalendarWritePreference(userId: number, tenantId = userId): CalendarPreferenceResolution {
  const preferences = getProviderPreferences(userId, tenantId);
  const availability = preferences.availability.calendar;
  const requested = preferences.featureEnabled ? preferences.primaryCalendarProvider : 'auto';
  if (requested === 'google') {
    return availability.google
      ? { source: 'google', requested, warningCode: null, warning: null, availability }
      : {
          source: null,
          requested,
          warningCode: 'GOOGLE_CALENDAR_PREFERENCE_UNAVAILABLE',
          warning: 'Google Calendar is your preferred calendar, but it is not connected or writable.',
          availability,
        };
  }
  if (requested === 'outlook') {
    return availability.outlook
      ? { source: 'outlook', requested, warningCode: null, warning: null, availability }
      : {
          source: null,
          requested,
          warningCode: 'OUTLOOK_CALENDAR_PREFERENCE_UNAVAILABLE',
          warning: 'Outlook Calendar is your preferred calendar, but it is not connected or writable.',
          availability,
        };
  }
  if (availability.outlook) return { source: 'outlook', requested, warningCode: null, warning: null, availability };
  if (availability.google) return { source: 'google', requested, warningCode: null, warning: null, availability };
  return {
    source: null,
    requested,
    warningCode: 'CALENDAR_INTEGRATION_MISSING',
    warning: 'No writable calendar provider is connected.',
    availability,
  };
}

export function resolveMailReadPreference(userId: number, tenantId = userId): MailPreferenceResolution {
  const preferences = getProviderPreferences(userId, tenantId);
  const availability = preferences.availability.mail;
  const requested = preferences.featureEnabled ? preferences.primaryMailProvider : 'auto';
  if (requested === 'gmail') {
    return availability.gmail
      ? { sources: ['gmail'], requested, warningCode: null, warning: null, availability }
      : {
          sources: [],
          requested,
          warningCode: 'PREFERRED_GMAIL_UNAVAILABLE',
          warning: 'Gmail is selected as the primary mail provider, but it is not connected.',
          availability,
        };
  }
  if (requested === 'outlook') {
    return availability.outlook
      ? { sources: ['outlook'], requested, warningCode: null, warning: null, availability }
      : {
          sources: [],
          requested,
          warningCode: 'PREFERRED_OUTLOOK_MAIL_UNAVAILABLE',
          warning: 'Outlook is selected as the primary mail provider, but it is not connected.',
          availability,
        };
  }
  return {
    sources: [
      ...(availability.outlook ? ['outlook' as const] : []),
      ...(availability.gmail ? ['gmail' as const] : []),
    ],
    requested,
    warningCode: null,
    warning: null,
    availability,
  };
}

function providerPreferenceWarnings(
  mail: PrimaryMailProvider,
  calendar: PrimaryCalendarProvider,
  availability: ProviderPreferenceAvailability,
): { warningCodes: string[]; warnings: string[] } {
  const warningCodes: string[] = [];
  const warnings: string[] = [];
  if (mail === 'gmail' && !availability.mail.gmail) {
    warningCodes.push('GMAIL_PREFERENCE_UNAVAILABLE');
    warnings.push('Gmail is selected for email, but Google is not connected.');
  }
  if (mail === 'outlook' && !availability.mail.outlook) {
    warningCodes.push('OUTLOOK_MAIL_PREFERENCE_UNAVAILABLE');
    warnings.push('Outlook is selected for email, but Outlook is not connected.');
  }
  if (calendar === 'google' && !availability.calendar.google) {
    warningCodes.push('GOOGLE_CALENDAR_PREFERENCE_UNAVAILABLE');
    warnings.push('Google Calendar is selected for calendar writes, but Google Calendar is not connected.');
  }
  if (calendar === 'outlook' && !availability.calendar.outlook) {
    warningCodes.push('OUTLOOK_CALENDAR_PREFERENCE_UNAVAILABLE');
    warnings.push('Outlook Calendar is selected for calendar writes, but Outlook Calendar is not connected.');
  }
  return { warningCodes, warnings };
}

function safeConnected(userId: number, provider: 'google' | 'outlook'): boolean {
  try {
    return isConnected(userId, provider);
  } catch {
    return false;
  }
}

function safeGoogleCalendar(userId: number): boolean {
  try {
    return isGoogleCalendarConfigured(userId);
  } catch {
    return false;
  }
}

function safeOutlookCalendar(userId: number): boolean {
  try {
    return isOutlookCalendarConfigured(userId);
  } catch {
    return false;
  }
}
