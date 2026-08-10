export function parseViMockStrictBaseline(raw) {
  const match = raw.match(/partialMockCount\s*=\s*(\d+)/);
  if (!match) throw new Error('vi.mock strict baseline is missing partialMockCount');

  const allowances = [];
  const seen = new Set();
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('allowExactPartialMocks=')) continue;
    const allowance = trimmed.match(
      /^allowExactPartialMocks=(src\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|mjs))\|([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)\|max=([1-9]\d*)$/u,
    );
    if (!allowance) throw new Error(`invalid vi.mock strict allowance: ${trimmed}`);

    const [, realModule, missingList, maximum] = allowance;
    if (seen.has(realModule)) {
      throw new Error(`duplicate vi.mock strict allowance for ${realModule}`);
    }
    seen.add(realModule);
    allowances.push({
      realModule,
      missing: missingList.split(',').sort(),
      maximum: Number(maximum),
    });
  }

  return { partialMockCount: Number(match[1]), allowances };
}

export function evaluateViMockStrictFindings(findings, baseline) {
  const partial = findings.filter((finding) => finding.severity === 'partial-mock');
  let allowedCount = 0;
  const exceededAllowances = [];

  for (const allowance of baseline.allowances) {
    const matches = partial.filter((finding) => (
      finding.realModule === allowance.realModule
      && finding.defaultMismatch === false
      && finding.hasReExport === false
      && JSON.stringify([...(finding.missing ?? [])].sort()) === JSON.stringify(allowance.missing)
    ));
    if (matches.length > allowance.maximum) {
      exceededAllowances.push({
        realModule: allowance.realModule,
        count: matches.length,
        maximum: allowance.maximum,
      });
    }
    allowedCount += Math.min(matches.length, allowance.maximum);
  }

  return {
    allowedCount,
    evaluatedPartialMockCount: partial.length - allowedCount,
    exceededAllowances,
  };
}

export function passesViMockStrictGate(baseline, evaluation) {
  return evaluation.exceededAllowances.length === 0
    && evaluation.evaluatedPartialMockCount <= baseline.partialMockCount;
}
