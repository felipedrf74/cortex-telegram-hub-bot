#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'node:path';
import { buildMigratedTestDatabaseTemplate } from '../src/testing/migrated-test-database-template';

const [outputDirectory, ...unexpected] = process.argv.slice(2);
if (!outputDirectory || unexpected.length > 0) {
  process.stderr.write(
    'Usage: build-migrated-test-database-template.ts <private-output-directory>\n',
  );
  process.exit(64);
}

const result = buildMigratedTestDatabaseTemplate(path.resolve(outputDirectory));
process.stdout.write(`${JSON.stringify(result)}\n`);
