/**
 * QA Validation Tests — package.json @nexushub/core rename
 *
 * Validates that package.json uses the scoped @nexushub/core name
 * and has license: MIT set.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

describe('package.json @nexushub/core rename', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
  );

  it('package name is @nexushub/core', () => {
    expect(pkg.name).toBe('@nexushub/core');
  });

  it('package name is not the old nexus-hub name', () => {
    expect(pkg.name).not.toBe('nexus-hub');
  });

  it('license is MIT', () => {
    expect(pkg.license).toBe('MIT');
  });

  it('description mentions Nexus Hub', () => {
    expect(pkg.description).toContain('Nexus Hub');
  });
});
