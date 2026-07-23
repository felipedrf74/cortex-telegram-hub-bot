import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const helper = path.resolve('scripts/application-dr-version-retention.py');
const python = process.env.NEXUS_TEST_PYTHON ?? 'python3';
const temporaryRoots: string[] = [];

type Tier = 'hourly' | 'daily' | 'weekly' | 'monthly';
type VersionEntry = ReturnType<typeof entry>;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function privateRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-dr-versions-')));
  fs.chmodSync(root, 0o700);
  temporaryRoots.push(root);
  return root;
}

function entry(
  key: string,
  versionId: string,
  modified: string,
  isLatest = true,
) {
  return {
    Key: key,
    VersionId: versionId,
    LastModified: modified,
    IsLatest: isLatest,
  };
}

function run(args: string[]) {
  return spawnSync(python, [helper, ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function completeListing(versions: VersionEntry[], markers: VersionEntry[] = []) {
  return {
    IsTruncated: false,
    Versions: versions,
    DeleteMarkers: markers,
  };
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, '0');
}

function tierKey(prefix: string, tier: Tier, index: number) {
  if (tier === 'hourly') {
    const date = new Date(Date.UTC(2026, 0, 1, index));
    const timestamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}`
      + `${pad(date.getUTCDate())}T${pad(date.getUTCHours())}0000Z`;
    return `${prefix}/${tier}/nexus-db-${timestamp}.sqlite.age`;
  }
  if (tier === 'daily') {
    return `${prefix}/${tier}/nexus-db-202607${pad(index + 1)}.sqlite.age`;
  }
  if (tier === 'weekly') {
    return `${prefix}/${tier}/nexus-db-2026-W${pad(index + 1)}.sqlite.age`;
  }
  return `${prefix}/${tier}/nexus-db-2026${pad(index + 1)}.sqlite.age`;
}

function writeListing(root: string, name: string, listing: unknown) {
  const listingPath = path.join(root, `${name}.json`);
  fs.writeFileSync(listingPath, JSON.stringify(listing));
  return listingPath;
}

function retentionPlan({
  root,
  listing,
  name,
  prefix,
  tier,
  retain,
}: {
  root: string;
  listing: unknown;
  name: string;
  prefix: string;
  tier: Tier;
  retain: number;
}) {
  const listingPath = writeListing(root, `${name}-listing`, listing);
  const output = path.join(root, `${name}-plan.json`);
  const result = run([
    '--listing',
    listingPath,
    '--prefix',
    prefix,
    '--output',
    output,
    'count',
    '--tier',
    tier,
    '--retain',
    String(retain),
  ]);
  return {
    result,
    output,
    plan: result.status === 0 ? JSON.parse(fs.readFileSync(output, 'utf8')) : null,
  };
}

describe('application DR versioned-S3 retention', () => {
  it.each([
    { tier: 'hourly' as const, retain: 24 },
    { tier: 'daily' as const, retain: 7 },
    { tier: 'weekly' as const, retain: 4 },
    { tier: 'monthly' as const, retain: 6 },
  ])('retains exactly one current version for the newest $retain $tier keys', ({
    tier,
    retain,
  }) => {
    const root = privateRoot();
    const prefix = 'nexus-hub/application/database';
    const keys = Array.from(
      { length: retain + 6 },
      (_, index) => tierKey(prefix, tier, index),
    );
    const newestKey = keys.at(-1)!;
    const versions = keys.flatMap((key, index) => {
      const current = entry(
        key,
        `current-${tier}-${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        key !== newestKey,
      );
      if (key !== newestKey) return [current];
      return [
        current,
        entry(
          key,
          `old-${tier}-${index}`,
          new Date(Date.UTC(2025, 11, 31, 0, index)).toISOString(),
          false,
        ),
      ];
    });
    versions.push(
      entry(
        `${prefix}/${tier}/operator-note.txt`,
        'unknown version id with spaces',
        '2020-01-01T00:00:00Z',
      ),
    );
    const markers = [
      entry(newestKey, `marker-${tier}`, '2026-12-31T00:00:00Z'),
      entry(
        `${prefix}/${tier}/operator-note.txt`,
        'unknown marker id with spaces',
        '2020-01-01T00:00:00Z',
      ),
    ];

    const { result, output, plan } = retentionPlan({
      root,
      listing: completeListing(versions, markers),
      name: tier,
      prefix,
      tier,
      retain,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(plan.schemaVersion).toBe('NexusApplicationDrVersionDeletionPlanV1');

    const deletedIdentities = new Set(
      plan.deletions.map(
        (item: { key: string; versionId: string }) => `${item.key}\0${item.versionId}`,
      ),
    );
    const retainedIdentities = versions
      .filter((item) => item.Key !== `${prefix}/${tier}/operator-note.txt`)
      .filter((item) => !deletedIdentities.has(`${item.Key}\0${item.VersionId}`))
      .map((item) => `${item.Key}\0${item.VersionId}`)
      .sort();
    const expectedRetained = keys
      .slice(-retain)
      .map((key, index) => {
        const originalIndex = keys.length - retain + index;
        return `${key}\0current-${tier}-${originalIndex}`;
      })
      .sort();
    expect(retainedIdentities).toEqual(expectedRetained);
    expect(plan.deletions).toContainEqual({
      key: newestKey,
      versionId: `marker-${tier}`,
      kind: 'delete-marker',
    });
    expect(
      plan.deletions.some(
        (item: { key: string }) => item.key.includes('operator-note'),
      ),
    ).toBe(false);
    const newestDeletions = plan.deletions.filter(
      (item: { key: string }) => item.key === newestKey,
    );
    expect(newestDeletions.map((item: { kind: string }) => item.kind)).toEqual([
      'version',
      'delete-marker',
    ]);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
  });

  it('accepts only an explicitly exhausted, ordered AWS marker chain', () => {
    const root = privateRoot();
    const prefix = 'nexus-hub/application/database';
    const firstKey = `${prefix}/daily/nexus-db-20260722.sqlite.age`;
    const secondKey = `${prefix}/daily/nexus-db-20260723.sqlite.age`;
    const firstPage = {
      IsTruncated: true,
      NextKeyMarker: firstKey,
      NextVersionIdMarker: 'first-version',
      Versions: [entry(firstKey, 'first-version', '2026-07-22T00:00:00Z')],
      DeleteMarkers: [],
    };
    const finalPage = {
      KeyMarker: firstKey,
      VersionIdMarker: 'first-version',
      IsTruncated: false,
      Versions: [entry(secondKey, 'second-version', '2026-07-23T00:00:00Z')],
      DeleteMarkers: [],
    };
    const envelope = {
      schemaVersion: 'NexusApplicationDrVersionListingV1',
      pages: [firstPage, finalPage],
    };
    const accepted = retentionPlan({
      root,
      listing: envelope,
      name: 'ordered-pages',
      prefix,
      tier: 'daily',
      retain: 1,
    });
    expect(accepted.result.status, accepted.result.stderr).toBe(0);
    expect(accepted.plan.deletions).toEqual([
      { key: firstKey, versionId: 'first-version', kind: 'version' },
    ]);

    const wrongChain = {
      ...envelope,
      pages: [firstPage, { ...finalPage, KeyMarker: 'wrong-key' }],
    };
    const rejected = retentionPlan({
      root,
      listing: wrongChain,
      name: 'wrong-chain',
      prefix,
      tier: 'daily',
      retain: 1,
    });
    expect(rejected.result.status).not.toBe(0);
    expect(rejected.result.stderr).toContain('marker chain is invalid');
  });

  it('keeps fresh release versions visible and orders locked versions before markers', () => {
    const root = privateRoot();
    const prefix = 'nexus-hub/application';
    const digest = 'a'.repeat(64);
    const oldKey = `${prefix}/releases/v4.14.220_before-v4.14.221_20260101_000000.tar.gz.${digest}.age`;
    const boundaryKey = `${prefix}/releases/v4.14.229_before-v4.14.230_20260424_110000.tar.gz.${digest}.age`;
    const freshKey = `${prefix}/releases/v4.14.230_before-v4.14.231_20260720_000000.tar.gz.${digest}.age`;
    const listing = writeListing(
      root,
      'release-versions',
      completeListing(
        [
          entry(oldKey, 'old-release-version', '2026-01-01T00:00:00Z', false),
          entry(
            boundaryKey,
            'boundary-release-version',
            '2026-04-24T11:00:00Z',
          ),
          entry(freshKey, 'fresh-release-version', '2026-07-20T00:00:00Z', false),
          entry(
            `${prefix}/releases/operator-note.txt`,
            'unknown version id with spaces',
            '2020-01-01T00:00:00Z',
          ),
        ],
        [
          entry(oldKey, 'old-release-marker', '2026-07-01T00:00:00Z'),
          entry(freshKey, 'fresh-release-marker', '2026-07-21T00:00:00Z'),
        ],
      ),
    );
    const output = path.join(root, 'release-plan.json');

    const result = run([
      '--listing',
      listing,
      '--prefix',
      prefix,
      '--output',
      output,
      'age',
      '--days',
      '90',
      '--now-epoch',
      String(Date.parse('2026-07-23T12:00:00Z') / 1000),
      '--grace-seconds',
      '3600',
    ]);
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(plan.deletions).toContainEqual({
      key: freshKey,
      versionId: 'fresh-release-marker',
      kind: 'delete-marker',
    });
    expect(plan.deletions).not.toContainEqual(
      expect.objectContaining({
        key: freshKey,
        versionId: 'fresh-release-version',
      }),
    );
    expect(plan.deletions).not.toContainEqual(
      expect.objectContaining({ key: boundaryKey }),
    );
    const oldDeletions = plan.deletions.filter(
      (item: { key: string }) => item.key === oldKey,
    );
    expect(oldDeletions).toEqual([
      { key: oldKey, versionId: 'old-release-version', kind: 'version' },
      { key: oldKey, versionId: 'old-release-marker', kind: 'delete-marker' },
    ]);
  });

  it('fails closed on incomplete listings, inconsistent latest state, and invalid calendars', () => {
    const root = privateRoot();
    const prefix = 'nexus-hub/application/database';
    const dailyKey = `${prefix}/daily/nexus-db-20260723.sqlite.age`;
    const weeklyKey = `${prefix}/weekly/nexus-db-2026-W30.sqlite.age`;
    const cases: Array<{
      name: string;
      listing: unknown;
      reason: string;
      tier?: Tier;
    }> = [
      {
        name: 'missing-truncation-state',
        listing: { Versions: [], DeleteMarkers: [] },
        reason: 'IsTruncated must be an explicit boolean',
      },
      {
        name: 'unexhausted',
        listing: {
          IsTruncated: true,
          NextKeyMarker: dailyKey,
          NextVersionIdMarker: 'daily-version',
          Versions: [entry(dailyKey, 'daily-version', '2026-07-23T00:00:00Z')],
          DeleteMarkers: [],
        },
        reason: 'pages are not fully exhausted',
      },
      {
        name: 'cli-token',
        listing: {
          ...completeListing([]),
          NextToken: 'still-more-data',
        },
        reason: 'unconsumed AWS CLI continuation token',
      },
      {
        name: 'invalid-id',
        listing: completeListing([
          entry(dailyKey, 'invalid version id', '2026-07-23T00:00:00Z'),
        ]),
        reason: 'invalid VersionId',
      },
      {
        name: 'duplicate',
        listing: completeListing(
          [entry(dailyKey, 'same-id', '2026-07-23T00:00:00Z')],
          [entry(dailyKey, 'same-id', '2026-07-23T00:00:01Z', false)],
        ),
        reason: 'duplicate key/version identities',
      },
      {
        name: 'multiple-latest',
        listing: completeListing(
          [entry(dailyKey, 'daily-version', '2026-07-23T00:00:00Z')],
          [entry(dailyKey, 'daily-marker', '2026-07-23T00:00:01Z')],
        ),
        reason: 'exactly one IsLatest',
      },
      {
        name: 'missing-latest',
        listing: completeListing([
          entry(dailyKey, 'daily-version', '2026-07-23T00:00:00Z', false),
        ]),
        reason: 'exactly one IsLatest',
      },
      {
        name: 'invalid-day',
        listing: completeListing([
          entry(
            `${prefix}/daily/nexus-db-20260230.sqlite.age`,
            'daily-version',
            '2026-02-28T00:00:00Z',
          ),
        ]),
        reason: 'invalid calendar value',
      },
      {
        name: 'invalid-iso-week',
        tier: 'weekly',
        listing: completeListing([
          entry(
            `${prefix}/weekly/nexus-db-2021-W53.sqlite.age`,
            'weekly-version',
            '2021-12-31T00:00:00Z',
          ),
        ]),
        reason: 'invalid calendar value',
      },
      {
        name: 'latest-order',
        tier: 'weekly',
        listing: completeListing([
          entry(weeklyKey, 'older-first', '2026-07-01T00:00:00Z', false),
          entry(weeklyKey, 'latest-second', '2026-07-02T00:00:00Z'),
        ]),
        reason: 'version order is invalid',
      },
    ];
    for (const testCase of cases) {
      const tier = testCase.tier ?? 'daily';
      const { result, output } = retentionPlan({
        root,
        listing: testCase.listing,
        name: testCase.name,
        prefix,
        tier,
        retain: tier === 'weekly' ? 4 : 7,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(testCase.reason);
      expect(fs.existsSync(output)).toBe(false);
    }
  });
});
