// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  userId: number;
  deviceId: string;
}

/**
 * JWT authentication middleware for iOS API routes.
 * Validates the Bearer token and attaches userId/deviceId to the request.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.ios.jwtSecret) as {
      userId: number;
      deviceId: string;
    };
    (req as AuthenticatedRequest).userId = payload.userId;
    (req as AuthenticatedRequest).deviceId = payload.deviceId;
    next();
  } catch (err) {
    logger.debug({ err }, 'iOS JWT verification failed');
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }
}
