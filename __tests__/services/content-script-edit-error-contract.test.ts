// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { mapContentScriptEditInferenceError } from '../../src/services/content-script-edit-error-contract';
import { SkillInferencePolicyError } from '../../src/services/skill-inference-account-lifecycle';

describe('Content script edit public inference error contract', () => {
  it('preserves closed local-primary errors without forwarding internal details', () => {
    const mapped = mapContentScriptEditInferenceError(new SkillInferencePolicyError(
      'INFERENCE_EMPTY_OUTPUT',
      'provider-owned message',
      502,
      { body: 'private provider response', model: 'internal-model' },
    ));

    expect(mapped).toEqual({
      code: 'INFERENCE_EMPTY_OUTPUT',
      message: 'Local inference returned no usable edit; the original script was preserved.',
      status: 502,
      details: { originalPreserved: true },
    });
    expect(JSON.stringify(mapped)).not.toContain('private provider response');
    expect(JSON.stringify(mapped)).not.toContain('internal-model');
  });

  it('maps raw local provider failures to one sanitized retryable response', () => {
    const mapped = mapContentScriptEditInferenceError(new SkillInferencePolicyError(
      'provider_unhealthy',
      'LocalLLMError: provider_unhealthy {"body":"raw response excerpt"}',
      502,
      { body: 'raw response excerpt' },
    ));

    expect(mapped).toEqual({
      code: 'CONTENT_SCRIPT_EDIT_UNAVAILABLE',
      message: 'Content script editing is temporarily unavailable; the original script was preserved.',
      status: 503,
      retryAfterSeconds: 60,
      details: { originalPreserved: true },
    });
    expect(JSON.stringify(mapped)).not.toContain('raw response excerpt');
  });

  it('maps local input-token overflow to the existing bounded input error', () => {
    expect(mapContentScriptEditInferenceError(new SkillInferencePolicyError(
      'input_token_overflow',
      'raw local error',
      413,
      { estimatedInputTokens: 999_999 },
    ))).toEqual({
      code: 'CONTENT_SCRIPT_INPUT_TOO_LARGE',
      message: 'The script edit context exceeds the supported model input size; the original script was preserved.',
      status: 413,
      details: { originalPreserved: true },
    });
  });
});
