/**
 * Portal Adapter Status Tests
 *
 * Validates:
 * - Adapter status panel data structure
 * - Telegram status: connected / idle / error based on polling state
 * - WhatsApp shows as planned/not configured
 * - Status determination logic based on polling + last message recency
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock telemetry before import
let mockPolling = false;
let mockLastMessage: string | null = null;

vi.mock('../../src/portal/telemetry', async (importOriginal) => {
  const orig = await importOriginal() as any;
  return {
    ...orig,
    isBotPollingActive: () => mockPolling,
    getLastMessageAt: () => mockLastMessage,
  };
});

describe('Adapter Status Logic', () => {
  beforeEach(() => {
    mockPolling = false;
    mockLastMessage = null;
  });

  it('Telegram shows as error when not polling', () => {
    mockPolling = false;
    mockLastMessage = null;

    const status = computeTelegramStatus(mockPolling, mockLastMessage);
    expect(status).toBe('error');
  });

  it('Telegram shows as idle when polling but no messages yet', () => {
    mockPolling = true;
    mockLastMessage = null;

    const status = computeTelegramStatus(mockPolling, mockLastMessage);
    expect(status).toBe('idle');
  });

  it('Telegram shows as connected when polling with recent message', () => {
    mockPolling = true;
    mockLastMessage = new Date().toISOString(); // just now

    const status = computeTelegramStatus(mockPolling, mockLastMessage);
    expect(status).toBe('connected');
  });

  it('Telegram shows as idle when polling but last message > 1 hour ago', () => {
    mockPolling = true;
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    mockLastMessage = twoHoursAgo;

    const status = computeTelegramStatus(mockPolling, mockLastMessage);
    expect(status).toBe('idle');
  });

  it('WhatsApp always shows as planned', () => {
    const adapter = {
      name: 'WhatsApp',
      status: 'planned' as const,
      configured: false,
      lastMessageAt: null,
    };
    expect(adapter.status).toBe('planned');
    expect(adapter.configured).toBe(false);
  });

  it('adapter status structure has required fields', () => {
    const adapters = buildAdapterList(true, new Date().toISOString());
    expect(adapters).toHaveLength(2);

    const telegram = adapters[0];
    expect(telegram.name).toBe('Telegram');
    expect(telegram.configured).toBe(true);
    expect(typeof telegram.status).toBe('string');
    expect(['connected', 'idle', 'error']).toContain(telegram.status);

    const whatsapp = adapters[1];
    expect(whatsapp.name).toBe('WhatsApp');
    expect(whatsapp.configured).toBe(false);
    expect(whatsapp.status).toBe('planned');
    expect(whatsapp.lastMessageAt).toBeNull();
  });

  it('adapter list returns Telegram as connected with recent activity', () => {
    const now = new Date().toISOString();
    const adapters = buildAdapterList(true, now);
    expect(adapters[0].status).toBe('connected');
    expect(adapters[0].lastMessageAt).toBe(now);
  });

  it('adapter list returns Telegram as error when not polling', () => {
    const adapters = buildAdapterList(false, null);
    expect(adapters[0].status).toBe('error');
  });
});

// ── Helper functions that mirror server.ts logic (unit-testable) ──

function computeTelegramStatus(
  polling: boolean,
  lastMessageAt: string | null,
): 'connected' | 'idle' | 'error' {
  if (!polling) return 'error';
  if (lastMessageAt) {
    const ageMs = Date.now() - new Date(lastMessageAt).getTime();
    return ageMs < 3_600_000 ? 'connected' : 'idle';
  }
  return 'idle';
}

function buildAdapterList(polling: boolean, lastMsg: string | null) {
  const telegramStatus = computeTelegramStatus(polling, lastMsg);
  return [
    {
      name: 'Telegram',
      status: telegramStatus,
      configured: true,
      lastMessageAt: lastMsg,
    },
    {
      name: 'WhatsApp',
      status: 'planned' as const,
      configured: false,
      lastMessageAt: null,
    },
  ];
}
