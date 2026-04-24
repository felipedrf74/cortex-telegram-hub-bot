// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { getDb } from '../services/database';
import { logger } from '../utils/logger';
import {
  getCachedPortalSnapshot,
  setCachedPortalSnapshot,
} from './snapshot-cache';
import { buildPortalUsageSummary } from './usage-summary';

export interface PortalSnapshotRouteOptions<TSnapshot> {
  buildSnapshot: () => TSnapshot;
}

export function registerPortalSnapshotRoutes<TSnapshot>(
  app: Express,
  options: PortalSnapshotRouteOptions<TSnapshot>,
): void {
  app.get('/api/snapshot', (_req: Request, res: Response) => {
    try {
      const now = Date.now();
      const cached = getCachedPortalSnapshot<TSnapshot>(now);
      if (cached) {
        res.json(cached);
        return;
      }
      const data = options.buildSnapshot();
      setCachedPortalSnapshot(data, now);
      res.json(data);
    } catch (err) {
      logger.error({ err }, 'Portal: snapshot failed');
      res.status(500).json({ error: 'Failed to build snapshot' });
    }
  });

  app.get('/api/usage/summary', (_req: Request, res: Response) => {
    try {
      const db = getDb();
      res.json(buildPortalUsageSummary(db));
    } catch (err) {
      logger.error({ err }, 'Portal: usage/summary failed');
      res.status(500).json({ ok: false, error: 'Failed to build usage summary' });
    }
  });
}
