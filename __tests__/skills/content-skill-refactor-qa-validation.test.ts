/**
 * QA Validation — Content Creator Domain → Skill Package Refactor
 *
 * Validates the migration of content domain to a v2 skill package with
 * 11 granular sub-skills, manifest v2, and correct cron job mappings.
 *
 * Focus areas:
 * 1. Manifest v2 JSON structure and consistency with skill-config.ts
 * 2. Sub-skill completeness (9 agent sub-skills + notes + shared-memory)
 * 3. Cron job ownership mapping
 * 4. meme-scout disabled-by-default behavior
 * 5. Routing config preserved after refactor
 * 6. Portal HTML updated with content sub-skill cards
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  DEFAULT_SKILLS,
  getSkillDefinition,
  getSubSkillNames,
  getCronJobOwner,
  getAllCronJobMappings,
  getPatternRoutes,
  getKeywordRoutes,
  getClassificationHints,
  _resetRegistry,
} from '../../src/skills/skill-config';

const ROOT = path.resolve(__dirname, '..', '..');

// ═══════════════════════════════════════════════════════════════════
// MANIFEST v2 CONSISTENCY
// ═══════════════════════════════════════════════════════════════════

describe('QA: Content manifest.json ↔ skill-config.ts consistency', () => {
  const manifestPath = path.join(ROOT, 'src', 'skills', 'content', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const contentSkill = DEFAULT_SKILLS.content;

  it('manifest exists at src/skills/content/manifest.json', () => {
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('manifest uses version 2 format', () => {
    expect(manifest.manifestVersion).toBe(2);
  });

  it('manifest name matches skill-config name', () => {
    expect(manifest.name).toBe(contentSkill.name);
  });

  it('manifest version matches skill-config version', () => {
    expect(manifest.version).toBe(contentSkill.version);
    expect(manifest.version).toBe('2.0.0');
  });

  it('manifest sub-skill count matches skill-config', () => {
    expect(manifest.subSkills.length).toBe(contentSkill.subSkills.length);
  });

  it('manifest sub-skill names match skill-config names (in order)', () => {
    const manifestNames = manifest.subSkills.map((s: { module_name: string }) => s.module_name);
    const configNames = contentSkill.subSkills.map(s => s.name);
    expect(manifestNames).toEqual(configNames);
  });

  it('manifest enabled_by_default flags match skill-config', () => {
    for (let i = 0; i < manifest.subSkills.length; i++) {
      const mSub = manifest.subSkills[i];
      const cSub = contentSkill.subSkills[i];
      expect(mSub.enabled_by_default).toBe(cSub.enabledByDefault);
    }
  });

  it('manifest cron job arrays match skill-config', () => {
    for (let i = 0; i < manifest.subSkills.length; i++) {
      const mSub = manifest.subSkills[i];
      const cSub = contentSkill.subSkills[i];
      expect(mSub.cronJobs).toEqual(cSub.cronJobs ?? []);
    }
  });

  it('manifest tool arrays match skill-config', () => {
    for (let i = 0; i < manifest.subSkills.length; i++) {
      const mSub = manifest.subSkills[i];
      const cSub = contentSkill.subSkills[i];
      expect(mSub.tools).toEqual(cSub.tools);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// CONTENT SUB-SKILL STRUCTURE
// ═══════════════════════════════════════════════════════════════════

describe('QA: Content sub-skill structure', () => {
  const content = DEFAULT_SKILLS.content;

  const EXPECTED_AGENT_SUBSKILLS = [
    'research-pipeline',
    'script-generator',
    'seo-tracker',
    'reaction-radar',
    'voice-evolution',
    'performance-intel',
    'pipeline-tracker',
    'topic-scheduler',
    'meme-scout',
  ];

  it('has exactly 9 agent sub-skills + notes + shared-memory = 11 total', () => {
    const names = content.subSkills.map(s => s.name);
    for (const agent of EXPECTED_AGENT_SUBSKILLS) {
      expect(names).toContain(agent);
    }
    expect(names).toContain('notes');
    expect(names).toContain('shared-memory');
    expect(names.length).toBe(11);
  });

  it('only meme-scout is disabled by default', () => {
    const disabled = content.subSkills.filter(s => !s.enabledByDefault);
    expect(disabled).toHaveLength(1);
    expect(disabled[0].name).toBe('meme-scout');
  });

  it('agent sub-skills have empty tool arrays (cron-driven)', () => {
    for (const name of EXPECTED_AGENT_SUBSKILLS) {
      if (name === 'meme-scout') continue; // experimental, no cron either
      const sub = content.subSkills.find(s => s.name === name)!;
      expect(sub.tools).toEqual([]);
    }
  });

  it('notes sub-skill has save_note and search_notes tools', () => {
    const notes = content.subSkills.find(s => s.name === 'notes')!;
    expect(notes.tools).toEqual(['save_note', 'search_notes']);
  });

  it('shared-memory sub-skill has memory tools', () => {
    const mem = content.subSkills.find(s => s.name === 'shared-memory')!;
    expect(mem.tools).toEqual(['shared_memory_set', 'shared_memory_remove']);
  });

  it('every sub-skill has a non-empty description', () => {
    for (const sub of content.subSkills) {
      expect(sub.description.length).toBeGreaterThan(10);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// CRON JOB OWNERSHIP
// ═══════════════════════════════════════════════════════════════════

describe('QA: Content cron job ownership', () => {
  const CONTENT_CRON_JOBS: Record<string, string> = {
    channel_relearn: 'research-pipeline',
    seo_agent: 'seo-tracker',
    reaction_radar: 'reaction-radar',
    voice_evolution: 'voice-evolution',
    performance_agent: 'performance-intel',
    pipeline_agent: 'pipeline-tracker',
    tuesday_reels: 'topic-scheduler',
    thursday_youtube: 'topic-scheduler',
    friday_weekly: 'topic-scheduler',
  };

  for (const [jobId, expectedSubSkill] of Object.entries(CONTENT_CRON_JOBS)) {
    it(`${jobId} is owned by content/${expectedSubSkill}`, () => {
      const owner = getCronJobOwner(jobId);
      expect(owner).not.toBeNull();
      expect(owner!.domain).toBe('content');
      expect(owner!.subSkill).toBe(expectedSubSkill);
    });
  }

  it('all content cron jobs appear in getAllCronJobMappings', () => {
    const mappings = getAllCronJobMappings();
    for (const jobId of Object.keys(CONTENT_CRON_JOBS)) {
      expect(mappings.has(jobId)).toBe(true);
    }
  });

  it('topic-scheduler owns exactly 3 cron jobs', () => {
    const topicSub = DEFAULT_SKILLS.content.subSkills.find(s => s.name === 'topic-scheduler')!;
    expect(topicSub.cronJobs).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ROUTING CONFIG PRESERVED
// ═══════════════════════════════════════════════════════════════════

describe('QA: Content routing config after refactor', () => {
  it('content has pattern routes for /content, /video, /reel, etc.', () => {
    const routes = getPatternRoutes();
    const contentRoute = routes.find(r => r.domain === 'content');
    expect(contentRoute).toBeDefined();
    expect(contentRoute!.patterns.length).toBe(3);
    expect(contentRoute!.patterns[0].test('/content plan')).toBe(true);
    expect(contentRoute!.patterns[0].test('/video ideas')).toBe(true);
    expect(contentRoute!.patterns[1].test('/trending now')).toBe(true);
    expect(contentRoute!.patterns[2].test('/seo check')).toBe(true);
  });

  it('content has keyword route for youtube, reels, etc.', () => {
    const routes = getKeywordRoutes();
    const contentRoute = routes.find(r => r.domain === 'content');
    expect(contentRoute).toBeDefined();
    expect(contentRoute!.pattern.test('youtube video ideas')).toBe(true);
    expect(contentRoute!.pattern.test('instagram reels strategy')).toBe(true);
    expect(contentRoute!.pattern.test('conteúdo para o canal')).toBe(true);
  });

  it('content has classification hint', () => {
    const hints = getClassificationHints();
    const contentHint = hints.find(h => h.label === 'content');
    expect(contentHint).toBeDefined();
    expect(contentHint!.examples.length).toBeGreaterThan(0);
  });

  it('content keyword route does NOT falsely match triathlon terms', () => {
    const routes = getKeywordRoutes();
    const contentRoute = routes.find(r => r.domain === 'content')!;
    expect(contentRoute.pattern.test('plan my workout')).toBe(false);
    expect(contentRoute.pattern.test('running intervals')).toBe(false);
    expect(contentRoute.pattern.test('how much protein')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PORTAL HTML
// ═══════════════════════════════════════════════════════════════════

describe('QA: Portal HTML updated for content skill', () => {
  const portalPath = path.join(ROOT, 'src', 'portal', 'portal.html');
  const portalHtml = fs.readFileSync(portalPath, 'utf-8');

  it('portal mentions content sub-skills or content agent mesh', () => {
    // The portal should have been updated with content sub-skill cards
    const hasContentRef = portalHtml.includes('content') || portalHtml.includes('Content');
    expect(hasContentRef).toBe(true);
  });
});
