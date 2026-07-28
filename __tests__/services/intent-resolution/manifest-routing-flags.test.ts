// M12 — per-surface manifest-routing activation flags.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLoggerInfo = vi.fn();

vi.mock('../../../src/utils/logger', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  isManifestRoutingEnabled,
  manifestRoutingEnvVarForSurface,
  MANIFEST_ROUTING_MASTER_KILL_ENV_VAR,
  _resetManifestRoutingBootLogForTests,
  type ManifestRoutingSurface,
} from '../../../src/services/intent-resolution/manifest-routing-flags';

const SURFACES: ManifestRoutingSurface[] = ['classifier', 'orchestrator', 'shadow', 'registry'];

describe('manifest routing flags', () => {
  it('defaults every surface to OFF', () => {
    for (const surface of SURFACES) {
      expect(isManifestRoutingEnabled(surface, {})).toBe(false);
    }
  });

  it('enables exactly the surface whose env var is set', () => {
    for (const surface of SURFACES) {
      const env = { [manifestRoutingEnvVarForSurface(surface)]: 'true' };
      for (const other of SURFACES) {
        expect(isManifestRoutingEnabled(other, env)).toBe(other === surface);
      }
    }
  });

  it('accepts true/1/yes and rejects everything else', () => {
    const envVar = manifestRoutingEnvVarForSurface('classifier');
    for (const value of ['true', '1', 'yes', ' TRUE ']) {
      expect(isManifestRoutingEnabled('classifier', { [envVar]: value })).toBe(true);
    }
    for (const value of ['false', '0', 'no', '', 'on', 'enabled', undefined]) {
      expect(isManifestRoutingEnabled('classifier', { [envVar]: value })).toBe(false);
    }
  });

  it('master kill flag wins over every per-surface enable', () => {
    const env: Record<string, string> = { [MANIFEST_ROUTING_MASTER_KILL_ENV_VAR]: 'true' };
    for (const surface of SURFACES) {
      env[manifestRoutingEnvVarForSurface(surface)] = 'true';
    }
    for (const surface of SURFACES) {
      expect(isManifestRoutingEnabled(surface, env)).toBe(false);
    }
  });

  it('maps each surface to its documented env var', () => {
    expect(manifestRoutingEnvVarForSurface('classifier')).toBe('AI_ROUTING_MANIFEST_CLASSIFIER');
    expect(manifestRoutingEnvVarForSurface('orchestrator')).toBe('AI_ROUTING_MANIFEST_ORCHESTRATOR');
    expect(manifestRoutingEnvVarForSurface('shadow')).toBe('AI_ROUTING_MANIFEST_SHADOW');
    expect(manifestRoutingEnvVarForSurface('registry')).toBe('AI_ROUTING_MANIFEST_REGISTRY');
  });

  describe('one-time boot log of the resolved flag state', () => {
    beforeEach(() => {
      mockLoggerInfo.mockReset();
      _resetManifestRoutingBootLogForTests();
    });

    it('logs the enabled surfaces exactly once when any flag is on', () => {
      const env = {
        [manifestRoutingEnvVarForSurface('shadow')]: 'true',
        [manifestRoutingEnvVarForSurface('registry')]: 'true',
      };
      isManifestRoutingEnabled('shadow', env);
      isManifestRoutingEnabled('registry', env);
      isManifestRoutingEnabled('classifier', env);

      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      const [payload, message] = mockLoggerInfo.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({
        enabledSurfaces: ['shadow', 'registry'],
        masterKill: false,
        suppressed: false,
      });
      expect(message).toContain('manifest routing');
    });

    it('stays silent when every flag is off', () => {
      for (const surface of SURFACES) {
        isManifestRoutingEnabled(surface, {});
      }
      expect(mockLoggerInfo).not.toHaveBeenCalled();
    });

    it('logs the suppression once when the master kill overrides enabled flags', () => {
      const env = {
        [MANIFEST_ROUTING_MASTER_KILL_ENV_VAR]: 'true',
        [manifestRoutingEnvVarForSurface('shadow')]: 'true',
      };
      expect(isManifestRoutingEnabled('shadow', env)).toBe(false);
      isManifestRoutingEnabled('shadow', env);

      expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
      const [payload, message] = mockLoggerInfo.mock.calls[0] as [Record<string, unknown>, string];
      expect(payload).toMatchObject({
        enabledSurfaces: ['shadow'],
        masterKill: true,
        suppressed: true,
      });
      expect(message).toContain('suppressed');
    });
  });
});
