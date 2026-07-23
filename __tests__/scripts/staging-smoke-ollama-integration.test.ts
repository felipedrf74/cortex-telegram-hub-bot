import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('canonical staging gate Ollama integration', () => {
  it('runs the exact-release policy smoke once in the existing sequential gate', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const ollama = read('scripts/staging-smoke-ollama.sh');
    const operator = read('scripts/release-operator.sh');

    expect(canonical.match(/staging-smoke-ollama\.sh/g)).toHaveLength(1);
    expect(canonical).toContain('OLLAMA_INVENTORY_PHASE=governed');
    expect(canonical).toContain('NEXUS_HUB_BASE_URL=http://127.0.0.1:8201');
    expect(canonical).toContain('PM2_APP_NAME=nexus-hub-staging');
    expect(canonical).toContain('PM2_BIN=/home/dominguez/.npm-global/bin/pm2');
    expect(canonical).toContain('evidence_record "Ollama release policy"');
    expect(ollama).toContain('strict|pre_cleanup|governed');
    expect(ollama).toContain('PM2_BIN must name an absolute executable PM2 launcher');
    expect(ollama).toContain('$names == ([$model] | sort)');
    expect(ollama).toContain('$names == ([$model, $remove1, $remove2, $remove3] | sort)');
    expect(operator).toContain('scripts/staging-smoke.sh');
    expect(operator).not.toContain('scripts/staging-smoke-ollama.sh');
  });
});
