// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { normalizeContentOutputLanguage } from './content-output-language';
import { localPrimaryInferenceConfig } from './local-primary-config';
import { getLocalInferenceRuntimeControl } from './local-inference-runtime-control';
import { isLocalInferenceUserEnrolled } from './local-inference-enrollment';

export type ScriptGenerationMode = 'draft' | 'quick' | 'standard' | 'deep';
export type ScriptRenderMode = 'structured' | 'chat';
export type ScriptStyle = 'detailed' | 'bullets';
export type ScriptProviderBoundary = <T>(providerCall: () => Promise<T>) => Promise<T>;
export interface ScriptRuntimeOptions {
  operationId?: string;
  abortSignal?: AbortSignal;
  /** Server-authored composite used for research; never accepted from clients. */
  researchQuery?: string;
  /** Pin the authenticated route's admission decision across the Python hop. */
  localPrimaryAdmitted?: boolean;
}

export function isContentLocalPrimaryAdmitted(userId: number | undefined): boolean {
  if (!localPrimaryInferenceConfig.contentProxyEnabled
      || !Number.isSafeInteger(userId) || Number(userId) <= 0) return false;
  const control = getLocalInferenceRuntimeControl();
  return control.mode === 'active'
    || (control.mode === 'canary'
      && isLocalInferenceUserEnrolled(Number(userId), control.rolloutPercent));
}

export function normalizeScriptLanguage(language?: string | null): string {
  return typeof language === 'string' && language.trim()
    ? normalizeContentOutputLanguage(language)
    : 'en-US';
}

export function normalizeScriptRenderMode(renderMode?: string | null): ScriptRenderMode {
  return String(renderMode || 'structured').trim().toLowerCase() === 'chat' ? 'chat' : 'structured';
}

export function normalizeScriptStyle(style?: string | null): ScriptStyle {
  return ['bullet', 'bullets', 'outline', 'pontos'].includes(String(style || 'detailed').trim().toLowerCase())
    ? 'bullets'
    : 'detailed';
}
