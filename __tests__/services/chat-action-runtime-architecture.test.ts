// Runtime architecture gates for Phases 0-15 QA.
//
// These tests intentionally import production modules instead of relying on
// grep counts. They pin the capability-registry soft-merge contract and the
// manifest-loader runtime verdict documented in the QA report.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  getChatActionRegistry,
  getSkillMetadata,
  SKILL_METADATA,
  type ChatActionSkill,
} from '../../src/services/chat/registry';
import {
  getChatSkillCapability,
  getChatSkillCapabilityRegistry,
} from '../../src/services/chat-skill-capability-registry';
import { buildChatGroundingEnvelope } from '../../src/services/chat-grounding-layer';
import { loadManifest } from '../../src/skills/loader';

const repoRoot = path.resolve(__dirname, '../..');
const srcRoot = path.join(repoRoot, 'src');

const sharedSkillMap: Array<{ ownerSkill: string; actionSkill: ChatActionSkill }> = [
  { ownerSkill: 'secretary', actionSkill: 'secretary_calendar' },
  { ownerSkill: 'tasks', actionSkill: 'tasks' },
  { ownerSkill: 'training', actionSkill: 'training' },
  { ownerSkill: 'cooking', actionSkill: 'cooking' },
  { ownerSkill: 'finance', actionSkill: 'finance' },
  { ownerSkill: 'content', actionSkill: 'content' },
  { ownerSkill: 'decision_center', actionSkill: 'decision_center' },
  { ownerSkill: 'connections', actionSkill: 'connections' },
  { ownerSkill: 'notifications', actionSkill: 'notifications' },
];

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('runtime capability-registry architecture', () => {
  it('keeps SKILL_METADATA as the action-skill source of shared capability metadata', () => {
    const metadataEntries = Object.entries(SKILL_METADATA);
    expect(metadataEntries).toHaveLength(11);
    expect(metadataEntries.map(([skill]) => skill).sort()).toEqual([
      'connections',
      'content',
      'cooking',
      'decision_center',
      'finance',
      'mail',
      'notifications',
      'secretary_calendar',
      'secretary_reminders',
      'tasks',
      'training',
    ]);

    for (const [skill, metadata] of metadataEntries) {
      expect(metadata.displayName, skill).toBeTruthy();
      expect(metadata.responseCardType, skill).toMatch(/^[a-z_]+$/);
      expect(metadata.latencyBudgetMs, skill).toBeGreaterThan(0);
      expect(metadata.privacyPolicy, skill).toMatch(/^(safe_preview|private_detail|sensitive_redacted|owner_admin_only)$/);
      expect(getSkillMetadata(skill as ChatActionSkill)).toEqual(metadata);
    }
  });

  it('preserves chat-skill-capability-registry as a real grounding layer, not a dead duplicate', () => {
    const capabilityRegistry = getChatSkillCapabilityRegistry();
    expect(capabilityRegistry.map((capability) => capability.skill)).toEqual(expect.arrayContaining([
      'secretary',
      'tasks',
      'training',
      'cooking',
      'finance',
      'content',
      'decision_center',
      'connections',
      'notifications',
      'owner_admin',
    ]));

    for (const { ownerSkill, actionSkill } of sharedSkillMap) {
      const capability = getChatSkillCapability(ownerSkill as any);
      const metadata = getSkillMetadata(actionSkill);
      expect({
        displayName: capability.displayName,
        responseCardType: capability.responseCardType,
        latencyBudgetMs: capability.latencyBudgetMs,
        privacyPolicy: capability.privacyPolicy,
      }).toEqual(metadata);
      expect(capability.executableActions.length, ownerSkill).toBeGreaterThan(0);
    }

    const ownerAdmin = getChatSkillCapability('owner_admin');
    expect(ownerAdmin.privacyPolicy).toBe('owner_admin_only');
    expect(Object.keys(SKILL_METADATA)).not.toContain('owner_admin');
  });

  it('feeds chat grounding envelopes through the capability registry at runtime', () => {
    const grounding = buildChatGroundingEnvelope({
      message: 'What finance payment is due next?',
      userId: 101,
      tenantId: 202,
      routedDomain: 'finance',
    });

    expect(grounding.capability.ownerSkill).toBe('finance');
    expect(grounding.capability.capability.responseCardType).toBe('finance_action');
    expect(grounding.capability.capability.privacyPolicy).toBe('sensitive_redacted');
    expect(grounding.groundingFacts.map((fact) => fact.source)).toContain('chat.skill_capability_registry');
    expect(JSON.stringify(grounding)).not.toContain('executor');
  });
});

describe('manifest loader runtime architecture', () => {
  it('loads and validates manifest.json files when called directly', () => {
    const manifest = loadManifest(path.join(srcRoot, 'skills', 'training'));
    expect(manifest.name).toBe('training');
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is not wired into production src startup/runtime imports today', () => {
    const importMatches = walkTsFiles(srcRoot)
      .filter((file) => !file.endsWith(path.join('src', 'skills', 'loader.ts')))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return /from ['"].*skills\/loader['"]|require\(['"].*skills\/loader['"]\)/.test(source)
          ? [path.relative(repoRoot, file)]
          : [];
      });

    expect(importMatches).toEqual([]);
  });
});

describe('runtime registry shape', () => {
  it('keeps disabled/deprecated actions out of the active registry count', () => {
    const actions = getChatActionRegistry();
    expect(actions).toHaveLength(54);
    expect(actions.every((entry) => entry.status === 'active')).toBe(true);
  });
});
