import { describe, expect, it } from 'vitest';
import { contentEngineApiBaseUrl } from '../../src/services/content-engine';

describe('content-engine client base URL', () => {
  it('appends the API prefix to Docker service base URLs', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('does not duplicate the API prefix when callers provide it', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100/api/v1')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });

  it('trims trailing slashes before adding the API prefix', () => {
    expect(contentEngineApiBaseUrl('http://content-engine:8100///')).toBe(
      'http://content-engine:8100/api/v1',
    );
  });
});
