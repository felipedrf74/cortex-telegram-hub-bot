// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Express, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp } from '../api/rate-limiter';
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
import { invalidateCookingDerivedCaches } from '../services/cache-coherence-registry';
import { logAudit } from '../services/audit-trail';
import type { SkillMemoryRecord } from '../services/skill-memory';
import { requireOperatorTargetUser } from './admin-target-user';
import { buildPortalAdminAuditDetails, logPortalAdminMutation } from './admin-audit';
import { sendPortalInternalError } from './http';

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') return 100;
  const parsed = parsePositiveInteger(value);
  return parsed === null ? 100 : Math.min(parsed, 250);
}

function hasInvalidOptionalConfidence(value: unknown): boolean {
  return value !== undefined
    && value !== null
    && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function hasInvalidOptionalText(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== 'string';
}

function hasInvalidPantryStatus(value: unknown, allowed: readonly string[]): boolean {
  if (value === undefined || value === null || value === '') return false;
  return typeof value !== 'string' || !allowed.includes(value.trim().toLowerCase());
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
  const configuredLimit = Number.parseInt(process.env.PORTAL_API_RATE_LIMIT ?? '', 10);
  const authorizationRateLimitMiddleware = rateLimit({
    windowMs: 60 * 1000,
    limit: Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 180,
    keyGenerator: (req: Request) => `ip:${ipKeyGenerator(extractClientIp(req))}`,
    legacyHeaders: false,
    standardHeaders: false,
    handler: (_req, res, _next, options) => {
      const retryAfter = Math.max(1, Math.ceil(options.windowMs / 1000));
      res.setHeader('Retry-After', retryAfter);
      res.status(options.statusCode).json({
        error: { code: 'RATE_LIMITED', message: 'Too many portal requests from this IP. Slow down.', retryAfter },
      });
    },
  });
  app.get(
    '/api/users/:userId/cooking/preferences',
    authorizationRateLimitMiddleware,
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
    authorizationRateLimitMiddleware,
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
        if (hasInvalidOptionalConfidence(req.body?.confidence)) {
          sendBadRequest(res, 'INVALID_COOKING_PREFERENCE_CONFIDENCE', 'confidence must be a number between 0 and 1');
          return;
        }

        const memory = setCookingPreferenceMemory(userId, {
          kind: req.body.kind,
          value,
          source: normalizeOptionalString(req.body?.source) ?? 'portal',
          correction: req.body?.correction === true,
          confidence: req.body?.confidence ?? undefined,
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
        const message = err instanceof Error ? err.message : '';
        if (message.startsWith('COOKING_PREFERENCE_INVALID')) {
          sendBadRequest(res, 'INVALID_COOKING_PREFERENCE', message);
          return;
        }
        sendPortalInternalError(res, err, 'Failed to write Cooking preference', 'Portal: cooking preference write failed');
      }
    },
  );

  app.get(
    '/api/users/:userId/cooking/pantry',
    authorizationRateLimitMiddleware,
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
    authorizationRateLimitMiddleware,
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
        const rawName = req.body?.name;
        const name = normalizeOptionalString(rawName);
        if (typeof rawName !== 'string' || !name) {
          sendBadRequest(res, 'INVALID_PANTRY_ITEM', 'name must be a non-empty string');
          return;
        }
        for (const field of ['quantity', 'unit', 'category', 'notes'] as const) {
          if (hasInvalidOptionalText(req.body?.[field])) {
            sendBadRequest(res, 'INVALID_PANTRY_TEXT', `${field} must be a string or null`);
            return;
          }
        }
        const rawExpiresAt = req.body?.expiresAt;
        if (rawExpiresAt !== undefined && rawExpiresAt !== null && typeof rawExpiresAt !== 'string') {
          sendBadRequest(res, 'INVALID_PANTRY_EXPIRY', 'expiresAt must be a valid YYYY-MM-DD date');
          return;
        }
        if (hasInvalidOptionalConfidence(req.body?.confidence)) {
          sendBadRequest(res, 'INVALID_PANTRY_CONFIDENCE', 'confidence must be a number between 0 and 1');
          return;
        }
        if (hasInvalidPantryStatus(req.body?.freshnessStatus, ['fresh', 'unknown', 'use_soon', 'expired'])) {
          sendBadRequest(res, 'INVALID_PANTRY_FRESHNESS', 'freshnessStatus must be fresh, unknown, use_soon, or expired');
          return;
        }
        if (hasInvalidPantryStatus(req.body?.availabilityStatus, ['available', 'low_stock', 'unavailable'])) {
          sendBadRequest(res, 'INVALID_PANTRY_AVAILABILITY', 'availabilityStatus must be available, low_stock, or unavailable');
          return;
        }

        const item = upsertPantryItem(userId, {
          name,
          quantity: normalizeOptionalString(req.body?.quantity) ?? null,
          unit: normalizeOptionalString(req.body?.unit) ?? null,
          category: normalizeOptionalString(req.body?.category) ?? null,
          expiresAt: rawExpiresAt ?? null,
          freshnessStatus: normalizeOptionalString(req.body?.freshnessStatus) ?? null,
          availabilityStatus: normalizeOptionalString(req.body?.availabilityStatus) ?? null,
          source: 'portal',
          confidence: req.body?.confidence ?? undefined,
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
        const message = err instanceof Error ? err.message : '';
        if (message.startsWith('COOKING_PANTRY_INVALID_EXPIRY')) {
          sendBadRequest(res, 'INVALID_PANTRY_EXPIRY', 'expiresAt must be a valid YYYY-MM-DD date');
          return;
        }
        if (message.startsWith('COOKING_PANTRY_INVALID_FRESHNESS')) {
          sendBadRequest(res, 'INVALID_PANTRY_FRESHNESS', 'freshnessStatus must be fresh, unknown, use_soon, or expired');
          return;
        }
        if (message.startsWith('COOKING_PANTRY_INVALID_AVAILABILITY')) {
          sendBadRequest(res, 'INVALID_PANTRY_AVAILABILITY', 'availabilityStatus must be available, low_stock, or unavailable');
          return;
        }
        if (message.startsWith('COOKING_PANTRY_INVALID_NAME')) {
          sendBadRequest(res, 'INVALID_PANTRY_ITEM', 'name must be a non-empty string');
          return;
        }
        if (message.startsWith('COOKING_PANTRY_INVALID_TEXT')) {
          sendBadRequest(res, 'INVALID_PANTRY_TEXT', message.split(':').slice(1).join(':').trim() || 'pantry text fields must be strings or null');
          return;
        }
        if (message.startsWith('COOKING_PANTRY_INVALID_CONFIDENCE')) {
          sendBadRequest(res, 'INVALID_PANTRY_CONFIDENCE', 'confidence must be a number between 0 and 1');
          return;
        }
        sendPortalInternalError(res, err, 'Failed to write Cooking pantry item', 'Portal: cooking pantry write failed');
      }
    },
  );

  app.delete(
    '/api/users/:userId/cooking/pantry/:itemId',
    authorizationRateLimitMiddleware,
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
    authorizationRateLimitMiddleware,
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
        if (message.startsWith('COOKING_SAFETY_BLOCKED')) {
          sendBadRequest(res, 'COOKING_SAFETY_BLOCKED', 'Cooking item conflicts with a saved cooking safety preference');
          return;
        }
        if (message.startsWith('COOKING_SUBSTITUTION')) {
          sendBadRequest(res, 'INVALID_COOKING_SUBSTITUTION', message);
          return;
        }
        sendPortalInternalError(res, err, 'Failed to apply Cooking substitution', 'Portal: cooking substitution apply failed');
      }
    },
  );
}
