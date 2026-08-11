#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  verifyInstalledReleaseBackupInterface,
} from './lib/release-installed-backup-interface.mjs';

if (process.argv.length !== 2) {
  process.stderr.write('release installed-backup interface check accepts no arguments\n');
  process.exit(64);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  const result = verifyInstalledReleaseBackupInterface({ root });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `installed backup interface verification failed: ${
      error instanceof Error ? error.message : 'unknown error'
    }\n`,
  );
  process.exit(1);
}
