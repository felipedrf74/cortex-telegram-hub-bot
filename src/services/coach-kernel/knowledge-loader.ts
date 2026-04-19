// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'fs';
import path from 'path';
import type { CoachKnowledgeBase, Exercise, WorkoutTemplate } from './types';

let cachedKnowledge: CoachKnowledgeBase | null = null;

function knowledgePath(...segments: string[]): string {
  return path.join(__dirname, 'knowledge', ...segments);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readJsonCompatibleYaml<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readMarkdown(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

export function loadCoachKnowledge(): CoachKnowledgeBase {
  if (cachedKnowledge) return cachedKnowledge;

  const exercises = readJsonFile<Exercise[]>(knowledgePath('entities', 'exercises.json'));
  const principles = readJsonFile<Record<string, unknown>>(knowledgePath('entities', 'training-principles.json'));
  const workoutTemplates = [
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'run-workouts.yaml')),
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'bike-workouts.yaml')),
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'swim-workouts.yaml')),
    ...readJsonCompatibleYaml<WorkoutTemplate[]>(knowledgePath('templates', 'strength-blocks.yaml')),
  ];

  cachedKnowledge = {
    exercises,
    workoutTemplates,
    principles,
    docs: {
      hybridAthleteRules: readMarkdown(knowledgePath('docs', 'hybrid-athlete-rules.md')),
      marathonPeriodization: readMarkdown(knowledgePath('docs', 'marathon-periodization.md')),
      llmToolContract: readMarkdown(knowledgePath('docs', 'llm-tool-contract.md')),
    },
  };

  return cachedKnowledge;
}

export function resetCoachKnowledgeCache(): void {
  cachedKnowledge = null;
}

