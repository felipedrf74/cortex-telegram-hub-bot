// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const SECRET_ASSIGNMENT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: /\b((?:provider[_\s-]?)?(?:access[_\s-]?token|refresh[_\s-]?token)|provider[_\s-]?token|oauth[_\s-]?(?:token|credentials?)|client[_\s-]?secret|api[_\s-]?key)\s*[:=]\s*["']?[^"',\s}\]]+/gi,
    replacement: '$1=[REDACTED]',
  },
  {
    pattern: /\b((?:raw[_\s-]?)?system[_\s-]?prompt|developer[_\s-]?prompt|internal[_\s-]?prompt)\s*:\s*.+$/gim,
    replacement: '$1: [REDACTED]',
  },
];

export function redactSensitivePromptText(value: string): string {
  return SECRET_ASSIGNMENT_PATTERNS.reduce(
    (text, rule) => text.replace(rule.pattern, rule.replacement),
    value,
  );
}

export function sanitizeLlmPromptValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitivePromptText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeLlmPromptValue(item));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = sanitizeLlmPromptValue(child);
  }
  return out;
}
