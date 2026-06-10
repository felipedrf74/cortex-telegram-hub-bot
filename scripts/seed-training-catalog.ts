#!/usr/bin/env npx tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function valueFor(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function usage(): string {
  return [
    'Usage: npx tsx scripts/seed-training-catalog.ts [--write] [--activate] [--catalog-version <version>] [--scope-key <scope>] [--created-by <name>]',
    '',
    'Default mode is dry-run validation only. This script never writes unless --write is present.',
    'Use --activate only after reviewing validation output; active catalog versions are immutable.',
  ].join('\n');
}

if (hasFlag('--help') || hasFlag('-h')) {
  console.log(usage());
  process.exit(0);
}

const write = hasFlag('--write');
const activate = hasFlag('--activate');
const catalogVersion = valueFor('--catalog-version');
const scopeKey = valueFor('--scope-key');
const createdBy = valueFor('--created-by') ?? 'seed-training-catalog';

if (activate && !write) {
  throw new Error('--activate requires --write. Dry-run mode validates only.');
}

async function main(): Promise<void> {
  if (!write) {
    process.env.TELEGRAM_BOT_TOKEN ||= 'dry-run-training-catalog-seed';
    process.env.TELEGRAM_ALLOWED_USER_IDS ||= '0';
  }

  const {
    assertCatalogPromotable,
    buildRepoTrainingCatalogSnapshot,
    seedRepoTrainingCatalogVersion,
  } = await import('../src/services/coach-kernel/training-catalog');

  if (!write) {
    const snapshot = buildRepoTrainingCatalogSnapshot();
    const resolvedCatalogVersion = catalogVersion ?? snapshot.catalogVersion;
    const resolvedScopeKey = scopeKey ?? snapshot.scopeKey;
    const validation = assertCatalogPromotable({
      ...snapshot,
      catalogVersion: resolvedCatalogVersion,
      scopeKey: resolvedScopeKey,
      exercises: snapshot.exercises.map((entry) => ({
        ...entry,
        catalogVersion: resolvedCatalogVersion,
        tenantOverrideScope: entry.tenantOverrideScope ?? resolvedScopeKey,
      })),
    });
    console.log(JSON.stringify({
      mode: 'dry_run',
      catalogVersion: resolvedCatalogVersion,
      scopeKey: resolvedScopeKey,
      exerciseCount: snapshot.exercises.length,
      equipmentCount: snapshot.equipment.length,
      validationStatus: validation.status,
      issueCount: validation.issues.length,
      issues: validation.issues.slice(0, 20),
    }, null, 2));
    process.exit(validation.status === 'passed' ? 0 : 1);
  }

  const { closeDatabase, initDatabase } = await import('../src/services/database');
  initDatabase();
  try {
    const result = seedRepoTrainingCatalogVersion({
      ...(catalogVersion ? { catalogVersion } : {}),
      ...(scopeKey ? { scopeKey } : {}),
      createdBy,
      activate,
    });

    console.log(JSON.stringify({
      mode: 'write',
      catalogVersion: result.snapshot.catalogVersion,
      scopeKey: result.snapshot.scopeKey,
      inserted: result.inserted,
      activated: result.activated,
      validationStatus: result.validation.status,
      issueCount: result.validation.issues.length,
      issues: result.validation.issues.slice(0, 20),
    }, null, 2));

    process.exitCode = result.validation.status === 'passed' ? 0 : 1;
  } finally {
    closeDatabase();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
