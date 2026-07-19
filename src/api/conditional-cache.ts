// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type { Request, Response } from 'express';
import { apiSuccess } from './response-helpers';
import { setServerTimingHeader, type RouteTiming } from './route-timing';

export interface ConditionalSuccessOptions {
  cached?: boolean;
  maxAgeSeconds?: number;
  timings?: RouteTiming[];
  /**
   * Optional stable value the ETag is derived from, INSTEAD of hashing the
   * full response body. Use this when the body embeds a per-call volatile
   * field (e.g. a `generatedAt` timestamp) that would otherwise change the
   * body hash on every request and make the 304 revalidation useless. The
   * seed must change iff the client-visible data changes. When omitted, the
   * ETag is a hash of the serialized body (the original behavior).
   */
  etagSeed?: unknown;
}

export function stableDataEtag(data: unknown): string {
  return `"${crypto.createHash('md5').update(JSON.stringify(data)).digest('hex')}"`;
}

export function requestMatchesEtag(req: Request, etag: string): boolean {
  const raw = req.headers['if-none-match'];
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  if (typeof value !== 'string' || value.trim().length === 0) return false;

  const candidates = value.split(',').map((entry) => entry.trim());
  return candidates.some((candidate) => candidate === etag || candidate === `W/${etag}`);
}

export function sendConditionalApiSuccess<T>(
  res: Response,
  req: Request,
  data: T,
  options: ConditionalSuccessOptions = {},
): void {
  const etag = 'etagSeed' in options ? stableDataEtag(options.etagSeed) : stableDataEtag(data);
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, max-age=${options.maxAgeSeconds ?? 30}`);
  setServerTimingHeader(res, options.timings ?? []);

  if (requestMatchesEtag(req, etag)) {
    res.status(304).end();
    return;
  }

  res.json(apiSuccess(data, { cached: options.cached ?? false }));
}
