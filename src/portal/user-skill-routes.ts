// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import express, { Request, Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import {
  getSkillCatalog,
  getUserSkillState,
  resetUserSkillOverrides,
  setSkillAccess,
} from '../services/user-skill-access';
import { logPortalAdminMutation } from './admin-audit';
import { requireOperatorTargetUser } from './admin-target-user';
import { sendPortalInternalError } from './http';

function parsePositiveUserId(value: unknown): number | null {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function validateSkillTarget(skill: unknown, subSkill: unknown): { skill: string; subSkill?: string } | null {
  const skillName = normalizeOptionalString(skill);
  if (!skillName) return null;

  const definition = getSkillCatalog().find(item => item.skill === skillName);
  if (!definition) return null;

  const subSkillName = normalizeOptionalString(subSkill);
  if (!subSkillName) return { skill: skillName };

  const hasSubSkill = definition.subSkills.some(item => item.id === subSkillName);
  if (!hasSubSkill) return null;

  return { skill: skillName, subSkill: subSkillName };
}

export function registerPortalUserSkillRoutes(app: express.Express): void {
  // Skills routes accept canonical users.id (v4.14+).
  app.get('/api/users/:userId/skills', (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      res.json({ skills: getUserSkillState(userId) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.put('/api/users/:userId/skills', requirePortalAdminToken, requireOperatorTargetUser('userId'), express.json(), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ ok: false, message: 'enabled must be boolean' });
        return;
      }

      const target = validateSkillTarget(req.body?.skill, req.body?.subSkill);
      if (!target) {
        res.status(400).json({ ok: false, message: 'valid skill/subSkill required' });
        return;
      }

      const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
      setSkillAccess(userId, target.skill, enabled, { subSkill: target.subSkill, reason });
      logPortalAdminMutation(req, userId, 'user.skills.update', {
        skill: target.skill,
        subSkill: target.subSkill,
        enabled,
        reason,
      });
      res.json({ ok: true, skills: getUserSkillState(userId) });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to update user skill access', 'Portal: user skill update failed');
    }
  });

  app.post('/api/users/:userId/skills/reset', requirePortalAdminToken, requireOperatorTargetUser('userId'), (req: Request, res: Response) => {
    try {
      const userId = parsePositiveUserId(req.params.userId);
      if (!userId) {
        res.status(400).json({ ok: false, message: 'invalid userId' });
        return;
      }

      resetUserSkillOverrides(userId);
      logPortalAdminMutation(req, userId, 'user.skills.reset');
      res.json({ ok: true });
    } catch (err) {
      sendPortalInternalError(res, err, 'Failed to reset user skill overrides', 'Portal: user skill reset failed');
    }
  });
}
