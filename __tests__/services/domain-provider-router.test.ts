// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getProviderForDomain,
  getFallbackForDomain,
  getDomainProviderConfig,
} from '../../src/services/domain-provider-router';

describe('Domain Provider Router', () => {
  describe('getProviderForDomain', () => {
    it('secretary always routes to anthropic', () => {
      expect(getProviderForDomain('secretary')).toBe('anthropic');
    });

    // Note: Other domains return 'anthropic' when GEMINI_ROUTING_ENABLED=false (default in tests)
    it('non-secretary domains default to anthropic when Gemini disabled', () => {
      expect(getProviderForDomain('triathlon')).toBe('anthropic');
      expect(getProviderForDomain('content')).toBe('anthropic');
      expect(getProviderForDomain('finance')).toBe('anthropic');
      expect(getProviderForDomain('cooking')).toBe('anthropic');
    });
  });

  describe('getFallbackForDomain', () => {
    it('secretary fallback is openai', () => {
      expect(getFallbackForDomain('secretary')).toBe('openai');
    });

    it('non-secretary fallback is anthropic', () => {
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
