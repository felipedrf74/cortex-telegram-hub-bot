// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OllamaTransportError,
  ollamaTransportFetch,
} from '../../src/services/ollama-transport';

describe('Ollama Unix transport', () => {
  it('surfaces a missing governed socket as a typed transport failure', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-missing-ollama-socket-'));
    const socketPath = path.join(directory, 'missing.sock');
    try {
      await expect(ollamaTransportFetch({
        baseUrl: 'http://127.0.0.1:11434',
        socketPath,
      }, '/api/version')).rejects.toMatchObject({
        name: 'OllamaTransportError',
        code: 'OLLAMA_LOCAL_TRANSPORT_UNAVAILABLE',
        systemCode: 'ENOENT',
        socketPath,
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the typed error distinguishable from ordinary request failures', () => {
    const error = new OllamaTransportError('ECONNREFUSED', '/run/nexus-inference/ollama.sock');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('OLLAMA_LOCAL_TRANSPORT_UNAVAILABLE');
  });

  it('preserves a typed account-deletion cancellation reason', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-cancelled-ollama-socket-'));
    const socketPath = path.join(directory, 'missing.sock');
    const controller = new AbortController();
    const reason = Object.assign(new Error('account_deletion_in_progress'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    controller.abort(reason);
    try {
      await expect(ollamaTransportFetch({
        baseUrl: 'http://127.0.0.1:11434',
        socketPath,
      }, '/api/version', {
        signal: controller.signal,
      })).rejects.toBe(reason);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
