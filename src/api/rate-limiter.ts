// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import type { AuthenticatedRequest } from './auth-middleware';

/**
 * Simple in-memory rate limiter per user.
 * Tracks requests in a sliding window and returns X-RateLimit-Remaining header.
 */
const requestLog = new Map<number, number[]>();

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = config.ios?.rateLimit || 60;

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const userId = (req as AuthenticatedRequest).userId;
  if (!userId) {
    next();
    return;
  }

  const now = Date.now();
  const userRequests = requestLog.get(userId) || [];

  // Remove entries outside the window
  const inWindow = userRequests.filter(ts => now - ts < WINDOW_MS);
  inWindow.push(now);
  requestLog.set(userId, inWindow);

  const remaining = Math.max(0, MAX_REQUESTS - inWindow.length);

  // Set rate limit headers on ALL responses
  res.setHeader('X-RateLimit-Limit', MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil((now + WINDOW_MS) / 1000));

  if (inWindow.length > MAX_REQUESTS) {
    const retryAfter = Math.ceil(WINDOW_MS / 1000);
    res.setHeader('Retry-After', retryAfter);
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Slow down.',
        retryAfter,
      },
    });
    return;
  }

  next();
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamps] of requestLog) {
    const inWindow = timestamps.filter(ts => now - ts < WINDOW_MS);
    if (inWindow.length === 0) {
      requestLog.delete(userId);
    } else {
      requestLog.set(userId, inWindow);
    }
  }
}, 5 * 60 * 1000);
