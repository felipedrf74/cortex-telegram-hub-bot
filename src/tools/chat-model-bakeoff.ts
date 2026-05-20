// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import {
  buildChatModelBakeoffReport,
  formatChatModelBakeoffMarkdown,
  type ChatModelBakeoffObservation,
} from '../services/chat-model-bakeoff';
import fs from 'fs';

const observationsPath = readFlagValue('--observations');
const observations = observationsPath ? readObservationsJsonl(observationsPath) : undefined;
const report = buildChatModelBakeoffReport({ observations });
console.log(formatChatModelBakeoffMarkdown(report));

function readFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a JSONL file path`);
  }
  return value;
}

function readObservationsJsonl(filePath: string): ChatModelBakeoffObservation[] {
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as ChatModelBakeoffObservation;
      } catch (err) {
        throw new Error(`Invalid observation JSON on line ${index + 1}: ${(err as Error).message}`);
      }
    });
}
