import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Telegram message chat reliability wiring', () => {
  it('enforces turn contracts, orchestration, destructive guardrails, and local-and-web research before domain handlers', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/handlers/message.ts'), 'utf8');
    const routeIndex = source.indexOf('const rawRoute = await routeMessage');
    const handlerIndex = source.indexOf('const handler = domainHandlers[route.domain]');

    expect(source).toContain('inferChatTurnContract');
    expect(source).toContain('analyzeChatSkillOrchestration');
    expect(source).toContain('applyChatSkillRoutingDecision');
    expect(source).toContain('buildChatInternetResearchAnswer');
    expect(source).toContain('buildSimpleStateContext(researchDomain, userId, text, tenantId)');
    expect(source).toContain("preTurnContract?.riskClass === 'destructive'");
    expect(routeIndex).toBeGreaterThan(0);
    expect(handlerIndex).toBeGreaterThan(routeIndex);
  });
});
