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
