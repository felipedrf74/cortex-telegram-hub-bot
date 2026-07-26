#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  process.stderr.write(`quality_sonar_cloudformation_yaml_failed:${message}\n`);
  process.exit(1);
}

function mappingKey(content) {
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (doubleQuoted && escaped) {
      escaped = false;
      continue;
    }
    if (doubleQuoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (!doubleQuoted && character === "'") {
      singleQuoted = !singleQuoted;
      continue;
    }
    if (!singleQuoted && character === '"') {
      doubleQuoted = !doubleQuoted;
      continue;
    }
    if (!singleQuoted && !doubleQuoted && character === ':') {
      if (index + 1 < content.length && !/\s/u.test(content[index + 1])) {
        continue;
      }
      const token = content.slice(0, index).trim();
      if (!token || token.startsWith('?') || token.startsWith('{')) return null;
      if ((token.startsWith("'") && token.endsWith("'"))
          || (token.startsWith('"') && token.endsWith('"'))) {
        return { key: token.slice(1, -1), separatorIndex: index };
      }
      return { key: token, separatorIndex: index };
    }
  }
  return null;
}

function validate(file) {
  if (!path.isAbsolute(file) || file === path.parse(file).root) {
    fail('template path must be an absolute non-root path');
  }
  let body;
  try {
    body = fs.readFileSync(file, 'utf8');
  } catch (error) {
    fail(`template is unreadable: ${error.message}`);
  }
  if (body.includes('\t')) fail('template must not contain tab characters');

  const contexts = [];
  const lines = body.split(/\r?\n/u);
  let blockScalarParentIndent = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const indentation = line.match(/^ */u)?.[0].length ?? 0;
    let content = line.slice(indentation);
    if (blockScalarParentIndent !== null) {
      if (!content || indentation > blockScalarParentIndent) continue;
      blockScalarParentIndent = null;
    }
    if (!content || content.startsWith('#')) continue;

    const sequenceItem = content.startsWith('- ');
    if (sequenceItem) {
      const itemIndent = indentation + 2;
      while (
        contexts.length > 0
        && contexts[contexts.length - 1].indent >= itemIndent
      ) {
        contexts.pop();
      }
      contexts.push({ indent: itemIndent, keys: new Map() });
      content = content.slice(2);
    }
    const mapping = mappingKey(content);
    if (mapping === null) continue;
    const { key } = mapping;
    const mappingIndent = indentation + (sequenceItem ? 2 : 0);
    while (
      contexts.length > 0
      && contexts[contexts.length - 1].indent > mappingIndent
    ) {
      contexts.pop();
    }
    if (
      contexts.length === 0
      || contexts[contexts.length - 1].indent < mappingIndent
    ) {
      contexts.push({ indent: mappingIndent, keys: new Map() });
    }
    const context = contexts[contexts.length - 1];
    const previousLine = context.keys.get(key);
    if (previousLine !== undefined) {
      fail(
        `duplicate block mapping key ${JSON.stringify(key)} at line `
        + `${lineIndex + 1}; first declared at line ${previousLine}`,
      );
    }
    context.keys.set(key, lineIndex + 1);
    if (/(?:^|\s)[|>][+-]?(?:\s+#.*)?$/u.test(
      content.slice(mapping.separatorIndex + 1).trim(),
    )) {
      blockScalarParentIndent = indentation;
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    check: 'duplicate-block-mapping-keys',
    template: file,
  })}\n`);
}

if (process.argv.length !== 3) {
  fail('usage: quality-sonar-cloudformation-yaml-check.mjs /absolute/template.yaml');
}
validate(path.resolve(process.argv[2]));
