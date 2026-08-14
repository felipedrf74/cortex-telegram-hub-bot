// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import http from 'node:http';

const MAX_GATEWAY_RESPONSE_BYTES = 32 * 1024 * 1024;

export interface OllamaTransportOptions {
  baseUrl: string;
  socketPath?: string;
}

export class OllamaTransportError extends Error {
  readonly code = 'OLLAMA_LOCAL_TRANSPORT_UNAVAILABLE';

  constructor(readonly systemCode: string, readonly socketPath: string) {
    super(`Ollama local transport is unavailable (${systemCode})`);
    this.name = 'OllamaTransportError';
  }
}

const UNAVAILABLE_SOCKET_CODES = new Set(['EACCES', 'ENOENT', 'ENOTSOCK', 'ECONNREFUSED']);

/**
 * Fetch an Ollama API path either directly (development/rollback) or through
 * the production Unix socket. The caller still owns its AbortSignal timeout.
 */
export async function ollamaTransportFetch(
  transport: OllamaTransportOptions,
  apiPath: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!apiPath.startsWith('/api/')) throw new Error('Ollama transport path must start with /api/');
  const socketPath = transport.socketPath?.trim();
  if (!socketPath) return fetch(`${transport.baseUrl}${apiPath}`, init);
  if (!socketPath.startsWith('/') || socketPath.includes('\0')) {
    throw new Error('OLLAMA_GATEWAY_SOCKET_PATH must be an absolute Unix socket path');
  }

  const body = init.body == null
    ? undefined
    : typeof init.body === 'string' || Buffer.isBuffer(init.body)
      ? init.body
      : String(init.body);
  const headers = Object.fromEntries(new Headers(init.headers).entries());

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const request = http.request({
      socketPath,
      path: apiPath,
      method: init.method ?? 'GET',
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_GATEWAY_RESPONSE_BYTES) {
          request.destroy(new Error('Ollama gateway response exceeded limit'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
          else if (value !== undefined) responseHeaders.set(name, String(value));
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: response.statusCode ?? 502,
          statusText: response.statusMessage,
          headers: responseHeaders,
        }));
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      const systemCode = typeof (error as NodeJS.ErrnoException).code === 'string'
        ? String((error as NodeJS.ErrnoException).code)
        : '';
      reject(UNAVAILABLE_SOCKET_CODES.has(systemCode)
        ? new OllamaTransportError(systemCode, socketPath)
        : error);
    });
    const abort = () => {
      const reason = init.signal?.reason;
      request.destroy(reason instanceof Error
        ? reason
        : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    };
    const cleanupAbort = () => init.signal?.removeEventListener('abort', abort);
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener('abort', abort, { once: true });
    if (body !== undefined) request.write(body);
    request.end();
  });
}
