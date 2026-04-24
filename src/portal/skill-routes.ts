// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import type { DomainName } from '../domains/types';
import { requirePortalAdminToken } from '../api/secret-guards';
import {
  disableSkill,
  disableSubSkill,
  enableSkill,
  enableSubSkill,
  getAllSkillStatuses,
} from '../skills/skill-manager';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache } from './snapshot-cache';

export function registerPortalSkillRoutes(app: Express): void {
  // GET /api/skills — all skill statuses with sub-skill toggles
  app.get('/api/skills', (_req: Request, res: Response) => {
    try {
      res.json(getAllSkillStatuses());
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to get skill statuses', 'Portal: skills status failed');
    }
  });

  // POST /api/skills/toggle — toggle a sub-skill on/off
  app.post('/api/skills/toggle', requirePortalAdminToken, (req: Request, res: Response) => {
    const { domain, subSkill, enabled } = req.body;
    if (!domain || !subSkill || typeof enabled !== 'boolean') {
      res.status(400).json({ ok: false, message: 'Required: domain, subSkill, enabled (boolean)' });
      return;
    }

    try {
      const result = enabled
        ? enableSubSkill(domain as DomainName, subSkill)
        : disableSubSkill(domain as DomainName, subSkill);
      clearPortalSnapshotCache();
      res.json({ ok: result, domain, subSkill, enabled });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: skill toggle failed');
    }
  });

  // POST /api/skills/:name/enable — enable an entire skill
  app.post('/api/skills/:name/enable', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const result = enableSkill(name);
      if (!result) {
        res.status(404).json({ ok: false, message: `Skill "${name}" not found` });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, message: `Skill "${name}" enabled` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // POST /api/skills/:name/disable — disable an entire skill
  app.post('/api/skills/:name/disable', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const result = disableSkill(name);
      if (!result) {
        res.status(404).json({ ok: false, message: `Skill "${name}" not found` });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, message: `Skill "${name}" disabled` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // POST /api/skills/:name/subskills/:sub/enable — enable a sub-skill
  app.post('/api/skills/:name/subskills/:sub/enable', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const sub = String(req.params.sub);
      const result = enableSubSkill(name, sub);
      if (!result) {
        res.status(404).json({ ok: false, message: `Sub-skill "${sub}" not found in "${name}"` });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, message: `Sub-skill "${sub}" enabled` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  // POST /api/skills/:name/subskills/:sub/disable — disable a sub-skill
  app.post('/api/skills/:name/subskills/:sub/disable', requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const name = req.params.name as DomainName;
      const sub = String(req.params.sub);
      const result = disableSubSkill(name, sub);
      if (!result) {
        res.status(404).json({ ok: false, message: `Sub-skill "${sub}" not found in "${name}"` });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, message: `Sub-skill "${sub}" disabled` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}

