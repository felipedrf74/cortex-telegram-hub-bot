// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Parse `git diff --name-status -z` without shell quoting or newline
 * assumptions. Renames and copies return both identities so policy keyed to
 * the old path cannot disappear through a same-prefix rename.
 */
export function parseGitNameStatusZ(value) {
  return parseGitNameStatusRecordsZ(value).flatMap((record) => record.paths);
}

export function parseGitNameStatusRecordsZ(value) {
  const fields = splitNul(value);
  const records = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!/^[A-Z?][0-9]*$/.test(status)) {
      throw new Error(`invalid Git name-status field: ${JSON.stringify(status)}`);
    }
    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    if (index + pathCount > fields.length) {
      throw new Error(`truncated Git name-status record: ${status}`);
    }
    const paths = [];
    for (let offset = 0; offset < pathCount; offset += 1) paths.push(fields[index++]);
    records.push({ status, paths });
  }
  return records;
}

export function parseGitPathsZ(value) {
  return splitNul(value);
}

function splitNul(value) {
  const fields = String(value).split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.some((field) => field.length === 0)) {
    throw new Error('Git emitted an empty path field');
  }
  return fields;
}
