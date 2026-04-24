// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  areGlobalInvoiceVendorsEnabled,
  canUseAnthropicRuntimeFallback,
  getAICallTimeoutMs,
  getGeminiDomainAllowlist,
  getGeminiIncludeSecretaryEnvOverride,
  getGeminiRoutingEnvOverride,
  isAnthropicRuntimeEnabled,
  isSecretaryHaikuRoutingEnabled,
  isTelegramLegacyDeliveryEnabled,
} from '../../src/services/runtime-flags';

describe('runtime-flags', () => {
  it('treats only literal true as enabled for anthropic and telegram runtime flags', () => {
    expect(isAnthropicRuntimeEnabled({ ANTHROPIC_ENABLED: 'true' })).toBe(true);
    expect(isAnthropicRuntimeEnabled({ ANTHROPIC_ENABLED: 'yes' })).toBe(false);
    expect(isAnthropicRuntimeEnabled({})).toBe(false);

    expect(isTelegramLegacyDeliveryEnabled({ TELEGRAM_LEGACY_DELIVERY: 'true' })).toBe(true);
    expect(isTelegramLegacyDeliveryEnabled({ TELEGRAM_LEGACY_DELIVERY: '1' })).toBe(false);
    expect(isTelegramLegacyDeliveryEnabled({})).toBe(false);

    expect(areGlobalInvoiceVendorsEnabled({ FISCAL_ENABLE_GLOBAL_BUILTIN_VENDORS: 'true' })).toBe(true);
    expect(areGlobalInvoiceVendorsEnabled({ FISCAL_ENABLE_GLOBAL_BUILTIN_VENDORS: '1' })).toBe(false);
    expect(areGlobalInvoiceVendorsEnabled({})).toBe(false);
  });

  it('requires both runtime enablement and an api key for anthropic fallback use', () => {
    expect(
      canUseAnthropicRuntimeFallback({ ANTHROPIC_ENABLED: 'true', ANTHROPIC_API_KEY: 'key' }),
    ).toBe(true);
    expect(
      canUseAnthropicRuntimeFallback({ ANTHROPIC_ENABLED: 'true', ANTHROPIC_API_KEY: '' }),
    ).toBe(false);
    expect(
      canUseAnthropicRuntimeFallback({ ANTHROPIC_ENABLED: 'false', ANTHROPIC_API_KEY: 'key' }),
    ).toBe(false);
  });

  it('parses ai timeout defensively and falls back for invalid values', () => {
    expect(getAICallTimeoutMs({ AI_CALL_TIMEOUT_MS: '45000' })).toBe(45000);
    expect(getAICallTimeoutMs({ AI_CALL_TIMEOUT_MS: '0' })).toBe(30000);
    expect(getAICallTimeoutMs({ AI_CALL_TIMEOUT_MS: 'not-a-number' })).toBe(30000);
    expect(getAICallTimeoutMs({})).toBe(30000);
  });

  it('parses gemini routing overrides and domain allowlist consistently', () => {
    expect(getGeminiRoutingEnvOverride({ GEMINI_ROUTING_ENABLED: 'true' })).toBe(true);
    expect(getGeminiRoutingEnvOverride({ GEMINI_ROUTING_ENABLED: 'false' })).toBe(false);
    expect(getGeminiRoutingEnvOverride({ GEMINI_ROUTING_ENABLED: 'maybe' })).toBeNull();
    expect(getGeminiIncludeSecretaryEnvOverride({ GEMINI_INCLUDE_SECRETARY: 'true' })).toBe(true);
    expect(getGeminiIncludeSecretaryEnvOverride({ GEMINI_INCLUDE_SECRETARY: 'nope' })).toBeNull();
    expect(
      getGeminiDomainAllowlist({ GEMINI_DOMAINS: 'triathlon, content , finance,, cooking ' }),
    ).toEqual(['triathlon', 'content', 'finance', 'cooking']);
  });

  it('treats secretary haiku routing as an explicit opt-in only', () => {
    expect(isSecretaryHaikuRoutingEnabled({ SECRETARY_HAIKU_ROUTING_ENABLED: 'true' })).toBe(true);
    expect(isSecretaryHaikuRoutingEnabled({ SECRETARY_HAIKU_ROUTING_ENABLED: 'false' })).toBe(false);
    expect(isSecretaryHaikuRoutingEnabled({})).toBe(false);
  });
});
