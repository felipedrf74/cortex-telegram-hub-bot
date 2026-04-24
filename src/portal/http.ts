// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { logger } from '../utils/logger';

export function sendPortalInternalError(
  res: Response,
  err: unknown,
  safeMessage: string,
  context: string,
): void {
  logger.error({ err }, context);
  res.status(500).json({
    ok: false,
    message: safeMessage,
    error: {
      code: 'INTERNAL',
      message: safeMessage,
    },
    timestamp: new Date().toISOString(),
  });
}
