// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, {
  Router,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { extractClientIp } from './rate-limiter';
import { sendError } from './response-helpers';

export const PRODUCT_LEARNING_ADMIN_BODY_LIMIT_BYTES = 16 * 1024;
export const PRODUCT_LEARNING_ADMIN_RATE_LIMIT = 30;
export const PRODUCT_LEARNING_ADMIN_GLOBAL_RATE_LIMIT = 300;
export const PRODUCT_LEARNING_ADMIN_RATE_WINDOW_MS = 60 * 1000;
export const ADMIN_PRE_BODY_MAX_TRACKED_IPS = 2_048;
export const ADMIN_PRE_BODY_PRUNE_EVERY_REQUESTS = 64;

export interface AdminPreBodyGuardOptions {
  bodyLimitBytes?: number;
  bucketName?: string;
  globalMessage?: string;
  globalMaxRequests?: number;
  maxTrackedIps?: number;
  maxRequests?: number;
  message?: string;
  now?: () => number;
  pruneEveryRequests?: number;
  windowMs?: number;
}

/**
 * Builds a route-local guard that runs before JSON parsing and authentication.
 * Each mounted guard owns an isolated, bounded-per-IP request bucket so an
 * invalid-credential flood cannot produce an unbounded audit burst per window.
 */
export function createAdminPreBodyGuard(
  options: AdminPreBodyGuardOptions = {},
): Router {
  const bodyLimitBytes = positiveInteger(
    options.bodyLimitBytes,
    PRODUCT_LEARNING_ADMIN_BODY_LIMIT_BYTES,
  );
  const maxRequests = positiveInteger(options.maxRequests, PRODUCT_LEARNING_ADMIN_RATE_LIMIT);
  const globalMaxRequests = positiveInteger(
    options.globalMaxRequests,
    PRODUCT_LEARNING_ADMIN_GLOBAL_RATE_LIMIT,
  );
  const maxTrackedIps = positiveInteger(options.maxTrackedIps, ADMIN_PRE_BODY_MAX_TRACKED_IPS);
  const pruneEveryRequests = positiveInteger(
    options.pruneEveryRequests,
    ADMIN_PRE_BODY_PRUNE_EVERY_REQUESTS,
  );
  const windowMs = positiveInteger(options.windowMs, PRODUCT_LEARNING_ADMIN_RATE_WINDOW_MS);
  const bucketName = options.bucketName ?? 'admin-pre-body-ip';
  const message = options.message ?? 'Too many admin requests from this IP. Slow down.';
  const globalMessage = options.globalMessage
    ?? 'Too many product-learning admin requests. Slow down.';
  const now = options.now ?? Date.now;
  const requestLog = new Map<string, number[]>();
  let globalRequestLog: number[] = [];
  let overflowRequestLog: number[] = [];
  let requestsUntilPrune = pruneEveryRequests;
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const currentTime = now();
    globalRequestLog = recentTimestamps(globalRequestLog, currentTime, windowMs);
    const globalResetAt = globalRequestLog[0] == null
      ? currentTime + windowMs
      : globalRequestLog[0] + windowMs;
    if (globalRequestLog.length >= globalMaxRequests) {
      // Global rejects never enter the per-IP maps or downstream auth/audit.
      // Do not append them, keeping work and state bounded during a distributed
      // invalid-credential flood.
      res.setHeader('X-RateLimit-Limit', globalMaxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(globalResetAt / 1000));
      res.setHeader('X-RateLimit-Bucket', `${bucketName}-global`);
      const retryAfterSeconds = Math.max(1, Math.ceil((globalResetAt - currentTime) / 1000));
      sendError(res, 'RATE_LIMITED', globalMessage, 429, { retryAfterSeconds });
      return;
    }
    globalRequestLog.push(currentTime);

    const clientIp = extractClientIp(req);
    requestsUntilPrune -= 1;
    if (requestsUntilPrune <= 0) {
      pruneStaleRequestBuckets(requestLog, currentTime, windowMs);
      overflowRequestLog = recentTimestamps(overflowRequestLog, currentTime, windowMs);
      requestsUntilPrune = pruneEveryRequests;
    }

    // Never scan the entire tracked-IP map for each unknown overflow client.
    // The fixed periodic prune above reclaims stale slots; until then, new
    // clients share the bounded overflow bucket.
    const useOverflowBucket = !requestLog.has(clientIp) && requestLog.size >= maxTrackedIps;
    const inWindow = recentTimestamps(
      useOverflowBucket ? overflowRequestLog : requestLog.get(clientIp) ?? [],
      currentTime,
      windowMs,
    );
    const resetAt = inWindow[0] == null
      ? currentTime + windowMs
      : inWindow[0] + windowMs;
    const responseBucketName = useOverflowBucket ? `${bucketName}-overflow` : bucketName;

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - inWindow.length));
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000));
    res.setHeader('X-RateLimit-Bucket', responseBucketName);

    if (inWindow.length >= maxRequests) {
      // Do not append rejected attempts. The limiter state and the downstream
      // portal.auth audit rows therefore both stay bounded per IP/window.
      if (useOverflowBucket) {
        overflowRequestLog = inWindow;
      } else {
        requestLog.set(clientIp, inWindow);
      }
      const retryAfterSeconds = Math.max(1, Math.ceil((resetAt - currentTime) / 1000));
      sendError(res, 'RATE_LIMITED', message, 429, { retryAfterSeconds });
      return;
    }

    inWindow.push(currentTime);
    if (useOverflowBucket) {
      overflowRequestLog = inWindow;
    } else {
      requestLog.set(clientIp, inWindow);
    }
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - inWindow.length));
    next();
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    const rawLength = req.headers['content-length'];
    const firstLength = Array.isArray(rawLength) ? rawLength[0] : rawLength;
    const contentLength = Number(firstLength ?? 0);
    if (Number.isFinite(contentLength) && contentLength > bodyLimitBytes) {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
      return;
    }
    next();
  });

  router.use(express.json({ limit: bodyLimitBytes }));

  const bodyErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if ((error as { type?: string } | undefined)?.type === 'entity.too.large') {
      sendError(res, 'PAYLOAD_TOO_LARGE', 'Request body is too large', 413);
      return;
    }
    next(error);
  };
  router.use(bodyErrorHandler);

  return router;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function recentTimestamps(timestamps: readonly number[], now: number, windowMs: number): number[] {
  return timestamps.filter((timestamp) => now - timestamp < windowMs);
}

function pruneStaleRequestBuckets(
  requestLog: Map<string, number[]>,
  now: number,
  windowMs: number,
): void {
  for (const [clientIp, timestamps] of requestLog) {
    const inWindow = recentTimestamps(timestamps, now, windowMs);
    if (inWindow.length === 0) {
      requestLog.delete(clientIp);
    } else if (inWindow.length !== timestamps.length) {
      requestLog.set(clientIp, inWindow);
    }
  }
}
