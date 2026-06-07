import fs from 'node:fs';
import path from 'node:path';

export function resolveMaxAge(raw, defaultValue, ceilingValue, options = {}) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  if (parsed <= defaultValue) return parsed;

  const overrideEnabled =
    process.env.NEXUS_RELEASE_FRESHNESS_OVERRIDE === '1' ||
    process.env.NEXUS_EMERGENCY_FRESHNESS_OVERRIDE === '1';
  if (!overrideEnabled) return defaultValue;

  const value = Math.min(parsed, ceilingValue);
  const auditPath = path.resolve(
    options.root || process.cwd(),
    process.env.NEXUS_RELEASE_AUDIT_LOG || '.local/release/override-audit.jsonl',
  );
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.appendFileSync(auditPath, `${JSON.stringify({
    ts: new Date().toISOString(),
    flag: options.flag || 'NEXUS_RELEASE_FRESHNESS_OVERRIDE',
    requested: raw,
    effective: value,
    defaultValue,
    ceilingValue,
    script: options.script || path.basename(process.argv[1] || 'unknown'),
    reason: process.env.NEXUS_EMERGENCY_SKIP_REASON || 'freshness override',
  })}\n`);
  return value;
}
