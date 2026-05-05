#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const globs = process.argv.slice(2).filter(Boolean);

function escapeRegex(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    const next = glob[i + 1];
    if (char === '*' && next === '*') {
      const after = glob[i + 2];
      if (after === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function firstLiteralSegment(glob) {
  const wildcardIndex = glob.search(/[*?[]/);
  const literal = wildcardIndex === -1 ? glob : glob.slice(0, wildcardIndex);
  const segment = literal.split('/').filter(Boolean)[0];
  return segment || '.';
}

function walkFiles(startDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(startDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, fullPath).split(path.sep).join('/'));
    }
  }
}

const roots = new Set(globs.map(firstLiteralSegment));
const files = [];
for (const segment of roots) {
  walkFiles(path.join(root, segment), files);
}

const existing = globs.filter((glob) => {
  if (!glob.includes('*') && !glob.includes('?') && !glob.includes('[')) {
    return fs.existsSync(path.join(root, glob));
  }
  const matcher = globToRegExp(glob);
  return files.some((file) => matcher.test(file));
});

process.stdout.write(existing.join(' '));
