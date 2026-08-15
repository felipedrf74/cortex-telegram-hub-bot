// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildContentEngineScriptCategory,
  buildLocalPrimaryShadowCategory,
  CLASSIFIER_SHADOW_JOB_NAME,
  CONTENT_ENGINE_SCRIPT_CATEGORY,
  isLongFormScriptDuration,
  isContentEngineScriptCategory,
  isInferenceShadowAttribution,
  LOCAL_PRIMARY_SHADOW_JOB_NAME,
} from '../../src/services/local-inference-vocabulary';

describe('local-primary attribution vocabulary', () => {
  it('keeps TS writers and readers on one exact vocabulary', () => {
    expect(buildContentEngineScriptCategory('standard')).toBe('content_engine_script_standard');
    expect(buildContentEngineScriptCategory(' Standard ')).toBe('content_engine_script_standard');
    expect(isContentEngineScriptCategory('content_engine_script_standard_openai_fallback')).toBe(true);
    expect(buildLocalPrimaryShadowCategory('ios_chat_message'))
      .toBe('local_primary_shadow:ios_chat_message');
    expect(isInferenceShadowAttribution({ jobName: CLASSIFIER_SHADOW_JOB_NAME })).toBe(true);
    expect(isInferenceShadowAttribution({
      baseCategory: 'local_primary_shadow:ios_chat_message',
    })).toBe(true);
    expect(isLongFormScriptDuration(180)).toBe(false);
    expect(isLongFormScriptDuration(181)).toBe(true);
  });

  it('mirrors the shared constants in the Python Content Engine boundary', () => {
    const source = readFileSync(
      resolve(__dirname, '../../content-engine/services/inference_vocabulary.py'),
      'utf8',
    );
    expect(source).toContain(`LOCAL_PRIMARY_SHADOW_JOB_NAME = "${LOCAL_PRIMARY_SHADOW_JOB_NAME}"`);
    expect(source).toContain(`CONTENT_ENGINE_SCRIPT_CATEGORY = "${CONTENT_ENGINE_SCRIPT_CATEGORY}"`);
    expect(source).toContain(`LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX = f"{LOCAL_PRIMARY_SHADOW_JOB_NAME}:"`);
  });
});
