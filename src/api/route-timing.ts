// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { performance } from 'perf_hooks';

export interface RouteTiming {
  name: string;
  durationMs: number;
}

export async function timedAsync<T>(
  timings: RouteTiming[],
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    timings.push({
      name,
      durationMs: performance.now() - startedAt,
    });
  }
}

export function timedSync<T>(
  timings: RouteTiming[],
  name: string,
  fn: () => T,
): T {
  const startedAt = performance.now();
  try {
    return fn();
  } finally {
    timings.push({
      name,
      durationMs: performance.now() - startedAt,
    });
  }
}

export function setServerTimingHeader(res: Response, timings: RouteTiming[]): void {
  if (timings.length === 0 || res.headersSent) return;
  res.setHeader('Server-Timing', formatServerTiming(timings));
}

export function formatServerTiming(timings: RouteTiming[]): string {
  return timings
    .map((timing) => `${sanitizeTimingName(timing.name)};dur=${Math.max(0, timing.durationMs).toFixed(1)}`)
    .join(', ');
}

function sanitizeTimingName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'step';
}
