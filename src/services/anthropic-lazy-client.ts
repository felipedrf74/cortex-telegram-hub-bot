// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { isAnthropicRuntimeEnabled } from './runtime-flags';

export interface LazyAnthropicClientOptions {
  maxRetries?: number;
}

export interface LazyAnthropicClient {
  get(): Anthropic;
  peekForTest(): Anthropic | null;
  resetForTest(): void;
}

export function createLazyAnthropicClient(options: LazyAnthropicClientOptions = {}): LazyAnthropicClient {
  let client: Anthropic | null = null;

  return {
    get(): Anthropic {
      if (!isAnthropicRuntimeEnabled()) {
        throw new Error('ANTHROPIC_RUNTIME_DISABLED');
      }
      if (!client) {
        client = new Anthropic({
          apiKey: config.anthropic.apiKey,
          maxRetries: options.maxRetries,
        });
      }
      return client;
    },
    peekForTest(): Anthropic | null {
      return client;
    },
    resetForTest(): void {
      client = null;
    },
  };
}
