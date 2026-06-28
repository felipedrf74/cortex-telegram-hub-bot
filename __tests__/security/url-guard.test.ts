import { describe, expect, it } from 'vitest';
import { assertSafeExternalUrl, isSafeExternalUrl } from '../../src/security/url-guard';
import { assertSafeYouTubeCaptionUrl, extractVideoId } from '../../src/services/youtube-transcript';

describe('SSRF URL guard', () => {
  it('accepts HTTPS allowlisted hosts', () => {
    const url = assertSafeExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', {
      allowedHostSuffixes: ['youtube.com'],
    });
    expect(url.hostname).toBe('www.youtube.com');
  });

  it('rejects local, metadata, credentialed, and non-HTTPS URLs', () => {
    const policy = { allowedHostSuffixes: ['example.com'] };
    expect(isSafeExternalUrl('http://example.com/path', policy)).toBe(false);
    expect(isSafeExternalUrl('https://127.0.0.1/admin', policy)).toBe(false);
    expect(isSafeExternalUrl('https://2130706433/admin', policy)).toBe(false);
    expect(isSafeExternalUrl('https://0177.0.0.1/admin', policy)).toBe(false);
    expect(isSafeExternalUrl('https://0x7f.0.0.1/admin', policy)).toBe(false);
    expect(isSafeExternalUrl('https://169.254.169.254/latest/meta-data', policy)).toBe(false);
    expect(isSafeExternalUrl('https://user:pass@example.com/private', policy)).toBe(false);
    expect(isSafeExternalUrl('file:///etc/passwd', policy)).toBe(false);
  });

  it('rejects private IPv6 and IPv4-mapped IPv6 SSRF vectors', () => {
    const policy = { allowedHostSuffixes: ['example.com'] };
    for (const rawUrl of [
      'https://[::1]/admin',
      'https://[fd00:1::1]/admin',
      'https://[fe80::1]/admin',
      'https://[febf::1]/admin',
      'https://[::ffff:127.0.0.1]/admin',
      'https://[0:0:0:0:0:0:0:1]/admin',
      'https://[::ffff:7f00:1]/admin',
    ]) {
      expect(isSafeExternalUrl(rawUrl, policy), rawUrl).toBe(false);
    }
  });

  it('keeps YouTube transcript URL parsing on real YouTube hosts only', () => {
    expect(extractVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractVideoId('https://evil-youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractVideoId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(extractVideoId('https://[::1]/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('keeps YouTube caption fetches on allowlisted HTTPS caption hosts', () => {
    expect(assertSafeYouTubeCaptionUrl('https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ').hostname)
      .toBe('www.youtube.com');
    expect(assertSafeYouTubeCaptionUrl('https://rr1---sn-a5mekn6k.googlevideo.com/videoplayback?mime=text').hostname)
      .toBe('rr1---sn-a5mekn6k.googlevideo.com');

    expect(() => assertSafeYouTubeCaptionUrl('https://youtube.com.evil.test/api/timedtext')).toThrow(/allowlisted/);
    expect(() => assertSafeYouTubeCaptionUrl('https://169.254.169.254/latest/meta-data')).toThrow(/Private IPv4/);
    expect(() => assertSafeYouTubeCaptionUrl('http://www.youtube.com/api/timedtext')).toThrow(/HTTPS/);
  });
});
