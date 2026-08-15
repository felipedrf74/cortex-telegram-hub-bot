// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/** Stable attribution vocabulary shared by local-primary writers and readers. */
export const LOCAL_PRIMARY_SHADOW_JOB_NAME = 'local_primary_shadow';
export const LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX = `${LOCAL_PRIMARY_SHADOW_JOB_NAME}:`;
export const CLASSIFIER_SHADOW_JOB_NAME = 'classify_shadow';
export const LONG_FORM_SCRIPT_THRESHOLD_SECONDS = 3 * 60;

export const CONTENT_ENGINE_SCRIPT_CATEGORY = 'content_engine_script';
export const CONTENT_ENGINE_DEEP_SEARCH_CATEGORY = 'content_engine_deepsearch';

export function isLongFormScriptDuration(targetDurationSeconds: number): boolean {
  return Number.isFinite(targetDurationSeconds)
    && targetDurationSeconds > LONG_FORM_SCRIPT_THRESHOLD_SECONDS;
}

export function buildLocalPrimaryShadowCategory(baseCategory: string): string {
  return `${LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX}${baseCategory}`.slice(0, 160);
}

export function isLocalPrimaryShadowCategory(category: string | null | undefined): boolean {
  return typeof category === 'string'
    && category.trim().toLowerCase().startsWith(LOCAL_PRIMARY_SHADOW_CATEGORY_PREFIX);
}

export function isInferenceShadowAttribution(input: {
  jobName?: string | null;
  baseCategory?: string | null;
}): boolean {
  return input.jobName === LOCAL_PRIMARY_SHADOW_JOB_NAME
    || input.jobName === CLASSIFIER_SHADOW_JOB_NAME
    || isLocalPrimaryShadowCategory(input.baseCategory)
    || input.baseCategory === CLASSIFIER_SHADOW_JOB_NAME;
}

export function buildContentEngineScriptCategory(mode: string): string {
  return `${CONTENT_ENGINE_SCRIPT_CATEGORY}_${mode.trim().toLowerCase()}`;
}

export function isContentEngineScriptCategory(category: string): boolean {
  const normalized = category.trim().toLowerCase();
  return normalized === CONTENT_ENGINE_SCRIPT_CATEGORY
    || normalized.startsWith(`${CONTENT_ENGINE_SCRIPT_CATEGORY}_`);
}
