// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const CONTENT_CREATOR_PROFILE_WRITABLE_FIELDS = [
  'pillars',
  'niches',
  'audience',
  'platforms',
  'voiceRules',
  'preferredFormats',
  'dislikedTopics',
  'bannedTopics',
  'trustedSources',
  'dislikedSources',
  'contentGoals',
  'languagePreference',
  'voiceExamples',
] as const;

type ContentCreatorProfileWritableField = typeof CONTENT_CREATOR_PROFILE_WRITABLE_FIELDS[number];

const STRING_ARRAY_FIELDS = new Set<ContentCreatorProfileWritableField>([
  'pillars',
  'niches',
  'voiceRules',
  'preferredFormats',
  'dislikedTopics',
  'bannedTopics',
  'trustedSources',
  'dislikedSources',
  'contentGoals',
  'voiceExamples',
]);

export class ContentCreatorProfileValidationError extends Error {
  readonly code = 'CONTENT_CREATOR_PROFILE_INVALID';
  readonly status = 400;

  constructor(
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentCreatorProfileValidationError';
  }
}

/**
 * Reject malformed partial updates before they can be sanitized into empty
 * values and overwrite an existing private profile. Trimming remains a normal
 * write-boundary normalization; structural loss and truncation do not.
 */
export function assertContentCreatorProfilePatch(
  input: unknown,
): asserts input is Record<ContentCreatorProfileWritableField, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalidProfile('Body must be an object.', '$', 'invalid_type');
  }

  const profile = input as Record<string, unknown>;
  const keys = Object.keys(profile);
  const unknownField = keys.find((key) => (
    !(CONTENT_CREATOR_PROFILE_WRITABLE_FIELDS as readonly string[]).includes(key)
  ));
  if (unknownField) {
    throw invalidProfile('Creator profile contains an unsupported field.', unknownField, 'unknown_field');
  }
  if (keys.length === 0) {
    throw invalidProfile('Creator profile update must include at least one writable field.', '$', 'empty_patch');
  }

  for (const field of CONTENT_CREATOR_PROFILE_WRITABLE_FIELDS) {
    if (!(field in profile)) continue;
    const value = profile[field];
    if (STRING_ARRAY_FIELDS.has(field)) {
      const maxItems = field === 'voiceExamples' ? 25 : 50;
      const maxChars = field === 'voiceExamples' ? 600 : 240;
      assertBoundedStringArray(value, field, maxItems, maxChars);
      continue;
    }
    if (field === 'platforms') {
      assertPlatforms(value);
      continue;
    }
    if (typeof value !== 'string') {
      throw invalidProfile(`${field} must be a string.`, field, 'invalid_type');
    }
    const maxChars = field === 'audience' ? 1_500 : 80;
    if (value.trim().length > maxChars) {
      throw invalidProfile(`${field} exceeds its safe length.`, field, 'too_large', { maxChars });
    }
  }
}

function assertBoundedStringArray(
  value: unknown,
  field: string,
  maxItems: number,
  maxChars: number,
): void {
  if (!Array.isArray(value)) {
    throw invalidProfile(`${field} must be an array of strings.`, field, 'invalid_type');
  }
  if (value.length > maxItems) {
    throw invalidProfile(`${field} contains too many entries.`, field, 'too_many_items', { maxItems });
  }
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryField = `${field}[${index}]`;
    if (typeof entry !== 'string') {
      throw invalidProfile(`${entryField} must be a string.`, entryField, 'invalid_type');
    }
    const length = entry.trim().length;
    if (length === 0) {
      throw invalidProfile(`${entryField} must not be empty.`, entryField, 'empty_value');
    }
    if (length > maxChars) {
      throw invalidProfile(`${entryField} exceeds its safe length.`, entryField, 'too_large', { maxChars });
    }
  }
}

function assertPlatforms(value: unknown): void {
  if (!Array.isArray(value)) {
    throw invalidProfile('platforms must be an array.', 'platforms', 'invalid_type');
  }
  if (value.length > 25) {
    throw invalidProfile('platforms contains too many entries.', 'platforms', 'too_many_items', { maxItems: 25 });
  }
  for (let index = 0; index < value.length; index += 1) {
    const platform = value[index];
    const field = `platforms[${index}]`;
    if (!platform || typeof platform !== 'object' || Array.isArray(platform)) {
      throw invalidProfile(`${field} must be an object.`, field, 'invalid_type');
    }
    const record = platform as Record<string, unknown>;
    const unknownKey = Object.keys(record).find((key) => !['name', 'cadence', 'enabled'].includes(key));
    if (unknownKey) {
      throw invalidProfile(
        `${field} contains an unsupported field.`,
        `${field}.${unknownKey}`,
        'unknown_field',
      );
    }
    if (typeof record.name !== 'string' || !record.name.trim()) {
      throw invalidProfile(`${field}.name must be a non-empty string.`, `${field}.name`, 'invalid_value');
    }
    if (record.name.trim().length > 80) {
      throw invalidProfile(`${field}.name exceeds its safe length.`, `${field}.name`, 'too_large', { maxChars: 80 });
    }
    if (record.cadence !== undefined && typeof record.cadence !== 'string') {
      throw invalidProfile(`${field}.cadence must be a string.`, `${field}.cadence`, 'invalid_type');
    }
    if (typeof record.cadence === 'string' && record.cadence.trim().length > 80) {
      throw invalidProfile(`${field}.cadence exceeds its safe length.`, `${field}.cadence`, 'too_large', { maxChars: 80 });
    }
    if (record.enabled !== undefined && typeof record.enabled !== 'boolean') {
      throw invalidProfile(`${field}.enabled must be a boolean.`, `${field}.enabled`, 'invalid_type');
    }
  }
}

function invalidProfile(
  message: string,
  field: string,
  reason: string,
  details: Record<string, unknown> = {},
): ContentCreatorProfileValidationError {
  return new ContentCreatorProfileValidationError(message, { field, reason, ...details });
}
