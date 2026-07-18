// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';

/** Build bounded cache telemetry without placing raw user topics in logs. */
export function buildContentEngineCacheLogContext(
  topic: string,
  mode: string,
  cacheHit: boolean,
  cacheTtl?: number,
): {
  topicLength: number;
  topicHash: string;
  mode: string;
  cacheHit: boolean;
  cacheTtl?: number;
} {
  return {
    topicLength: topic.length,
    topicHash: createHash('sha256').update(topic).digest('hex').slice(0, 16),
    mode,
    cacheHit,
    ...(cacheTtl === undefined ? {} : { cacheTtl }),
  };
}
