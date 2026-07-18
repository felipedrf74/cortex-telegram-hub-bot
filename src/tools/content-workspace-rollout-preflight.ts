// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  getContentWorkspaceRolloutPreflightStatus,
} from '../services/content-workspace-rollout-preflight';

const status = getContentWorkspaceRolloutPreflightStatus({
  dbPath: process.env.DATABASE_PATH || './data/bot.db',
});

if (!status.ok) {
  console.error(`content_workspace_rollout_preflight_failed:${status.errors.join(',')}`);
  process.exit(1);
}

console.log('content_workspace_rollout_preflight_ok cohort=scoped_owner writes=all');
