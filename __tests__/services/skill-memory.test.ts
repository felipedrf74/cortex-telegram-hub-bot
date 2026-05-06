import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

import {
  applySkillMemoryCorrection,
  buildSkillMemorySummary,
  getSkillMemories,
  getSkillMemoryBoundaries,
  markSkillMemoriesStaleForRelatedSkillVersion,
  markSkillMemoriesStaleForVersion,
  resolveSkillMemoryReference,
  setSkillMemory,
} from '../../src/services/skill-memory';

describe('skill-memory foundation', () => {
  beforeEach(() => {
    delete process.env.ENABLE_TENANT_SHARED_MEMORY;
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('keeps user-private memory invisible to another user', () => {
    setSkillMemory({
      tenantId: 10,
      userId: 7,
      skillId: 'secretary',
      memoryType: 'schedule_preference',
      scope: 'user_private',
      memoryKey: 'focus_window',
      memoryValue: 'Protect mornings for deep work.',
      source: 'user_answer',
      confidence: 0.9,
    });

    expect(getSkillMemories({ tenantId: 10, userId: 7, skillId: 'secretary' })).toHaveLength(1);
    expect(getSkillMemories({ tenantId: 10, userId: 8, skillId: 'secretary' })).toHaveLength(0);
  });

  it('keeps tenant-shared memory inside its tenant', () => {
    setSkillMemory({
      tenantId: 20,
      skillId: 'content',
      memoryType: 'voice_brand_preference',
      scope: 'tenant_shared',
      memoryKey: 'brand_voice',
      memoryValue: 'Direct, evidence-led, no hype.',
      source: 'brand_profile',
      confidence: 0.86,
    });

    expect(getSkillMemories({ tenantId: 20, userId: 20, skillId: 'content' })[0].memoryValue)
      .toBe('Direct, evidence-led, no hype.');
    expect(getSkillMemories({ tenantId: 21, userId: 7, skillId: 'content' })).toHaveLength(0);
  });

  it('fails closed for tenant-shared memory when user membership cannot be proven', () => {
    setSkillMemory({
      tenantId: 22,
      skillId: 'content',
      memoryType: 'voice_brand_preference',
      scope: 'tenant_shared',
      memoryKey: 'brand_voice',
      memoryValue: 'Tenant owner only until membership table exists.',
      source: 'brand_profile',
      confidence: 0.86,
    });

    expect(getSkillMemories({ tenantId: 22, userId: 7, skillId: 'content' })).toHaveLength(0);
    expect(getSkillMemories({ tenantId: 22, userId: 22, skillId: 'content' })).toHaveLength(1);
  });

  it('does not retrieve skill memory for unrelated skills unless it is an explicit cross-skill signal', () => {
    setSkillMemory({
      tenantId: 30,
      userId: 7,
      skillId: 'training',
      memoryType: 'training_preference',
      scope: 'user_private',
      memoryKey: 'equipment',
      memoryValue: 'Has dumbbells and treadmill.',
      source: 'onboarding',
      confidence: 0.92,
    });
    setSkillMemory({
      tenantId: 30,
      userId: 7,
      skillId: 'training',
      memoryType: 'cross_skill_signal',
      scope: 'user_private',
      memoryKey: 'heavy_training_day',
      memoryValue: 'Wednesday has heavy lower-body work.',
      source: 'training_plan',
      confidence: 0.82,
    });

    expect(getSkillMemories({ tenantId: 30, userId: 7, skillId: 'content' })).toHaveLength(0);
    expect(getSkillMemories({
      tenantId: 30,
      userId: 7,
      skillId: 'content',
      includeCrossSkillSignals: true,
    }).map((memory) => memory.memoryKey)).toEqual(['heavy_training_day']);
  });

  it('downgrades expired memory and excludes it by default', () => {
    setSkillMemory({
      tenantId: 40,
      userId: 7,
      skillId: 'chat',
      memoryType: 'user_preference',
      scope: 'user_private',
      memoryKey: 'temporary_tone',
      memoryValue: 'Use extra detail today.',
      source: 'chat',
      confidence: 0.7,
      expiresAt: '2026-01-01T00:00:00.000Z',
    });

    expect(getSkillMemories({
      tenantId: 40,
      userId: 7,
      skillId: 'chat',
      now: new Date('2026-04-29T12:00:00.000Z'),
    })).toHaveLength(0);
    const stale = getSkillMemories({
      tenantId: 40,
      userId: 7,
      skillId: 'chat',
      includeStale: true,
    });
    expect(stale[0]).toEqual(expect.objectContaining({
      freshnessStatus: 'expired',
      status: 'stale',
    }));
  });

  it('corrected memory supersedes older conflicting memory', () => {
    const first = setSkillMemory({
      tenantId: 50,
      userId: 7,
      skillId: 'secretary',
      memoryType: 'schedule_preference',
      scope: 'user_private',
      memoryKey: 'workout_timing',
      memoryValue: 'Prefers workouts before work.',
      source: 'user_answer',
      confidence: 0.75,
    });

    const corrected = applySkillMemoryCorrection({
      tenantId: 50,
      userId: 7,
      skillId: 'secretary',
      memoryType: 'schedule_preference',
      scope: 'user_private',
      memoryKey: 'workout_timing',
      correctedValue: 'Prefers workouts after work.',
      source: 'user_correction',
    });

    expect(corrected.memoryValue).toBe('Prefers workouts after work.');
    expect(corrected.freshnessStatus).toBe('corrected');
    expect(corrected.correctionHistory[0].supersededMemoryId).toBe(first.memoryId);
    expect(getSkillMemories({ tenantId: 50, userId: 7, skillId: 'secretary' })).toEqual([
      expect.objectContaining({ memoryValue: 'Prefers workouts after work.' }),
    ]);
  });

  it('keeps full correction lineage across repeated skill memory corrections', () => {
    const first = setSkillMemory({
      tenantId: 50,
      userId: 7,
      skillId: 'content',
      memoryType: 'content_creative_preference',
      scope: 'user_private',
      memoryKey: 'voice_style',
      memoryValue: 'Soft editorial voice.',
      source: 'user_answer',
      confidence: 0.7,
    });

    const second = applySkillMemoryCorrection({
      tenantId: 50,
      userId: 7,
      skillId: 'content',
      memoryType: 'content_creative_preference',
      scope: 'user_private',
      memoryKey: 'voice_style',
      correctedValue: 'Direct creator voice.',
      source: 'user_correction',
    });

    const third = applySkillMemoryCorrection({
      tenantId: 50,
      userId: 7,
      skillId: 'content',
      memoryType: 'content_creative_preference',
      scope: 'user_private',
      memoryKey: 'voice_style',
      correctedValue: 'Direct creator voice with proof points.',
      source: 'user_correction',
    });

    expect(second.correctionHistory).toEqual([
      expect.objectContaining({ supersededMemoryId: first.memoryId, previousValue: 'Soft editorial voice.' }),
    ]);
    expect(third.correctionHistory).toEqual([
      expect.objectContaining({ supersededMemoryId: first.memoryId, previousValue: 'Soft editorial voice.' }),
      expect.objectContaining({ supersededMemoryId: second.memoryId, previousValue: 'Direct creator voice.' }),
    ]);
  });

  it('invalidates stale schema-version memories after a major skill release without leaking tenants', () => {
    setSkillMemory({
      tenantId: 60,
      userId: 7,
      skillId: 'content',
      memoryType: 'content_creative_preference',
      scope: 'user_private',
      memoryKey: 'format_preference',
      memoryValue: 'Prefers short-form first.',
      source: 'user_answer',
      schemaVersion: 'content-memory-v1',
    });
    setSkillMemory({
      tenantId: 61,
      userId: 7,
      skillId: 'content',
      memoryType: 'content_creative_preference',
      scope: 'user_private',
      memoryKey: 'format_preference',
      memoryValue: 'Tenant B private strategy.',
      source: 'user_answer',
      schemaVersion: 'content-memory-v1',
    });

    const changed = markSkillMemoriesStaleForVersion({
      tenantId: 60,
      skillId: 'content',
      schemaVersion: 'content-memory-v2',
      reason: 'major content memory schema upgrade',
    });

    expect(changed).toBe(1);
    expect(getSkillMemories({ tenantId: 60, userId: 7, skillId: 'content' })).toHaveLength(0);
    expect(getSkillMemories({ tenantId: 61, userId: 7, skillId: 'content' })).toHaveLength(1);
  });

  it('stales only memories tied to the canceled related skill version', () => {
    setSkillMemory({
      tenantId: 60,
      userId: 7,
      skillId: 'cooking',
      memoryType: 'cross_skill_signal',
      scope: 'user_private',
      memoryKey: 'training_meal_window',
      memoryValue: 'Prep before cancelled plan.',
      source: 'training',
      relatedSkillVersion: 'training-plan-v3',
    });
    setSkillMemory({
      tenantId: 60,
      userId: 7,
      skillId: 'cooking',
      memoryType: 'cross_skill_signal',
      scope: 'user_private',
      memoryKey: 'current_training_context',
      memoryValue: 'Active plan context.',
      source: 'training',
      relatedSkillVersion: 'training-plan-v4',
    });
    setSkillMemory({
      tenantId: 61,
      userId: 7,
      skillId: 'cooking',
      memoryType: 'cross_skill_signal',
      scope: 'user_private',
      memoryKey: 'other_tenant_training_window',
      memoryValue: 'Other tenant context.',
      source: 'training',
      relatedSkillVersion: 'training-plan-v3',
    });

    const changed = markSkillMemoriesStaleForRelatedSkillVersion({
      tenantId: 60,
      userId: 7,
      skillId: 'cooking',
      relatedSkillVersion: 'training-plan-v3',
      reason: 'training_plan_canceled',
    });

    expect(changed).toBe(1);
    expect(getSkillMemories({ tenantId: 60, userId: 7, skillId: 'cooking' }).map((memory) => memory.memoryKey))
      .toEqual(['current_training_context']);
    expect(getSkillMemories({ tenantId: 61, userId: 7, skillId: 'cooking' }).map((memory) => memory.memoryKey))
      .toEqual(['other_tenant_training_window']);
  });

  it('surfaces Content voice memory and Secretary/Training preferences with source and confidence', () => {
    setSkillMemory({
      tenantId: 70,
      skillId: 'content',
      memoryType: 'voice_brand_preference',
      scope: 'tenant_shared',
      memoryKey: 'voice',
      memoryValue: 'Sharp, practical, product-led.',
      source: 'voice_dna',
      confidence: 0.88,
    });
    setSkillMemory({
      tenantId: 70,
      userId: 7,
      skillId: 'secretary',
      memoryType: 'schedule_preference',
      scope: 'user_private',
      memoryKey: 'buffer',
      memoryValue: 'Keep 15 minutes between meetings.',
      source: 'schedule_profile',
      confidence: 0.91,
    });
    setSkillMemory({
      tenantId: 70,
      userId: 7,
      skillId: 'training',
      memoryType: 'training_preference',
      scope: 'user_private',
      memoryKey: 'equipment',
      memoryValue: 'Apartment gym, treadmill, dumbbells.',
      source: 'athlete_profile',
      confidence: 0.89,
    });

    expect(buildSkillMemorySummary({ tenantId: 70, userId: 70, skillId: 'content' }))
      .toContain('voice: Sharp, practical, product-led. (source=voice_dna, confidence=0.88, freshness=fresh)');
    expect(buildSkillMemorySummary({ tenantId: 70, userId: 7, skillId: 'secretary' }))
      .toContain('buffer: Keep 15 minutes between meetings.');
    expect(buildSkillMemorySummary({ tenantId: 70, userId: 7, skillId: 'training' }))
      .toContain('equipment: Apartment gym, treadmill, dumbbells.');
  });

  it('resolves Chat ambiguous follow-up only from safe scoped memory, otherwise asks clarification', () => {
    setSkillMemory({
      tenantId: 80,
      userId: 7,
      skillId: 'chat',
      memoryType: 'action_history',
      scope: 'user_private',
      memoryKey: 'last_action',
      memoryValue: 'Rescheduled content block to Friday.',
      source: 'tool_result',
      confidence: 0.95,
    });

    expect(resolveSkillMemoryReference({
      tenantId: 80,
      userId: 7,
      skillId: 'chat',
      memoryKey: 'last_action',
    })).toEqual({
      status: 'resolved',
      memory: expect.objectContaining({ memoryValue: 'Rescheduled content block to Friday.' }),
    });
    expect(resolveSkillMemoryReference({
      tenantId: 81,
      userId: 7,
      skillId: 'chat',
      memoryKey: 'last_action',
    })).toEqual({
      status: 'needs_clarification',
      reason: 'missing_or_unauthorized_context',
      candidates: [],
    });
  });

  it('rejects disallowed memory types and unsafe values', () => {
    expect(() => setSkillMemory({
      tenantId: 90,
      userId: 7,
      skillId: 'finance',
      memoryType: 'voice_brand_preference',
      scope: 'user_private',
      memoryKey: 'voice',
      memoryValue: 'Wrong domain.',
      source: 'test',
    })).toThrow(/SKILL_MEMORY_BOUNDARY/);

    expect(() => setSkillMemory({
      tenantId: 90,
      userId: 7,
      skillId: 'chat',
      memoryType: 'user_preference',
      scope: 'user_private',
      memoryKey: 'token',
      memoryValue: 'refresh_token=secret-refresh-token',
      source: 'test',
    })).toThrow(/SKILL_MEMORY_UNSAFE/);

    expect(getSkillMemoryBoundaries().content).toContain('voice_brand_preference');
  });

  it.each([
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature'],
    ['aws_access_key', 'AKIA1234567890ABCDEF'],
    ['aws_secret', 'abcdEFGH1234abcdEFGH1234abcdEFGH1234abcd'],
    ['google_api_key', 'AIza1234567890abcdefghijklmnopqrstuvwxy'],
    ['stripe_secret', 'sk_live_51NxExampleSecretKey'],
    ['github_pat', 'ghp_1234567890abcdefghijklmnop'],
    ['slack_token', 'xoxb-1234567890-abcdef'],
    ['postgres_url', 'postgres://user:supersecret@localhost:5432/app'],
    ['mongodb_url', 'mongodb+srv://user:supersecret@example.mongodb.net/app'],
    ['mysql_url', 'mysql://user:supersecret@localhost:3306/app'],
    ['private_key', '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'],
    ['aws_session', 'FQoGZXIvYXdzEJr//////////wEaDKExampleSessionToken'],
    ['azure_connection', 'DefaultEndpointsProtocol=https;AccountName=test;AccountKey=secret==;EndpointSuffix=core.windows.net'],
  ])('rejects modern credential pattern: %s', (_name, memoryValue) => {
    expect(() => setSkillMemory({
      tenantId: 91,
      userId: 7,
      skillId: 'chat',
      memoryType: 'user_preference',
      scope: 'user_private',
      memoryKey: `unsafe_${_name}`,
      memoryValue,
      source: 'test',
    })).toThrow(/SKILL_MEMORY_UNSAFE/);
  });

  it('schema-validates skill_specific_memory and rejects typed-bucket secret bypasses', () => {
    expect(() => setSkillMemory({
      tenantId: 92,
      userId: 7,
      skillId: 'finance',
      memoryType: 'skill_specific_memory',
      scope: 'user_private',
      memoryKey: 'finance_notes',
      memoryValue: 'Use this broad bucket for finance memory.',
      source: 'test',
    })).toThrow(/skill_specific_memory must be a JSON object/);

    expect(() => setSkillMemory({
      tenantId: 92,
      userId: 7,
      skillId: 'finance',
      memoryType: 'skill_specific_memory',
      scope: 'user_private',
      memoryKey: 'finance_secret',
      memoryValue: JSON.stringify({ apiKey: 'sk_live_51NxExampleSecretKey' }),
      source: 'test',
    })).toThrow(/SKILL_MEMORY_UNSAFE/);

    expect(setSkillMemory({
      tenantId: 92,
      userId: 7,
      skillId: 'finance',
      memoryType: 'skill_specific_memory',
      scope: 'user_private',
      memoryKey: 'review_style',
      memoryValue: JSON.stringify({ schema: 'finance-v1', preference: 'Batch monthly review tasks.' }),
      source: 'test',
    })).toEqual(expect.objectContaining({ memoryKey: 'review_style' }));
  });

  it('enforces an active memory quota without blocking correction of an existing key', () => {
    for (let i = 0; i < 100; i += 1) {
      setSkillMemory({
        tenantId: 93,
        userId: 7,
        skillId: 'chat',
        memoryType: 'user_preference',
        scope: 'user_private',
        memoryKey: `preference_${i}`,
        memoryValue: `Preference ${i}`,
        source: 'test',
      });
    }

    expect(() => setSkillMemory({
      tenantId: 93,
      userId: 7,
      skillId: 'chat',
      memoryType: 'user_preference',
      scope: 'user_private',
      memoryKey: 'preference_over_quota',
      memoryValue: 'This would exceed the active quota.',
      source: 'test',
    })).toThrow(/SKILL_MEMORY_QUOTA/);

    expect(setSkillMemory({
      tenantId: 93,
      userId: 7,
      skillId: 'chat',
      memoryType: 'user_preference',
      scope: 'user_private',
      memoryKey: 'preference_0',
      memoryValue: 'Corrected preference 0',
      source: 'test',
    })).toEqual(expect.objectContaining({
      memoryKey: 'preference_0',
      memoryValue: 'Corrected preference 0',
    }));
  });

  it('rejects non-owner tenant-shared memory writes until membership authorization exists', () => {
    expect(() => setSkillMemory({
      tenantId: 70,
      userId: 99,
      skillId: 'content',
      memoryType: 'voice_brand_preference',
      scope: 'tenant_shared',
      memoryKey: 'voice',
      memoryValue: 'Unauthorized tenant-shared voice update.',
      source: 'portal',
    })).toThrow(/TENANT_SHARED_NOT_AVAILABLE/);

    expect(setSkillMemory({
      tenantId: 70,
      userId: 70,
      skillId: 'content',
      memoryType: 'voice_brand_preference',
      scope: 'tenant_shared',
      memoryKey: 'voice',
      memoryValue: 'Owner-approved tenant voice.',
      source: 'portal',
    })).toEqual(expect.objectContaining({
      memoryValue: 'Owner-approved tenant voice.',
    }));
  });
});
