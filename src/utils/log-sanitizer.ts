// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const REDACTION = '[Redacted]';
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;

const SENSITIVE_KEY_RE = /(?:^|[_-])(?:authorization|cookie|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|api[_-]?key|provider[_-]?key|email|destination[_-]?email|phone|address|prompt|system[_-]?prompt|raw[_-]?prompt|completion|response[_-]?text|messages?|memory|references?|draft|script|voice[_-]?profile|calendar|event[_-]?(?:title|description|body|text|content)?|health|hrv|heart[_-]?rate|body[_-]?battery|sleep|finance|amount|merchant|vendor|tax[_-]?due|gross[_-]?income|source[_-]?(?:snippet|text|content)s?|attachment[_-]?content|file[_-]?content|tool[_-]?output|provider[_-]?(?:response|error|message))(?:$|[_-])/i;

const TEXT_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTION}`],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{12,}/gi, REDACTION],
  [
    /\b(access_token|refresh_token|id_token|client_secret|api_key|token|secret|password|authorization|cookie)=([^&\s]+)/gi,
    `$1=${REDACTION}`,
  ],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[RedactedEmail]'],
  [
    /(["']?(?:access_token|refresh_token|id_token|client_secret|api_key|token|secret|password|authorization|cookie)["']?\s*[:=]\s*["'])([^"'\n]{4,})(["'])/gi,
    `$1${REDACTION}$3`,
  ],
  [
    /\b(prompt|systemPrompt|rawPrompt|completion|responseText|messages|memory|references|draft|script|voiceProfile)\s*[:=]\s*["']?.{4,}?(?=\s+(?:access_token|refresh_token|id_token|client_secret|api_key|token|secret|password|authorization|cookie|prompt|systemPrompt|rawPrompt|completion|responseText|messages|memory|references|draft|script|voiceProfile)\s*[:=]|$)/gi,
    `$1=${REDACTION}`,
  ],
];

export function sanitizeLogText(value: string): string {
  let sanitized = value;
  for (const [pattern, replacement] of TEXT_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

export function isSensitiveLogKey(key: string): boolean {
  const camelSeparated = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return SENSITIVE_KEY_RE.test(key) || SENSITIVE_KEY_RE.test(camelSeparated);
}

export function sanitizeLogValue(value: unknown, key = '', depth = 0): unknown {
  if (key && isSensitiveLogKey(key)) return REDACTION;
  if (value == null) return value;

  if (typeof value === 'string') return sanitizeLogText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogText(value.message),
      stack: value.stack ? sanitizeLogText(value.stack) : undefined,
    };
  }

  if (depth >= MAX_DEPTH) return '[Truncated]';

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLogValue(item, '', depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[Truncated ${value.length - MAX_ARRAY_ITEMS} items]`);
    return items;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
    for (const [childKey, childValue] of entries) {
      out[childKey] = sanitizeLogValue(childValue, childKey, depth + 1);
    }
    if (Object.keys(value as Record<string, unknown>).length > MAX_OBJECT_KEYS) {
      out.__truncated = true;
    }
    return out;
  }

  return value;
}

export function stringifySanitizedLogContext(value: unknown, maxLength?: number): string | null {
  try {
    const json = JSON.stringify(sanitizeLogValue(value));
    return typeof maxLength === 'number' ? json.slice(0, maxLength) : json;
  } catch {
    return null;
  }
}
