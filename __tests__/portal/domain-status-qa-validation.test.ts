/**
 * QA Validation Tests — Portal Domain Handler Status (pre-skill modules)
 *
 * Validates the domain handler panel added by the flex agent:
 * - SnapshotResponse.domainStatus type shape
 * - Portal HTML rendering: cards, stats, detail chips
 * - All three domains present: secretary, triathlon, content
 * - Detail chips: Garmin connected, MS Graph, agent mesh info
 * - Message count display
 * - Pre-skill module labeling
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

describe('Domain Status — SnapshotResponse type', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('domainStatus field exists in SnapshotResponse', () => {
    expect(serverTs).toContain('domainStatus:');
  });

  it('domainStatus has domain string field', () => {
    expect(serverTs).toContain('domain: string');
  });

  it('domainStatus has label string field', () => {
    expect(serverTs).toContain('label: string');
  });

  it('domainStatus has active boolean field', () => {
    expect(serverTs).toContain('active: boolean');
  });

  it('domainStatus has messagesToday number field', () => {
    expect(serverTs).toContain('messagesToday: number');
  });

  it('domainStatus has totalMessages number field', () => {
    expect(serverTs).toContain('totalMessages: number');
  });

  it('domainStatus has lastMessageAt nullable string field', () => {
    expect(serverTs).toContain('lastMessageAt: string | null');
  });

  it('domainStatus has details record field', () => {
    expect(serverTs).toContain('details: Record<string, string | number | boolean>');
  });
});

describe('Domain Status — server.ts domain definitions', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('defines Secretary domain', () => {
    expect(serverTs).toContain("domain: 'secretary'");
    expect(serverTs).toContain("label: 'Secretary'");
  });

  it('defines Triathlon domain', () => {
    expect(serverTs).toContain("domain: 'triathlon'");
    expect(serverTs).toContain("label: 'Triathlon'");
  });

  it('defines Content Creator domain', () => {
    expect(serverTs).toContain("domain: 'content'");
    expect(serverTs).toContain("label: 'Content Creator'");
  });

  it('Secretary domain tracks graphConnected and garminConnected', () => {
    // Find secretary domain block
    const secretaryIdx = serverTs.indexOf("domain: 'secretary'");
    const nextDomainIdx = serverTs.indexOf("domain: 'triathlon'");
    const secretaryBlock = serverTs.slice(secretaryIdx, nextDomainIdx);
    expect(secretaryBlock).toContain('graphConnected');
    expect(secretaryBlock).toContain('garminConnected');
  });

  it('Triathlon domain tracks garminConnected', () => {
    const triIdx = serverTs.indexOf("domain: 'triathlon'");
    const nextIdx = serverTs.indexOf("domain: 'content'");
    const triBlock = serverTs.slice(triIdx, nextIdx);
    expect(triBlock).toContain('garminConnected');
  });

  it('Content Creator domain tracks activeAgents and activeSignals', () => {
    const contentIdx = serverTs.indexOf("domain: 'content'");
    const contentBlock = serverTs.slice(contentIdx, contentIdx + 500);
    expect(contentBlock).toContain('activeAgents');
    expect(contentBlock).toContain('activeSignals');
  });

  it('all domains are set to active: true', () => {
    // There should be exactly 5 occurrences of active: true for domains
    const domainBlock = serverTs.slice(
      serverTs.indexOf('domainStatus = ['),
      serverTs.indexOf('];', serverTs.indexOf('domainStatus = [')),
    );
    const activeMatches = domainBlock.match(/active: true/g) || [];
    expect(activeMatches.length).toBe(5);
  });
});

describe('Domain Status — SQL queries', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('defines domainMessagesToday prepared statement', () => {
    expect(serverTs).toContain('domainMessagesToday');
  });

  it('domainMessagesToday filters by today', () => {
    expect(serverTs).toContain("created_at >= date('now')");
  });

  it('domainMessagesToday groups by domain', () => {
    expect(serverTs).toContain('GROUP BY domain');
  });

  it('defines domainMessagesTotal prepared statement', () => {
    expect(serverTs).toContain('domainMessagesTotal');
  });

  it('domainMessagesTotal retrieves MAX(created_at) as last_at', () => {
    expect(serverTs).toContain('MAX(created_at) as last_at');
  });
});

describe('Domain Status — Portal HTML structure', () => {
  // Updated for the redesigned portal (TASK-15a). The Domain Handlers panel
  // now lives inside the Skills section rather than its own card, and uses
  // the unified `provider-card` component with `status-dot` indicators
  // instead of bespoke `.domain-card` classes. Functionality is preserved:
  // every domain still renders messagesToday / totalMessages / lastMessageAt
  // and the active state is shown as a status dot.
  const html = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'portal.html'),
    'utf-8',
  );

  it('has domain status container div in the new portal', () => {
    expect(html).toContain('id="domain-status-content"');
  });

  it('section title says Domain Handlers', () => {
    expect(html).toContain('Domain Handlers');
  });

  it('section subtitle indicates runtime status', () => {
    expect(html).toContain('Runtime status');
  });

  it('reuses the provider-card component for domain rendering', () => {
    // The redesign collapses domain-card → provider-card to share styles
    // with the AI provider health cards.
    expect(html).toContain('provider-card');
    expect(html).toContain('provider-card-header');
    expect(html).toContain('provider-stats');
  });

  it('uses status-dot indicators for active state', () => {
    // Replaces the old .domain-detail-chip ok/warn variants.
    expect(html).toContain('.status-dot');
    expect(html).toContain('.status-dot.online');
    expect(html).toContain('.status-dot.offline');
  });

  it('uses responsive auto-fit grid layout for domain cards', () => {
    expect(html).toContain('grid-template-columns');
    // The new design uses 260px minmax in the grid-cols-auto utility.
    expect(html).toContain('minmax(260px, 1fr)');
  });
});

describe('Domain Status — JS rendering logic', () => {
  const html = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'portal.html'),
    'utf-8',
  );

  it('reads domain field from server snapshot', () => {
    // The render function consumes the same SnapshotResponse.domainStatus
    // shape that the server emits — verify the new function reads .domain.
    expect(html).toContain('renderDomainStatus');
    expect(html).toContain('d.domain');
  });

  it('uses domain CSS classes (matches iOS palette)', () => {
    // Per-domain colors are now defined as CSS variables / classes
    // (.domain-secretary etc.) instead of inline JS color maps.
    expect(html).toContain('.domain-secretary');
    expect(html).toContain('.domain-triathlon');
    expect(html).toContain('.domain-content');
  });

  it('renders active/inactive status indicator', () => {
    // The new design shows online/offline via status-dot CSS classes
    // applied to the domain card header.
    expect(html).toContain('status-dot');
    expect(html).toContain("d.active ? 'online' : 'offline'");
  });

  it('renders message count today', () => {
    expect(html).toContain('d.messagesToday');
  });

  it('renders total message count', () => {
    expect(html).toContain('d.totalMessages');
  });

  it('renders last message relative time', () => {
    expect(html).toContain('relativeTime(d.lastMessageAt)');
  });
});

describe('Domain Status — error handling', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('wraps domain status query in try/catch', () => {
    // The domain status section should be inside a try block
    const domainIdx = serverTs.indexOf('Domain handler status');
    const blockAfter = serverTs.slice(domainIdx, domainIdx + 2000);
    expect(blockAfter).toContain('try {');
    expect(blockAfter).toContain('catch');
  });

  it('initializes domainStatus as empty array before try block', () => {
    expect(serverTs).toContain("domainStatus: SnapshotResponse['domainStatus'] = []");
  });

  it('handles missing agent stats gracefully with inner try/catch', () => {
    const domainIdx = serverTs.indexOf('Active agent count');
    const blockAfter = serverTs.slice(domainIdx, domainIdx + 500);
    expect(blockAfter).toContain('try {');
    expect(blockAfter).toContain('catch');
  });
});
