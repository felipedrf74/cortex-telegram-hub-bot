import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('local runtime container contract', () => {
  it('packages and bind-mounts the runtime capability configuration', () => {
    const dockerfile = readFileSync('Dockerfile.node', 'utf8');
    const compose = readFileSync('docker-compose.local.yml', 'utf8');

    expect(dockerfile).toContain('COPY config ./config');
    expect(compose).toContain('./config:/app/config:ro');
  });

  it('prints timeout diagnostics when no compose project name is configured', () => {
    const script = readFileSync('scripts/wait-for-health.sh', 'utf8');

    expect(script).toContain(
      'docker compose --project-name "$NEXUS_HEALTH_COMPOSE_PROJECT" -f "$COMPOSE_FILE" logs --tail=30',
    );
    expect(script).toContain(
      'docker compose -f "$COMPOSE_FILE" logs --tail=30',
    );
    expect(script).not.toContain('"${COMPOSE_PROJECT_ARGS[@]}"');
  });
});
