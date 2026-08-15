// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  getLocalModelManifest,
  tryGetLocalModelManifest,
  type LocalModelManifest,
  type LocalModelManifestEntry,
  type LocalModelManifestLoadResult,
} from '../services/ollama-model-policy';
import { ollamaModelDigestsEqual } from '../services/ollama-model-digest';
import { validateStructuredOutputSchema } from '../services/structured-output-schema';

const SOCKET_PATH = String(process.env.OLLAMA_GATEWAY_SOCKET_PATH ?? '').trim();
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 11434;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const RESIDENCY_PROBE_TIMEOUT_MS = 3_000;
const RESIDENCY_WARM_TIMEOUT_MS = 5 * 60 * 1000;
const RESIDENCY_WARM_FAILURE_COOLDOWN_MS = 30_000;
const ALLOWED_GET_PATHS = new Set(['/api/version', '/api/tags', '/api/ps']);
const ALLOWED_POST_PATHS = new Set(['/api/show', '/api/chat']);
const ALLOWED_CHAT_FIELDS = new Set(['model', 'messages', 'think', 'stream', 'keep_alive', 'options', 'format']);
const ALLOWED_OPTION_FIELDS = new Set(['num_ctx', 'num_predict', 'temperature', 'top_p', 'top_k', 'seed', 'stop']);
const MAX_OUTPUT_TOKENS = 6_144;
const ALLOWED_MESSAGE_ROLES = new Set(['system', 'user', 'assistant']);

export interface OllamaUnixGatewayOptions {
  /** Test-only seam; the production command always uses fixed loopback. */
  upstreamHost?: string;
  /** Test-only seam; the production command always uses Ollama's 11434 port. */
  upstreamPort?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  residencyProbeTimeoutMs?: number;
  residencyWarmTimeoutMs?: number;
  residencyWarmFailureCooldownMs?: number;
  now?: () => number;
  onEvent?: (event: Record<string, unknown>) => void;
  /** Test-only seam for simulating a packaged-manifest outage after startup. */
  manifestLoader?: () => LocalModelManifest;
}

interface OllamaGatewayRuntime {
  upstreamHost: string;
  upstreamPort: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  residencyProbeTimeoutMs: number;
  residencyWarmTimeoutMs: number;
  residencyWarmFailureCooldownMs: number;
  now: () => number;
  onEvent: (event: Record<string, unknown>) => void;
  readManifest: () => LocalModelManifestLoadResult;
  residencyWarmCooldownUntilMs: number;
  activeChatRequests: number;
  waitingChatRequests: QueuedGatewayChat[];
}

interface QueuedGatewayChat {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  start: () => void;
  removeDisconnectListeners?: () => void;
}

function createGatewayRuntime(options: OllamaUnixGatewayOptions = {}): OllamaGatewayRuntime {
  if ((options.upstreamHost !== undefined
      || options.upstreamPort !== undefined
      || options.manifestLoader !== undefined)
      && process.env.NODE_ENV !== 'test') {
    throw new Error('Ollama gateway upstream and manifest overrides are test-only');
  }
  return {
    upstreamHost: options.upstreamHost ?? UPSTREAM_HOST,
    upstreamPort: options.upstreamPort ?? UPSTREAM_PORT,
    maxRequestBytes: options.maxRequestBytes ?? MAX_REQUEST_BYTES,
    maxResponseBytes: options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    residencyProbeTimeoutMs: options.residencyProbeTimeoutMs ?? RESIDENCY_PROBE_TIMEOUT_MS,
    residencyWarmTimeoutMs: options.residencyWarmTimeoutMs ?? RESIDENCY_WARM_TIMEOUT_MS,
    residencyWarmFailureCooldownMs: options.residencyWarmFailureCooldownMs
      ?? RESIDENCY_WARM_FAILURE_COOLDOWN_MS,
    now: options.now ?? Date.now,
    onEvent: options.onEvent ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`)),
    readManifest: () => tryGetLocalModelManifest({
      fresh: true,
      ...(options.manifestLoader ? { loader: options.manifestLoader } : {}),
    }),
    residencyWarmCooldownUntilMs: 0,
    activeChatRequests: 0,
    waitingChatRequests: [],
  };
}

export function isOllamaGatewayPathAllowed(method: string, apiPath: string): boolean {
  if (method === 'GET') return apiPath === '/health' || ALLOWED_GET_PATHS.has(apiPath);
  return method === 'POST' && ALLOWED_POST_PATHS.has(apiPath);
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function safeSocketPath(socketPath: string): string {
  if (!path.isAbsolute(socketPath) || socketPath.includes('\0')) {
    throw new Error('OLLAMA_GATEWAY_SOCKET_PATH must be an absolute path');
  }
  const parent = path.dirname(socketPath);
  if (fs.realpathSync(parent) !== path.resolve(parent)) {
    throw new Error('Ollama gateway socket path must not traverse symlinked ancestors');
  }
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Ollama gateway socket parent must be a real directory');
  }
  const processUid = process.getuid?.();
  if (processUid !== undefined && stat.uid !== processUid) {
    throw new Error('Ollama gateway socket parent must be owned by the gateway UID');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Ollama gateway socket parent must not grant group or other access');
  }
  if (fs.existsSync(socketPath)) {
    const existing = fs.lstatSync(socketPath);
    if (!existing.isSocket() || existing.isSymbolicLink()) {
      throw new Error('Refusing to replace a non-socket Ollama gateway path');
    }
    fs.unlinkSync(socketPath);
  }
  return socketPath;
}

function boundedNumber(value: unknown, min: number, max: number, integer = false): boolean {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= min
    && value <= max
    && (!integer || Number.isSafeInteger(value));
}

function activeModelFromManifest(manifest: LocalModelManifest): LocalModelManifestEntry {
  return manifest.models.find((model) => model.id === manifest.activeModelId)!;
}

function validateChatOptions(
  options: Record<string, unknown>,
  activeModel: LocalModelManifestEntry,
): string | null {
  const maxContextTokens = activeModel.maxContextTokens;
  if (!boundedNumber(options.num_ctx, 1, maxContextTokens, true)) {
    return 'num_ctx_out_of_policy';
  }
  if (!boundedNumber(options.num_predict, 1, MAX_OUTPUT_TOKENS, true)) {
    return 'num_predict_out_of_policy';
  }
  if (options.temperature !== undefined && !boundedNumber(options.temperature, 0, 2)) return 'temperature_out_of_policy';
  if (options.top_p !== undefined && !boundedNumber(options.top_p, 0, 1)) return 'top_p_out_of_policy';
  if (options.top_k !== undefined && !boundedNumber(options.top_k, 1, 200, true)) return 'top_k_out_of_policy';
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) return 'seed_out_of_policy';
  if (options.stop !== undefined
      && (!Array.isArray(options.stop)
        || options.stop.length > 16
        || options.stop.some((item) => typeof item !== 'string' || item.length > 256))) {
    return 'stop_out_of_policy';
  }
  return null;
}

export function validateOllamaGatewayChatBody(
  body: unknown,
  manifest: LocalModelManifest = getLocalModelManifest({ fresh: true }),
): string | null {
  const activeModel = activeModelFromManifest(manifest);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request_body_must_be_object';
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_CHAT_FIELDS.has(key))) return 'unsupported_chat_field';
  if (record.model !== activeModel.ollamaTag) return 'model_not_active';
  if (record.stream !== false) return 'streaming_not_permitted';
  if (!Array.isArray(record.messages) || record.messages.length === 0 || record.messages.length > 64) {
    return 'invalid_messages';
  }
  if (record.messages.some((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return true;
    const item = message as Record<string, unknown>;
    return Object.keys(item).some((key) => key !== 'role' && key !== 'content')
      || typeof item.role !== 'string'
      || !ALLOWED_MESSAGE_ROLES.has(item.role)
      || typeof item.content !== 'string';
  })) return 'invalid_messages';
  if (record.think !== undefined && typeof record.think !== 'boolean') return 'invalid_think';
  if (record.keep_alive !== undefined && record.keep_alive !== -1) return 'keep_alive_out_of_policy';
  if (!record.options || typeof record.options !== 'object' || Array.isArray(record.options)) return 'invalid_options';
  if (Object.keys(record.options as Record<string, unknown>).some((key) => !ALLOWED_OPTION_FIELDS.has(key))) {
    return 'unsupported_option';
  }
  const optionError = validateChatOptions(record.options as Record<string, unknown>, activeModel);
  if (optionError) return optionError;
  if (record.format !== undefined) {
    if (!record.format || typeof record.format !== 'object' || Array.isArray(record.format)) {
      return 'format_out_of_policy';
    }
    if (Buffer.byteLength(JSON.stringify(record.format), 'utf8') > 64 * 1024) {
      return 'format_out_of_policy';
    }
    const schemaValidation = validateStructuredOutputSchema(record.format);
    if (!schemaValidation.valid) return 'format_out_of_policy';
  }
  return null;
}

export function validateOllamaGatewayPostBody(
  apiPath: string,
  body: unknown,
  manifest: LocalModelManifest = getLocalModelManifest({ fresh: true }),
): string | null {
  if (apiPath === '/api/chat') return validateOllamaGatewayChatBody(body, manifest);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'request_body_must_be_object';
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'model' && key !== 'name')) return 'unsupported_show_field';
  if (Object.keys(record).length !== 1
      || (record.model === undefined) === (record.name === undefined)) return 'invalid_show_model_selector';
  const selected = record.model ?? record.name;
  return selected === activeModelFromManifest(manifest).ollamaTag ? null : 'model_not_active';
}

function proxy(
  runtime: OllamaGatewayRuntime,
  apiPath: string,
  method: string,
  body: Buffer | undefined,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  let finished = false;
  const request = http.request({
    host: runtime.upstreamHost,
    port: runtime.upstreamPort,
    path: apiPath,
    method,
    headers: body ? { 'content-type': 'application/json', 'content-length': body.length } : undefined,
    timeout: runtime.requestTimeoutMs,
  }, (upstream) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    upstream.on('data', (chunk: Buffer | string) => {
      if (finished) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > runtime.maxResponseBytes) {
        finished = true;
        cleanup();
        upstream.destroy();
        request.destroy();
        json(res, 502, { error: 'upstream_response_too_large' });
        return;
      }
      chunks.push(buffer);
    });
    upstream.on('end', () => {
      if (finished) return;
      finished = true;
      cleanup();
      if (res.headersSent || res.destroyed) return;
      const payload = Buffer.concat(chunks);
      res.writeHead(upstream.statusCode ?? 502, {
        'content-type': String(upstream.headers['content-type'] ?? 'application/json'),
        'content-length': payload.length,
        'cache-control': 'no-store',
      });
      res.end(payload);
    });
  });
  const wallClockDeadline = setTimeout(
    () => request.destroy(new Error('upstream_wall_clock_deadline')),
    runtime.requestTimeoutMs,
  );
  const abortUpstreamWhenClientLeaves = (): void => {
    if (!finished) {
      finished = true;
      cleanup();
      request.destroy(Object.assign(new Error('downstream_request_aborted'), { name: 'AbortError' }));
    }
  };
  const cleanup = (): void => {
    clearTimeout(wallClockDeadline);
    res.removeListener('close', abortUpstreamWhenClientLeaves);
    req.removeListener('aborted', abortUpstreamWhenClientLeaves);
  };
  wallClockDeadline.unref?.();
  res.once('close', abortUpstreamWhenClientLeaves);
  req.once('aborted', abortUpstreamWhenClientLeaves);
  request.on('timeout', () => request.destroy(new Error('upstream_timeout')));
  request.on('error', () => {
    if (finished) return;
    finished = true;
    cleanup();
    if (!res.headersSent && !res.destroyed) json(res, 503, { error: 'ollama_upstream_unavailable' });
    else if (!res.destroyed) res.destroy();
  });
  if (body) request.write(body);
  request.end();
}

type OllamaActiveModelResidency = 'resident' | 'not_loaded' | 'identity_mismatch' | 'probe_failed';

function classifyOllamaPsActiveModelResidency(
  statusCode: number | undefined,
  payload: unknown,
  activeModel: LocalModelManifestEntry = activeModelFromManifest(getLocalModelManifest({ fresh: true })),
): OllamaActiveModelResidency {
  if (statusCode !== 200 || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'probe_failed';
  }
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return 'probe_failed';
  if (models.length === 0) return 'not_loaded';
  if (models.length !== 1) return 'identity_mismatch';
  const activeTag = activeModel.ollamaTag;
  const model = models[0];
  if (!model || typeof model !== 'object' || Array.isArray(model)) return 'identity_mismatch';
  const record = model as { name?: unknown; model?: unknown; digest?: unknown };
  return (record.name === activeTag || record.model === activeTag)
    && ollamaModelDigestsEqual(record.digest, activeModel.digest)
    ? 'resident'
    : 'identity_mismatch';
}

export function ollamaPsHasActiveModel(
  statusCode: number | undefined,
  payload: unknown,
  activeModel: LocalModelManifestEntry = activeModelFromManifest(getLocalModelManifest({ fresh: true })),
): boolean {
  return classifyOllamaPsActiveModelResidency(statusCode, payload, activeModel) === 'resident';
}

function verifyActiveModelResidency(
  runtime: OllamaGatewayRuntime,
  activeModel: LocalModelManifestEntry,
  signal: AbortSignal,
  callback: (residency: OllamaActiveModelResidency) => void,
): void {
  if (signal.aborted) {
    callback('probe_failed');
    return;
  }
  let settled = false;
  let wallClockDeadline: NodeJS.Timeout | undefined;
  const settle = (residency: OllamaActiveModelResidency): void => {
    if (settled) return;
    settled = true;
    if (wallClockDeadline) clearTimeout(wallClockDeadline);
    signal.removeEventListener('abort', abort);
    callback(residency);
  };
  const request = http.request({
    host: runtime.upstreamHost,
    port: runtime.upstreamPort,
    path: '/api/ps',
    method: 'GET',
    timeout: runtime.residencyProbeTimeoutMs,
  }, (response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    response.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) request.destroy(new Error('residency_response_too_large'));
      else chunks.push(buffer);
    });
    response.on('end', () => {
      try {
        settle(classifyOllamaPsActiveModelResidency(
          response.statusCode,
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
          activeModel,
        ));
      } catch {
        settle('probe_failed');
      }
    });
  });
  wallClockDeadline = setTimeout(
    () => request.destroy(new Error('residency_wall_clock_deadline')),
    runtime.residencyProbeTimeoutMs,
  );
  wallClockDeadline.unref?.();
  const abort = (): void => {
    request.destroy(Object.assign(new Error('residency_request_aborted'), {
      name: 'AbortError',
    }));
  };
  request.on('timeout', () => request.destroy(new Error('residency_timeout')));
  request.on('error', () => settle('probe_failed'));
  signal.addEventListener('abort', abort, { once: true });
  request.end();
}

export function buildOllamaGatewayResidencyWarmBody(
  activeModel: LocalModelManifestEntry = activeModelFromManifest(getLocalModelManifest({ fresh: true })),
): Record<string, unknown> {
  return {
    model: activeModel.ollamaTag,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    think: false,
    stream: false,
    keep_alive: -1,
    options: {
      num_ctx: Math.min(1_024, activeModel.maxContextTokens),
      num_predict: 1,
      temperature: 0,
    },
  };
}

function warmActiveModelResidency(
  runtime: OllamaGatewayRuntime,
  manifest: LocalModelManifest,
  activeModel: LocalModelManifestEntry,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (runtime.now() < runtime.residencyWarmCooldownUntilMs) return Promise.resolve(false);
  const startedAt = runtime.now();
  const activeModelId = manifest.activeModelId;
  runtime.onEvent({
    event: 'ollama_gateway_residency_warm_started',
    activeModelId,
  });
  const warmAttempt = new Promise<boolean>((resolve) => {
    const body = Buffer.from(JSON.stringify(buildOllamaGatewayResidencyWarmBody(activeModel)), 'utf8');
    let settled = false;
    const settle = (resident: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(wallClockDeadline);
      signal.removeEventListener('abort', abort);
      resolve(resident);
    };
    const request = http.request({
      host: runtime.upstreamHost,
      port: runtime.upstreamPort,
      path: '/api/chat',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: runtime.residencyWarmTimeoutMs,
    }, (response) => {
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) request.destroy(new Error('residency_warm_response_too_large'));
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          settle(false);
          return;
        }
        verifyActiveModelResidency(
          runtime,
          activeModel,
          signal,
          (residency) => settle(residency === 'resident'),
        );
      });
    });
    const wallClockDeadline = setTimeout(
      () => request.destroy(new Error('residency_warm_wall_clock_deadline')),
      runtime.residencyWarmTimeoutMs,
    );
    wallClockDeadline.unref?.();
    const abort = (): void => {
      request.destroy(Object.assign(new Error('residency_warm_aborted'), {
        name: 'AbortError',
      }));
    };
    request.on('timeout', () => request.destroy(new Error('residency_warm_timeout')));
    request.on('error', () => settle(false));
    signal.addEventListener('abort', abort, { once: true });
    request.end(body);
  }).then((resident) => {
    if (signal.aborted) {
      runtime.onEvent({
        event: 'ollama_gateway_residency_warm_cancelled',
        activeModelId,
        durationMs: Math.max(0, runtime.now() - startedAt),
      });
      return false;
    }
    if (!resident) {
      runtime.residencyWarmCooldownUntilMs = runtime.now() + runtime.residencyWarmFailureCooldownMs;
    } else {
      runtime.residencyWarmCooldownUntilMs = 0;
    }
    runtime.onEvent({
      event: 'ollama_gateway_residency_warm_completed',
      activeModelId,
      success: resident,
      durationMs: Math.max(0, runtime.now() - startedAt),
      ...(resident ? {} : { cooldownUntilMs: runtime.residencyWarmCooldownUntilMs }),
    });
    return resident;
  });
  return warmAttempt;
}

function ensureActiveModelResidency(
  runtime: OllamaGatewayRuntime,
  manifest: LocalModelManifest,
  activeModel: LocalModelManifestEntry,
  signal: AbortSignal,
  callback: (resident: boolean) => void,
): void {
  verifyActiveModelResidency(runtime, activeModel, signal, (residency) => {
    if (residency === 'resident') {
      callback(true);
      return;
    }
    // Warming invokes the mutable active tag, so it is safe only when the
    // daemon authoritatively reports that no model is loaded. A present model
    // with missing/wrong identity, or an invalid probe, must fail without any
    // `/api/chat` dispatch—even the gateway-owned fixed warm request.
    if (residency !== 'not_loaded' || signal.aborted) {
      callback(false);
      return;
    }
    void warmActiveModelResidency(runtime, manifest, activeModel, signal).then(callback, () => callback(false));
  });
}

function startNextGatewayChat(runtime: OllamaGatewayRuntime): void {
  if (runtime.activeChatRequests !== 0) return;
  while (runtime.waitingChatRequests.length > 0) {
    const next = runtime.waitingChatRequests.shift()!;
    next.removeDisconnectListeners?.();
    // IncomingMessage is an auto-destroying readable stream: `destroyed`
    // becomes true after a fully consumed, healthy request body. Treat only
    // an actual abort (or a closed response) as queue abandonment.
    if (next.req.aborted || next.res.destroyed || next.res.writableEnded) continue;
    startGatewayChat(runtime, next);
    return;
  }
}

function startGatewayChat(runtime: OllamaGatewayRuntime, work: QueuedGatewayChat): void {
  runtime.activeChatRequests += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    work.res.removeListener('finish', release);
    work.res.removeListener('close', release);
    work.req.removeListener('aborted', release);
    runtime.activeChatRequests = Math.max(0, runtime.activeChatRequests - 1);
    startNextGatewayChat(runtime);
  };
  work.res.once('finish', release);
  work.res.once('close', release);
  work.req.once('aborted', release);
  try {
    work.start();
  } catch {
    release();
    json(work.res, 503, { error: 'gateway_chat_dispatch_failed' });
  }
}

function admitGatewayChat(
  runtime: OllamaGatewayRuntime,
  manifest: LocalModelManifest,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  start: () => void,
): void {
  const parallel = manifest.productionEnvelope.parallelGenerations;
  const maxWaiting = manifest.productionEnvelope.waitingQueueDepth;
  if (parallel !== 1 || !Number.isSafeInteger(maxWaiting) || maxWaiting! < 1) {
    json(res, 503, { error: 'manifest_concurrency_envelope_unavailable' });
    return;
  }
  const work: QueuedGatewayChat = { req, res, start };
  if (runtime.activeChatRequests < parallel) {
    startGatewayChat(runtime, work);
    return;
  }
  if (runtime.waitingChatRequests.length >= maxWaiting!) {
    json(res, 503, { error: 'gateway_chat_queue_full' });
    return;
  }
  const removeWaiting = (): void => {
    const index = runtime.waitingChatRequests.indexOf(work);
    if (index >= 0) runtime.waitingChatRequests.splice(index, 1);
    work.removeDisconnectListeners?.();
  };
  req.once('aborted', removeWaiting);
  res.once('close', removeWaiting);
  work.removeDisconnectListeners = () => {
    req.removeListener('aborted', removeWaiting);
    res.removeListener('close', removeWaiting);
  };
  runtime.waitingChatRequests.push(work);
}

function handle(runtime: OllamaGatewayRuntime, req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = req.method ?? 'GET';
  let apiPath: string;
  try {
    apiPath = new URL(req.url ?? '/', 'http://unix').pathname;
  } catch {
    req.resume();
    json(res, 400, { error: 'malformed_request_target' });
    return;
  }
  if (method === 'GET' && apiPath === '/health') {
    const loaded = runtime.readManifest();
    if (!loaded.ok) {
      json(res, 503, { ok: false, error: loaded.code });
      return;
    }
    json(res, 200, {
      ok: true,
      schemaVersion: loaded.manifest.schemaVersion,
      manifestVersion: loaded.manifest.manifestVersion,
      activeModelId: loaded.manifest.activeModelId,
      activeChatRequests: runtime.activeChatRequests,
      waitingChatRequests: runtime.waitingChatRequests.length,
      parallelGenerations: loaded.manifest.productionEnvelope.parallelGenerations,
      waitingQueueDepth: loaded.manifest.productionEnvelope.waitingQueueDepth,
    });
    return;
  }
  if (!isOllamaGatewayPathAllowed(method, apiPath)) {
    req.resume();
    json(res, 403, { error: 'gateway_path_or_method_forbidden' });
    return;
  }
  if (method === 'GET') {
    proxy(runtime, apiPath, method, undefined, req, res);
    return;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let requestRejected = false;
  let rejectedDrainDeadline: ReturnType<typeof setTimeout> | null = null;
  const clearRejectedDrainDeadline = (): void => {
    if (!rejectedDrainDeadline) return;
    clearTimeout(rejectedDrainDeadline);
    rejectedDrainDeadline = null;
  };
  req.once('close', clearRejectedDrainDeadline);
  req.on('data', (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (!requestRejected && bytes > runtime.maxRequestBytes) {
      requestRejected = true;
      chunks.length = 0;
      json(res, 413, { error: 'request_body_too_large' });
      // Keep consuming without retaining bytes so a well-behaved client can
      // receive the governed 413 instead of an EPIPE. A bounded absolute
      // deadline still cuts off a peer that keeps the rejected body open.
      rejectedDrainDeadline = setTimeout(
        () => req.destroy(new Error('rejected_request_drain_deadline')),
        Math.min(runtime.requestTimeoutMs, 1_000),
      );
      rejectedDrainDeadline.unref?.();
    }
    else if (!requestRejected) chunks.push(buffer);
  });
  req.on('error', () => {
    if (!res.headersSent) json(res, 400, { error: 'request_stream_error' });
  });
  req.on('end', () => {
    clearRejectedDrainDeadline();
    if (requestRejected || res.writableEnded) return;
    let parsed: unknown;
    const body = Buffer.concat(chunks);
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }
    const loaded = runtime.readManifest();
    if (!loaded.ok) {
      json(res, 503, { error: loaded.code });
      return;
    }
    const validationError = validateOllamaGatewayPostBody(apiPath, parsed, loaded.manifest);
    if (validationError) {
      json(res, 400, { error: validationError });
      return;
    }
    if (apiPath === '/api/chat') {
      admitGatewayChat(runtime, loaded.manifest, req, res, () => {
        const current = runtime.readManifest();
        if (!current.ok) {
          json(res, 503, { error: current.code });
          return;
        }
        const waitingQueueDepth = current.manifest.productionEnvelope.waitingQueueDepth;
        if (current.manifest.productionEnvelope.parallelGenerations !== 1
            || typeof waitingQueueDepth !== 'number'
            || !Number.isSafeInteger(waitingQueueDepth)
            || waitingQueueDepth < 1) {
          json(res, 503, { error: 'manifest_concurrency_envelope_unavailable' });
          return;
        }
        const currentValidationError = validateOllamaGatewayPostBody(apiPath, parsed, current.manifest);
        if (currentValidationError) {
          json(res, 409, { error: currentValidationError });
          return;
        }
        const currentActiveModel = activeModelFromManifest(current.manifest);
        const residencyAbort = new AbortController();
        const abortResidency = (): void => residencyAbort.abort();
        req.once('aborted', abortResidency);
        res.once('close', abortResidency);
        ensureActiveModelResidency(
          runtime,
          current.manifest,
          currentActiveModel,
          residencyAbort.signal,
          (resident) => {
            req.removeListener('aborted', abortResidency);
            res.removeListener('close', abortResidency);
            if (res.destroyed || res.writableEnded) return;
            if (!resident) {
              json(res, 503, { error: 'active_model_not_resident' });
              return;
            }
            proxy(runtime, apiPath, method, body, req, res);
          },
        );
      });
      return;
    }
    proxy(runtime, apiPath, method, body, req, res);
  });
}

export function startOllamaUnixGateway(
  socketPath = SOCKET_PATH,
  options: OllamaUnixGatewayOptions = {},
): http.Server {
  if (!socketPath) {
    throw new Error('OLLAMA_GATEWAY_SOCKET_PATH must select the staging or production socket leaf');
  }
  const resolvedSocketPath = safeSocketPath(socketPath);
  const runtime = createGatewayRuntime(options);
  const server = http.createServer((req, res) => handle(runtime, req, res));
  // Unix sockets inherit 0777 masked by the process umask. Apply 0177 before
  // bind so there is never a group/world-readable window between bind and the
  // defensive chmod in the listening callback.
  const previousUmask = process.umask(0o177);
  let umaskRestored = false;
  const restoreUmask = (): void => {
    if (umaskRestored) return;
    umaskRestored = true;
    process.umask(previousUmask);
  };
  server.once('error', restoreUmask);
  server.listen(resolvedSocketPath, () => {
    try {
      fs.chmodSync(resolvedSocketPath, 0o600);
      runtime.onEvent({ event: 'ollama_gateway_ready', socketPath: resolvedSocketPath });
    } finally {
      restoreUmask();
      server.removeListener('error', restoreUmask);
    }
  });
  return server;
}

if (require.main === module) {
  const socketPath = SOCKET_PATH;
  const server = startOllamaUnixGateway(socketPath);
  const shutdown = (): void => {
    server.close(() => {
      try {
        const stat = fs.lstatSync(socketPath);
        if (stat.isSocket()) fs.unlinkSync(socketPath);
      } catch { /* already removed */ }
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
