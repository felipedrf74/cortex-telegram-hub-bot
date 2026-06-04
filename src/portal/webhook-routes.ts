// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import express, { type Express, type Request, type Response } from 'express';
import { requirePortalAdminToken } from '../api/secret-guards';
import { config as defaultConfig } from '../config';
import { logger as defaultLogger } from '../utils/logger';
import { pushEvent as defaultPushEvent } from './telemetry';
import { sendPortalInternalError } from './http';
import { clearPortalSnapshotCache as defaultClearPortalSnapshotCache } from './snapshot-cache';
import { extractEventType, extractIdempotencyKey, flattenHeaders } from './webhooks';
import type { WebhookProvider } from '../services/webhook-registry';

type HeaderRecord = Record<string, string | string[] | undefined>;

interface PortalWebhookConfig {
  whatsapp?: {
    enabled?: boolean;
    verifyToken?: string;
    appSecret?: string;
  };
  webhooks: {
    maxPayloadBytes: number;
    secret?: string;
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
  secret?: string | null;
}

interface PortalWebhookRegistry {
  verifySignature: (
    provider: WebhookProvider,
    body: Buffer,
    headers: HeaderRecord,
    secret: string,
  ) => boolean;
  receiveWebhookEvent: (event: {
    provider: WebhookProvider;
    event_type: string;
    payload: Record<string, unknown>;
    headers: Record<string, string>;
    idempotency_key?: string;
    subscription_id?: number;
  }) => Promise<number>;
  getSubscriptions: (filter?: Record<string, unknown>) => WebhookSubscription[];
  registerSubscription: (subscription: Record<string, unknown>) => number;
  removeSubscription: (id: number) => boolean;
  getWebhookStats: () => Record<string, unknown>;
  getRecentEvents: (filter?: Record<string, unknown>) => unknown[];
  replayEvent: (id: number) => Promise<boolean>;
}

interface PortalWebhookRouteDeps {
  config?: PortalWebhookConfig;
  logger?: PortalWebhookLogger;
  pushEvent?: typeof defaultPushEvent;
  clearPortalSnapshotCache?: () => void;
  registry?: PortalWebhookRegistry;
}

function getWebhookRegistry(deps: PortalWebhookRouteDeps): PortalWebhookRegistry {
  if (deps.registry) return deps.registry;
  return require('../services/webhook-registry');
}

function parseWebhookPayload(body: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(body)) {
    try {
      return JSON.parse(body.toString('utf-8'));
    } catch {
      return { raw: body.toString('utf-8') };
    }
  }
  if (typeof body === 'object' && body !== null) return body as Record<string, unknown>;
  return { raw: String(body) };
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

export function registerPortalWebhookRoutes(app: Express, deps: PortalWebhookRouteDeps = {}): void {
  const routeConfig = deps.config ?? defaultConfig;
  const logger = deps.logger ?? defaultLogger;
  const pushEvent = deps.pushEvent ?? defaultPushEvent;
  const clearPortalSnapshotCache = deps.clearPortalSnapshotCache ?? defaultClearPortalSnapshotCache;

  app.get('/api/webhooks/whatsapp', (req: Request, res: Response) => {
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
          const contacts = value?.contacts ?? [];

          for (const msg of messages) {
            const senderPhone = msg.from;
            const senderName = contacts.find((contact: { wa_id: string; profile?: { name?: string } }) =>
              contact.wa_id === senderPhone)?.profile?.name ?? 'Unknown';

            pushEvent({
              ts: new Date().toISOString(),
              type: 'message',
              summary: `WhatsApp from ${senderName}: ${(msg.text?.body ?? msg.type).slice(0, 60)}`,
              detail: JSON.stringify(msg),
              domain: 'whatsapp',
            });

            logger.info({
              from: senderPhone,
              name: senderName,
              type: msg.type,
              msgId: msg.id,
            }, 'WhatsApp incoming message');
          }

          const statuses = value?.statuses ?? [];
          for (const status of statuses) {
            logger.debug({
              msgId: status.id,
              status: status.status,
              recipientId: status.recipient_id,
            }, 'WhatsApp message status update');
          }
        }
      }
    });

  app.post('/api/webhooks/:provider',
    express.raw({ type: '*/*', limit: routeConfig.webhooks.maxPayloadBytes }),
    async (req: Request, res: Response) => {
      const provider = req.params.provider as WebhookProvider;

      if (req.headers['x-goog-resource-state'] === 'sync') {
        res.status(200).send('OK');
        return;
      }

      const validationToken = req.query.validationToken;
      if (validationToken && typeof validationToken === 'string') {
        res.type('text/plain').status(200).send(validationToken);
        return;
      }

      const registry = getWebhookRegistry(deps);
      const subs = registry.getSubscriptions({ provider, status: 'active' });
      const sub = subs.length > 0 ? subs[0] : null;

      if (!sub?.secret) {
        logger.warn({ provider }, 'Webhook signing secret is not configured');
        res.status(401).json({ ok: false, message: 'Webhook signing secret is not configured' });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
      const valid = registry.verifySignature(
        provider,
        rawBody,
        req.headers as HeaderRecord,
        sub.secret,
      );
      if (!valid) {
        logger.warn({ provider }, 'Webhook signature verification failed');
        res.status(401).json({ ok: false, message: 'Invalid signature' });
        return;
      }

      try {
        const payload = parseWebhookPayload(req.body);
        const eventType = extractEventType(provider, req.headers, payload);
        const idempotencyKey = extractIdempotencyKey(provider, req.headers, payload);

        const eventId = await registry.receiveWebhookEvent({
          provider,
          event_type: eventType,
          payload,
          headers: flattenHeaders(req.headers),
          idempotency_key: idempotencyKey,
          subscription_id: sub?.id,
        });

        res.status(200).json({ ok: true, eventId });
      } catch (err) {
        logger.error({ err, provider }, 'Webhook processing failed');
        res.status(500).json({ ok: false, message: 'Processing failed' });
      }
    });

  app.get('/api/webhooks/stats', (_req: Request, res: Response) => {
    try {
      const registry = getWebhookRegistry(deps);
      const stats = registry.getWebhookStats();
      res.json({ ok: true, ...stats });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.get('/api/webhooks/subscriptions', (req: Request, res: Response) => {
    try {
      const registry = getWebhookRegistry(deps);
      const provider = req.query.provider as WebhookProvider | undefined;
      const subs = registry.getSubscriptions(provider ? { provider } : undefined);
      res.json({ ok: true, subscriptions: subs });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/webhooks/subscriptions', requirePortalAdminToken, (req: Request, res: Response) => {
    const { provider, event_types, secret, external_id, metadata, expires_at } = req.body || {};
    if (!provider) {
      res.status(400).json({ ok: false, message: 'provider is required' });
      return;
    }
    try {
      const registry = getWebhookRegistry(deps);
      const id = registry.registerSubscription({
        provider,
        event_types,
        endpoint_path: `/api/webhooks/${provider}`,
        secret: secret || routeConfig.webhooks.secret || undefined,
        external_id,
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

  app.delete('/api/webhooks/subscriptions/:id', requirePortalAdminToken, (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ ok: false, message: 'Invalid subscription ID' });
      return;
    }
    try {
      const registry = getWebhookRegistry(deps);
      const removed = registry.removeSubscription(id);
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

  app.get('/api/webhooks/events', (req: Request, res: Response) => {
    try {
      const registry = getWebhookRegistry(deps);
      const provider = req.query.provider as string | undefined;
      const status = req.query.status as string | undefined;
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const events = registry.getRecentEvents({
        provider: provider || undefined,
        status: status as any || undefined,
        limit: Math.min(limit, 200),
      });
      res.json({ ok: true, events });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });

  app.post('/api/webhooks/events/:id/replay', requirePortalAdminToken, async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) {
      res.status(400).json({ ok: false, message: 'Invalid event ID' });
      return;
    }
    try {
      const registry = getWebhookRegistry(deps);
      const success = await registry.replayEvent(id);
      res.json({ ok: success, message: success ? 'Event replayed successfully' : 'Replay failed' });
    } catch (err) {
      sendPortalInternalError(res, err, 'Portal request failed', 'Portal: request failed');
    }
  });
}
