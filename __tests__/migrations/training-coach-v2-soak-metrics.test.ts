// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const UP = readFileSync(resolve(process.cwd(), 'migrations/305_training_coach_v2_soak_metrics.sql'), 'utf8');
const DOWN = readFileSync(resolve(process.cwd(), 'migrations/down/305_training_coach_v2_soak_metrics.sql'), 'utf8');

describe('migration 305 — Training Coach V2 soak metrics', () => {
  it('round-trips the durable evidence tables without predecessor coupling', () => {
    const db = createMigratedTestDatabase({ excludeFiles: ['305_training_coach_v2_soak_metrics.sql'] });
    try {
      db.exec(UP);
      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'training_coach_v2_%'
        ORDER BY name
      `).all()).toEqual(expect.arrayContaining([
        { name: 'training_coach_v2_adaptation_observations' },
        { name: 'training_coach_v2_rule_firings' },
        { name: 'training_coach_v2_rule_reviews' },
      ]));
      expect(db.pragma('foreign_key_list(training_coach_v2_rule_reviews)')).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      db.exec(DOWN);
      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (
          'training_coach_v2_adaptation_observations',
          'training_coach_v2_rule_firings',
          'training_coach_v2_rule_reviews'
        )
      `).all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
