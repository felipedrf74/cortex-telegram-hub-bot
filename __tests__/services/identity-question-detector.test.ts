// Phase 14 batch 76 (2026-05-16): identity-question detector tests.
//
// Tests the consolidated detector that the chat-message route now imports
// from `src/services/identity-question-detector.ts` (was inline regex
// array in `src/api/routes/chat-message-local-responses.ts`). The new
// module also adds Spanish coverage.

import { describe, expect, it } from 'vitest';

import { isAuthenticatedIdentityQuestion } from '../../src/services/identity-question-detector';

describe('isAuthenticatedIdentityQuestion (Phase 14 batch 76)', () => {
  it.each([
    'Who am I?',
    'who am i signed in as',
    "What's my name?",
    'Do you know who I am?',
    'Which account am I using?',
    'Quem sou eu?',
    'qual é o meu nome',
    'Como me chamo?',
    'Quién soy?',
    'Cómo me llamo?',
    'Cuál es mi nombre',
  ])('detects identity question "%s"', (text) => {
    expect(isAuthenticatedIdentityQuestion(text)).toBe(true);
  });

  it.each([
    'Schedule a meeting tomorrow',
    'Show my agenda',
    "What's the weather like",
    'Pay the credit card',
  ])('does not flag non-identity question "%s"', (text) => {
    expect(isAuthenticatedIdentityQuestion(text)).toBe(false);
  });
});
