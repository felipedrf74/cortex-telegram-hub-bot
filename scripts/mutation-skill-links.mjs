#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Stryker copies tracked entries as regular files and cannot copy directory
// symlinks. Rebuild only the known mirrors inside its disposable sandbox.
export function restoreMutationSkillLinks(root) {
  root = fs.realpathSync(root);
  if (!root.split(path.sep).join('/').includes('/.local/stryker-tmp/sandbox-')) {
    throw new Error('Skill mirror preparation requires a Stryker sandbox');
  }
  const mirrorRoot = path.join(root, '.claude', 'skills');
  for (const part of [path.join(root, '.claude'), mirrorRoot]) {
    if (fs.existsSync(part) && (!fs.lstatSync(part).isDirectory() || fs.lstatSync(part).isSymbolicLink())) throw new Error('Unsafe mirror parent');
    fs.mkdirSync(part, { recursive: true });
  }
  for (const name of ['product-sentinel', 'release-operator', 'test-audit', 'verifiable-reward-check']) {
    const source = path.join(root, '.agents', 'skills', name);
    if (!fs.realpathSync(source).startsWith(root + path.sep) || !fs.existsSync(path.join(source, 'SKILL.md'))) throw new Error('Missing canonical sandbox skill');
    const target = path.join(mirrorRoot, name), relative = `../../.agents/skills/${name}`;
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isSymbolicLink() || fs.readlinkSync(target) !== relative) throw new Error('Existing mirror differs; retained');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.symlinkSync(relative, target, 'dir');
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) restoreMutationSkillLinks(process.cwd());
