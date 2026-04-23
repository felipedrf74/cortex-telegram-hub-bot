// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Structural pins for the wire-enum → human label map
 * (OI-UX-104, 2026-04-23).
 *
 * Previously the UI leaked snake_case wire values like
 * "want_to_read" and "tenant_admin" directly into user-facing
 * pills. This test file locks in:
 *
 *   - Both consoles declare the same LABELS shape (bookStatus,
 *     channelKind, role, inviteStatus, tenantPlan, tenantStatus).
 *   - labelFor(kind, value) falls back to the raw value — a
 *     newly-added server enum shows the raw wire value rather
 *     than silently rendering empty.
 *   - Every raw-enum display site that used to interpolate
 *     `esc(row.<field>)` now goes through labelFor(...).
 *   - Form `<option>` values still carry the wire value (they
 *     round-trip on POST/PATCH), so the label map affects ONLY
 *     display, not submission.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const USER_CONSOLE = path.resolve(__dirname, '../../src/portal/user-console.html');
const ADMIN_CONSOLE = path.resolve(__dirname, '../../src/portal/admin-console.html');
const loadUser = (): string => fs.readFileSync(USER_CONSOLE, 'utf-8');
const loadAdmin = (): string => fs.readFileSync(ADMIN_CONSOLE, 'utf-8');

const LABEL_KINDS = ['bookStatus', 'channelKind', 'role', 'inviteStatus', 'tenantPlan', 'tenantStatus'];
const BOOK_STATUSES = [
  ['want_to_read', 'Want to read'],
  ['reading', 'Reading'],
  ['finished', 'Finished'],
  ['abandoned', 'Abandoned'],
];
const CHANNEL_KINDS = [
  ['generic', 'Generic'],
  ['youtube', 'YouTube'],
  ['podcast', 'Podcast'],
  ['newsletter', 'Newsletter'],
  ['rss', 'RSS'],
  ['twitter', 'Twitter'],
  ['substack', 'Substack'],
];
const ROLES = [
  ['tenant_admin', 'Admin'],
  ['tenant_member', 'Member'],
  ['tenant_viewer', 'Viewer'],
  ['platform_admin', 'Platform admin'],
  ['owner', 'Owner'],
];
const INVITE_STATUSES = [
  ['pending', 'Pending'],
  ['accepted', 'Accepted'],
  ['revoked', 'Revoked'],
  ['expired', 'Expired'],
];
const TENANT_PLANS = [
  ['free', 'Free'],
  ['pro', 'Pro'],
  ['enterprise', 'Enterprise'],
];
const TENANT_STATUSES = [
  ['active', 'Active'],
  ['suspended', 'Suspended'],
  ['archived', 'Archived'],
];

describe('LABELS map — declared identically in both consoles (OI-UX-104)', () => {
  for (const [console, load] of [['user-console', loadUser], ['admin-console', loadAdmin]] as const) {
    describe(console, () => {
      const html = load();

      it('LABELS object declared with all 6 kinds', () => {
        expect(html).toMatch(/const LABELS\s*=\s*\{/);
        for (const kind of LABEL_KINDS) {
          expect(html).toMatch(new RegExp(`${kind}:\\s*\\{`));
        }
      });

      it('bookStatus: all 4 values → expected human labels', () => {
        for (const [raw, label] of BOOK_STATUSES) {
          expect(html).toMatch(new RegExp(`${raw}:\\s*['"]${label}['"]`));
        }
      });

      it('channelKind: all 7 values → expected human labels', () => {
        for (const [raw, label] of CHANNEL_KINDS) {
          expect(html).toMatch(new RegExp(`${raw}:\\s*['"]${label}['"]`));
        }
      });

      it('role: all 5 values → expected human labels', () => {
        for (const [raw, label] of ROLES) {
          expect(html).toMatch(new RegExp(`${raw}:\\s*['"]${label.replace(/ /g, ' ')}['"]`));
        }
      });

      it('inviteStatus: all 4 values → expected human labels', () => {
        for (const [raw, label] of INVITE_STATUSES) {
          expect(html).toMatch(new RegExp(`${raw}:\\s*['"]${label}['"]`));
        }
      });

      it('tenantPlan: all 3 values → expected human labels', () => {
        for (const [raw, label] of TENANT_PLANS) {
          expect(html).toMatch(new RegExp(`${raw}:\\s*['"]${label}['"]`));
        }
      });

      it('tenantStatus: all 3 values → expected human labels', () => {
        for (const [raw, label] of TENANT_STATUSES) {
          expect(html).toMatch(new RegExp(`${raw}:\\s*['"]${label}['"]`));
        }
      });
    });
  }
});

describe('labelFor helper — defined + graceful fallback (OI-UX-104)', () => {
  for (const [console, load] of [['user-console', loadUser], ['admin-console', loadAdmin]] as const) {
    describe(console, () => {
      const html = load();

      it('defined with (kind, value) signature', () => {
        expect(html).toMatch(/function labelFor\(kind,\s*value\)/);
      });

      it('handles null/undefined/empty → empty string (never "undefined" leaking to UI)', () => {
        expect(html).toMatch(
          /labelFor[\s\S]*?if \(value === undefined \|\| value === null \|\| value === ['"]['"]\) return ['"]['"]/,
        );
      });

      it('falls back to the raw value when map key is missing', () => {
        // A new server-side status shows the raw wire value rather
        // than a silent empty pill — easier to notice + fix.
        expect(html).toMatch(/labelFor[\s\S]*?\(map && map\[value\]\)\s*\|\|\s*value/);
      });
    });
  }
});

describe('user-console: raw-enum display sites now go through labelFor (OI-UX-104)', () => {
  const html = loadUser();

  it('Book status pill uses labelFor bookStatus', () => {
    expect(html).toMatch(/labelFor\(['"]bookStatus['"],\s*b\.status\s*\|\|\s*['"]want_to_read['"]\)/);
  });

  it('Book search subtitle uses labelFor bookStatus', () => {
    expect(html).toMatch(/labelFor\(['"]bookStatus['"],\s*b\.status\s*\|\|\s*['"]['"]\)/);
  });

  it('Channels kind pill uses labelFor channelKind', () => {
    expect(html).toMatch(/labelFor\(['"]channelKind['"],\s*ch\.kind\)/);
  });

  it('Team-member role pill uses labelFor role', () => {
    expect(html).toMatch(/labelFor\(['"]role['"],\s*x\.role\)/);
  });

  it('Invite role pill uses labelFor role', () => {
    expect(html).toMatch(/labelFor\(['"]role['"],\s*i\.role\)/);
  });

  it('Invite status pill uses labelFor inviteStatus', () => {
    expect(html).toMatch(/labelFor\(['"]inviteStatus['"],\s*i\.status\)/);
  });

  it('Tenant switch option shows labelFor role (not raw tenant_admin)', () => {
    expect(html).toMatch(/labelFor\(['"]role['"],\s*t\.role\)/);
  });

  it('No regression: raw `esc(x.role)` / `esc(i.role)` leaks gone', () => {
    // These would render "tenant_admin" verbatim in a pill — the
    // bug OI-UX-104 fixes. Pin absence.
    expect(html).not.toMatch(/\$\{esc\(x\.role\)\}/);
    expect(html).not.toMatch(/\$\{esc\(i\.role\)\}/);
    expect(html).not.toMatch(/\$\{esc\(i\.status\)\}/);
    expect(html).not.toMatch(/\$\{esc\(ch\.kind\)\}/);
  });
});

describe('admin-console: raw-enum display sites now go through labelFor (OI-UX-104)', () => {
  const html = loadAdmin();

  it('Tenants-table plan pill uses labelFor tenantPlan', () => {
    expect(html).toMatch(/labelFor\(['"]tenantPlan['"],\s*t\.plan\s*\|\|\s*['"]free['"]\)/);
  });

  it('Tenant-drawer plan KV uses labelFor tenantPlan', () => {
    // Two call sites for plan; one in table, one in drawer KV.
    const plans = html.match(/labelFor\(['"]tenantPlan['"],/g) || [];
    expect(plans.length).toBeGreaterThanOrEqual(2);
  });

  it('Tenant-drawer status KV uses labelFor tenantStatus', () => {
    expect(html).toMatch(/labelFor\(['"]tenantStatus['"],\s*t\.status\s*\|\|\s*['"]active['"]\)/);
  });

  it('Drawer-members role pill uses labelFor role', () => {
    expect(html).toMatch(/labelFor\(['"]role['"],\s*x\.role\)/);
  });

  it('No regression: raw `esc(x.role)` / `esc(t.plan)` / `esc(t.status)` leaks gone', () => {
    expect(html).not.toMatch(/\$\{esc\(x\.role\)\}/);
    expect(html).not.toMatch(/\$\{esc\(t\.plan\s*\|\|\s*['"]free['"]\)\}/);
    expect(html).not.toMatch(/\$\{esc\(t\.status\s*\|\|\s*['"]active['"]\)\}/);
  });
});

describe('form `<option>` values still carry WIRE values, not labels (regression)', () => {
  const html = loadUser();

  it('Book status select keeps wire values in option value= attributes', () => {
    // The round-trip on POST/PATCH needs the wire value. If someone
    // "helpfully" changed value="want_to_read" to value="Want to read"
    // it would break the server validator. Pin the wire values.
    expect(html).toMatch(/<option value="want_to_read">Want to read<\/option>/);
    expect(html).toMatch(/<option value="reading"[^>]*>Reading<\/option>/);
    expect(html).toMatch(/<option value="finished">Finished<\/option>/);
    expect(html).toMatch(/<option value="abandoned">Abandoned<\/option>/);
  });

  it('Channel kind select keeps wire values in option value= attributes', () => {
    for (const [raw, _label] of CHANNEL_KINDS) {
      expect(html).toMatch(new RegExp(`<option value="${raw}">`));
    }
  });
});
