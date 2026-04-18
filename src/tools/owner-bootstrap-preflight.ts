// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getOwnerBootstrapPreflightStatus } from '../services/owner-bootstrap-preflight';

function main(): void {
  const strict = process.argv.includes('--strict');
  const status = getOwnerBootstrapPreflightStatus();

  console.log('Owner bootstrap preflight');
  console.log(`- strict mode: ${strict ? 'on' : 'off'}`);
  console.log(`- database path: ${status.dbPath}`);
  console.log(`- database exists: ${status.dbExists ? 'yes' : 'no'}`);
  console.log(`- explicit OWNER_TELEGRAM_ID: ${status.configuredOwnerTelegramId ?? 'none'}`);
  console.log(`- persisted owner telegram_id: ${status.persistedOwnerTelegramId ?? 'none'}`);
  console.log(`- persisted owner user id: ${status.persistedOwnerUserId ?? 'none'}`);
  console.log(`- persisted owner row count: ${status.persistedOwnerCount}`);
  console.log(`- startup action: ${status.seedAction}`);

  for (const warning of status.warnings) {
    console.log(`- warning: ${warning}`);
  }

  if (status.ok) {
    console.log('- result: OK');
    if (status.seedAction === 'seed') {
      console.log('- note: startup will seed the owner row from OWNER_TELEGRAM_ID');
    } else if (status.seedAction === 'upgrade') {
      console.log('- note: startup will upgrade the existing Telegram user into the owner row');
    } else {
      console.log('- note: startup already has a stable owner bootstrap source');
    }
    process.exit(0);
  }

  for (const error of status.errors) {
    console.error(`- error: ${error}`);
  }

  console.error(`- result: ${strict ? 'FAILED' : 'WARN'}`);
  process.exit(strict ? 1 : 0);
}

main();
