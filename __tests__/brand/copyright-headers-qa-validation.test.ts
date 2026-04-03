/**
 * QA Validation Tests — MIT copyright headers across all src/ files
 *
 * Validates that every .ts file under src/ has the required MIT
 * copyright header as its first line.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const ROOT = path.resolve(__dirname, '..', '..');

function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('Copyright headers — QA validation', () => {
  const srcDir = path.join(ROOT, 'src');
  const tsFiles = getAllTsFiles(srcDir);

  it('finds at least 60 .ts files in src/', () => {
    expect(tsFiles.length).toBeGreaterThanOrEqual(60);
  });

  it('every .ts file in src/ has the MIT copyright header on line 1', () => {
    const missing: string[] = [];
    for (const file of tsFiles) {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      if (!firstLine.includes('MIT License')) {
        missing.push(path.relative(ROOT, file));
      }
    }
    expect(missing).toEqual([]);
  });

  it('copyright header mentions Felipe Dominguez', () => {
    const sample = tsFiles.slice(0, 10);
    for (const file of sample) {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      expect(firstLine).toContain('Felipe Dominguez');
    }
  });

  it('copyright header references LICENSE file', () => {
    const sample = tsFiles.slice(0, 10);
    for (const file of sample) {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      expect(firstLine).toContain('See LICENSE');
    }
  });

  it('header format is consistent across all files', () => {
    const headers = new Set<string>();
    for (const file of tsFiles) {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0].trim();
      if (firstLine.includes('MIT License')) {
        headers.add(firstLine);
      }
    }
    // All files should use the exact same header format
    expect(headers.size).toBe(1);
  });

  it('100% of src/ .ts files have coverage (no file missed)', () => {
    const withHeader = tsFiles.filter((file) => {
      const firstLine = fs.readFileSync(file, 'utf-8').split('\n')[0];
      return firstLine.includes('MIT License');
    });
    expect(withHeader.length).toBe(tsFiles.length);
  });
});
