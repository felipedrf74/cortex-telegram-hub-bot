import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function normalizedGitMode(stat) {
  if (stat.isSymbolicLink()) return '120000';
  if (stat.isFile()) return (stat.mode & 0o111) === 0 ? '100644' : '100755';
  throw new Error('Project map source digest only supports files and symbolic links');
}

export function projectMapSourceDigest(root, files) {
  const digest = createHash('sha256');
  for (const file of files) {
    const absolute = path.join(root, file);
    const stat = fs.lstatSync(absolute);
    digest.update(file).update('\0').update(normalizedGitMode(stat)).update('\0');
    if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(absolute));
    else digest.update(fs.readFileSync(absolute));
    digest.update('\0');
  }
  return digest.digest('hex');
}
