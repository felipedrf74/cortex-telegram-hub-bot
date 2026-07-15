export function projectMapFreshnessProjection(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
    if (typeof parsed.generatedFrom?.baseCommit !== 'string'
        || typeof parsed.generatedFrom?.baseCommitTimestamp !== 'string') return null;
    delete parsed.generatedFrom.baseCommit;
    delete parsed.generatedFrom.baseCommitTimestamp;
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}
