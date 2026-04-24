// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  buildSignalSummary,
  buildSignalTitle,
  formatSignalDigest,
  localizeKnowledgeCategoryLabel,
  localizeVoiceEntryLabel,
  summarizeContentJobStatus,
  summarizeOptimizationStatus,
  truncateText,
} from '../../src/api/routes/content-home-route-utils';

const signal = (overrides: Record<string, any>) => ({
  id: 42,
  signal_type: 'pillar_performance',
  payload: {},
  priority: 'high',
  created_at: '2026-04-20T12:00:00.000Z',
  ...overrides,
} as any);

describe('content home route utilities', () => {
  it('summarizes content job state deterministically', () => {
    expect(summarizeContentJobStatus('failed', 3)).toBe('degraded');
    expect(summarizeContentJobStatus('running', 3)).toBe('syncing');
    expect(summarizeContentJobStatus(undefined, 1)).toBe('ready');
    expect(summarizeContentJobStatus('never', 0)).toBe('warming_up');
  });

  it('summarizes optimization state across both background jobs', () => {
    expect(summarizeOptimizationStatus('success', 'failed', 4)).toBe('degraded');
    expect(summarizeOptimizationStatus('running', 'success', 4)).toBe('syncing');
    expect(summarizeOptimizationStatus('never', 'never', 2)).toBe('ready');
    expect(summarizeOptimizationStatus('never', 'never', 0)).toBe('warming_up');
  });

  it('localizes signal titles and summaries for Portuguese content home cards', () => {
    const contentSignal = signal({
      payload: {
        pillar: 'training',
        summary: 'hooks with recovery angle are retaining better',
      },
    });

    expect(buildSignalTitle(contentSignal, 'pt-PT')).toBe('Treino');
    expect(buildSignalSummary(contentSignal, 'pt-PT')).toBe(
      'Performance de Treino: hooks with recovery angle are retaining better',
    );
  });

  it('formats compact signal digests with localized fallback copy', () => {
    expect(formatSignalDigest(signal({
      signal_type: 'reaction_opportunity',
      payload: {},
      priority: 'medium',
    }), 'en')).toEqual({
      id: 42,
      type: 'reaction_opportunity',
      title: 'Reaction opportunity',
      summary: 'There is a short reaction window worth moving on quickly.',
      priority: 'medium',
      createdAt: '2026-04-20T12:00:00.000Z',
    });
  });

  it('localizes voice labels and category fallbacks', () => {
    expect(localizeVoiceEntryLabel('Hook Styles', 'pt-PT')).toBe('Estilos de hook');
    expect(localizeKnowledgeCategoryLabel(
      'brand_voice',
      [{ category: 'brand_voice', label: 'Brand Voice' }],
      'pt-BR',
    )).toBe('Voz da marca');
    expect(localizeKnowledgeCategoryLabel('new_category', [], 'en')).toBe('New Category');
  });

  it('truncates without leaving trailing whitespace before the ellipsis', () => {
    expect(truncateText('A compact idea that should trim cleanly', 18)).toBe('A compact idea th…');
    expect(truncateText('Short', 20)).toBe('Short');
  });
});
