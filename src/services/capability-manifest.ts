// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import path from 'node:path';

export type CapabilityLifecycle = 'experimental' | 'shadow' | 'active' | 'deprecated' | 'removed';

export interface CapabilityManifestEntry {
  id: string;
  version: string;
  lifecycle: CapabilityLifecycle;
  owner: string;
  requiredTier: 'free' | 'pro' | 'max' | 'owner';
  memoryScope: string;
  providerPolicy: string;
  costBudget: string;
  latencyBudgetMs: number;
  supportedChannels: string[];
  requiredEvaluations: string[];
}

interface CapabilityManifest {
  schema: 'nexus.capability-manifest.v1';
  version: string;
  capabilities: CapabilityManifestEntry[];
}

let cached: CapabilityManifest | null = null;

export function loadCapabilityManifest(): CapabilityManifest {
  if (cached) return cached;
  const manifestPath = path.resolve(process.cwd(), 'config/capability-manifest.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CapabilityManifest;
  if (parsed.schema !== 'nexus.capability-manifest.v1' || !Array.isArray(parsed.capabilities)) {
    throw new Error('invalid CapabilityManifest schema');
  }
  const ids = new Set<string>();
  for (const entry of parsed.capabilities) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`invalid duplicate capability: ${entry.id}`);
    if (!entry.owner || !entry.version || entry.requiredEvaluations.length === 0) {
      throw new Error(`incomplete capability governance: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  cached = parsed;
  return parsed;
}

export function getCapabilityManifestEntry(skillId: string): CapabilityManifestEntry | null {
  const normalized = skillId === 'training' ? 'triathlon' : skillId;
  return loadCapabilityManifest().capabilities.find((entry) => entry.id === normalized) ?? null;
}

export function resetCapabilityManifestForTest(): void {
  cached = null;
}
