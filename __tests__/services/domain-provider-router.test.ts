// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProviderForDomain,
  getFallbackForDomain,
  getDomainProviderConfig,
} from '../../src/services/domain-provider-router';

describe('Domain Provider Router', () => {
  describe('getProviderForDomain', () => {
    // April 2026 revision — no Claude models as primary ANYWHERE.
    // Every domain (including secretary, which previously used Sonnet for
    // tool-use quality) now defaults to Gemini 3 Flash. Anthropic stays
    // wired in as the fallback so provider-fallback.ts has a safety net.
    it('every domain routes to gemini by default', () => {
      expect(getProviderForDomain('secretary')).toBe('gemini');
      expect(getProviderForDomain('triathlon')).toBe('gemini');
      expect(getProviderForDomain('content')).toBe('gemini');
      expect(getProviderForDomain('finance')).toBe('gemini');
      expect(getProviderForDomain('cooking')).toBe('gemini');
    });
  });

  describe('getFallbackForDomain', () => {
    // Every domain falls back to Anthropic (Haiku 4.5) when the primary
    // Gemini provider errors or circuit-breaks. Secretary previously fell
    // back to OpenAI but now shares the Anthropic fallback with the other
    // domains — one fewer provider wired into the production config.
    it('every domain falls back to anthropic', () => {
      expect(getFallbackForDomain('secretary')).toBe('anthropic');
      expect(getFallbackForDomain('triathlon')).toBe('anthropic');
      expect(getFallbackForDomain('content')).toBe('anthropic');
      expect(getFallbackForDomain('finance')).toBe('anthropic');
      expect(getFallbackForDomain('cooking')).toBe('anthropic');
    });
  });

  describe('getDomainProviderConfig', () => {
    it('returns config for all 5 domains', () => {
      const config = getDomainProviderConfig();
      expect(config).toHaveLength(5);
      const domains = config.map(c => c.domain);
      expect(domains).toContain('secretary');
      expect(domains).toContain('triathlon');
      expect(domains).toContain('content');
      expect(domains).toContain('finance');
      expect(domains).toContain('cooking');
    });

    it('each config entry has required fields', () => {
      const config = getDomainProviderConfig();
      for (const entry of config) {
        expect(entry).toHaveProperty('domain');
        expect(entry).toHaveProperty('provider');
        expect(entry).toHaveProperty('fallback');
        expect(entry).toHaveProperty('geminiEnabled');
      }
    });
  });
});
