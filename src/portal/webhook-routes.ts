// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { extractClientIp, rateLimitMiddleware } from '../api/rate-limiter';
import { requirePortalAdminToken } from '../api/secret-guards';
import { config as defaultConfig } from '../config';
import { logger as defaultLogger } from '../utils/logger';
import { pushEvent as defaultPushEvent } from './telemetry';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache as defaultClearPortalSnapshotCache } from './snapshot-cache';
import {
  authorizePortalOperatorTargetUser,
  portalOperatorUserScopesConfigured,
} from './admin-target-user';
import { extractEventType, extractIdempotencyKey, flattenHeaders } from './webhooks';
import {
  isValidWebhookEventTypes,
  isWebhookProvider,
  type WebhookProvider,
} from '../services/webhook-registry';

type HeaderRecord = Record<string, string | string[] | undefined>;

interface PortalWebhookConfig {
  whatsapp?: {
    enabled?: boolean;
    verifyToken?: string;
    appSecret?: string;
  };
  webhooks: {
    enabled?: boolean;
    maxPayloadBytes: number;
  };
}

interface PortalWebhookLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface WebhookSubscription {
  id?: number;
  user_id?: number;
  secret?: string | null;
  external_id?: string | null;
  event_types?: string[];
  [key: string]: unknown;
}

interface PortalWebhookRegistry {
  verifySignature: (
    provider: WebhookProvider,
    body: Buffer,
    headers: HeaderRecord,
    secret: string,
  ) => boolean;
  receiveWebhookEvent: (event: {
    user_id: number;
    provider: WebhookProvider;
    event_type: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    idempotency_key?: string;
    subscription_id?: number;
  }) => Promise<number>;
  getSubscriptions: (filter?: Record<string, unknown>) => WebhookSubscription[];
  getSubscription: (id: number) => WebhookSubscription | null;
  registerSubscription: (subscription: Record<string, unknown>) => number;
  removeSubscription: (id: number, expectedUserId?: number) => boolean;
  getWebhookStats: (userId?: number) => Record<string, unknown>;
  getRecentEvents: (filter?: Record<string, unknown>) => unknown[];
  getEvent: (id: number) => { user_id?: number; [key: string]: unknown } | null;
  replayEvent: (id: number, expectedUserId?: number) => Promise<boolean>;
}

interface PortalWebhookRouteDeps {
  config?: PortalWebhookConfig;
  logger?: PortalWebhookLogger;
  pushEvent?: typeof defaultPushEvent;
  clearPortalSnapshotCache?: () => void;
  registry?: PortalWebhookRegistry;
  authorizeTargetUser?: typeof authorizePortalOperatorTargetUser;
  operatorScopesConfigured?: typeof portalOperatorUserScopesConfigured;
}

function getWebhookRegistry(deps: PortalWebhookRouteDeps): PortalWebhookRegistry {
  if (deps.registry) return deps.registry;
  return require('../services/webhook-registry');
}

const OUTLOOK_WEBHOOK_PROVIDERS = new Set<WebhookProvider>([
  'outlook_calendar',
  'outlook_mail',
  'outlook_todo',
]);
const WEBHOOK_MANAGEMENT_ROUTE_SEGMENTS = new Set(['events', 'stats', 'subscriptions']);
const MAX_OUTLOOK_WEBHOOK_NOTIFICATIONS = 1000;

function isPlainWebhookRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseWebhookPayload(body: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(body)) {
    const raw = body.toString('utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Preserve the existing non-JSON custom-webhook contract.
      return { raw };
    }
    if (!isPlainWebhookRecord(parsed)) {
      // Never reinterpret valid scalar/array JSON as a record: those shapes do
      // not satisfy the persistence schema for new events.
      throw Object.assign(new Error('Webhook JSON payload must be an object.'), {
        code: 'WEBHOOK_PAYLOAD_NOT_OBJECT',
      });
    }
    return parsed;
  }
  if (isPlainWebhookRecord(body)) return body;
  return { raw: String(body) };
}

function webhookDeliveries(
  provider: WebhookProvider,
  payload: Record<string, unknown>,
): { deliveries: Record<string, unknown>[]; malformedCount: number } {
  if (!OUTLOOK_WEBHOOK_PROVIDERS.has(provider)) {
    return { deliveries: [payload], malformedCount: 0 };
  }
  if (payload.value === undefined) return { deliveries: [payload], malformedCount: 0 };
  if (!Array.isArray(payload.value) || payload.value.length === 0) {
    throw Object.assign(new Error('Outlook webhook notifications must be non-empty objects.'), {
      code: 'WEBHOOK_PAYLOAD_NOT_OBJECT',
    });
  }
  if (payload.value.length > MAX_OUTLOOK_WEBHOOK_NOTIFICATIONS) {
    throw Object.assign(new Error('Outlook webhook batch exceeds the notification limit.'), {
      code: 'WEBHOOK_BATCH_TOO_LARGE',
    });
  }
  const deliveries = payload.value.filter(isPlainWebhookRecord);
  return {
    deliveries,
    malformedCount: payload.value.length - deliveries.length,
  };
}

function subscriptionExternalIdentityMatches(
  provider: WebhookProvider,
  subscription: WebhookSubscription,
  headers: HeaderRecord,
  payload: Record<string, unknown>,
): boolean {
  if (provider === 'google_calendar') {
    const channelId = headers['x-goog-channel-id'];
    return typeof channelId === 'string'
      && typeof subscription.external_id === 'string'
      && subscription.external_id === channelId;
  }
  if (OUTLOOK_WEBHOOK_PROVIDERS.has(provider)) {
    return typeof payload.subscriptionId === 'string'
      && typeof subscription.external_id === 'string'
      && subscription.external_id === payload.subscriptionId;
  }
  return true;
}

function subscriptionAcceptsEventType(
  subscription: WebhookSubscription,
  eventType: string,
): boolean {
  const eventTypes = subscription.event_types ?? ['*'];
  return eventType !== '*'
    && isValidWebhookEventTypes([eventType])
    && isValidWebhookEventTypes(eventTypes)
    && (eventTypes.includes('*') || eventTypes.includes(eventType));
}

function persistableWebhookDelivery(
  provider: WebhookProvider,
  delivery: Record<string, unknown>,
): Record<string, unknown> {
  if (!OUTLOOK_WEBHOOK_PROVIDERS.has(provider)) return delivery;
  // Microsoft Graph's clientState is an authentication secret, not event
  // data. Verify it against the raw notification, then exclude it from the
  // encrypted event ledger, exports, replay handlers, and idempotency digest.
  const { clientState: _clientState, ...persistableDelivery } = delivery;
  return persistableDelivery;
}

function boundedWebhookEventLimit(raw: unknown): number {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return 50;
    return Math.min(Math.max(raw, 1), 200);
  }
  if (raw === undefined) return 50;
  if (typeof raw !== 'string' || !/^-?\d+$/u.test(raw)) return 50;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 200);
}

function sendWebhookManagementError(
  res: Response,
  status: number,
  code: string,
  message: string,
): void {
  res.status(status).json({ ok: false, error: { code, message } });
}

function resolveWebhookManagementOwner(
  req: Request,
  res: Response,
  deps: PortalWebhookRouteDeps,
): number | undefined | null {
  const raw = req.query.owner_user_id;
  const scopesConfigured = deps.operatorScopesConfigured
    ?? portalOperatorUserScopesConfigured;
  if (raw === undefined) {
    if (scopesConfigured()) {
      sendWebhookManagementError(
        res,
        400,
        'OWNER_USER_ID_REQUIRED',
        'owner_user_id is required when operator user scopes are configured',
      );
      return null;
    }
    return undefined;
  }
  if (typeof raw !== 'string' || !/^[1-9]\d*$/u.test(raw)) {
    sendWebhookManagementError(res, 400, 'INVALID_USER_ID', 'owner_user_id must be a positive integer');
    return null;
  }
  const ownerUserId = Number(raw);
  if (!Number.isSafeInteger(ownerUserId)) {
    sendWebhookManagementError(res, 400, 'INVALID_USER_ID', 'owner_user_id must be a positive integer');
    return null;
  }
  const authorizeTargetUser = deps.authorizeTargetUser
    ?? authorizePortalOperatorTargetUser;
  return authorizeTargetUser(req, res, ownerUserId) ? ownerUserId : null;
}

function parsePositiveRouteId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function publicWebhookManagementFallthroughGuard(req: Request, _res: Response, next: NextFunction): void {
  const providerValue = req.params.provider;
  if (typeof providerValue === 'string' && WEBHOOK_MANAGEMENT_ROUTE_SEGMENTS.has(providerValue)) {
    next('route');
    return;
  }
  next();
}

function publicWebhookProviderValidationGuard(req: Request, res: Response, next: NextFunction): void {
  const providerValue = req.params.provider;
  if (!isWebhookProvider(providerValue)) {
    res.status(404).json({ ok: false, message: 'Unsupported webhook provider' });
    return;
  }
  next();
}

function parseWhatsAppPayload(body: unknown): Record<string, any> | null {
  try {
    if (typeof body === 'string') return JSON.parse(body);
    if (Buffer.isBuffer(body)) return JSON.parse(body.toString('utf-8'));
    if (typeof body === 'object' && body !== null) return body as Record<string, any>;
    return null;
  } catch {
    return null;
  }
}

export function registerPublicPortalWebhookRoutes(app: Express, deps: PortalWebhookRouteDeps = {}): void {
  const routeConfig = deps.config ?? defaultConfig;
  const logger = deps.logger ?? defaultLogger;
  const pushEvent = deps.pushEvent ?? defaultPushEvent;

  app.get('/api/webhooks/whatsapp', rateLimitMiddleware, (req: Request, res: Response) => {
    const verifyToken = routeConfig.whatsapp?.verifyToken;

    if (!routeConfig.whatsapp?.enabled || !verifyToken) {
      res.status(403).send('Forbidden');
      return;
    }

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && typeof token === 'string') {
      const tokenBuf = Buffer.from(token);
      const expectedBuf = Buffer.from(verifyToken);
      if (tokenBuf.length === expectedBuf.length &&
          crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
        logger.info('WhatsApp webhook verified');
        res.status(200).send(challenge);
        return;
      }
    }

    logger.warn({ mode }, 'WhatsApp webhook verification failed');
    res.status(403).send('Forbidden');
  });

  app.post('/api/webhooks/whatsapp',
    rateLimitMiddleware,
    express.raw({ type: 'application/json', limit: '1mb' }),
    (req: Request, res: Response) => {
      const appSecret = routeConfig.whatsapp?.appSecret;
      if (!appSecret) {
        logger.warn('WhatsApp webhook HMAC secret is not configured');
        res.status(403).send('Forbidden');
        return;
      }
      const sig = req.headers['x-hub-signature-256'] as string | undefined;
      if (!sig) {
        res.status(403).send('Forbidden');
        return;
      }
      const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(req.body as Buffer)
        .digest('hex');
      const sigBuf = Buffer.from(sig);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn('WhatsApp webhook HMAC verification failed');
        res.status(403).send('Forbidden');
        return;
      }

      res.status(200).send('OK');

      const body = parseWhatsAppPayload(req.body);
      if (body?.object !== 'whatsapp_business_account') return;

      const entries = body.entry ?? [];
      for (const entry of entries) {
        const changes = entry.changes ?? [];
        for (const change of changes) {
          if (change.field !== 'messages') continue;

          const value = change.value;
          const messages = value?.messages ?? [];

          for (const msg of messages) {
            pushEvent({
              ts: new Date().toISOString(),
              type: 'message',
              summary: 'WhatsApp message received',
              domain: 'whatsapp',
            });

            logger.info({
              type: msg.type,
            }, 'WhatsApp incoming message');
          }

          const statuses = value?.statuses ?? [];
          for (const status of statuses) {
            logger.debug({
              status: status.status,
            }, 'WhatsApp message status update');
          }
        }
      }
    });

  app.post('/api/webhooks/:provider',
    // Management paths fall through before the public limiter/parser; every
    // other callback-shaped request, including an invalid provider, is bounded.
    publicWebhookManagementFallthroughGuard,
    rateLimitMiddleware,
    publicWebhookProviderValidationGuard,
    // Provider authentication is defined over the wire bytes. A string media
    // type matcher skips requests with no Content-Type, so match every request
    // explicitly and reject compressed bodies instead of authenticating bytes
    // after a transparent transform.
    express.raw({
      type: () => true,
      limit: routeConfig.webhooks.maxPayloadBytes,
      inflate: false,
    }),
    async (req: Request, res: Response) => {
      if (routeConfig.webhooks.enabled === false) {
        res.status(503).json({ ok: false, message: 'Webhook ingestion is disabled' });
        return;
      }
      const providerValue = req.params.provider;
      if (!isWebhookProvider(providerValue)) {
        res.status(404).json({ ok: false, message: 'Unsupported webhook provider' });
        return;
      }
      const provider = providerValue;
      if (provider === 'google_gmail') {
        res.status(501).json({ ok: false, message: 'Gmail Pub/Sub webhook verification is not configured' });
        return;
      }
      if (provider === 'strava') {
        res.status(501).json({ ok: false, message: 'Strava webhook verification is not configured' });
        return;
      }

      const validationToken = req.query.validationToken;
      if (OUTLOOK_WEBHOOK_PROVIDERS.has(provider)
          && validationToken
          && typeof validationToken === 'string') {
        res.type('text/plain').status(200).send(validationToken);
        return;
      }

      // body-parser leaves `body` undefined for a genuinely empty request.
      // Normalize that case to the exact zero wire bytes, never the synthetic
      // UTF-8 text "undefined".
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

      try {
        const payload = parseWebhookPayload(rawBody);
        const { deliveries, malformedCount } = webhookDeliveries(provider, payload);
        const registry = getWebhookRegistry(deps);
        const subs = registry.getSubscriptions({ provider, status: 'active' });
        const admitted = deliveries.map((delivery) => {
          const persistableDelivery = persistableWebhookDelivery(provider, delivery);
          const eventType = extractEventType(provider, req.headers, persistableDelivery);
          const verificationBody = OUTLOOK_WEBHOOK_PROVIDERS.has(provider)
            ? Buffer.from(JSON.stringify(delivery))
            : rawBody;
          const matchingSubscriptions = subs.filter((candidate) => (
            Number.isSafeInteger(candidate.id)
            && Number(candidate.id) > 0
            && Number.isSafeInteger(candidate.user_id)
            && Number(candidate.user_id) > 0
            && subscriptionAcceptsEventType(candidate, eventType)
            && typeof candidate.secret === 'string'
            && candidate.secret.length > 0
            && subscriptionExternalIdentityMatches(
              provider,
              candidate,
              req.headers as HeaderRecord,
              delivery,
            )
            && registry.verifySignature(
              provider,
              verificationBody,
              req.headers as HeaderRecord,
              candidate.secret,
            )
          ));
          return { eventType, persistableDelivery, matchingSubscriptions };
        });

        const unauthorizedCount = admitted.filter(
          ({ matchingSubscriptions }) => matchingSubscriptions.length === 0,
        ).length;
        const ambiguousCount = admitted.filter(
          ({ matchingSubscriptions }) => matchingSubscriptions.length > 1,
        ).length;
        const uniquelyAdmitted = admitted.filter(
          ({ matchingSubscriptions }) => matchingSubscriptions.length === 1,
        );

        if (uniquelyAdmitted.length === 0 && ambiguousCount > 0) {
          logger.error({ provider, ambiguousCount }, 'Webhook signature matched more than one owner');
          res.status(409).json({ ok: false, message: 'Ambiguous webhook subscription owner' });
          return;
        }
        if (uniquelyAdmitted.length === 0 && unauthorizedCount === 0 && malformedCount > 0) {
          res.status(400).json({ ok: false, message: 'Webhook JSON payload must be an object' });
          return;
        }
        if (uniquelyAdmitted.length === 0) {
          logger.warn({ provider }, 'Webhook signature or subscription ownership did not validate');
          res.status(401).json({ ok: false, message: 'Invalid signature or subscription owner' });
          return;
        }
        if (!OUTLOOK_WEBHOOK_PROVIDERS.has(provider)
            && (unauthorizedCount > 0 || ambiguousCount > 0)) {
          res.status(401).json({ ok: false, message: 'Invalid signature or subscription owner' });
          return;
        }

        // Google sends a signed/token-bound `sync` state as channel setup
        // acknowledgement. Verify its owner above, but do not persist it as a
        // user data change.
        if (provider === 'google_calendar'
            && req.headers['x-goog-resource-state'] === 'sync') {
          res.status(200).send('OK');
          return;
        }

        const eventIds: number[] = [];
        for (const { eventType, persistableDelivery, matchingSubscriptions } of uniquelyAdmitted) {
          const sub = matchingSubscriptions[0];
          const eventId = await registry.receiveWebhookEvent({
            user_id: sub.user_id as number,
            provider,
            event_type: eventType,
            payload: persistableDelivery,
            headers: flattenHeaders(req.headers),
            idempotency_key: extractIdempotencyKey(provider, req.headers, persistableDelivery),
            subscription_id: sub.id,
          });
          if (eventId < 0) {
            res.status(503).json({ ok: false, message: 'Webhook event could not be admitted' });
            return;
          }
          eventIds.push(eventId);
        }
        const rejectedCount = unauthorizedCount + ambiguousCount + malformedCount;
        res.status(rejectedCount > 0 ? 202 : 200).json({
          ok: true,
          eventId: eventIds[0],
          ...(eventIds.length > 1 ? { eventIds } : {}),
          ...(rejectedCount > 0 ? {
            partial: true,
            rejected: {
              unauthorized: unauthorizedCount,
              ambiguous: ambiguousCount,
              malformed: malformedCount,
            },
          } : {}),
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'WEBHOOK_BATCH_TOO_LARGE') {
          res.status(413).json({ ok: false, message: 'Webhook notification batch is too large' });
          return;
        }
        if ((err as { code?: string })?.code === 'WEBHOOK_PAYLOAD_NOT_OBJECT') {
          res.status(400).json({ ok: false, message: 'Webhook JSON payload must be an object' });
          return;
        }
        logger.error({
          provider,
          errorName: err instanceof Error && err.name ? err.name : 'UnknownError',
        }, 'Webhook processing failed');
        res.status(500).json({ ok: false, message: 'Processing failed' });
      }
    });
}

export function registerPortalWebhookManagementRoutes(app: Express, deps: PortalWebhookRouteDeps = {}): void {
  const clearPortalSnapshotCache = deps.clearPortalSnapshotCache ?? defaultClearPortalSnapshotCache;
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
  app.get('/api/webhooks/stats', authorizationRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const ownerUserId = resolveWebhookManagementOwner(req, res, deps);
      if (ownerUserId === null) return;
      const registry = getWebhookRegistry(deps);
      const stats = registry.getWebhookStats(ownerUserId);
      res.json({ ok: true, ...stats });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/webhooks/subscriptions', authorizationRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const ownerUserId = resolveWebhookManagementOwner(req, res, deps);
      if (ownerUserId === null) return;
      const registry = getWebhookRegistry(deps);
      const providerValue = req.query.provider;
      if (providerValue != null && !isWebhookProvider(providerValue)) {
        res.status(400).json({ ok: false, message: 'Unsupported webhook provider' });
        return;
      }
      const provider = providerValue as WebhookProvider | undefined;
      const filter = {
        ...(provider ? { provider } : {}),
        ...(ownerUserId !== undefined ? { user_id: ownerUserId } : {}),
      };
      const subs = registry.getSubscriptions(Object.keys(filter).length > 0 ? filter : undefined);
      const safeSubscriptions = subs.map(({ secret, ...subscription }) => ({
        ...subscription,
        secretConfigured: typeof secret === 'string' && secret.length > 0,
      }));
      res.json({ ok: true, subscriptions: safeSubscriptions });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/webhooks/subscriptions', authorizationRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    const { provider, event_types, secret, external_id, metadata, expires_at, owner_user_id } = req.body || {};
    if (!isWebhookProvider(provider)) {
      res.status(400).json({ ok: false, message: 'supported provider is required' });
      return;
    }
    if (provider === 'google_gmail' || provider === 'strava') {
      res.status(400).json({ ok: false, message: 'provider native verification is not configured' });
      return;
    }
    if (typeof owner_user_id !== 'number'
        || !Number.isSafeInteger(owner_user_id)
        || owner_user_id <= 0) {
      res.status(400).json({ ok: false, message: 'owner_user_id must be a positive integer' });
      return;
    }
    const ownerUserId = owner_user_id;
    const authorizeTargetUser = deps.authorizeTargetUser
      ?? authorizePortalOperatorTargetUser;
    if (!authorizeTargetUser(req, res, ownerUserId)) return;
    if (typeof secret !== 'string' || secret.trim().length === 0) {
      res.status(400).json({ ok: false, message: 'a unique subscription secret is required' });
      return;
    }
    if ((provider === 'google_calendar'
          || OUTLOOK_WEBHOOK_PROVIDERS.has(provider))
        && (typeof external_id !== 'string' || external_id.trim().length === 0)) {
      res.status(400).json({ ok: false, message: 'external_id is required for provider owner binding' });
      return;
    }
    if (metadata !== undefined && !isPlainWebhookRecord(metadata)) {
      res.status(400).json({ ok: false, message: 'metadata must be a JSON object' });
      return;
    }
    if (event_types !== undefined && !isValidWebhookEventTypes(event_types)) {
      res.status(400).json({ ok: false, message: 'event_types must be a bounded non-empty string array' });
      return;
    }
    try {
      const registry = getWebhookRegistry(deps);
      const id = registry.registerSubscription({
        user_id: ownerUserId,
        provider,
        event_types,
        endpoint_path: `/api/webhooks/${provider}`,
        secret: secret.trim(),
        external_id: typeof external_id === 'string' ? external_id.trim() : external_id,
        metadata,
        expires_at,
      });
      if (id < 0) {
        res.status(500).json({ ok: false, message: 'Failed to register subscription' });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, id, endpoint: `/api/webhooks/${provider}` });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.delete('/api/webhooks/subscriptions/:id', authorizationRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    const id = parsePositiveRouteId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, message: 'Invalid subscription ID' });
      return;
    }
    try {
      const registry = getWebhookRegistry(deps);
      const subscription = registry.getSubscription(id);
      if (!subscription
          || !Number.isSafeInteger(subscription.user_id)
          || Number(subscription.user_id) <= 0) {
        res.status(404).json({ ok: false, message: 'Subscription not found' });
        return;
      }
      const ownerUserId = Number(subscription.user_id);
      const authorizeTargetUser = deps.authorizeTargetUser
        ?? authorizePortalOperatorTargetUser;
      if (!authorizeTargetUser(req, res, ownerUserId)) return;
      const removed = registry.removeSubscription(id, ownerUserId);
      if (!removed) {
        res.status(404).json({ ok: false, message: 'Subscription not found' });
        return;
      }
      clearPortalSnapshotCache();
      res.json({ ok: true, message: 'Subscription removed' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/webhooks/events', authorizationRateLimitMiddleware, requirePortalAdminToken, (req: Request, res: Response) => {
    try {
      const ownerUserId = resolveWebhookManagementOwner(req, res, deps);
      if (ownerUserId === null) return;
      const registry = getWebhookRegistry(deps);
      const provider = req.query.provider as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = boundedWebhookEventLimit(req.query.limit);
      const events = registry.getRecentEvents({
        provider: provider || undefined,
        status: status as any || undefined,
        limit,
        ...(ownerUserId !== undefined ? { user_id: ownerUserId } : {}),
      });
      const safeEvents = events.map((event) => {
        if (event == null || typeof event !== 'object' || Array.isArray(event)) return event;
        const { headers: _headers, ...safeEvent } = event as Record<string, unknown>;
        return safeEvent;
      });
      res.json({ ok: true, events: safeEvents });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/webhooks/events/:id/replay', authorizationRateLimitMiddleware, requirePortalAdminToken, async (req: Request, res: Response) => {
    const id = parsePositiveRouteId(req.params.id);
    if (id === null) {
      res.status(400).json({ ok: false, message: 'Invalid event ID' });
      return;
    }
    try {
      const registry = getWebhookRegistry(deps);
      const event = registry.getEvent(id);
      if (!event || !Number.isSafeInteger(event.user_id) || Number(event.user_id) <= 0) {
        res.status(404).json({ ok: false, message: 'Event not found' });
        return;
      }
      const ownerUserId = Number(event.user_id);
      const authorizeTargetUser = deps.authorizeTargetUser
        ?? authorizePortalOperatorTargetUser;
      if (!authorizeTargetUser(req, res, ownerUserId)) return;
      const success = await registry.replayEvent(id, ownerUserId);
      res.json({ ok: success, message: success ? 'Event replayed successfully' : 'Replay failed' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}

/**
 * Test/local-composition compatibility helper. Production deliberately mounts
 * the public raw-body callbacks before global parsing/authentication and mounts
 * the management surface only after portal authentication.
 */
export function registerPortalWebhookRoutes(app: Express, deps: PortalWebhookRouteDeps = {}): void {
  registerPublicPortalWebhookRoutes(app, deps);
  registerPortalWebhookManagementRoutes(app, deps);
}
