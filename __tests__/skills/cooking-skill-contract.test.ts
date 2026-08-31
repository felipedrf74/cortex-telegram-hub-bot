// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'path';
import { describe, expect, it } from 'vitest';

import { TOOLS } from '../../src/services/anthropic';
import { DEFAULT_SKILLS } from '../../src/skills/skill-config';
import { loadManifest } from '../../src/skills/loader';

const COOKING_MANIFEST_DIR = path.join(process.cwd(), 'src', 'skills', 'cooking');

describe('Cooking skill contract', () => {
  it('keeps the install manifest aligned with runtime sub-skills', () => {
    const manifest = loadManifest(COOKING_MANIFEST_DIR);
    const runtime = DEFAULT_SKILLS.cooking;
    const declaredSubSkills = (manifest.submodules ?? []) as Array<{
      module_name: string;
      description?: string;
      enabled_by_default?: boolean;
      tools?: string[];
      cronJobs?: string[];
    }>;

    expect(manifest.name).toBe(runtime.name);
    expect(manifest.domain).toBe(runtime.name);
    expect(manifest.version).toBe(runtime.version);
    expect(manifest.description).toBe(runtime.description);
    expect(declaredSubSkills.map((subSkill) => subSkill.module_name))
      .toEqual(runtime.subSkills.map((subSkill) => subSkill.name));

    for (const subSkill of runtime.subSkills) {
      const declared = declaredSubSkills.find((entry) => entry.module_name === subSkill.name);
      expect(declared, `${subSkill.name} missing from Cooking manifest`).toBeTruthy();
      expect(declared?.description).toBe(subSkill.description);
      expect(declared?.enabled_by_default).toBe(subSkill.enabledByDefault);
      expect(declared?.tools ?? []).toEqual(subSkill.tools);
      expect(declared?.cronJobs ?? []).toEqual(subSkill.cronJobs ?? []);
    }
  });

  it('advertises only executable runtime modules and covers every Cooking tool', () => {
    const manifest = loadManifest(COOKING_MANIFEST_DIR);
    const declaredSubSkills = (manifest.submodules ?? []) as Array<{
      module_name: string;
      enabled_by_default?: boolean;
      tools?: string[];
    }>;
    const declaredTools = declaredSubSkills.flatMap((subSkill) => subSkill.tools ?? []);
    const cookingTools = TOOLS
      .map((tool) => tool.name)
      .filter((toolName) => toolName.startsWith('cooking_'));

    expect(declaredSubSkills.every((subSkill) => !subSkill.enabled_by_default || (subSkill.tools?.length ?? 0) > 0))
      .toBe(true);
    expect(new Set(declaredTools).size).toBe(declaredTools.length);
    expect(declaredTools.filter((toolName) => toolName.startsWith('cooking_')).sort())
      .toEqual(cookingTools.sort());
  });

  it('keeps recipe numeric invariants and Monday shopping boundaries in the tool schema', () => {
    const recipeTool = TOOLS.find((tool) => tool.name === 'cooking_add_recipe');
    const generateShoppingList = TOOLS.find((tool) => tool.name === 'cooking_generate_shopping_list');
    const getShoppingList = TOOLS.find((tool) => tool.name === 'cooking_get_shopping_list');
    expect(recipeTool).toBeDefined();
    const recipeProperties = recipeTool?.input_schema.properties as Record<string, Record<string, unknown>>;

    expect(recipeProperties.prep_time_min).toMatchObject({ minimum: 0, multipleOf: 1 });
    expect(recipeProperties.cook_time_min).toMatchObject({ minimum: 0, multipleOf: 1 });
    expect(recipeProperties.servings).toMatchObject({ minimum: 1, multipleOf: 1 });
    expect(generateShoppingList).toBeDefined();
    expect(getShoppingList).toBeDefined();
    const generationWeek = (generateShoppingList?.input_schema.properties as Record<string, { description?: string }>).week_start;
    const readWeek = (getShoppingList?.input_schema.properties as Record<string, { description?: string }>).week_start;
    expect(generationWeek.description).toMatch(/Monday/i);
    expect(readWeek.description).toMatch(/requested week/i);
  });

  it('keeps Cooking identifiers, limits, confidence, and dates bounded in tool schemas', () => {
    const propertiesFor = (toolName: string) => {
      const tool = TOOLS.find((candidate) => candidate.name === toolName);
      expect(tool, `${toolName} missing from runtime tools`).toBeDefined();
      return tool?.input_schema.properties as Record<string, Record<string, unknown>>;
    };

    expect(propertiesFor('cooking_get_recipes').limit)
      .toMatchObject({ minimum: 1, maximum: 100, multipleOf: 1 });
    expect(propertiesFor('cooking_delete_recipe').recipe_id)
      .toMatchObject({ minimum: 1, multipleOf: 1 });
    expect(propertiesFor('cooking_get_pantry').limit)
      .toMatchObject({ minimum: 1, maximum: 250, multipleOf: 1 });
    expect(propertiesFor('cooking_delete_pantry_item').item_id)
      .toMatchObject({ minimum: 1, multipleOf: 1 });
    expect(propertiesFor('cooking_upsert_pantry_item').confidence)
      .toMatchObject({ minimum: 0, maximum: 1 });
    expect(propertiesFor('cooking_set_preference').confidence)
      .toMatchObject({ minimum: 0, maximum: 1 });
    expect(propertiesFor('cooking_set_meal').recipe_id)
      .toMatchObject({ minimum: 1, multipleOf: 1 });

    for (const [toolName, field] of [
      ['cooking_upsert_pantry_item', 'expires_at'],
      ['cooking_set_meal', 'date'],
      ['cooking_get_meal_plan', 'start_date'],
      ['cooking_get_meal_plan', 'end_date'],
      ['cooking_delete_meal', 'date'],
      ['cooking_generate_shopping_list', 'week_start'],
      ['cooking_get_shopping_list', 'week_start'],
    ] as const) {
      expect(propertiesFor(toolName)[field].pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
    }
  });
});
