import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const helper = path.resolve('scripts/application-dr-version-retention.py');
const python = process.env.NEXUS_DR_PYTHON_BIN || 'python3';
const prefix = 'nexus-hub/application/database';
const nowIso = '2026-07-23T12:00:00Z';
const nowEpoch = String(Date.parse(nowIso) / 1000);
const expected = {
  hourly: `${prefix}/hourly/nexus-db-20260723T120000Z.sqlite.age`,
  daily: `${prefix}/daily/nexus-db-20260723.sqlite.age`,
  weekly: `${prefix}/weekly/nexus-db-2026-W30.sqlite.age`,
  monthly: `${prefix}/monthly/nexus-db-202607.sqlite.age`,
};

type Version = {
  Key: string;
  VersionId: string;
  LastModified: string;
  IsLatest: boolean;
};

function privateRoot(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  fs.chmodSync(root, 0o700);
  return root;
}

function version(key: string, id: string, modified = nowIso, latest = true): Version {
  return {
    Key: key,
    VersionId: id,
    LastModified: modified,
    IsLatest: latest,
  };
}

function warmingVersions() {
  return [
    version(expected.hourly, 'hourly-current'),
    version(expected.daily, 'daily-current'),
    version(expected.weekly, 'weekly-current'),
    version(expected.monthly, 'monthly-current'),
  ];
}

function matureVersions() {
  const values: Version[] = [];
  for (let offset = 23; offset >= 0; offset -= 1) {
    const instant = new Date(Date.parse(nowIso) - offset * 60 * 60 * 1000);
    const stamp = instant.toISOString()
      .replaceAll('-', '')
      .replaceAll(':', '')
      .replace('.000', '');
    values.push(version(
      `${prefix}/hourly/nexus-db-${stamp}.sqlite.age`,
      `hourly-${offset}`,
      instant.toISOString(),
    ));
  }
  for (const day of ['17', '18', '19', '20', '21', '22', '23']) {
    values.push(version(
      `${prefix}/daily/nexus-db-202607${day}.sqlite.age`,
      `daily-${day}`,
      `2026-07-${day}T00:00:00Z`,
    ));
  }
  for (const week of ['27', '28', '29', '30']) {
    values.push(version(
      `${prefix}/weekly/nexus-db-2026-W${week}.sqlite.age`,
      `weekly-${week}`,
    ));
  }
  for (const month of ['02', '03', '04', '05', '06', '07']) {
    values.push(version(
      `${prefix}/monthly/nexus-db-2026${month}.sqlite.age`,
      `monthly-${month}`,
    ));
  }
  return values;
}

function runEvidence(
  listing: object,
  name: string,
  overrides: Partial<typeof expected> = {},
) {
  const root = privateRoot(`nexus-dr-retention-evidence-${name}-`);
  const listingPath = path.join(root, 'listing.json');
  const output = path.join(root, 'evidence.json');
  fs.writeFileSync(listingPath, JSON.stringify(listing), { mode: 0o600 });
  const keys = { ...expected, ...overrides };
  const result = spawnSync(python, [
    helper,
    '--listing',
    listingPath,
    '--prefix',
    prefix,
    '--output',
    output,
    '--now-epoch',
    nowEpoch,
    '--expected-hourly-key',
    keys.hourly,
    '--expected-daily-key',
    keys.daily,
    '--expected-weekly-key',
    keys.weekly,
    '--expected-monthly-key',
    keys.monthly,
  ], { encoding: 'utf8' });
  return {
    result,
    output,
    evidence: result.status === 0
      ? JSON.parse(fs.readFileSync(output, 'utf8'))
      : null,
  };
}

function directListing(versions: Version[], markers: Version[] = []) {
  return {
    IsTruncated: false,
    Versions: versions,
    DeleteMarkers: markers,
  };
}

describe('application DR versioned-S3 retention evidence', () => {
  it('reports configured policy separately from an honestly warming floor', () => {
    const { result, output, evidence } = runEvidence(
      directListing(warmingVersions()),
      'warming',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(evidence).toMatchObject({
      schemaVersion: 'NexusApplicationDrRetentionEvidenceV1',
      inventoryOnly: true,
      policyConfigured: {
        hourly: 24,
        daily: 7,
        weekly: 4,
        monthly: 6,
      },
      floorObserved: false,
      maturityStatus: 'warming',
      maturitySealed: false,
      selectedObjectsVerified: false,
      currentPeriodsVerified: true,
    });
    expect(evidence).not.toHaveProperty('deletions');
    expect(evidence.tiers.hourly).toMatchObject({
      requiredPoints: 24,
      visiblePoints: 1,
      currentKey: expected.hourly,
      currentKeyPresent: true,
      coveredRequiredPeriods: 1,
      consecutiveRequiredPeriodsPresent: false,
    });
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  it('reports a mature 24/7/4/6 visible retention floor without deletion output', () => {
    const { result, evidence } = runEvidence(
      directListing(matureVersions()),
      'mature',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(evidence.floorObserved).toBe(true);
    expect(evidence.maturityStatus).toBe('mature');
    expect(evidence.tiers.hourly.visiblePoints).toBe(24);
    expect(evidence.tiers.daily.visiblePoints).toBe(7);
    expect(evidence.tiers.weekly.visiblePoints).toBe(4);
    expect(evidence.tiers.monthly.visiblePoints).toBe(6);
    expect(evidence.tiers.hourly.selectedVersions).toHaveLength(24);
    expect(evidence.tiers.daily.selectedVersions).toHaveLength(7);
    expect(evidence.tiers.weekly.selectedVersions).toHaveLength(4);
    expect(evidence.tiers.monthly.selectedVersions).toHaveLength(6);
    expect(JSON.stringify(evidence)).not.toContain('DeletionPlan');
    expect(JSON.stringify(evidence)).not.toContain('deletions');
  });

  it('accepts a fully exhausted, exact two-page service marker chain', () => {
    const values = warmingVersions();
    values[1] = {
      ...values[1],
      VersionId: '--opaque-✓-%2F?generation=1|part',
    };
    const markerKey = values[1].Key;
    const markerVersion = values[1].VersionId;
    const listing = {
      schemaVersion: 'NexusApplicationDrVersionListingV1',
      pages: [
        {
          IsTruncated: true,
          NextKeyMarker: markerKey,
          NextVersionIdMarker: markerVersion,
          Versions: values.slice(0, 2),
          DeleteMarkers: [],
        },
        {
          IsTruncated: false,
          KeyMarker: markerKey,
          VersionIdMarker: markerVersion,
          Versions: values.slice(2),
          DeleteMarkers: [],
        },
      ],
    };

    const { result, evidence } = runEvidence(listing, 'paginated');
    expect(result.status, result.stderr).toBe(0);
    expect(evidence.currentPeriodsVerified).toBe(true);
  });

  it('preserves opaque printable UTF-8 AWS VersionIds without an ASCII grammar', () => {
    const values = warmingVersions();
    values[0] = {
      ...values[0],
      VersionId: '--opaque-✓-%2F?generation=1|part',
    };
    const { result, evidence } = runEvidence(
      directListing(values),
      'opaque-version-id',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(evidence.tiers.hourly.selectedVersions[0].versionId)
      .toBe('--opaque-✓-%2F?generation=1|part');
  });

  it('measures the opaque VersionId limit in UTF-8 bytes', () => {
    const exactValues = warmingVersions();
    exactValues[0] = {
      ...exactValues[0],
      VersionId: 'é'.repeat(512),
    };
    const exact = runEvidence(directListing(exactValues), 'exact-byte-limit');
    expect(exact.result.status, exact.result.stderr).toBe(0);

    const oversizedValues = warmingVersions();
    oversizedValues[0] = {
      ...oversizedValues[0],
      VersionId: `${'é'.repeat(512)}a`,
    };
    const oversized = runEvidence(
      directListing(oversizedValues),
      'oversized-byte-limit',
    );
    expect(oversized.result.status).not.toBe(0);
    expect(oversized.result.stderr).toContain('invalid VersionId');
  });

  it('does not call an equal raw count mature when a recent period is missing', () => {
    const values = matureVersions().filter(
      (item) => !item.Key.includes('/daily/nexus-db-20260722.'),
    );
    values.push(version(
      `${prefix}/daily/nexus-db-20260716.sqlite.age`,
      'daily-16',
      '2026-07-16T00:00:00Z',
    ));
    const { result, evidence } = runEvidence(
      directListing(values),
      'non-consecutive',
    );

    expect(result.status, result.stderr).toBe(0);
    expect(evidence.tiers.daily.visiblePoints).toBe(7);
    expect(evidence.tiers.daily.coveredRequiredPeriods).toBe(6);
    expect(evidence.tiers.daily.consecutiveRequiredPeriodsPresent).toBe(false);
    expect(evidence.floorObserved).toBe(false);
    expect(evidence.maturityStatus).toBe('warming');
  });

  it('seals first maturity and fails closed if a later floor regresses', () => {
    const root = privateRoot('nexus-dr-retention-maturity-seal-');
    const seal = path.join(root, 'retention-maturity.json');
    const common = [
      helper,
      '--prefix', prefix,
      '--now-epoch', nowEpoch,
      '--maturity-seal', seal,
      '--bucket', 'nexus-recovery',
      '--expected-hourly-key', expected.hourly,
      '--expected-daily-key', expected.daily,
      '--expected-weekly-key', expected.weekly,
      '--expected-monthly-key', expected.monthly,
    ];
    const run = (name: string, versions: Version[]) => {
      const listing = path.join(root, `${name}-listing.json`);
      const output = path.join(root, `${name}-evidence.json`);
      fs.writeFileSync(
        listing,
        JSON.stringify(directListing(versions)),
        { mode: 0o600 },
      );
      const result = spawnSync(python, [
        ...common,
        '--listing', listing,
        '--output', output,
      ], { encoding: 'utf8' });
      return { result, output };
    };

    const mature = run('mature', matureVersions());
    expect(mature.result.status, mature.result.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(mature.output, 'utf8')))
      .toMatchObject({ maturityStatus: 'mature', maturitySealed: true });
    expect(fs.statSync(seal).mode & 0o777).toBe(0o600);

    const regressed = run('regressed', warmingVersions());
    expect(regressed.result.status).not.toBe(0);
    expect(regressed.result.stderr).toContain(
      'sealed retention maturity regressed below the 24/7/4/6 floor',
    );
    expect(fs.existsSync(regressed.output)).toBe(false);
  });

  it.each([
    {
      name: 'literal-null-version',
      listing: directListing([
        { ...warmingVersions()[0], VersionId: 'null' },
        ...warmingVersions().slice(1),
      ]),
      message: 'invalid VersionId',
    },
    {
      name: 'json-null-version',
      listing: directListing([
        {
          ...warmingVersions()[0],
          VersionId: null as unknown as string,
        },
        ...warmingVersions().slice(1),
      ]),
      message: 'invalid VersionId',
    },
    {
      name: 'duplicate-identity',
      listing: directListing([
        ...warmingVersions(),
        { ...warmingVersions()[0], IsLatest: false },
      ]),
      message: 'duplicate key/version identities',
    },
    {
      name: 'control-character-version',
      listing: directListing([
        { ...warmingVersions()[0], VersionId: 'unsafe\nversion' },
        ...warmingVersions().slice(1),
      ]),
      message: 'invalid VersionId',
    },
    {
      name: 'hidden-current-period',
      listing: directListing(
        [
          { ...warmingVersions()[0], IsLatest: false },
          ...warmingVersions().slice(1),
        ],
        [version(expected.hourly, 'hourly-delete-marker')],
      ),
      message: 'current hourly recovery point is not visibly retained',
    },
    {
      name: 'unexhausted-page',
      listing: {
        IsTruncated: true,
        NextKeyMarker: expected.daily,
        NextVersionIdMarker: 'daily-current',
        Versions: warmingVersions(),
        DeleteMarkers: [],
      },
      message: 'pages are not fully exhausted',
    },
    {
      name: 'future-period',
      listing: directListing([
        ...warmingVersions(),
        version(
          `${prefix}/hourly/nexus-db-20260723T123000Z.sqlite.age`,
          'future-hourly',
          '2026-07-23T12:30:00Z',
        ),
      ]),
      message: 'future calendar period',
    },
  ])('fails closed for $name', ({ listing, message, name }) => {
    const { result, output } = runEvidence(listing, name);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(output)).toBe(false);
  });

  it('rejects an expected calendar key that does not match the observation period', () => {
    const { result } = runEvidence(
      directListing(warmingVersions()),
      'wrong-period',
      {
        daily: `${prefix}/daily/nexus-db-20260722.sqlite.age`,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'expected daily key does not match the current UTC period',
    );
  });
});
