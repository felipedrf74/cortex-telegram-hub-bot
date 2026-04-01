/**
 * QA Validation Tests — @nexushub/core rename consistency
 *
 * Validates that the package rename from nexus-hub to @nexushub/core
 * is consistent across package.json, package-lock.json, and that
 * no stale references to the old name remain in key config files.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

describe('@nexushub/core rename — QA validation', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')
  );
  const lockfile = fs.readFileSync(
    path.join(ROOT, 'package-lock.json'),
    'utf-8'
  );
  const lock = JSON.parse(lockfile);

  describe('package.json fields', () => {
    it('name is scoped @nexushub/core', () => {
      expect(pkg.name).toBe('@nexushub/core');
    });

    it('license is MIT', () => {
      expect(pkg.license).toBe('MIT');
    });

    it('has an author field', () => {
      expect(pkg.author).toBeTruthy();
    });

    it('description does not reference old "cortex" name', () => {
      expect(pkg.description.toLowerCase()).not.toContain('cortex');
    });

    it('version follows semver', () => {
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('package-lock.json consistency', () => {
    it('lock name matches package.json name', () => {
      expect(lock.name).toBe(pkg.name);
    });

    it('lock version matches package.json version', () => {
      expect(lock.version).toBe(pkg.version);
    });

    it('lock root package name matches', () => {
      const rootEntry = lock.packages?.[''];
      if (rootEntry) {
        expect(rootEntry.name).toBe(pkg.name);
      }
    });

    it('lockfile does not contain old "nexus-hub" as a root name', () => {
      // Only check the first few lines where root name is defined
      const firstLines = lockfile.split('\n').slice(0, 15).join('\n');
      expect(firstLines).not.toContain('"name": "nexus-hub"');
    });
  });

  describe('no stale old-name references in config', () => {
    it('tsconfig.json does not reference old package name', () => {
      const tsconfig = fs.readFileSync(
        path.join(ROOT, 'tsconfig.json'),
        'utf-8'
      );
      expect(tsconfig).not.toContain('"nexus-hub"');
    });

    it('package.json scripts do not reference old package name', () => {
      const scriptsJson = JSON.stringify(pkg.scripts || {});
      expect(scriptsJson).not.toContain('nexus-hub');
    });
  });
});
