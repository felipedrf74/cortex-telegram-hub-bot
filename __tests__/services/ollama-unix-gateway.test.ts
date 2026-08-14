// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getActiveLocalModel,
  getLocalModelManifest,
} from '../../src/services/ollama-model-policy';
import {
  buildOllamaGatewayResidencyWarmBody,
  isOllamaGatewayPathAllowed,
  ollamaPsHasActiveModel,
  startOllamaUnixGateway,
  validateOllamaGatewayChatBody,
  validateOllamaGatewayPostBody,
} from '../../src/tools/ollama-unix-gateway';

const openServers: http.Server[] = [];
const temporaryDirectories: string[] = [];

async function listen(server: http.Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  openServers.push(server);
}

async function closeServer(server: http.Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function makeSocketPath(): string {
  // macOS exposes TMPDIR through a /var -> /private/var symlink. The gateway
  // correctly rejects symlink-traversing socket paths, so build the fixture
  // under the canonical temporary-directory path used by production policy.
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nexus-ollama-gateway-'));
  fs.chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return path.join(directory, 'ollama.sock');
}

async function startUpstream(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await listen(server, 0, '127.0.0.1');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test upstream did not bind TCP');
  return { server, port: address.port };
}

async function startGateway(
  upstreamPort: number,
  options: Parameters<typeof startOllamaUnixGateway>[1] = {},
): Promise<{ server: http.Server; socketPath: string }> {
  const socketPath = makeSocketPath();
  const server = startOllamaUnixGateway(socketPath, {
    upstreamPort,
    onEvent: () => undefined,
    ...options,
  });
  await new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
  });
  openServers.push(server);
  return { server, socketPath };
}

async function gatewayRequest(input: {
  socketPath: string;
  apiPath: string;
  method?: string;
  body?: string;
}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: input.socketPath,
      path: input.apiPath,
      method: input.method ?? 'GET',
      headers: input.body === undefined ? undefined : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(input.body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    if (input.body !== undefined) request.write(input.body);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function validChat(): Record<string, unknown> {
  return {
    model: getActiveLocalModel().ollamaTag,
    messages: [{ role: 'user', content: 'Draft a short outline.' }],
    stream: false,
    keep_alive: -1,
    options: {
      num_ctx: getActiveLocalModel().maxContextTokens,
      num_predict: 512,
      temperature: 0.2,
    },
  };
}

describe('Ollama Unix gateway policy', () => {
  it('accepts only the active model and bounded non-streaming chat shape', () => {
    expect(validateOllamaGatewayChatBody(validChat())).toBeNull();
    expect(validateOllamaGatewayChatBody({ ...validChat(), model: 'unapproved:latest' }))
      .toBe('model_not_active');
    expect(validateOllamaGatewayChatBody({ ...validChat(), stream: true }))
      .toBe('streaming_not_permitted');
    expect(validateOllamaGatewayChatBody({ ...validChat(), tools: [] }))
      .toBe('unsupported_chat_field');
  });

  it('independently enforces the signed context and output envelope', () => {
    const { options: _options, ...withoutOptions } = validChat();
    expect(validateOllamaGatewayChatBody(withoutOptions)).toBe('invalid_options');
    expect(validateOllamaGatewayChatBody({ ...validChat(), options: {} }))
      .toBe('num_ctx_out_of_policy');
    expect(validateOllamaGatewayChatBody({
      ...validChat(),
      options: { num_ctx: getActiveLocalModel().maxContextTokens },
    })).toBe('num_predict_out_of_policy');
    expect(validateOllamaGatewayChatBody({
      ...validChat(),
      options: { num_ctx: getActiveLocalModel().maxContextTokens + 1 },
    })).toBe('num_ctx_out_of_policy');
    expect(validateOllamaGatewayChatBody({
      ...validChat(),
      options: { num_ctx: getActiveLocalModel().maxContextTokens, num_predict: 6_145 },
    })).toBe('num_predict_out_of_policy');
    expect(validateOllamaGatewayChatBody({
      ...validChat(),
      keep_alive: 3600,
    })).toBe('keep_alive_out_of_policy');
    expect(validateOllamaGatewayChatBody({ ...validChat(), format: 'json' }))
      .toBe('format_out_of_policy');
    expect(validateOllamaGatewayChatBody({
      ...validChat(),
      format: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
    })).toBeNull();
    expect(validateOllamaGatewayChatBody({
      ...validChat(),
      format: { type: 'object', properties: { answer: { type: 'unsupported' } } },
    })).toBe('format_out_of_policy');
  });

  it('requires the exact active model in each bounded /api/ps residency result', () => {
    const active = getActiveLocalModel();
    const bareDigest = active.digest?.replace(/^sha256:/u, '');
    expect(ollamaPsHasActiveModel(200, {
      models: [{ name: active.ollamaTag, digest: active.digest }],
    })).toBe(true);
    expect(ollamaPsHasActiveModel(200, {
      models: [{ model: active.ollamaTag, digest: bareDigest }],
    })).toBe(true);
    expect(ollamaPsHasActiveModel(200, { models: [{ name: active.ollamaTag }] })).toBe(false);
    expect(ollamaPsHasActiveModel(200, {
      models: [{ name: active.ollamaTag, digest: `sha256:${'0'.repeat(64)}` }],
    })).toBe(false);
    expect(ollamaPsHasActiveModel(200, {
      models: [
        { name: active.ollamaTag, digest: active.digest },
        { name: 'other:model', digest: active.digest },
      ],
    })).toBe(false);
    expect(ollamaPsHasActiveModel(200, {
      models: [{ name: 'other:model', digest: active.digest }],
    })).toBe(false);
    expect(ollamaPsHasActiveModel(503, {
      models: [{ name: active.ollamaTag, digest: active.digest }],
    })).toBe(false);
    expect(ollamaPsHasActiveModel(200, { models: 'not-an-array' })).toBe(false);
  });

  it('uses a fixed policy-valid local-only chat to restore residency after daemon eviction', () => {
    const warmBody = buildOllamaGatewayResidencyWarmBody();
    expect(validateOllamaGatewayChatBody(warmBody)).toBeNull();
    expect(warmBody).toEqual({
      model: getActiveLocalModel().ollamaTag,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      think: false,
      stream: false,
      keep_alive: -1,
      options: {
        num_ctx: Math.min(1_024, getActiveLocalModel().maxContextTokens),
        num_predict: 1,
        temperature: 0,
      },
    });
  });

  it('forbids model mutation and arbitrary proxy bodies', () => {
    expect(isOllamaGatewayPathAllowed('POST', '/api/pull')).toBe(false);
    expect(isOllamaGatewayPathAllowed('POST', '/api/create')).toBe(false);
    expect(isOllamaGatewayPathAllowed('DELETE', '/api/delete')).toBe(false);
    expect(validateOllamaGatewayPostBody('/api/show', { model: 'unapproved:latest' }))
      .toBe('model_not_active');
    expect(validateOllamaGatewayPostBody('/api/show', {
      model: getActiveLocalModel().ollamaTag,
      insecure: true,
    })).toBe('unsupported_show_field');
    expect(validateOllamaGatewayPostBody('/api/show', {
      model: getActiveLocalModel().ollamaTag,
      name: 'unapproved:latest',
    })).toBe('invalid_show_model_selector');
  });
});

describe('Ollama Unix gateway HTTP boundary', () => {
  it('fails health and model-bound requests closed when the signed manifest becomes unavailable', async () => {
    const manifest = getLocalModelManifest();
    let manifestAvailable = true;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected_upstream_call' }));
    });
    const gateway = await startGateway(upstream.port, {
      manifestLoader: () => {
        if (!manifestAvailable) throw new Error('packaged manifest unavailable');
        return manifest;
      },
    });

    const healthy = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/health',
    });
    expect(healthy.status).toBe(200);

    manifestAvailable = false;
    const unhealthy = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/health',
    });
    expect(unhealthy).toEqual({
      status: 503,
      text: JSON.stringify({ ok: false, error: 'model_manifest_unavailable' }),
    });

    const modelBound = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/show',
      method: 'POST',
      body: JSON.stringify({ model: getActiveLocalModel().ollamaTag }),
    });
    expect(modelBound).toEqual({
      status: 503,
      text: JSON.stringify({ error: 'model_manifest_unavailable' }),
    });
    const chatBound = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body: JSON.stringify(validChat()),
    });
    expect(chatBound).toEqual({
      status: 503,
      text: JSON.stringify({ error: 'model_manifest_unavailable' }),
    });
    expect(gateway.server.listening).toBe(true);
  });

  it('proxies only validated requests and enforces request and response byte caps', async () => {
    const active = getActiveLocalModel();
    const activeModel = active.ollamaTag;
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: activeModel, digest: active.digest }] }));
        return;
      }
      if (req.url === '/api/chat') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'proxied' }, done: true }));
        return;
      }
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'x'.repeat(512) }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: 'test' }));
    });
    const gateway = await startGateway(upstream.port, {
      maxRequestBytes: 256,
      maxResponseBytes: 128,
    });

    const version = await gatewayRequest({ socketPath: gateway.socketPath, apiPath: '/api/version' });
    expect(version).toEqual({ status: 200, text: JSON.stringify({ version: 'test' }) });

    const forbidden = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/pull',
      method: 'POST',
      body: JSON.stringify({ model: activeModel }),
    });
    expect(forbidden).toEqual({
      status: 403,
      text: JSON.stringify({ error: 'gateway_path_or_method_forbidden' }),
    });

    const chat = JSON.stringify(validChat());
    const proxied = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body: chat,
    });
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.text)).toMatchObject({ message: { content: 'proxied' } });

    const malformed = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/show',
      method: 'POST',
      body: '{not-json',
    });
    expect(malformed).toEqual({ status: 400, text: JSON.stringify({ error: 'invalid_json' }) });

    const oversizedRequest = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/show',
      method: 'POST',
      body: JSON.stringify({ model: activeModel, padding: 'x'.repeat(512) }),
    });
    expect(oversizedRequest).toEqual({
      status: 413,
      text: JSON.stringify({ error: 'request_body_too_large' }),
    });

    const oversizedResponse = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/tags',
    });
    expect(oversizedResponse).toEqual({
      status: 502,
      text: JSON.stringify({ error: 'upstream_response_too_large' }),
    });
  });

  it('single-flights a bounded warm and re-verifies residency before proxying chat', async () => {
    const active = getActiveLocalModel();
    const activeModel = active.ollamaTag;
    let resident = false;
    let warmCalls = 0;
    let visibleChatCalls = 0;
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          models: resident ? [{ name: activeModel, digest: active.digest }] : [],
        }));
        return;
      }
      if (req.url === '/api/chat') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            options?: { num_predict?: number };
          };
          if (body.options?.num_predict === 1) {
            warmCalls += 1;
            resident = true;
          } else {
            visibleChatCalls += 1;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    const events: Array<Record<string, unknown>> = [];
    const gateway = await startGateway(upstream.port, { onEvent: (event) => events.push(event) });
    const body = JSON.stringify(validChat());

    const [first, second] = await Promise.all([
      gatewayRequest({ socketPath: gateway.socketPath, apiPath: '/api/chat', method: 'POST', body }),
      gatewayRequest({ socketPath: gateway.socketPath, apiPath: '/api/chat', method: 'POST', body }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(warmCalls).toBe(1);
    expect(visibleChatCalls).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'ollama_gateway_residency_warm_started' }),
      expect.objectContaining({ event: 'ollama_gateway_residency_warm_completed', success: true }),
    ]));
    expect(JSON.stringify(events)).not.toContain('Reply with OK');
  });

  it.each([
    ['missing', undefined],
    ['mismatched', `sha256:${'0'.repeat(64)}`],
  ])('does not warm or proxy when the resident active tag has a %s digest', async (_label, digest) => {
    const active = getActiveLocalModel();
    let residencyCalls = 0;
    let chatCalls = 0;
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        residencyCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          models: [{
            name: active.ollamaTag,
            ...(digest === undefined ? {} : { digest }),
          }],
        }));
        return;
      }
      if (req.url === '/api/chat') {
        chatCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'must not run' }, done: true }));
        return;
      }
      res.writeHead(404).end();
    });
    const gateway = await startGateway(upstream.port);

    const result = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body: JSON.stringify(validChat()),
    });

    expect(result).toEqual({
      status: 503,
      text: JSON.stringify({ error: 'active_model_not_resident' }),
    });
    expect(residencyCalls).toBe(1);
    expect(chatCalls).toBe(0);
  });

  it.each([
    ['a non-OK response', 503, JSON.stringify({ error: 'daemon_unavailable' })],
    ['malformed JSON', 200, '{not-json'],
    ['a non-array inventory', 200, JSON.stringify({ models: 'invalid' })],
  ])('does not warm or proxy after %s from the residency probe', async (_label, status, payload) => {
    let residencyCalls = 0;
    let chatCalls = 0;
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        residencyCalls += 1;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
        return;
      }
      if (req.url === '/api/chat') {
        chatCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'must not run' }, done: true }));
        return;
      }
      res.writeHead(404).end();
    });
    const gateway = await startGateway(upstream.port);

    const result = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body: JSON.stringify(validChat()),
    });

    expect(result).toEqual({
      status: 503,
      text: JSON.stringify({ error: 'active_model_not_resident' }),
    });
    expect(residencyCalls).toBe(1);
    expect(chatCalls).toBe(0);
  });

  it('serializes visible chat requests at the signed one-generation boundary', async () => {
    const active = getActiveLocalModel();
    const activeModel = active.ollamaTag;
    let activeChats = 0;
    let maximumActiveChats = 0;
    let visibleChatCalls = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstVisibleStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: activeModel, digest: active.digest }] }));
        return;
      }
      if (req.url !== '/api/chat') {
        res.writeHead(404).end();
        return;
      }
      req.resume();
      req.on('end', () => {
        visibleChatCalls += 1;
        activeChats += 1;
        maximumActiveChats = Math.max(maximumActiveChats, activeChats);
        const complete = () => {
          activeChats -= 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
        };
        if (visibleChatCalls === 1) {
          releaseFirst = complete;
          firstStarted();
        } else {
          complete();
        }
      });
    });
    const gateway = await startGateway(upstream.port);
    const body = JSON.stringify(validChat());

    const first = gatewayRequest({ socketPath: gateway.socketPath, apiPath: '/api/chat', method: 'POST', body });
    await firstVisibleStarted;
    const second = gatewayRequest({ socketPath: gateway.socketPath, apiPath: '/api/chat', method: 'POST', body });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(visibleChatCalls).toBe(1);
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: 200 });
    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(visibleChatCalls).toBe(2);
    expect(maximumActiveChats).toBe(1);
  });

  it('returns residency 503 and suppresses repeated failed warm attempts during cooldown', async () => {
    let nowMs = 10_000;
    let warmCalls = 0;
    const events: Array<Record<string, unknown>> = [];
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
      if (req.url === '/api/chat') {
        warmCalls += 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'warm_failed' }));
        return;
      }
      res.writeHead(404).end();
    });
    const gateway = await startGateway(upstream.port, {
      now: () => nowMs,
      residencyWarmFailureCooldownMs: 30_000,
      onEvent: (event) => events.push(event),
    });
    const body = JSON.stringify(validChat());

    const first = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body,
    });
    const second = await gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body,
    });

    expect(first).toEqual({ status: 503, text: JSON.stringify({ error: 'active_model_not_resident' }) });
    expect(second).toEqual(first);
    expect(warmCalls).toBe(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'ollama_gateway_residency_warm_completed',
        success: false,
        cooldownUntilMs: 40_000,
      }),
    ]));

    nowMs = 40_001;
    await gatewayRequest({ socketPath: gateway.socketPath, apiPath: '/api/chat', method: 'POST', body });
    expect(warmCalls).toBe(2);
  });

  it('does not start a warm or terminate when the client disconnects during the residency probe', async () => {
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => { probeStarted = resolve; });
    let probeClosed!: () => void;
    const closed = new Promise<void>((resolve) => { probeClosed = resolve; });
    let warmCalls = 0;
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        probeStarted();
        req.socket.once('close', probeClosed);
        return;
      }
      if (req.url === '/api/chat') {
        warmCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
        return;
      }
      if (req.url === '/api/version') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ version: 'test' }));
        return;
      }
      res.writeHead(404).end();
    });
    const gateway = await startGateway(upstream.port);
    const body = JSON.stringify(validChat());
    const client = http.request({
      socketPath: gateway.socketPath,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    client.on('error', () => undefined);
    client.end(body);

    await started;
    client.destroy();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warmCalls).toBe(0);
    await expect(gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/version',
    })).resolves.toMatchObject({ status: 200 });
  });

  it('does not impose the shared failure cooldown when a client disconnects during warm', async () => {
    const active = getActiveLocalModel();
    const activeModel = active.ollamaTag;
    let resident = false;
    let chatCalls = 0;
    let firstWarmStarted!: () => void;
    const warmStarted = new Promise<void>((resolve) => { firstWarmStarted = resolve; });
    let firstWarmClosed!: () => void;
    const warmClosed = new Promise<void>((resolve) => { firstWarmClosed = resolve; });
    const events: Array<Record<string, unknown>> = [];
    const upstream = await startUpstream((req, res) => {
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          models: resident ? [{ name: activeModel, digest: active.digest }] : [],
        }));
        return;
      }
      if (req.url === '/api/chat') {
        chatCalls += 1;
        if (chatCalls === 1) {
          firstWarmStarted();
          req.socket.once('close', firstWarmClosed);
          return;
        }
        if (chatCalls === 2) resident = true;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }));
        return;
      }
      res.writeHead(404).end();
    });
    const gateway = await startGateway(upstream.port, {
      residencyWarmFailureCooldownMs: 30_000,
      onEvent: (event) => events.push(event),
    });
    const body = JSON.stringify(validChat());
    const firstClient = http.request({
      socketPath: gateway.socketPath,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    });
    firstClient.on('error', () => undefined);
    firstClient.end(body);

    await warmStarted;
    firstClient.destroy();
    await warmClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(gatewayRequest({
      socketPath: gateway.socketPath,
      apiPath: '/api/chat',
      method: 'POST',
      body,
    })).resolves.toMatchObject({ status: 200 });
    expect(chatCalls).toBe(3);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'ollama_gateway_residency_warm_cancelled' }),
      expect.objectContaining({ event: 'ollama_gateway_residency_warm_completed', success: true }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'ollama_gateway_residency_warm_completed', success: false }),
    ]));
  });

  it('aborts an upstream proxy request when the Unix-socket client closes', async () => {
    let upstreamStarted!: () => void;
    const started = new Promise<void>((resolve) => { upstreamStarted = resolve; });
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    const upstream = await startUpstream((req) => {
      upstreamStarted();
      req.socket.once('close', () => upstreamClosed());
    });
    const gateway = await startGateway(upstream.port);
    const client = http.request({
      socketPath: gateway.socketPath,
      path: '/api/version',
      method: 'GET',
    });
    client.on('error', () => undefined);
    client.end();
    await started;

    client.destroy();

    await closed;
  });
});
