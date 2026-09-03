// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { parseCreativeProposalInput } from '../../src/api/routes/content-creative-routes';

const scope = { tenantId: 42, userId: 7 };

describe('Content creative route input contract', () => {
  it.each([null, [], 'topic=A safe launch'])('rejects non-object request bodies %#', (body) => {
    expect(() => parseCreativeProposalInput('hooks', body, scope, 'en-US'))
      .toThrow('Request body must be an object.');
  });

  it('normalizes bounded operation selectors without accepting generated authority fields', () => {
    expect(parseCreativeProposalInput('hooks', {
      topic: 'A safe launch',
      niche: 'product design',
      count: 4,
      format: 'Reel',
      sourcePackageId: 'sp_safe_package',
    }, scope, 'pt-PT')).toMatchObject({
      operation: 'hooks',
      topic: 'A safe launch',
      niche: 'product design',
      count: 4,
      format: 'Reel',
      sourcePackageId: 'sp_safe_package',
      language: 'pt-PT',
      ...scope,
    });

    expect(parseCreativeProposalInput('titles', {
      topic: 'A safe launch',
      count: 6,
      platform: 'Instagram',
    }, scope, 'en-US')).toMatchObject({ count: 6, platform: 'Instagram' });

    expect(parseCreativeProposalInput('thumbnail', {
      title: 'A calm launch',
    }, scope, 'en-US')).toMatchObject({
      title: 'A calm launch',
      topic: 'A calm launch',
    });

    expect(parseCreativeProposalInput('repurpose', {
      topic: 'A safe launch',
      sourceContent: 'Long-form source draft.',
      originalFormat: 'Newsletter',
    }, scope, 'en-US')).toMatchObject({
      sourceContent: 'Long-form source draft.',
      originalFormat: 'Newsletter',
    });
  });

  it.each([
    { sourceSummary: ['client-authored'] },
    { source_summary: ['client-authored'] },
  ])('rejects public source-summary injection %#', (authorityField) => {
    expect(() => parseCreativeProposalInput('caption', {
      topic: 'A safe launch',
      ...authorityField,
    }, scope, 'en-US')).toThrow('sourceSummary is server-authored');
  });

  it('rejects out-of-range selectors and malformed artifact identifiers', () => {
    expect(() => parseCreativeProposalInput('hooks', {
      topic: 'A safe launch',
      count: 9,
    }, scope, 'en-US')).toThrow('count must be an integer between 1 and 8');
    expect(() => parseCreativeProposalInput('titles', {
      topic: 'A safe launch',
      platform: 'TikTok',
    }, scope, 'en-US')).toThrow('platform must be one of');
    expect(() => parseCreativeProposalInput('caption', {
      topic: 'A safe launch',
      sourcePackageId: 'bad id with spaces',
    }, scope, 'en-US')).toThrow('valid Content artifact identifier');
  });

  it.each([
    ['caption', { topic: 'A safe launch', niche: null }, 'niche'],
    ['caption', { topic: 'A safe launch', sourcePackageId: null }, 'sourcePackageId'],
    ['hooks', { topic: 'A safe launch', count: null }, 'count'],
    ['hooks', { topic: 'A safe launch', format: null }, 'format'],
    ['titles', { topic: 'A safe launch', platform: null }, 'platform'],
    ['thumbnail', { title: 'A safe launch', topic: null }, 'topic'],
    ['repurpose', { topic: 'A safe launch', sourceContent: 'Source copy', originalFormat: null }, 'originalFormat'],
  ] as const)('rejects explicit null instead of silently selecting the %s default for %s', (operation, body, field) => {
    expect(() => parseCreativeProposalInput(operation, body, scope, 'en-US'))
      .toThrow(field);
  });

  it('enforces the thumbnail combined prompt boundary before the engine call', () => {
    expect(parseCreativeProposalInput('thumbnail', {
      title: 'a'.repeat(1_400),
      topic: 'b'.repeat(1_400),
    }, scope, 'en-US')).toMatchObject({
      title: 'a'.repeat(1_400),
      topic: 'b'.repeat(1_400),
    });
    expect(() => parseCreativeProposalInput('thumbnail', {
      title: 'a'.repeat(1_400),
      topic: 'b'.repeat(1_401),
    }, scope, 'en-US')).toThrow('at most 2800 characters combined');
    expect(() => parseCreativeProposalInput('thumbnail', {
      title: 'a'.repeat(1_401),
    }, scope, 'en-US')).toThrow('at most 2800 characters combined');
  });

  it('rejects control characters while preserving normal multiline repurpose copy', () => {
    expect(() => parseCreativeProposalInput('hooks', {
      topic: 'Safe title\u0000hidden instruction',
    }, scope, 'en-US')).toThrow('unsupported control characters');
    expect(() => parseCreativeProposalInput('repurpose', {
      topic: 'A safe launch',
      sourceContent: 'Line one\u0007hidden instruction',
    }, scope, 'en-US')).toThrow('unsupported control characters');
    expect(parseCreativeProposalInput('repurpose', {
      topic: 'A safe launch',
      sourceContent: 'Line one\nLine two\twith a note',
    }, scope, 'en-US')).toMatchObject({
      sourceContent: 'Line one\nLine two\twith a note',
    });
  });
});
