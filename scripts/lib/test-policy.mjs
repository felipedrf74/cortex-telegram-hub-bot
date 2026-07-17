import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function loadTestPolicy() {
  return JSON.parse(fs.readFileSync(path.join(root, 'config/test-policy.json'), 'utf8'));
}

export function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === '*' && next === '*') {
      if (glob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function walkTestFiles(sourceRoot = root) {
  const files = [];
  const start = path.join(sourceRoot, '__tests__');
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
        files.push(path.relative(sourceRoot, absolute).split(path.sep).join('/'));
      }
    }
  };
  walk(start);
  return files.sort();
}

export function matchFiles(files, patterns) {
  const matchers = patterns.map(globToRegExp);
  return files.filter((file) => matchers.some((matcher) => matcher.test(file)));
}

export function dispositionRuleProvenance(rule, ruleIndex) {
  return {
    kind: /[*?]/.test(rule.pattern) ? 'pattern' : 'exact',
    pattern: rule.pattern,
    ruleIndex,
  };
}

export function resolveTestDisposition(file, policy) {
  for (const [ruleIndex, rule] of (policy.dispositionRules ?? []).entries()) {
    if (globToRegExp(rule.pattern).test(file)) {
      return {
        disposition: rule.disposition,
        reason: rule.reason,
        provenance: dispositionRuleProvenance(rule, ruleIndex),
      };
    }
  }
  return null;
}

export function partitionTestFiles(files, policy) {
  const records = files.map((file) => ({
    file,
    resolution: resolveTestDisposition(file, policy),
  }));
  const unresolved = records.filter(({ resolution }) => resolution === null).map(({ file }) => file);
  if (unresolved.length > 0) {
    throw new Error(`Test policy left ${unresolved.length} files without a disposition: ${unresolved.join(', ')}`);
  }

  const evaluation = records
    .filter(({ resolution }) => resolution.disposition === 'eval')
    .map(({ file }) => file);
  const deterministic = records
    .filter(({ resolution }) => resolution.disposition !== 'eval')
    .map(({ file }) => file);

  return { deterministic, evaluation };
}
