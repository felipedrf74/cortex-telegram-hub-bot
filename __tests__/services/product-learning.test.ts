import { describe, expect, it } from 'vitest';
import { promoteLearningCase, validateLearningCase, type LearningCase } from '../../src/services/product-learning';

const observed = (): LearningCase => ({
  id: 'training-capacity-correction-1',
  tenantId: 42,
  owner: 'training',
  lifecycle: 'observed',
  privacyClass: 'redacted-product',
  redactedInput: { conflictType: 'capacity', accepted: false },
  expectedContract: { outcome: 'ask-before-moving-immovable-session' },
  evidenceReferences: ['ci://run/123/case/1'],
  observedAt: '2026-07-15T00:00:00.000Z',
});

describe('governed product learning', () => {
  it('rejects raw private fields', () => {
    expect(validateLearningCase({ ...observed(), redactedInput: { calendarContents: 'private' } }))
      .toContain('redaction_failed');
  });

  it('requires review and evidence before golden promotion', () => {
    expect(() => promoteLearningCase({ ...observed(), evidenceReferences: [] }, 'golden'))
      .toThrow(/golden_requires_evidence/);
    expect(promoteLearningCase(observed(), 'golden').lifecycle).toBe('golden');
  });
});
