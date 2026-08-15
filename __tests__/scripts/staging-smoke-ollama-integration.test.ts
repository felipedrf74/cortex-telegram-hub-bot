import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('canonical staging gate Ollama integration', () => {
  it('can run the exact canonical smoke inside ServerDominguez without recursive SSH', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const manifest = read('scripts/lib/release-artifact-manifest.mjs');

    expect(canonical).toContain('NEXUS_STAGING_SMOKE_LOCAL_SERVER');
    expect(canonical).toContain('NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY');
    expect(canonical).toContain('NEXUS_RELEASE_SHA');
    expect(canonical).toContain('NEXUS_RELEASE_ARTIFACT_SHA256');
    expect(canonical).toContain('NEXUS_SMOKE_EVIDENCE_PATH');
    expect(canonical).toContain('NEXUS_SMOKE_EVIDENCE_DIR');
    expect(canonical).toContain("node -e 'process.stdout.write(new Date().toISOString())'");
    expect(canonical).not.toContain('date -u +%Y-%m-%dT%H:%M:%S.%3NZ');
    expect(canonical).toContain(
      'smoke_ssh "$SERVER" /usr/bin/node - "$STAGING_ROOT" "$STAGING_RELEASE"',
    );
    expect(canonical).toContain('runtimeSha: process.env.SMOKE_RUNTIME_SHA');
    expect(canonical).toContain('artifactDigest: process.env.SMOKE_ARTIFACT_DIGEST');
    expect(canonical).toContain('classifierBaseSha: process.env.SMOKE_CLASSIFIER_BASE_SHA || null');
    expect(canonical).toContain('classifierHeadSha: process.env.SMOKE_CLASSIFIER_HEAD_SHA || null');
    expect(canonical).toContain('nexus.staging-smoke.canonical.token-zero-locale.v2');
    expect(canonical).toContain('const evidenceStat = fs.lstatSync(file);');
    expect(canonical).toContain('evidenceStat.uid !== process.getuid()');
    expect(canonical).not.toContain("stat -c '%U:%a:%h'");
    expect(canonical).toContain('local server mode requires exact release identity');
    expect(manifest).toContain("'scripts/staging-smoke.sh'");
  });

  it('reuses one private SSH transport while keeping every smoke probe sequential', () => {
    const canonical = read('scripts/staging-smoke.sh');

    expect(canonical).toContain('SSH_CONTROL_DIR="$(mktemp -d /tmp/nexus-staging-ssh.XXXXXX)"');
    expect(canonical).toContain('chmod 700 "$SSH_CONTROL_DIR"');
    expect(canonical).toContain('-o ControlMaster=auto');
    expect(canonical).toContain('-o ControlPersist=30');
    expect(canonical).toContain('-o "ControlPath=$SSH_CONTROL_PATH"');
    expect(canonical).toContain('-O exit "$SERVER"');
    expect(canonical).toContain('trap cleanup_smoke_transport EXIT');
    expect(canonical.match(/smoke_ssh "\$SERVER"/g)?.length).toBeGreaterThanOrEqual(9);
    expect(canonical).not.toMatch(/(^|[^_])ssh "\$SERVER"/m);
    expect(canonical).not.toContain('ControlMaster=yes');
    expect(canonical).not.toMatch(/smoke_ssh [^\n]*[ \t]&[ \t]*(?:$|#)/m);
    expect(canonical).toContain('ENDPOINT_CACHE_URLS=()');
    expect(canonical).toContain('ENDPOINT_CACHE_RESULTS=()');
    expect(canonical).toContain('fetch_endpoint_once "$url"');
    expect(canonical).toContain('ENDPOINT_RESULT="${ENDPOINT_CACHE_RESULTS[$index]}"');
    expect(canonical).toContain('IOS_RESPONSE_CACHE_KEYS=()');
    expect(canonical).toContain('fetch_ios_remote_response');
    expect(canonical).toContain('fetch_ios_response_once');
    expect(canonical).toContain('curl_args=(-sS --connect-timeout 2 --max-time 10');
    expect(canonical).toContain('if ! http_code="$(curl "${curl_args[@]}" "$url" 2>/dev/null)"; then');
    expect(canonical).not.toContain("curl \"${curl_args[@]}\" \"$url\" 2>/dev/null || printf '000'");
    expect(canonical).toContain('body_size');
    expect(canonical).not.toContain('/tmp/_smoke_body');
    expect(canonical).not.toContain('/tmp/_smoke_chat_body');
    expect(canonical).toContain('"failed" "disabled_by_kill_switch"');
    expect(canonical).not.toContain('"passed" "skipped_by_kill_switch"');
    expect(canonical).toContain('CLASSIFIER_BASE_SHA="${NEXUS_SMOKE_CLASSIFIER_BASE_SHA:-origin/main}"');
    expect(canonical).toContain('--base "$CLASSIFIER_BASE_SHA"');
    expect(canonical).toContain('CLASSIFIER_HEAD="$(git -C "$LOCAL_DIR" rev-parse HEAD)"');
    expect(canonical).not.toContain('rev-parse --short=8 HEAD');
    expect(canonical).toContain('value?.baseRef === process.argv[1]');
    expect(canonical).toContain('protected release changed-area classification failed or drifted');
    expect(canonical).toContain('protected release domain probes cannot be disabled');
    expect(canonical).toContain('protected release changed-area classifier is missing or not executable');
    expect(canonical).toContain('DB_CHECK_RC=0');
    expect(canonical).toContain('DB_CHECK_RC=$?');
    expect(canonical).toContain('DB_CHECK="FAILED (staging DB integrity transport status $DB_CHECK_RC)"');
    expect(canonical).not.toContain('DB_CHECK="${DB_CHECK:-FAILED}"');
    expect(canonical).toContain('"$STAGING_ROOT" "$STAGING_RELEASE"');
    expect(canonical).not.toContain('cd /home/dominguez/telegram-hub-bot-staging');
  });

  it('binds retained diagnostics and server sync to one immutable current release', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const fixture = read('scripts/staging-fixture-seed.mjs');
    const sync = read('scripts/sync-from-server.sh');

    expect(canonical).toContain(
      'STAGING_ROOT="${STAGING_PATH:-/home/dominguez/telegram-hub-bot-staging}"',
    );
    expect(canonical).toContain('STAGING_RELEASE="$(resolve_staging_release)"');
    expect(canonical).toContain('case "$staging_release" in');
    expect(canonical).toContain('"$staging_root"/releases/*)');
    expect(canonical).toContain(
      '[ "$(readlink -f -- "$staging_release/.env")" = "$staging_root/.env" ]',
    );
    expect(canonical).toContain(
      '[ "$(readlink -f -- "$staging_release/data")" = "$staging_root/data" ]',
    );
    expect(canonical).toContain('cd "$STAGING_RELEASE"');
    expect(canonical).toContain('export DATABASE_PATH="$STAGING_ROOT/data/bot.db"');
    expect(canonical).toContain('NODE_PATH="$staging_release/node_modules"');
    expect(canonical).toContain('evidence_record "immutable staging selector"');
    expect(canonical).not.toContain('STAGING_DIR');
    expect(canonical).toContain(
      'LOCALE_SMOKE_RESULT=$(smoke_ssh "$SERVER" bash -s -- \\\n'
      + '    "$STAGING_ROOT" "$STAGING_RELEASE"',
    );
    expect(canonical).toContain(
      'staging current selector changed during locale smoke',
    );

    expect(fixture).toContain('export function buildRemoteNodeCommand');
    expect(fixture).toContain('cd "$staging_release"');
    expect(fixture).toContain('. "$staging_root/.env"');
    expect(fixture).toContain('export DATABASE_PATH="$staging_root/data/bot.db"');
    expect(fixture).toContain('export NODE_PATH="$staging_release/node_modules"');
    expect(fixture).toContain('staging current selector changed during fixture operation');

    expect(sync).toContain('REMOTE_RELEASE="$(resolve_remote_release)"');
    expect(sync).toContain('"$release_root"/releases/*)');
    expect(sync).toContain('"$SERVER:$REMOTE_RELEASE/" "$TEMP_DIR/"');
    expect(sync).toContain('assert_remote_selector');
    expect(sync).toContain("--exclude='.env'");
    expect(sync).toContain("--exclude='data/***'");
    expect(sync).toContain("--exclude='node_modules/***'");
    expect(sync).not.toContain('$SERVER:$REMOTE_ROOT/');
  });

  it('keeps embedded fixture JavaScript syntactically valid', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const embeddedPrograms = [...canonical.matchAll(
      /\/usr\/bin\/node <<'NODE'\n([\s\S]*?)\nNODE/g,
    )].map((match) => match[1]);

    expect(embeddedPrograms).toHaveLength(2);
    for (const program of embeddedPrograms) {
      const checked = spawnSync(process.execPath, ['--check'], {
        input: program,
        encoding: 'utf8',
      });
      expect(checked.status, checked.stderr).toBe(0);
    }
  });

  it('refuses to replace an unknown principal at either governed smoke fixture ID', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const embeddedPrograms = [...canonical.matchAll(
      /\/usr\/bin\/node <<'NODE'\n([\s\S]*?)\nNODE/g,
    )].map((match) => match[1]);

    expect(embeddedPrograms).toHaveLength(2);
    for (const program of embeddedPrograms) {
      expect(program).toContain('function seedGovernedFixtureUser');
      expect(program).toContain('governed staging fixture principal collision');
      expect(program).toContain("'id', 'telegram_id', 'email', 'username', 'auth_provider'");
      expect(program).toContain('fixture principal changed during safe seed');
      expect(program).toContain('seedGovernedFixtureUser({');
      expect(program).toContain('}).immediate();');
      expect(program).not.toMatch(/insert\('users'/u);
    }
  });

  it('leaves an unknown fixture-ID collision unchanged and accepts an exact fixture idempotently', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const embeddedPrograms = [...canonical.matchAll(
      /\/usr\/bin\/node <<'NODE'\n([\s\S]*?)\nNODE/g,
    )].map((match) => match[1]);
    const fixtures = [
      {
        id: 1_000_014,
        telegramId: 911_000_014,
        email: 'training-preview-smoke-1000014@nexushub.test',
        username: 'training_preview_smoke_1000014',
      },
      {
        id: 1_000_016,
        telegramId: 911_000_016,
        email: 'locale-fidelity-smoke-1000016@nexushub.test',
        username: 'locale_fidelity_smoke_1000016',
      },
    ];

    expect(embeddedPrograms).toHaveLength(fixtures.length);
    for (const [index, program] of embeddedPrograms.entries()) {
      const helperSource = program.match(
        /\/\/ GOVERNED_FIXTURE_USER_SEED_START\n([\s\S]*?)\/\/ GOVERNED_FIXTURE_USER_SEED_END/u,
      )?.[1];
      expect(helperSource).toBeTruthy();

      const fixture = { ...fixtures[index], authProvider: 'email' };
      const db = new Database(':memory:');
      try {
        db.exec(`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY,
            telegram_id INTEGER,
            email TEXT,
            username TEXT,
            auth_provider TEXT,
            language TEXT,
            created_at TEXT,
            last_active_at TEXT
          )
        `);
        const columnsFor = (name: string) => new Set(
          db.prepare(`PRAGMA table_info(${name})`).all()
            .map((row) => (row as { name: string }).name),
        );
        const context: Record<string, unknown> = {
          db,
          fixturePrincipal: fixture,
          columnsFor,
          seedResult: null,
        };
        runInNewContext(`${helperSource}\nseedResult = seedGovernedFixtureUser;`, context);
        const seed = context.seedResult as (values: Record<string, unknown>) => void;
        const values = {
          id: fixture.id,
          telegram_id: fixture.telegramId,
          email: fixture.email,
          username: fixture.username,
          auth_provider: fixture.authProvider,
          language: index === 0 ? 'en-US' : 'es-ES',
          created_at: '2026-08-02T00:00:00.000Z',
          last_active_at: '2026-08-02T00:00:00.000Z',
        };

        db.prepare(`
          INSERT INTO users (
            id, telegram_id, email, username, auth_provider, language, created_at, last_active_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          fixture.id,
          fixture.telegramId + 99,
          `real-user-${fixture.id}@example.com`,
          `real_user_${fixture.id}`,
          'apple',
          'pt-BR',
          '2025-01-01T00:00:00.000Z',
          '2025-01-02T00:00:00.000Z',
        );
        const collisionBefore = JSON.stringify(
          db.prepare('SELECT * FROM users WHERE id = ?').get(fixture.id),
        );
        expect(() => seed(values)).toThrow(/governed staging fixture principal collision/u);
        expect(JSON.stringify(
          db.prepare('SELECT * FROM users WHERE id = ?').get(fixture.id),
        )).toBe(collisionBefore);

        db.prepare('DELETE FROM users WHERE id = ?').run(fixture.id);
        expect(() => seed(values)).not.toThrow();
        const exactFixtureAfterFirstSeed = JSON.stringify(
          db.prepare('SELECT * FROM users WHERE id = ?').get(fixture.id),
        );
        expect(() => seed(values)).not.toThrow();
        expect(JSON.stringify(
          db.prepare('SELECT * FROM users WHERE id = ?').get(fixture.id),
        )).toBe(exactFixtureAfterFirstSeed);
        expect(db.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
        expect(db.prepare(`
          SELECT id, telegram_id AS telegramId, email, username, auth_provider AS authProvider
          FROM users WHERE id = ?
        `).get(fixture.id)).toEqual(fixture);
      } finally {
        db.close();
      }
    }
  });

  it('proves a persisted legacy Spanish preference falls back to English without rewriting it', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const legacyTurn = canonical.indexOf(
      "{ locale: 'es-419', expectedLocale: 'en-US'",
    );
    const englishTurn = canonical.indexOf(
      "{ locale: 'en-US', expectedLocale: 'en-US'",
    );
    const portugueseTurn = canonical.indexOf("{ locale: 'pt-BR'");

    expect(legacyTurn).toBeGreaterThan(0);
    expect(legacyTurn).toBeLessThan(englishTurn);
    expect(legacyTurn).toBeLessThan(portugueseTurn);
    expect(canonical).toContain(
      "if (turn.locale === 'es-419' && storedLanguage !== 'es-ES')",
    );
    expect(canonical).toContain(
      "throw new Error('legacy Spanish preference was rewritten during compatibility smoke')",
    );
  });

  it('keeps the canonical locale smoke on a verified token-zero identity route', () => {
    const canonical = read('scripts/staging-smoke.sh');

    expect(canonical).toContain('checkResponseLocaleFidelity');
    expect(canonical).not.toContain('checkStagingLocaleWritePreview');
    expect(canonical).toContain("text: 'Who am I signed in as?'");
    expect(canonical).toContain("text: 'Quem sou eu?'");
    expect(canonical).toContain("text: '¿Quién soy?'");
    expect(canonical).toContain("routeMethod === 'authenticated-identity'");
    expect(canonical).toContain("metadata?.type === 'authenticated_identity'");
    expect(canonical).toContain('metadata?.userId === userId');
    expect(canonical).toContain('metadata?.hasDisplayName === true');
    expect(canonical).toContain('userId !== 1000014');
    expect(canonical).toContain('userId !== 1000016');
    expect(canonical).toContain('successful training smoke exceeded 16384-byte evidence limit');
    expect(canonical).toContain('successful training smoke did not emit one strict JSON document');
    expect(canonical).toContain('providerUsageBefore');
    expect(canonical).toContain('providerUsageAfter');
    expect(canonical).toContain('providerUsageAfter === providerUsageBefore');
    expect(canonical).not.toContain('the reply itself may spend planner tokens');
    expect(canonical).not.toContain('Crea una tarea llamada staging legacy locale smoke');
    expect(canonical).not.toContain('Create a task called staging English locale smoke');
    expect(canonical).not.toContain('Cria uma tarefa chamada revisão do planejador de fumaça');
  });

  it('runs the exact-release policy smoke once in the existing sequential gate', () => {
    const canonical = read('scripts/staging-smoke.sh');
    const ollama = read('scripts/staging-smoke-ollama.sh');
    const operator = read('scripts/release-operator.sh');
    const remote = read('scripts/remote-user-release-transaction.sh');

    expect(canonical.match(/staging-smoke-ollama\.sh/g)).toHaveLength(1);
    expect(canonical).toContain('OLLAMA_INVENTORY_PHASE=release');
    expect(canonical).toContain('NEXUS_HUB_BASE_URL=http://127.0.0.1:8201');
    expect(canonical).toContain('PM2_APP_NAME=nexus-hub-staging');
    expect(canonical).toContain('PM2_BIN=/home/dominguez/.npm-global/bin/pm2');
    expect(canonical).toContain('evidence_record "Ollama release policy"');
    expect(ollama).toContain('final|release');
    expect(ollama).toContain('PM2_BIN must name an absolute executable PM2 launcher');
    expect(ollama).toContain('LOCAL_MODEL_MANIFEST_PATH');
    expect(ollama).toContain('active model tag and digest match the signed manifest');
    expect(ollama).toContain('(.models | length) <= 1');
    expect(ollama).toContain('test($disallowed_model_pattern)');
    expect(ollama).not.toContain('test("flash|nano|mini|haiku|lite|classifier|fast")');
    const pattern = ollama.match(
      /^DISALLOWED_REASONING_MODEL_TOKEN_PATTERN='([^']+)'$/m,
    )?.[1];
    expect(pattern).toBeTruthy();
    const disallowedModelToken = new RegExp(pattern!);
    expect(disallowedModelToken.test('gemini-2.5-pro')).toBe(false);
    expect(disallowedModelToken.test('gpt-5-mini')).toBe(true);
    expect(disallowedModelToken.test('gemini-2.5-flash')).toBe(true);
    expect(disallowedModelToken.test('claude-haiku-4-5')).toBe(true);
    expect(disallowedModelToken.test('geminiflash')).toBe(false);

    const filterStart = ollama.indexOf(
      '      [.[] | select(.name == $name and .pm2_env.status == "online")',
    );
    const filterEnd = ollama.indexOf("\n    ' >/dev/null; then", filterStart);
    expect(filterStart).toBeGreaterThan(0);
    expect(filterEnd).toBeGreaterThan(filterStart);
    const routingFilter = ollama.slice(filterStart, filterEnd);
    const appName = 'nexus-hub-staging';
    const retainedModel = 'qwen2.5:3b-instruct-q4_K_M';
    const routingEnvironment = (provider: string, model: string) => ({
      status: 'online',
      OLLAMA_ENABLED: 'true',
      AI_CLASSIFY_PRIMARY: 'gemini',
      LOCAL_LLM_CLASSIFY_SHADOW: 'true',
      CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE: 'shadow',
      LOCAL_LLM_EVALUATION_MODE: 'false',
      AI_SCRIPT_GENERATION_REQUIRE_LOCAL: 'false',
      AI_SCRIPT_GENERATION_FALLBACK: 'approved_cloud_reasoning',
      AI_LOCAL_REASONING_FALLBACK: 'approved_cloud_reasoning',
      CLOUD_REASONING_FALLBACK_ENABLED: 'true',
      CLOUD_REASONING_REQUIRE_APPROVED_MODEL: 'true',
      CLOUD_REASONING_ON_UNAPPROVED_MODEL: 'fail_visibly',
      CLOUD_REASONING_PRIVACY_MODE: 'never',
      CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA: 'false',
      CLOUD_REASONING_PROVIDER: provider,
      CLOUD_REASONING_MODEL: model,
      APPROVED_REASONING_MODELS: model,
      OLLAMA_MODEL: retainedModel,
      OLLAMA_CLASSIFIER_MODEL: retainedModel,
      CHAT_CORE_V2_LOCAL_CHAT_MODEL: retainedModel,
      CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL: retainedModel,
      CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL: 'off',
    });
    const evaluateRouting = (provider: string, model: string, environment = {}) => {
      const input = JSON.stringify([{
        name: appName,
        pm2_env: { ...routingEnvironment(provider, model), ...environment },
      }]);
      return execFileSync('jq', [
        '-e',
        '--arg', 'name', appName,
        '--arg', 'model', retainedModel,
        '--arg', 'disallowed_model_pattern', pattern!,
        routingFilter,
      ], { input, encoding: 'utf8' });
    };

    expect(() => evaluateRouting('gemini', 'gemini-2.5-pro')).not.toThrow();
    for (const [provider, model] of [
      ['openai', 'gpt-5-mini'],
      ['gemini', 'gemini-2.5-flash'],
      ['anthropic', 'claude-haiku-4-5'],
    ]) {
      expect(() => evaluateRouting(provider, model)).toThrow();
    }
    expect(() => evaluateRouting('anthropic', 'gemini-2.5-pro')).toThrow();
    expect(() => evaluateRouting('gemini', 'gemini-2.5-pro', {
      OLLAMA_ENABLED: 'false',
    })).toThrow();

    // Stronger guarantee: the narrow remote authenticated smoke remains, but
    // prepare must also run and bind the complete canonical staging smoke.
    expect(operator).toContain('"$ROOT/scripts/staging-smoke.sh"');
    expect(operator).toContain('NEXUS_SMOKE_REQUIRE_EXACT_IDENTITY=1');
    expect(operator).toContain('NEXUS_SMOKE_CLASSIFIER_BASE_SHA="$CANONICAL_DEPLOYED_SHA"');
    expect(operator).toContain('scripts/lib/staging-smoke-evidence.mjs validate');
    expect(remote).toContain('authenticated_runtime_smoke');
    expect(remote).toContain('AUTHENTICATED_SMOKE=passed');
    expect(remote).toContain('DATABASE_INTEGRITY=passed');
    expect(operator).not.toContain('scripts/staging-smoke-ollama.sh');
  });
});
