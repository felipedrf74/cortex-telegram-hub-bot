import { describe, expect, it } from 'vitest';
import {
  buildChannelLearnerExtractionPrompt,
  buildChannelLearnerSynthesisPrompt,
} from '../../src/services/channel-learner';

const NON_FOUNDER_PROFILE = {
  languagePreference: 'en-US',
  audience: '25-45 women',
  pillars: ['knitting'],
  niches: ['knitting tutorials'],
};

const FORBIDDEN = [
  'pt-BR',
  'PT-BR',
  'Portuguese-language',
  'Portuguese',
  'fitness + commentary',
  '18-40',
  'faith',
  'carnivore',
  'Felipe',
];

const sampleVideos = [{
  videoId: 'abc123',
  title: 'Cable sweater mistakes',
  description: 'How to fix common cable pattern mistakes.',
  publishedAt: '2026-05-01T00:00:00.000Z',
  viewCount: 12000,
  likeCount: 900,
  commentCount: 44,
  duration: 'PT10M',
  channelTitle: 'Fiber Studio',
}] as any[];

function assertClean(prompt: string): void {
  for (const token of FORBIDDEN) {
    expect(prompt).not.toContain(token);
  }
  expect(prompt).toContain('en-US');
  expect(prompt).toContain('25-45 women');
  expect(prompt).toContain('knitting');
}

describe('channel-learner prompt cleanliness', () => {
  it('uses per-tenant creator profile in extraction prompts', () => {
    assertClean(buildChannelLearnerExtractionPrompt('Fiber Studio', sampleVideos, NON_FOUNDER_PROFILE));
  });

  it('uses per-tenant creator profile in synthesis prompts', () => {
    assertClean(buildChannelLearnerSynthesisPrompt(NON_FOUNDER_PROFILE));
  });
});
