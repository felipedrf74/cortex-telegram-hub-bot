// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Input Validation & Sanitization Utilities
 *
 * Central module for validating and sanitizing all external input
 * before it enters business logic, database queries, or AI prompts.
 */

// ── Constants ───────────────────────────────────────────────────────

/** Maximum length for a user text message (Telegram limit is 4096, but we cap for AI cost) */
export const MAX_MESSAGE_LENGTH = 4096;

/** Maximum length for photo captions */
export const MAX_CAPTION_LENGTH = 1024;

/** Maximum file size for photo processing (10 MB) */
export const MAX_PHOTO_SIZE_BYTES = 10 * 1024 * 1024;

/** Patterns that attempt to override system prompt context */
const PROMPT_INJECTION_PATTERNS = [
  /\[(?:system|current\s*state|instructions?|context)\]/i,
  /(?:^|\n)\s*(?:you\s+are|ignore\s+(?:all\s+)?(?:previous|above|prior))/i,
  /ignore\s+all\s+(?:previous|above|prior)\s+instructions?/i,
  /(?:^|\n)\s*(?:new\s+instructions?|override\s+(?:system|instructions?))/i,
  /(?:^|\n)\s*(?:forget\s+(?:everything|all|your))/i,
  /\bsystem\s*:\s*/i,
];

// ── Message Validation ──────────────────────────────────────────────

/**
 * Validates and trims a user text message.
 * Returns null if the message is invalid (empty or too long).
 */
export function validateMessage(text: string | undefined | null): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_MESSAGE_LENGTH) return null;
  return trimmed;
}

/**
 * Validates a photo caption.
 * Returns the trimmed caption or empty string if invalid/missing.
 */
export function validateCaption(caption: string | undefined | null): string {
  if (!caption) return '';
  const trimmed = caption.trim();
  if (trimmed.length > MAX_CAPTION_LENGTH) return trimmed.slice(0, MAX_CAPTION_LENGTH);
  return trimmed;
}

/**
 * Validates file size for photo processing.
 */
export function isFileSizeValid(sizeBytes: number | undefined): boolean {
  if (sizeBytes === undefined) return true; // Telegram may not always report size
  return sizeBytes > 0 && sizeBytes <= MAX_PHOTO_SIZE_BYTES;
}

// ── Prompt Injection Defense ────────────────────────────────────────

/**
 * Detects prompt injection attempts in user input.
 * Returns true if suspicious patterns are found.
 */
export function detectPromptInjection(text: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Wraps user content with clear delimiters to prevent prompt injection.
 * The delimiters make it unambiguous to the AI model where user content
 * starts and ends, preventing users from injecting fake context blocks.
 */
export function sandboxUserContent(userMessage: string): string {
  return `<user_message>\n${userMessage}\n</user_message>`;
}

/**
 * Builds a safe context prefix for AI calls.
 * Wraps state context in XML-style tags and user message in separate tags,
 * preventing user content from impersonating state context.
 */
export function buildSafeContextMessage(stateContext: string, userMessage: string): string {
  if (!stateContext) {
    return sandboxUserContent(userMessage);
  }
  return `<state_context>\n${stateContext}\n</state_context>\n\n${sandboxUserContent(userMessage)}`;
}

// ── SQL Safety ──────────────────────────────────────────────────────

/**
 * Validates that a column name is in an allowed whitelist.
 * Prevents SQL injection through dynamic column names.
 */
export function validateColumnName(name: string, allowedColumns: readonly string[]): boolean {
  return allowedColumns.includes(name);
}

// ── Error Sanitization ──────────────────────────────────────────────

/** Patterns that may leak sensitive info in error messages */
const SENSITIVE_ERROR_PATTERNS = [
  /sk-ant-[a-zA-Z0-9-]+/g,           // Anthropic API keys
  /sk-[a-zA-Z0-9]{20,}/g,            // OpenAI API keys
  /AIza[a-zA-Z0-9_-]{35}/g,          // Google API keys
  /bot\d+:[a-zA-Z0-9_-]{35}/gi,      // Telegram bot tokens
  /(?:\/home\/|\/Users\/)[^\s'"]+/g,  // File system paths
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // Email addresses
  /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, // IP addresses
];

/**
 * Sanitizes error messages before they reach users or AI context.
 * Strips API keys, file paths, emails, and IP addresses.
 */
export function sanitizeErrorMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SENSITIVE_ERROR_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}
