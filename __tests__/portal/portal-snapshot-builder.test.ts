import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

function readPortalSource(file: string): string {
  return fs.readFileSync(path.join(ROOT, 'src', 'portal', file), 'utf-8');
}

describe('portal snapshot builder ownership', () => {
  it('keeps snapshot contract and composition outside the portal server factory', () => {
    const serverSource = readPortalSource('server.ts');
    const snapshotBuilderSource = readPortalSource('snapshot-builder.ts');

    expect(snapshotBuilderSource).toContain('export interface PortalSnapshotResponse');
    expect(snapshotBuilderSource).toContain('export function buildPortalSnapshot');
    expect(snapshotBuilderSource).toContain('domainStatus: PortalSnapshotResponse');
    expect(snapshotBuilderSource).toContain('!isPausedContentAgent');
    expect(snapshotBuilderSource).toContain("lifecycle: 'paused', lastResult: 'paused'");
    expect(snapshotBuilderSource).toContain("if (job.lifecycle === 'paused') continue");
    expect(snapshotBuilderSource).toContain("if (job.lifecycle === 'active')");
    expect(snapshotBuilderSource).toContain('excludeSourceAgents: PAUSED_CONTENT_AGENT_IDS');
    expect(snapshotBuilderSource).toContain('excludeIneligibleContentLearningDigests: true');
    expect(snapshotBuilderSource).toContain('usageMetering: PortalSnapshotResponse');

    expect(serverSource).toContain('buildPortalSnapshot(startedAt)');
    expect(serverSource).not.toContain('function buildSnapshot');
    expect(serverSource).not.toContain('interface SnapshotResponse');
  });

  it('keeps snapshot route ownership to caching and HTTP response shape only', () => {
    const serverSource = readPortalSource('server.ts');
    const snapshotRouteSource = readPortalSource('snapshot-routes.ts');

    expect(serverSource).toContain('registerPortalSnapshotRoutes(app');
    expect(serverSource).not.toContain("app.get('/api/snapshot'");
    expect(serverSource).not.toContain("app.get('/api/usage/summary'");
    expect(snapshotRouteSource).toContain('getCachedPortalSnapshot');
    expect(snapshotRouteSource).toContain('setCachedPortalSnapshot(data, now)');
    expect(snapshotRouteSource).toContain('options.buildSnapshot()');
    expect(snapshotRouteSource).not.toContain('domainStatus = [');
    expect(snapshotRouteSource).not.toContain("name: 'Google Calendar'");
  });
});
