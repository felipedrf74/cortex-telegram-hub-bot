// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('migrated test database templates', () => {
  it('returns isolated copies rather than mutating the cached template', () => {
    const first = createMigratedTestDatabase();
    first.exec('CREATE TABLE test_only_mutation (id INTEGER PRIMARY KEY)');
    first.close();

    const second = createMigratedTestDatabase();
    try {
      expect(second.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'test_only_mutation'",
      ).get()).toBeUndefined();
    } finally {
      second.close();
    }
  });

  it('normalizes exclusion order into one isolated schema-template key', () => {
    const first = createMigratedTestDatabase({
      excludeFiles: [
        '231_training_m4_capacity_snapshots.sql',
        '230_training_adaptation_proposals_v1.sql',
      ],
    });
    first.exec('CREATE TABLE excluded_template_mutation (id INTEGER PRIMARY KEY)');
    first.close();

    const second = createMigratedTestDatabase({
      excludeFiles: [
        '230_training_adaptation_proposals_v1.sql',
        '231_training_m4_capacity_snapshots.sql',
      ],
    });
    try {
      expect(second.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'excluded_template_mutation'",
      ).get()).toBeUndefined();
      expect(second.prepare(
        "SELECT filename FROM _migrations WHERE filename IN (?, ?)",
      ).all(
        '230_training_adaptation_proposals_v1.sql',
        '231_training_m4_capacity_snapshots.sql',
      )).toEqual([]);
    } finally {
      second.close();
    }
  });

  it('keeps stop-before and fully migrated templates separate', () => {
    const beforeCapacity = createMigratedTestDatabase({
      stopBefore: '231_training_m4_capacity_snapshots.sql',
    });
    const fullyMigrated = createMigratedTestDatabase();
    try {
      expect(beforeCapacity.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_m4_capacity_snapshots'",
      ).get()).toBeUndefined();
      expect(fullyMigrated.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'training_m4_capacity_snapshots'",
      ).get()).toBeDefined();
    } finally {
      beforeCapacity.close();
      fullyMigrated.close();
    }
  });
});
