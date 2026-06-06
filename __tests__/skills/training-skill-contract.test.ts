// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SKILLS } from '../../src/skills/skill-config';
import { loadManifest } from '../../src/skills/loader';
import { getChatActionRegistry } from '../../src/services/chat/registry';
import { getChatStepExecutor } from '../../src/services/chat/executor/dispatch-table';

const ROOT = process.cwd();
const TRAINING_MANIFEST_DIR = path.join(ROOT, 'src', 'skills', 'training');
const TRAINING_MANIFEST_PATH = path.join(TRAINING_MANIFEST_DIR, 'manifest.json');

function readTrainingManifest(): any {
  return JSON.parse(fs.readFileSync(TRAINING_MANIFEST_PATH, 'utf8'));
}

describe('Training skill contract', () => {
  it('loads the manifest and keeps sub-skills aligned with skill-config', () => {
    const manifest = loadManifest(TRAINING_MANIFEST_DIR);
    const runtime = DEFAULT_SKILLS.triathlon;

    expect(manifest.name).toBe('training');
    expect(manifest.domain).toBe(runtime.name);
    expect(manifest.version).toBe(runtime.version);

    const manifestSubskills = (manifest.submodules ?? []) as Array<{
      module_name: string;
      enabled_by_default?: boolean;
      tools?: string[];
      cronJobs?: string[];
    }>;
    expect(manifestSubskills.map((sub) => sub.module_name)).toEqual(runtime.subSkills.map((sub) => sub.name));

    for (const sub of runtime.subSkills) {
      const declared = manifestSubskills.find((entry) => entry.module_name === sub.name);
      expect(declared, `${sub.name} missing from manifest`).toBeTruthy();
      expect(declared?.enabled_by_default).toBe(sub.enabledByDefault);
      expect(declared?.tools ?? []).toEqual(sub.tools);
      expect(declared?.cronJobs ?? []).toEqual(sub.cronJobs ?? []);
    }
  });

  it('does not pin Training model availability to one provider key', () => {
    const manifest = readTrainingManifest();

    expect(manifest.requiredApiKeys).toEqual([]);
    expect(manifest.config?.modelRouting).toEqual({
      task: 'toolUse',
      primaryEnv: 'AI_TOOL_USE_PRIMARY',
      fallbackEnv: 'AI_TOOL_USE_FALLBACK',
    });
    expect(JSON.stringify(manifest.requiredApiKeys)).not.toMatch(/GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  });

  it('keeps Training registry actions executable unless explicitly blocked', () => {
    const trainingActions = getChatActionRegistry().filter((entry) => entry.skill === 'training');

    expect(trainingActions.map((entry) => entry.action)).toEqual([
      'training_explain_session',
      'training_coach_report',
      'training_plan_create',
      'training_reflow_preview',
      'training_reflow_confirm',
      'training_adjust_plan',
    ]);

    for (const entry of trainingActions) {
      const executor = getChatStepExecutor(entry.action);
      if (entry.executionPolicy === 'blocked') {
        expect(entry.action).toBe('training_adjust_plan');
        expect(entry.status).toBe('active');
        expect(executor).toBeUndefined();
        continue;
      }
      expect(executor, `${entry.action} is active but has no dispatch-table executor`).toBeTypeOf('function');
    }
  });

  it('marks Training reflow actions as preview-then-confirm writes', () => {
    const trainingActions = getChatActionRegistry().filter((entry) => entry.skill === 'training');
    const reflow = trainingActions.filter((entry) => entry.action.startsWith('training_reflow_'));

    expect(reflow).toHaveLength(2);
    for (const entry of reflow) {
      expect(entry.confirmationPolicy).toBe('confirm');
      expect(entry.executionPolicy).toBe('preview_then_confirm');
      expect(entry.verificationPolicy).toBe('local_readback_required');
    }
  });
});
