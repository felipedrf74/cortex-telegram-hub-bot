import { describe, expect, it, vi } from 'vitest';

const runtimeGuard = vi.hoisted(() => ({ allowed: false }));

vi.mock('../../src/services/chat-capability-runtime-guard', () => ({
  chatCapabilityRuntimeAllowsFlags: () => runtimeGuard.allowed,
}));

import { isManifestClassifierPromptEnabled } from '../../src/router/classifier-prompt-builder';
import { isCrossSkillExecutionEnabled } from '../../src/services/chat/planner/cross-skill-ownership';
import { isRoutingClarifyEnabled } from '../../src/services/intent-resolution/confidence';
import { isManifestRoutingEnabled } from '../../src/services/intent-resolution/manifest-routing-flags';

describe('chat capability runtime guard wiring', () => {
  it('cannot be bypassed by any explicit EnvLike capability enable', () => {
    runtimeGuard.allowed = false;
    const env = {
      AI_ROUTING_MANIFEST_CLASSIFIER: 'true',
      AI_ROUTING_MANIFEST_ORCHESTRATOR: 'true',
      AI_ROUTING_MANIFEST_SHADOW: 'true',
      AI_ROUTING_MANIFEST_REGISTRY: 'true',
      AI_ROUTING_CLARIFY: 'true',
      AI_CLASSIFY_MANIFEST_PROMPT: 'true',
      AI_CROSS_SKILL_EXECUTION: 'true',
      AI_ROUTING_MANIFEST_KILL: 'false',
    };

    expect(isManifestRoutingEnabled('classifier', env)).toBe(false);
    expect(isManifestRoutingEnabled('orchestrator', env)).toBe(false);
    expect(isManifestRoutingEnabled('shadow', env)).toBe(false);
    expect(isManifestRoutingEnabled('registry', env)).toBe(false);
    expect(isRoutingClarifyEnabled(env)).toBe(false);
    expect(isManifestClassifierPromptEnabled(env)).toBe(false);
    expect(isCrossSkillExecutionEnabled(env)).toBe(false);
  });
});
