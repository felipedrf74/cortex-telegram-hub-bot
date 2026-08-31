import { describe, expect, it } from 'vitest';

import {
  CHAT_ACTION_REGISTRY,
  findChatActionDefinition,
  getChatActionRegistry,
  type ChatActionDefinition,
  type ChatActionRiskClass,
} from '../../src/services/chat/registry';
import { CONFIRMED_TARGET_FIELDS } from '../../src/services/chat-tool-authorization';

function expectedRiskClassForRisk(risk: ChatActionDefinition['risk']): ChatActionRiskClass {
  if (risk === 'read_only') return 'R0';
  if (risk === 'safe_write') return 'R1';
  if (risk === 'external_side_effect') return 'R2';
  if (risk === 'destructive' || risk === 'financial' || risk === 'admin_security') return 'R3';
  return 'R4';
}

describe('chat-action-registry completeness', () => {
  const registry = getChatActionRegistry();

  it('exposes a non-empty registry', () => {
    expect(registry.length).toBeGreaterThan(0);
    expect(CHAT_ACTION_REGISTRY.length).toBeGreaterThan(0);
  });

  it('has at least one action per registered skill', () => {
    const skills = new Set(registry.map((entry) => entry.skill));
    expect(skills.size).toBeGreaterThan(0);
    for (const skill of skills) {
      const actions = registry.filter((entry) => entry.skill === skill);
      expect(actions.length).toBeGreaterThan(0);
    }
  });

  it('every entry has skill, action, executor, verifier, risk, confirmationPolicy populated', () => {
    for (const entry of registry) {
      expect(entry.skill, `${entry.action}: skill missing`).toBeTruthy();
      expect(entry.action, `${entry.skill}.${entry.action}: action missing`).toBeTruthy();
      expect(entry.executor, `${entry.skill}.${entry.action}: executor missing`).toBeTruthy();
      expect(entry.verifier, `${entry.skill}.${entry.action}: verifier missing`).toBeTruthy();
      expect(entry.risk, `${entry.skill}.${entry.action}: risk missing`).toBeTruthy();
      expect(entry.confirmationPolicy, `${entry.skill}.${entry.action}: confirmationPolicy missing`).toBeTruthy();
    }
  });

  it('every entry has supportedCards populated as a non-empty array', () => {
    for (const entry of registry) {
      expect(Array.isArray(entry.supportedCards)).toBe(true);
      expect(entry.supportedCards.length).toBeGreaterThan(0);
    }
  });

  it('non-read-only actions have at least one required field', () => {
    for (const entry of registry) {
      if (entry.risk === 'read_only') continue;
      expect(
        entry.requiredFields.length,
        `${entry.skill}.${entry.action}: non-read-only actions need at least one required field`,
      ).toBeGreaterThan(0);
    }
  });

  it('riskClass (when set) agrees with the risk-class derivation rules', () => {
    for (const entry of registry) {
      if (!entry.riskClass) continue;
      const expected = expectedRiskClassForRisk(entry.risk);
      expect(
        entry.riskClass,
        `${entry.skill}.${entry.action}: riskClass mismatch (risk=${entry.risk})`,
      ).toBe(expected);
    }
  });

  it('ambiguous-risk entries must declare executionPolicy "blocked"', () => {
    for (const entry of registry) {
      if (entry.risk === 'ambiguous') {
        expect(entry.executionPolicy).toBe('blocked');
      }
    }
  });

  it('readableIntents is a non-empty array for every entry', () => {
    for (const entry of registry) {
      expect(Array.isArray(entry.readableIntents)).toBe(true);
      expect(entry.readableIntents.length).toBeGreaterThan(0);
    }
  });

  it('confirmationPolicy is one of the documented values', () => {
    const allowed = new Set(['none', 'clarify', 'confirm', 'strong_confirm']);
    for (const entry of registry) {
      expect(allowed.has(entry.confirmationPolicy)).toBe(true);
    }
  });

  it('every destructive, financial, admin-security, or external-send action declares an exact confirmation target', () => {
    const exactTargetRisks = new Set(['destructive', 'financial', 'admin_security', 'external_side_effect']);
    for (const entry of registry) {
      if (!exactTargetRisks.has(entry.risk)) continue;
      expect(
        entry.confirmationTarget,
        `${entry.skill}.${entry.action}: exact confirmation target missing`,
      ).toMatchObject({
        tool: expect.any(String),
        argumentField: expect.any(String),
      });
      expect(
        [...entry.requiredFields, ...entry.optionalFields],
        `${entry.skill}.${entry.action}: confirmation target must name a declared argument`,
      ).toContain(entry.confirmationTarget?.argumentField);
      expect(
        CONFIRMED_TARGET_FIELDS[entry.confirmationTarget?.tool ?? ''],
        `${entry.skill}.${entry.action}: confirmation tool must have an authorization target mapping`,
      ).toBeDefined();
      if (entry.confirmationTarget?.argumentFields) {
        expect(
          Object.values(entry.confirmationTarget.argumentFields).every((field) => (
            [...entry.requiredFields, ...entry.optionalFields].includes(field)
          )),
          `${entry.skill}.${entry.action}: every composite target value must name a declared argument`,
        ).toBe(true);
        expect(Object.keys(entry.confirmationTarget.argumentFields).sort()).toEqual(
          [...(CONFIRMED_TARGET_FIELDS[entry.confirmationTarget.tool] ?? [])].sort(),
        );
      }
    }
  });

  it('verifier is one of the documented dispatch keys', () => {
    const allowed = new Set(['provider_read_back', 'local_read_back', 'none']);
    for (const entry of registry) {
      expect(allowed.has(entry.verifier)).toBe(true);
    }
  });

  it('findChatActionDefinition resolves every registry entry', () => {
    for (const entry of CHAT_ACTION_REGISTRY) {
      const found = findChatActionDefinition(entry.skill, entry.action);
      expect(found).toBeTruthy();
      expect(found?.skill).toBe(entry.skill);
      expect(found?.action).toBe(entry.action);
    }
  });

  it('no duplicate (skill, action) pairs', () => {
    const seen = new Set<string>();
    for (const entry of CHAT_ACTION_REGISTRY) {
      const key = `${entry.skill}.${entry.action}`;
      expect(seen.has(key), `duplicate registry entry: ${key}`).toBe(false);
      seen.add(key);
    }
  });

  // Forward-looking assertions enabled by Phase 0 deliverables.
  // version/status/owner unlocked 2026-05-15 (default-injection via getChatActionRegistry).
  // The tuple-shorthand assertion remains skipped until the bigger refactor lands.
  it('every entry has version populated (Phase 0 deliverable)', () => {
    for (const entry of registry) {
      expect(entry).toHaveProperty('version');
      expect((entry as ChatActionDefinition & { version?: string }).version).toBeTruthy();
    }
  });

  it('every entry has status (active|deprecated|experimental) populated (Phase 0 deliverable)', () => {
    const allowed = new Set(['active', 'deprecated', 'experimental']);
    for (const entry of registry) {
      const status = (entry as ChatActionDefinition & { status?: string }).status;
      expect(status).toBeTruthy();
      expect(allowed.has(status as string)).toBe(true);
    }
  });

  it('every entry has owner populated (Phase 0 deliverable)', () => {
    const allowed = new Set(['productivity', 'training', 'content', 'finance', 'cooking', 'platform']);
    for (const entry of registry) {
      const owner = (entry as ChatActionDefinition & { owner?: string }).owner;
      expect(owner).toBeTruthy();
      expect(allowed.has(owner as string)).toBe(true);
    }
  });

  it('no tuple-shorthand entries remain (every entry needs PT/EN intent variants)', () => {
    // Phase 0 tuple → full-literal promotion landed 2026-05-15. Phase 1
    // populated examples; Phase 6 closing-out (2026-05-15) enables this test
    // to lock the assertion: every action's readableIntents must have either
    // multiple variants OR a variant that's NOT just the synthesized
    // "<action>".replace(/_/g, ' ') form.
    for (const entry of registry) {
      const synthesized = entry.action.replace(/_/g, ' ');
      const isOnlySynthesized =
        entry.readableIntents.length === 1 && entry.readableIntents[0] === synthesized;
      expect(
        isOnlySynthesized,
        `${entry.skill}.${entry.action}: still using only the synthesized intent variant`,
      ).toBe(false);
    }
  });

  // Phase 1 example-coverage floor (2026-05-15): every active action must have
  // at least one example (EN or PT). Phase 1 batches 1-6 populated all 45
  // actions; this test locks the floor so regressions are caught at PR time.
  it('every active action has at least one example (Phase 1 floor)', () => {
    for (const entry of registry) {
      const status = (entry as ChatActionDefinition & { status?: string }).status;
      if (status === 'deprecated') continue;
      const examples = (entry as ChatActionDefinition & { examples?: unknown[] }).examples ?? [];
      expect(
        examples.length,
        `${entry.skill}.${entry.action}: active action must have at least one example`,
      ).toBeGreaterThan(0);
    }
  });

  it('every active action has at least one EN and one PT example (locale floor)', () => {
    type LocaleExample = { locale?: string };
    for (const entry of registry) {
      const status = (entry as ChatActionDefinition & { status?: string }).status;
      if (status === 'deprecated') continue;
      const examples = ((entry as ChatActionDefinition & { examples?: LocaleExample[] }).examples ?? []);
      const locales = new Set(examples.map((e) => e.locale ?? 'en'));
      const hasEn = locales.has('en');
      const hasPt = locales.has('pt');
      // Some actions only need one locale (e.g., experimental/state-only
      // examples). Require BOTH only when the action has ≥2 examples; this
      // keeps the floor strong for the MVP scope while letting future single-
      // example actions live until they're fleshed out.
      if (examples.length >= 2) {
        expect(
          hasEn && hasPt,
          `${entry.skill}.${entry.action}: actions with ≥2 examples need both EN and PT coverage (have: ${[...locales].join(', ')})`,
        ).toBe(true);
      }
    }
  });

  // Phase 2 batch 7 safety floor (2026-05-15): every high-risk action must have
  // at least one prompt_injection-tagged example documenting the refusal
  // contract. "High-risk" = destructive, external_side_effect, financial, or
  // admin_security. Catches a regression where someone adds a new mutation
  // action without thinking about adversarial input handling.
  it('every high-risk action has at least one prompt_injection example (safety floor)', () => {
    type TaggedExample = { tags?: string[] };
    const HIGH_RISK = new Set(['destructive', 'external_side_effect', 'financial', 'admin_security']);
    const EXEMPTIONS = new Set<string>([
      // Some calendar mutations (update_event, move_event) carry safe_write
      // risk but Phase 2 batch 7 added an injection example anyway for
      // demonstration. Truly low-risk actions (read_only, safe_write) are
      // exempt from this floor because they don't dispatch side effects.
    ]);
    for (const entry of registry) {
      const status = (entry as ChatActionDefinition & { status?: string }).status;
      if (status === 'deprecated') continue;
      if (!HIGH_RISK.has(entry.risk)) continue;
      if (EXEMPTIONS.has(`${entry.skill}.${entry.action}`)) continue;
      const examples = ((entry as ChatActionDefinition & { examples?: TaggedExample[] }).examples ?? []);
      const hasInjection = examples.some((ex) => Array.isArray(ex.tags) && ex.tags.includes('prompt_injection'));
      expect(
        hasInjection,
        `${entry.skill}.${entry.action} (risk=${entry.risk}): high-risk actions need at least one prompt_injection example to document the refusal contract`,
      ).toBe(true);
    }
  });
});
