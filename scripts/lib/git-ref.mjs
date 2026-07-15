import { execFileSync } from 'node:child_process';

const LOCAL_GIT_ENV_KEYS = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_PREFIX',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]);

export function cleanGitEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of LOCAL_GIT_ENV_KEYS) delete env[key];
  return { ...env, ...overrides };
}

export function resolveExactCommit(repositoryRoot, ref, invoke = execFileSync) {
  if (typeof ref !== 'string' || ref.trim() === '') return null;
  try {
    const sha = String(invoke('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: cleanGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
