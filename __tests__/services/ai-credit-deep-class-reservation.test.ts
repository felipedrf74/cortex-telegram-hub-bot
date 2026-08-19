// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * NH-0040: the `deep` operation class is explicitly RESERVED, not silently
 * dead. Plan §2 prices deep reasoning/research at 3 credits, but no
 * standalone deep-reasoning user surface exists yet. This pin makes wiring
 * the first `deep` admission a deliberate decision: whoever ships the deep
 * surface must update the policy status marker together with this test.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_CREDIT_OPERATION_COSTS,
  DEEP_OPERATION_CLASS_STATUS,
} from '../../src/services/ai-credit-policy';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('deep operation class reservation', () => {
  it('keeps the plan §2 price while the surface is pending', () => {
    expect(AI_CREDIT_OPERATION_COSTS.deep).toBe(3);
    expect(DEEP_OPERATION_CLASS_STATUS).toBe('reserved_pending_deep_surface');
  });

  it('has no runtime workload admitting the deep class yet', () => {
    const srcRoot = join(__dirname, '..', '..', 'src');
    const offenders: string[] = [];
    for (const file of listTsFiles(srcRoot)) {
      const content = readFileSync(file, 'utf8');
      if (/operationClass:\s*'deep'/.test(content)) offenders.push(file);
    }
    // Shipping the deep surface: wire its admission with operationClass
    // 'deep', then flip DEEP_OPERATION_CLASS_STATUS and update this pin.
    expect(offenders).toEqual([]);
  });
});
