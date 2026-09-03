import { describe, expect, it } from 'vitest';
import {
  _youtubeTranscriptCodecsForTests,
  stripMarkupTagsToPlainText,
} from '../../src/services/youtube-transcript';

describe('Content plain-text codecs', () => {
  it('keeps a boundary where nested markup is removed', () => {
    const text = stripMarkupTagsToPlainText('Before <scr<x>ipt>alert After');

    expect(text).toBe('Before  ipt>alert After');
    expect(text).not.toContain('<script>');
  });

  it('decodes each XML entity from the source at most once', () => {
    expect(_youtubeTranscriptCodecsForTests.decodeXmlEntities('&amp;lt;script&amp;gt;')).toBe(
      '&lt;script&gt;',
    );
    expect(_youtubeTranscriptCodecsForTests.decodeXmlEntities('&lt;b&gt;safe&lt;/b&gt;')).toBe(
      '<b>safe</b>',
    );
  });

  it('uses native JSON decoding without double-unescaping embedded player data', () => {
    const playerResponse = {
      videoDetails: {
        actualNewline: 'line one\nline two',
        literalBackslashN: '\\n',
        quoted: 'say "hello"',
      },
    };
    const html = `{"playerResponse":${JSON.stringify(JSON.stringify(playerResponse))}}`;

    expect(_youtubeTranscriptCodecsForTests.extractPlayerResponse(html)).toEqual(playerResponse);
  });

  it('normalizes markup in VTT and XML captions without creating tag tokens', () => {
    const vtt = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:02.000',
      '<scr<c>ipt>alert',
      '',
    ].join('\n');
    const xml = '<transcript><text start="0.0" dur="2.0">&amp;lt;script&amp;gt; &lt;b&gt;safe&lt;/b&gt;</text></transcript>';

    expect(_youtubeTranscriptCodecsForTests.parseVttCaptions(vtt)[0]?.text).not.toContain('<script>');
    const xmlText = _youtubeTranscriptCodecsForTests.parseXmlCaptions(xml)[0]?.text;
    expect(xmlText).toContain('&lt;script&gt;');
    expect(xmlText).toContain('safe');
    expect(xmlText).not.toContain('<script>');
  });
});
