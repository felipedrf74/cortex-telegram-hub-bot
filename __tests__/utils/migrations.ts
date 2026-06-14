// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

const CANONICAL_MIGRATION_FILENAME = /^\d+_[A-Za-z0-9_-]+\.sql$/;

export function listCanonicalMigrationFiles(files: readonly string[]): string[] {
  return files
    .filter((file) => CANONICAL_MIGRATION_FILENAME.test(file))
    .sort();
}
