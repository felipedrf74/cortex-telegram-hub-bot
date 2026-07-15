// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const packageManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));

describe('Package publication manifest', () => {
  it('declares the canonical Nexus package identity and valid release metadata', () => {
    expect(packageManifest).toMatchObject({
      name: '@nexushub/core',
      author: 'Felipe Dominguez',
      license: 'MIT',
    });
    expect(packageManifest.version).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    expect(packageManifest.description).not.toMatch(/\bcortex\b/i);
  });

  it('binds the lockfile root to the same package identity', () => {
    expect(packageLock).toMatchObject({
      name: packageManifest.name,
      version: packageManifest.version,
      packages: {
        '': {
          name: packageManifest.name,
          version: packageManifest.version,
          license: packageManifest.license,
        },
      },
    });
  });

  it('ships the MIT license referenced by package metadata and source headers', () => {
    const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
    expect(license).toContain('MIT License');
    expect(license).toContain('Copyright (c) 2025 Felipe Dominguez');
    expect(license).toContain('Permission is hereby granted, free of charge');
  });
});
