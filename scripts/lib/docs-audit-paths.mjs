import path from 'node:path';
import fs from 'node:fs';

export function isWorkspaceArchitectureDecision(file, workspaceRoot) {
  const normalizedFile = path.resolve(file);
  const adrRoot = path.join(path.resolve(workspaceRoot), 'docs', 'adr');
  return normalizedFile.startsWith(`${adrRoot}${path.sep}`);
}

export function hasGitCheckoutMetadata(repoRoot, exists = fs.existsSync) {
  return exists(path.join(path.resolve(repoRoot), '.git'));
}

const ENGINEERING_REGISTRY = 'docs/engineering/ENGINEERING_STANDARDS_INDEX.md';

/**
 * Return repository-local Markdown paths declared by a canonical path registry.
 *
 * The engineering index also documents paths owned by the surrounding Nexus
 * workspace. Those are intentionally outside this repository's audit boundary,
 * so only its local canonical/companion sections are inspected.
 */
export function canonicalRegistryMarkdownPaths(registryFile, source) {
  const normalized = registryFile.split(path.sep).join('/');
  const localSource = normalized === ENGINEERING_REGISTRY
    ? source.split(/^## Related cross-repo standards\s*$/m, 1)[0]
    : source;
  const withoutFences = localSource.replace(/```[\s\S]*?```/g, '');
  return [...withoutFences.matchAll(/`([^`\r\n]+\.md(?:#[^`\r\n]+)?)`/g)]
    .map((match) => match[1].replace(/#.*$/, ''))
    .filter((reference, index, references) => references.indexOf(reference) === index);
}

export function resolveCanonicalRegistryMarkdownPath(registryFile, reference, repoRoot) {
  if (path.isAbsolute(reference)) return path.normalize(reference);
  if (reference.startsWith('docs/') || !reference.includes('/')) {
    if (!reference.includes('/')) {
      return path.resolve(path.dirname(path.join(repoRoot, registryFile)), reference);
    }
    return path.resolve(repoRoot, reference);
  }
  return path.resolve(path.dirname(path.join(repoRoot, registryFile)), reference);
}

export function missingCanonicalRegistryMarkdownPaths({
  registryFile,
  source,
  repoRoot,
  exists = fs.existsSync,
}) {
  return canonicalRegistryMarkdownPaths(registryFile, source)
    .map((reference) => ({
      reference,
      target: resolveCanonicalRegistryMarkdownPath(registryFile, reference, repoRoot),
    }))
    .filter(({ target }) => !exists(target));
}
