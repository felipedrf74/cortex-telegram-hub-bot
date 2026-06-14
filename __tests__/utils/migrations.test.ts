// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { listCanonicalMigrationFiles } from './migrations';

describe('listCanonicalMigrationFiles', () => {
  it('keeps canonical migration files and ignores local duplicate-copy files', () => {
    expect(listCanonicalMigrationFiles([
      '203_apple_health_encrypted_payload 2.sql',
      '008_email_log.sql',
      'not-a-migration.sql',
      '001_initial.sql',
      '024_usage_metering.sql',
      '024_usage_metering-copy.sql',
      'README.md',
    ])).toEqual([
      '001_initial.sql',
      '008_email_log.sql',
      '024_usage_metering-copy.sql',
      '024_usage_metering.sql',
    ]);
  });
});
