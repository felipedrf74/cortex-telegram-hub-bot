import { describe, expect, it } from 'vitest';
import { buildVideoStudySystemPrompt } from '../../src/services/video-study';

const NON_FOUNDER_PROFILE = {
  languagePreference: 'en-US',
  audience: '25-45 women',
  pillars: ['knitting'],
  niches: ['knitting tutorials'],
};

const FORBIDDEN = [
  'pt-BR',
  'PT-BR',
  'Portuguese',
  '18-40',
  'faith',
  'carnivore',
  'Felipe',
];

describe('video-study prompt cleanliness', () => {
  it('uses per-tenant creator profile instead of founder defaults', () => {
    const prompt = buildVideoStudySystemPrompt(NON_FOUNDER_PROFILE);

    for (const token of FORBIDDEN) {
      expect(prompt).not.toContain(token);
    }
    expect(prompt).toContain('en-US');
    expect(prompt).toContain('25-45 women');
    expect(prompt).toContain('knitting');
  });

  it('treats platform timing and audience-response guidance as bounded hypotheses', () => {
    const prompt = buildVideoStudySystemPrompt(NON_FOUNDER_PROFILE);

    expect(prompt).toContain('use transcript timestamps rather than assuming a universal duration');
    expect(prompt).toContain('bounded review hypotheses');
    expect(prompt).not.toContain('viral potential');
    expect(prompt).not.toContain('aim for 30-60s');
    expect(prompt).not.toContain('Detailed first-30s breakdown');
    expect(prompt).not.toContain('FIRST 30 SECONDS (HOOK)');
  });
});
