// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { requirePortalAdminToken, getPortalAuthContext } from '../api/secret-guards';
import {
  applyMealPlanSubstitution,
  deletePantryItem,
  getPantryItems,
  upsertPantryItem,
  type CookingSubstitutionReason,
  type PantryItem,
} from '../services/cooking-chef';
import {
  buildCookingPreferenceReadModel,
  isCookingPreferenceKind,
  setCookingPreferenceMemory,
} from '../services/cooking-preferences';
import { invalidateCookingDerivedCaches } from '../services/cooking-cache-invalidator';
import { logAudit } from '../services/audit-trail';
import type { SkillMemoryRecord } from '../services/skill-memory';
import { requireOperatorTargetUser } from './admin-target-user';
import { buildPortalAdminAuditDetails, logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? '100'), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return 100;
  return Math.min(parsed, 250);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function isCookingSubstitutionReason(value: unknown): value is CookingSubstitutionReason {
  return value === 'allergy'
    || value === 'dietary_restriction'
    || value === 'disliked_ingredient'
    || value === 'expired_pantry';
}

function resolveTenantId(req: Request, userId: number): number | null {
  const rawTenant = req.body?.tenantId ?? req.query.tenantId;
  const tenantId = rawTenant === undefined || rawTenant === null || rawTenant === ''
    ? userId
    : parsePositiveInteger(rawTenant);
  if (!tenantId) return null;
  // Current portal operator scoping is user-based. Until tenant membership
  // scoping is explicit in the portal, fail closed for cross-tenant reads/writes.
  return tenantId === userId ? tenantId : null;
}

function sendBadRequest(res: Response, code: string, message: string): void {
  res.status(400).json({ ok: false, error: { code, message } });
}

function sendForbiddenTenant(res: Response): void {
  res.status(403).json({
    ok: false,
    error: {
      code: 'FORBIDDEN_TENANT_SCOPE',
      message: 'operator is not scoped to this Cooking tenant',
    },
  });
}

function auditPortalCookingRead(req: Request, userId: number, tenantId: number, resource: string, details?: Record<string, unknown>): void {
  const auth = getPortalAuthContext(req);
  logAudit({
    userId,
    tenantId,
    actorId: 0,
    action: 'access',
    resource,
    details: {
      ...buildPortalAdminAuditDetails(req),
      matchedCredential: auth?.matchedCredential ?? 'unknown',
      privacyMode: 'metadata_and_scoped_cooking_state',
      ...(details ?? {}),
    },
    ipAddress: req.ip || req.socket?.remoteAddress || undefined,
  });
}

function sanitizePreferenceMemory(memory: SkillMemoryRecord): Record<string, unknown> {
  return {
    memoryId: memory.memoryId,
    tenantId: memory.tenantId,
    userId: memory.userId,
    skillId: memory.skillId,
    memoryType: memory.memoryType,
    scope: memory.scope,
    memoryKey: memory.memoryKey,
    source: memory.source,
    confidence: memory.confidence,
    freshnessStatus: memory.freshnessStatus,
    status: memory.status,
    schemaVersion: memory.schemaVersion,
    relatedSkillVersion: memory.relatedSkillVersion,
    updatedAt: memory.updatedAt,
  };
}

function sanitizePantryItem(item: PantryItem): PantryItem {
  return item;
}

export function registerPortalCookingRoutes(app: Express): void {
  app.get(
    '/api/users/:userId/cooking/preferences',
    requirePortalAdminToken,
    requireOperatorTargetUser('userId'),
    (req: Request, res: Response) => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }

        const readModel = buildCookingPreferenceReadModel(userId, tenantId);
        auditPortalCookingRead(req, userId, tenantId, 'portal.cooking.preferences.read', {
          memoryCount: readModel.memories.length,
        });
        res.json({
          ok: true,
          tenantId,
          preferences: {
            profile: readModel.profile,
            summary: readModel.summary,
            skillMemorySummary: readModel.skillMemorySummary,
            memories: readModel.memories.map(sanitizePreferenceMemory),
          },
        });
      } catch (err) {
        sendPortalInternalError(res, err, 'Portal request failed', 'Portal: cooking preferences read failed');
      }
    },
  );

  app.post(
    '/api/users/:userId/cooking/preferences',
    requirePortalAdminToken,
    requireOperatorTargetUser('userId'),
    (req: Request, res: Response) => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }
        if (!isCookingPreferenceKind(req.body?.kind)) {
          sendBadRequest(res, 'INVALID_COOKING_PREFERENCE', 'valid Cooking preference kind required');
          return;
        }
        const value = req.body?.value;
        if (!['string', 'number', 'boolean'].includes(typeof value)) {
          sendBadRequest(res, 'INVALID_COOKING_PREFERENCE_VALUE', 'value must be string, number, or boolean');
          return;
        }

        const memory = setCookingPreferenceMemory(userId, {
          kind: req.body.kind,
          value,
          source: normalizeOptionalString(req.body?.source) ?? 'portal',
          correction: req.body?.correction === true,
          confidence: typeof req.body?.confidence === 'number' ? req.body.confidence : undefined,
          expiresAt: normalizeOptionalString(req.body?.expiresAt),
        }, tenantId);
        invalidateCookingDerivedCaches(userId);
        logPortalAdminMutation(req, userId, 'portal.cooking.preferences.write', {
          tenantId,
          kind: req.body.kind,
          correction: req.body?.correction === true,
          memoryId: memory.memoryId,
        });
        res.status(201).json({
          ok: true,
          tenantId,
          memory: sanitizePreferenceMemory(memory),
          preferences: buildCookingPreferenceReadModel(userId, tenantId).summary,
        });
      } catch (err) {
        sendPortalInternalError(res, err, 'Failed to write Cooking preference', 'Portal: cooking preference write failed');
      }
    },
  );

  app.get(
    '/api/users/:userId/cooking/pantry',
    requirePortalAdminToken,
    requireOperatorTargetUser('userId'),
    (req: Request, res: Response) => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }

        const items = getPantryItems(userId, {
          tenantId,
          search: normalizeOptionalString(req.query.search),
          category: normalizeOptionalString(req.query.category),
          includeExpired: req.query.includeExpired === 'true',
          limit: parseLimit(req.query.limit),
        }).map(sanitizePantryItem);
        auditPortalCookingRead(req, userId, tenantId, 'portal.cooking.pantry.read', {
          itemCount: items.length,
          includeExpired: req.query.includeExpired === 'true',
        });
        res.json({ ok: true, tenantId, items, count: items.length });
      } catch (err) {
        sendPortalInternalError(res, err, 'Portal request failed', 'Portal: cooking pantry read failed');
      }
    },
  );

  app.post(
    '/api/users/:userId/cooking/pantry',
    requirePortalAdminToken,
    requireOperatorTargetUser('userId'),
    (req: Request, res: Response) => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }
        const name = normalizeOptionalString(req.body?.name);
        if (!name) {
          sendBadRequest(res, 'INVALID_PANTRY_ITEM', 'name is required');
          return;
        }

        const item = upsertPantryItem(userId, {
          name,
          quantity: normalizeOptionalString(req.body?.quantity) ?? null,
          unit: normalizeOptionalString(req.body?.unit) ?? null,
          category: normalizeOptionalString(req.body?.category) ?? null,
          expiresAt: normalizeOptionalString(req.body?.expiresAt) ?? null,
          freshnessStatus: normalizeOptionalString(req.body?.freshnessStatus) ?? null,
          availabilityStatus: normalizeOptionalString(req.body?.availabilityStatus) ?? null,
          source: 'portal',
          confidence: typeof req.body?.confidence === 'number' ? req.body.confidence : undefined,
          notes: normalizeOptionalString(req.body?.notes) ?? null,
        }, tenantId);
        invalidateCookingDerivedCaches(userId);
        logPortalAdminMutation(req, userId, 'portal.cooking.pantry.upsert', {
          tenantId,
          pantryItemId: item.id,
          freshnessStatus: item.freshness_status,
          availabilityStatus: item.availability_status,
        });
        res.status(201).json({ ok: true, tenantId, item: sanitizePantryItem(item) });
      } catch (err) {
        sendPortalInternalError(res, err, 'Failed to write Cooking pantry item', 'Portal: cooking pantry write failed');
      }
    },
  );

  app.delete(
    '/api/users/:userId/cooking/pantry/:itemId',
    requirePortalAdminToken,
    requireOperatorTargetUser('userId'),
    (req: Request, res: Response) => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        const itemId = parsePositiveInteger(req.params.itemId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        if (!itemId) {
          sendBadRequest(res, 'INVALID_PANTRY_ITEM', 'invalid itemId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }

        const deleted = deletePantryItem(userId, itemId, tenantId);
        if (!deleted) {
          res.status(404).json({ ok: false, error: { code: 'PANTRY_ITEM_NOT_FOUND', message: 'pantry item not found' } });
          return;
        }
        invalidateCookingDerivedCaches(userId);
        logPortalAdminMutation(req, userId, 'portal.cooking.pantry.delete', {
          tenantId,
          pantryItemId: itemId,
        });
        res.json({ ok: true, tenantId, deleted: true, itemId });
      } catch (err) {
        sendPortalInternalError(res, err, 'Failed to delete Cooking pantry item', 'Portal: cooking pantry delete failed');
      }
    },
  );

  app.post(
    '/api/users/:userId/cooking/meal-plan/substitutions/apply',
    requirePortalAdminToken,
    requireOperatorTargetUser('userId'),
    (req: Request, res: Response) => {
      try {
        const userId = parsePositiveInteger(req.params.userId);
        if (!userId) {
          sendBadRequest(res, 'INVALID_USER_ID', 'invalid userId');
          return;
        }
        const tenantId = resolveTenantId(req, userId);
        if (!tenantId) {
          sendForbiddenTenant(res);
          return;
        }

        const date = normalizeOptionalString(req.body?.date);
        const mealType = normalizeOptionalString(req.body?.mealType);
        const originalIngredient = normalizeOptionalString(req.body?.originalIngredient);
        const suggestedIngredient = normalizeOptionalString(req.body?.suggestedIngredient);
        const reason = req.body?.reason;
        const updateShoppingList = req.body?.updateShoppingList;
        if (!date || !mealType || !originalIngredient || !suggestedIngredient) {
          sendBadRequest(res, 'INVALID_COOKING_SUBSTITUTION', 'date, mealType, originalIngredient, and suggestedIngredient are required');
          return;
        }
        if (!isCookingSubstitutionReason(reason)) {
          sendBadRequest(res, 'INVALID_COOKING_SUBSTITUTION_REASON', 'valid substitution reason required');
          return;
        }
        if (updateShoppingList !== undefined && typeof updateShoppingList !== 'boolean') {
          sendBadRequest(res, 'INVALID_COOKING_SUBSTITUTION_SHOPPING_LIST', 'updateShoppingList must be a boolean when provided');
          return;
        }

        const result = applyMealPlanSubstitution(userId, {
          date,
          mealType,
          originalIngredient,
          suggestedIngredient,
          reason,
          updateShoppingList,
        }, tenantId);
        if (!result.applied) {
          const status = result.reason === 'meal_not_found' || result.reason === 'recipe_not_found' ? 404 : 400;
          res.status(status).json({
            ok: false,
            error: {
              code: status === 404 ? 'COOKING_SUBSTITUTION_TARGET_NOT_FOUND' : 'COOKING_SUBSTITUTION_NOT_APPLIED',
              message: result.reason ?? 'substitution was not applied',
            },
            result,
          });
          return;
        }

        invalidateCookingDerivedCaches(userId);
        logPortalAdminMutation(req, userId, 'portal.cooking.substitution.apply', {
          tenantId,
          date,
          mealType,
          reason,
          affectedMealId: result.substitution.affectedMealId,
          affectedRecipeId: result.substitution.affectedRecipeId,
          shoppingListUpdated: result.substitution.shoppingListUpdated,
        });
        res.status(201).json({ ok: true, tenantId, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (message.startsWith('COOKING_SUBSTITUTION')) {
          sendBadRequest(res, 'INVALID_COOKING_SUBSTITUTION', message);
          return;
        }
        sendPortalInternalError(res, err, 'Failed to apply Cooking substitution', 'Portal: cooking substitution apply failed');
      }
    },
  );
}
