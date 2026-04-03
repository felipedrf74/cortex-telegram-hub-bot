// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Shared bot state — per-user Maps and types used across multiple handlers.
 *
 * Extracted from bot.ts to allow handler modules to access shared state
 * without circular dependencies.
 */

import { config } from '../config';
import { DomainName } from '../domains/types';
import * as onboarding from '../services/onboarding';

// ─── Rate Limiting ──────────────────────────────────────────────────

export const rateLimitMap = new Map<number, number[]>();

export function isRateLimited(userId: number): boolean {
  const ts = Date.now();
  const window = 60_000;
  const max = config.rateLimit.maxMessagesPerMinute;

  let timestamps = rateLimitMap.get(userId) || [];
  timestamps = timestamps.filter((t) => ts - t < window);

  if (timestamps.length >= max) {
    rateLimitMap.set(userId, timestamps);
    return true;
  }

  timestamps.push(ts);
  rateLimitMap.set(userId, timestamps);
  return false;
}

// ─── Pending Edit State (per user) ──────────────────────────────────

export interface PendingEdit {
  listId: string;
  taskId: string;
  title: string;
  listName: string;
  field: string;
  expires: number;
}

export const pendingEdits = new Map<number, PendingEdit>();

// ─── Pending Onboarding Text Input (per user) ──────────────────────

export interface PendingOnboarding {
  questionnaire: string;
  step: onboarding.QuestionStep;
  expires: number;
}

export const pendingOnboarding = new Map<number, PendingOnboarding>();

// ─── Last Active Domain (per user) ──────────────────────────────────

export interface LastDomainState {
  domain: DomainName;
  timestamp: number;
}

export const lastActiveDomain = new Map<number, LastDomainState>();

/** Tracks the last pending calendar callback ref per user */
export const pendingCalendarRef = new Map<number, { ref: string; timestamp: number }>();

/** Conversation continuity window */
export const CONTINUITY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ─── Sequential Processing Queue ────────────────────────────────────

export const processingQueue = new Map<number, Promise<void>>();

export function enqueue(userId: number, fn: () => Promise<void>): void {
  const current = processingQueue.get(userId) ?? Promise.resolve();
  const next = current.then(fn, fn); // chain regardless of success/failure
  processingQueue.set(userId, next);
  next.finally(() => {
    if (processingQueue.get(userId) === next) {
      processingQueue.delete(userId);
    }
  });
}

// ─── Periodic Memory Cleanup ────────────────────────────────────────

setInterval(() => {
  const now = Date.now();

  for (const [userId, timestamps] of rateLimitMap) {
    const fresh = timestamps.filter((t) => now - t < 60_000);
    if (fresh.length === 0) rateLimitMap.delete(userId);
    else rateLimitMap.set(userId, fresh);
  }

  for (const [userId, state] of lastActiveDomain) {
    if (now - state.timestamp > CONTINUITY_WINDOW_MS) lastActiveDomain.delete(userId);
  }

  for (const [userId, edit] of pendingEdits) {
    if (now > edit.expires) pendingEdits.delete(userId);
  }
}, 10 * 60 * 1000);

// ─── Exported Utilities ─────────────────────────────────────────────

/** Set last active domain for a user (used by scheduler for cron-triggered messages) */
export function setLastActiveDomain(userId: number, domain: DomainName): void {
  lastActiveDomain.set(userId, { domain, timestamp: Date.now() });
}

/** HTML parse error detection */
export function isHtmlParseError(err: unknown): boolean {
  const msg = (err as any)?.description || (err as any)?.message || '';
  return msg.includes("can't parse entities") || msg.includes('Bad Request');
}
