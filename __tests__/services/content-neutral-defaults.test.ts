import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string): string => readFileSync(path.join(root, relativePath), 'utf8');

describe('Content neutral defaults and legacy retirement contract', () => {
  it('does not fall back to founder-shaped books or reference channels at runtime', () => {
    const books = read('src/commands/books.ts');
    const channels = read('src/services/channel-learner.ts');

    expect(books).not.toContain("{ title: 'The Law', author: 'Frédéric Bastiat' }");
    expect(channels).not.toContain('https://www.youtube.com/@danielbarada');
    expect(channels).not.toContain('const DEFAULT_CHANNELS = getDefaultChannels();');
    expect(books).not.toContain('const SEED_BOOKS = getSeedBooks();');
    expect(channels).toContain('const defaultChannels = getDefaultChannels();');
    expect(books).toContain('const seedBooks = getSeedBooks();');
    expect(books).toContain('platformOrSystemSeedContentScopePredicate()');
  });

  it('retires exact migration-055 configuration, materialized data, and global signals', () => {
    const migration = read('migrations/312_content_neutral_legacy_defaults.sql');
    const rollback = read('migrations/down/312_content_neutral_legacy_defaults.sql');

    expect(migration).toContain('UPDATE config_seed_books');
    expect(migration).toContain('UPDATE config_default_channels');
    expect(migration).toContain("scope_status = 'archived'");
    expect(migration).toContain("signal.signal_type = 'book_knowledge'");
    expect(migration).toContain("signal.signal_type = 'channel_dna'");
    expect(migration).toContain("signal.source_agent = 'book-extractor'");
    expect(migration).toContain("signal.source_agent = 'channel-learner'");
    expect(migration).toContain("json_extract(signal.payload, '$.channel_id') = legacy_channel.channel_id");
    expect(migration).toContain("NULLIF(TRIM(CAST(json_extract(signal.payload, '$.channel_id') AS TEXT)), '') IS NULL");
    expect(migration).toContain("SET status = 'dismissed'");
    expect(migration).toContain('content_neutral_legacy_config_retirements_312');
    expect(migration).toContain('content_neutral_legacy_row_retirements_312');
    expect(migration).toContain('COALESCE(channel.tenant_id, 0) = 0');
    expect(rollback).toContain('content_neutral_legacy_signal_retirements_312');
    expect(rollback).toContain('previous_enabled');
    expect(rollback).toContain('previous_audit_metadata_json');
  });

  it('keeps dormant creator defaults structural and provider dispatch single-attempt', () => {
    const creatorConfig = read('prompts/creator-config.md');
    const channels = read('src/services/channel-learner.ts');

    expect(creatorConfig).toContain('optional structural tools');
    expect(creatorConfig).not.toContain('Vine Boom');
    expect(creatorConfig).not.toContain('2-3 SFX per minute');
    expect(channels).toContain('maxRetries: 0');
    expect(channels.match(/allowFallbackAfterProviderFailure: false/g)).toHaveLength(2);
  });
});
