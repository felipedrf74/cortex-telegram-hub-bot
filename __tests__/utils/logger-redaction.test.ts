import { describe, expect, it } from 'vitest';

import { LOGGER_REDACTION_PATHS } from '../../src/utils/logger';

describe('logger redaction policy', () => {
  it('redacts provider auth material from nested SDK error objects', () => {
    expect(LOGGER_REDACTION_PATHS).toEqual(expect.arrayContaining([
      'err.config.headers.authorization',
      'err.config.headers.Authorization',
      'err.response.config.headers.authorization',
      'err.response.config.headers.Authorization',
      'err.request._header',
      'err.options.authProvider',
      'err.options.auth',
    ]));
  });

  it('redacts common token and secret field names before logs are written', () => {
    expect(LOGGER_REDACTION_PATHS).toEqual(expect.arrayContaining([
      'access_token',
      'refresh_token',
      'id_token',
      'body.access_token',
      'body.refresh_token',
      'body.id_token',
      'body.client_secret',
      'clientSecret',
    ]));
  });
});
