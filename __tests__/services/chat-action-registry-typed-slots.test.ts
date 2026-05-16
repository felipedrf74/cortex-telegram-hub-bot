// Phase 11 batch 59 (2026-05-16): typed slot-extractor / slot-validator
// function refs.
//
// The Phase 0 audit flagged the registry's slotExtractors / slotValidators
// fields as label-only strings that aren't connected to actual functions.
// This batch adds typed `SlotExtractor` / `SlotValidator` interfaces and
// helpers that prefer the typed form when present, falling back to the
// legacy string labels for backwards-compatibility.
//
// Tests cover:
//   • Type shape — required fields on SlotExtractor / SlotValidator
//   • makeRequiredFieldsValidator factory — correct missing detection
//   • getSlotExtractors / getSlotValidators — typed wins over string,
//     string falls back to label-only no-op shape, no-validator entries
//     get the auto-required-fields validator
//   • getSlotExtractorNames / getSlotValidatorNames — string lists
//   • runSlotValidators — aggregates errors + missing across multiple
//     typed validators

import { describe, expect, it } from 'vitest';

import {
  getSlotExtractorNames,
  getSlotExtractors,
  getSlotValidatorNames,
  getSlotValidators,
  makeRequiredFieldsValidator,
  runSlotValidators,
  type ChatActionDefinition,
  type SlotExtractor,
  type SlotValidator,
} from '../../src/services/chat-action-registry';

function makeEntry(overrides: Partial<ChatActionDefinition>): ChatActionDefinition {
  return {
    skill: 'tasks',
    action: 'create_task',
    readableIntents: ['create a task'],
    requiredFields: ['title'],
    optionalFields: [],
    providerDependencies: ['nexus'],
    risk: 'safe_write',
    confirmationPolicy: 'none',
    executor: 'tasks.create_task',
    verifier: 'local_read_back',
    supportedCards: [],
    ...overrides,
  };
}

describe('makeRequiredFieldsValidator (Phase 11 batch 59)', () => {
  it('returns ok when every required field is present', () => {
    const v = makeRequiredFieldsValidator(['title', 'dueDate']);
    const result = v.validate({ title: 'Write tests', dueDate: '2026-05-17' });
    expect(result.ok).toBe(true);
    expect(result.missing).toBeUndefined();
  });

  it('returns the missing field names when any are absent', () => {
    const v = makeRequiredFieldsValidator(['title', 'dueDate']);
    const result = v.validate({ title: 'Write tests' });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['dueDate']);
  });

  it('treats null and undefined and empty string as missing', () => {
    const v = makeRequiredFieldsValidator(['title']);
    expect(v.validate({ title: null }).ok).toBe(false);
    expect(v.validate({ title: undefined }).ok).toBe(false);
    expect(v.validate({ title: '' }).ok).toBe(false);
    expect(v.validate({ title: 'real' }).ok).toBe(true);
  });

  it('uses the provided name + auto-generated label', () => {
    const v = makeRequiredFieldsValidator(['a', 'b'], 'custom_name');
    expect(v.name).toBe('custom_name');
    expect(v.label).toBe('requires: a, b');
  });
});

describe('getSlotExtractors / getSlotExtractorNames (Phase 11 batch 59)', () => {
  it('returns typed extractors when defined on the entry', () => {
    const ext: SlotExtractor = {
      name: 'date_extractor',
      extract: (text) => ({ slots: { date: text } }),
    };
    const entry = makeEntry({ typedSlotExtractors: [ext] });
    const got = getSlotExtractors(entry);
    expect(got).toHaveLength(1);
    expect(got[0]).toBe(ext);
  });

  it('falls back to label-only shape when only the legacy string list is set', () => {
    const entry = makeEntry({ slotExtractors: ['llm_only'] });
    const got = getSlotExtractors(entry);
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('llm_only');
    // Label-only fallback: extract function exists but is a no-op.
    expect(got[0].extract('any text', {})).toEqual({ slots: {} });
  });

  it('returns the names regardless of which storage form the entry uses', () => {
    const stringEntry = makeEntry({ slotExtractors: ['a', 'b'] });
    expect(getSlotExtractorNames(stringEntry)).toEqual(['a', 'b']);
    const typedEntry = makeEntry({
      typedSlotExtractors: [
        { name: 'c', extract: () => ({ slots: {} }) },
        { name: 'd', extract: () => ({ slots: {} }) },
      ],
    });
    expect(getSlotExtractorNames(typedEntry)).toEqual(['c', 'd']);
  });
});

describe('getSlotValidators / getSlotValidatorNames (Phase 11 batch 59)', () => {
  it('returns typed validators when defined on the entry', () => {
    const v: SlotValidator = {
      name: 'custom',
      validate: () => ({ ok: false, errors: { x: 'bad' } }),
    };
    const entry = makeEntry({ typedSlotValidators: [v] });
    expect(getSlotValidators(entry)[0]).toBe(v);
  });

  it('auto-generates a required-fields validator when no validators are configured', () => {
    const entry = makeEntry({ slotValidators: undefined, requiredFields: ['title', 'dueDate'] });
    const got = getSlotValidators(entry);
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('required_fields');
    expect(got[0].validate({ title: 'x', dueDate: 'y' }).ok).toBe(true);
    expect(got[0].validate({ title: 'x' }).ok).toBe(false);
  });

  it('exposes string-name accessor that prefers typed names', () => {
    const stringEntry = makeEntry({ slotValidators: ['a', 'b'] });
    expect(getSlotValidatorNames(stringEntry)).toEqual(['a', 'b']);
    const typedEntry = makeEntry({
      typedSlotValidators: [
        { name: 'c', validate: () => ({ ok: true }) },
      ],
    });
    expect(getSlotValidatorNames(typedEntry)).toEqual(['c']);
  });

  it('falls back to <field>_required style names when nothing is configured', () => {
    const entry = makeEntry({ slotValidators: undefined, requiredFields: ['title', 'dueDate'] });
    expect(getSlotValidatorNames(entry)).toEqual(['title_required', 'dueDate_required']);
  });
});

describe('runSlotValidators (Phase 11 batch 59)', () => {
  it('returns ok when every typed validator passes', () => {
    const a: SlotValidator = { name: 'a', validate: () => ({ ok: true }) };
    const b: SlotValidator = { name: 'b', validate: () => ({ ok: true }) };
    const entry = makeEntry({ typedSlotValidators: [a, b] });
    expect(runSlotValidators(entry, {})).toEqual({ ok: true });
  });

  it('aggregates per-slot errors across validators', () => {
    const a: SlotValidator = {
      name: 'a', validate: () => ({ ok: false, errors: { title: 'too short' } }),
    };
    const b: SlotValidator = {
      name: 'b', validate: () => ({ ok: false, errors: { dueDate: 'invalid format' } }),
    };
    const entry = makeEntry({ typedSlotValidators: [a, b] });
    const result = runSlotValidators(entry, {});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual({ title: 'too short', dueDate: 'invalid format' });
  });

  it('deduplicates missing-field names', () => {
    const a: SlotValidator = { name: 'a', validate: () => ({ ok: false, missing: ['title'] }) };
    const b: SlotValidator = { name: 'b', validate: () => ({ ok: false, missing: ['title', 'dueDate'] }) };
    const entry = makeEntry({ typedSlotValidators: [a, b] });
    const result = runSlotValidators(entry, {});
    expect(result.missing?.sort()).toEqual(['dueDate', 'title']);
  });

  it('falls back to the auto-generated required-fields validator', () => {
    const entry = makeEntry({ requiredFields: ['title', 'dueDate'] });
    const result = runSlotValidators(entry, { title: 'x' });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['dueDate']);
  });
});
