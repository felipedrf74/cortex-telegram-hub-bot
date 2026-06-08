import { describe, expect, it } from 'vitest';

import {
  CHAT_ACTION_REGISTRY,
  getChatActionRegistry,
} from '../../src/services/chat/registry';

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[a-z]{2,}/i;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}/;
const PLACEHOLDER_HOSTS = new Set([
  'nexushub.test',
  'example.com',
  'example.org',
  'example.net',
  'placeholder.test',
  'invalid',
]);

const INJECTION_MARKERS = [
  /ignore previous instructions/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|system\|>/i,
  /<\|user\|>/i,
  /<\|assistant\|>/i,
  /system prompt:/i,
  /you are now/i,
  /forget everything above/i,
];

const FORBIDDEN_SLOT_KEYS = new Set([
  'userId',
  'user_id',
  'userID',
  'tenantId',
  'tenant_id',
  'tenantID',
  'accountId',
  'account_id',
  'accountID',
  'ownerUserId',
  'ownerId',
  'owner',
  '__proto__',
  'prototype',
  'constructor',
  'customerId',
  'subjectId',
  'principalId',
  'memberId',
  'actorId',
]);

const VALID_EXECUTOR_PATTERN = /^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)+$/;

type RawExample = {
  text: string;
  expectedSlots?: Record<string, unknown>;
  tags?: string[];
  locale?: string;
};

function isPlaceholderEmail(match: string): boolean {
  const host = match.split('@')[1]?.toLowerCase();
  if (!host) return false;
  for (const safe of PLACEHOLDER_HOSTS) {
    if (host === safe || host.endsWith(`.${safe}`)) return true;
  }
  return false;
}

describe('chat-action-registry lint', () => {
  const registry = getChatActionRegistry();

  describe('executor dispatch keys (sanity)', () => {
    it('every executor follows the namespaced.identifier pattern', () => {
      for (const entry of registry) {
        expect(
          VALID_EXECUTOR_PATTERN.test(entry.executor),
          `${entry.skill}.${entry.action}: executor "${entry.executor}" is not a valid namespaced dispatch key`,
        ).toBe(true);
      }
    });

    it('executor namespace prefixes are kept to a small known set', () => {
      const allowed = new Set([
        'task_store',
        'unified_calendar',
        'unified_mail',
        'mail',
        'training',
        'content',
        'cooking',
        'finance',
        'stripe',
        'connections',
        'notifications',
        'secretary',
        'decisionCenter',
        'daily_brief_orchestrator',
      ]);
      const seen = new Set<string>();
      for (const entry of registry) {
        const prefix = entry.executor.split('.')[0];
        seen.add(prefix);
        expect(
          allowed.has(prefix),
          `${entry.skill}.${entry.action}: executor prefix "${prefix}" is not in the allowed namespace set`,
        ).toBe(true);
      }
    });
  });

  describe('examples — PII / placeholder discipline', () => {
    it('no example text contains real email addresses (only placeholder hosts allowed)', () => {
      for (const entry of registry) {
        const examples = (entry.examples ?? []) as RawExample[];
        for (const example of examples) {
          const match = example.text.match(EMAIL_PATTERN);
          if (!match) continue;
          expect(
            isPlaceholderEmail(match[0]),
            `${entry.skill}.${entry.action}: example "${example.text}" contains non-placeholder email "${match[0]}"`,
          ).toBe(true);
        }
      }
    });

    it('no example text contains phone-shaped patterns', () => {
      for (const entry of registry) {
        const examples = (entry.examples ?? []) as RawExample[];
        for (const example of examples) {
          expect(
            PHONE_PATTERN.test(example.text),
            `${entry.skill}.${entry.action}: example "${example.text}" contains a phone-shaped pattern`,
          ).toBe(false);
        }
      }
    });
  });

  describe('examples — injection markers gated by tags', () => {
    it('injection markers only appear in examples tagged "prompt_injection"', () => {
      for (const entry of registry) {
        const examples = (entry.examples ?? []) as RawExample[];
        for (const example of examples) {
          const matched = INJECTION_MARKERS.find((pattern) => pattern.test(example.text));
          if (!matched) continue;
          const tags = Array.isArray(example.tags) ? example.tags : [];
          expect(
            tags.includes('prompt_injection') || tags.includes('adversarial'),
            `${entry.skill}.${entry.action}: example "${example.text}" matches injection marker ${matched} but is not tagged prompt_injection/adversarial`,
          ).toBe(true);
        }
      }
    });
  });

  describe('examples — expectedSlots cannot carry identity keys', () => {
    it('no expectedSlots key is a forbidden identity key', () => {
      for (const entry of registry) {
        const examples = (entry.examples ?? []) as RawExample[];
        for (const example of examples) {
          const slots = example.expectedSlots;
          if (!slots) continue;
          for (const key of Object.keys(slots)) {
            const normalized = key.replace(/[^a-zA-Z0-9]/g, '');
            expect(
              FORBIDDEN_SLOT_KEYS.has(key) || FORBIDDEN_SLOT_KEYS.has(normalized),
              `${entry.skill}.${entry.action}: example "${example.text}" expectedSlots contains forbidden key "${key}"`,
            ).toBe(false);
          }
        }
      }
    });

    it('expectedSlots values are not raw provider object IDs (heuristic: long opaque tokens)', () => {
      const SUSPICIOUS_ID_PATTERN = /^[A-Za-z0-9_-]{20,}$/;
      for (const entry of registry) {
        const examples = (entry.examples ?? []) as RawExample[];
        for (const example of examples) {
          const slots = example.expectedSlots;
          if (!slots) continue;
          for (const [key, value] of Object.entries(slots)) {
            if (typeof value !== 'string') continue;
            // Allow placeholder-style values that contain underscores or angle brackets
            if (value.startsWith('<') || value.includes(' ') || value.includes('-tz')) continue;
            if (key === 'provider' || key === 'priority' || key === 'sport' || key === 'goal') continue;
            expect(
              SUSPICIOUS_ID_PATTERN.test(value),
              `${entry.skill}.${entry.action}: example "${example.text}" expectedSlots["${key}"] looks like a raw provider ID: "${value}"`,
            ).toBe(false);
          }
        }
      }
    });
  });

  describe('examples — locale tag (when present) is one of the documented codes', () => {
    it('locale tag, when present, is en/pt/es/mixed', () => {
      const allowed = new Set(['en', 'pt', 'es', 'mixed']);
      for (const entry of registry) {
        const examples = (entry.examples ?? []) as RawExample[];
        for (const example of examples) {
          if (example.locale === undefined) continue;
          expect(
            allowed.has(example.locale),
            `${entry.skill}.${entry.action}: example locale "${example.locale}" is not one of en/pt/es/mixed`,
          ).toBe(true);
        }
      }
    });
  });

  describe('registry shape sanity', () => {
    it('CHAT_ACTION_REGISTRY array does not have undefined entries', () => {
      for (const entry of CHAT_ACTION_REGISTRY) {
        expect(entry).toBeTruthy();
      }
    });

    it('every entry survives the default-applying lazy aggregator (getChatActionRegistry)', () => {
      expect(getChatActionRegistry().length).toBe(CHAT_ACTION_REGISTRY.length);
    });
  });
});
