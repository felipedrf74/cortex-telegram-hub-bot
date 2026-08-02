#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Source-checkout entry point for the provider-free Phase 7 action-skill gate.
 * The release operator invokes the same implementation from compiled dist/.
 */

import { runRoutingActionSkillAccuracyCli } from '../src/tools/routing-action-skill-accuracy';

void runRoutingActionSkillAccuracyCli()
  .then((status) => { process.exitCode = status; })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
