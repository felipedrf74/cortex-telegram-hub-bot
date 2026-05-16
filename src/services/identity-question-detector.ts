// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 14 batch 76 (2026-05-16): identity-question detector extracted from
// `src/api/routes/chat-message-local-responses.ts` as part of the Phase 0
// audit MERGE-2 item (inline phrase regexes scattered across the codebase).
//
// Detects messages where the user is asking the bot "who am I?" — these
// route to a deterministic identity-reflection response instead of through
// the chat planner. Coverage:
//   • EN: "who am I", "what's my name", "which account am I using"
//   • PT (PT-PT + PT-BR): "quem sou eu", "qual o meu nome", "como me chamo"

const IDENTITY_QUESTION_PATTERNS: readonly RegExp[] = [
  /\bwho am i\b/,
  /\bwho am i signed in as\b/,
  /\bwhat(?:'s| s| is) my name\b/,
  /\bdo you know who i am\b/,
  /\bwhich account am i using\b/,
  /\bwhich user am i\b/,
  /\bquem sou eu\b/,
  /\bquem eu sou\b/,
  /\bquem sou\b/,
  /\bqual e o meu nome\b/,
  /\bqual e meu nome\b/,
  /\bcomo me chamo\b/,
  /\bsabes quem sou\b/,
  /\bvoce sabe quem eu sou\b/,
  /\bque conta estou a usar\b/,
  /\bqual usuario sou eu\b/,
  // Phase 14 batch 76: Spanish identity questions.
  /\bquien soy\b/,
  /\bquien soy yo\b/,
  /\bcual es mi nombre\b/,
  /\bcomo me llamo\b/,
];

export function normalizeIdentityQuestion(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[?!.,;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAuthenticatedIdentityQuestion(text: string): boolean {
  const normalized = normalizeIdentityQuestion(text);
  return IDENTITY_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized));
}
