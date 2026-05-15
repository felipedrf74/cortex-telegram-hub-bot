import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const serverPath = path.join(repoRoot, 'scripts/cockpit/server.js');
const appPath = path.join(repoRoot, 'scripts/cockpit/app.js');
const simLocalPath = path.join(repoRoot, 'scripts/sim-local.sh');
const simDownPath = path.join(repoRoot, 'scripts/sim-down.sh');
const localSmokePath = path.join(repoRoot, 'scripts/local-smoke.sh');
const cockpitLaunchPath = path.join(repoRoot, 'scripts/cockpit.sh');

let child: ChildProcessWithoutNullStreams | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('no port assigned')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function startCockpit(token: string): Promise<string> {
  const port = await freePort();
  child = spawn(process.execPath, [serverPath, '--port', String(port)], {
    cwd: repoRoot,
    env: { ...process.env, NEXUS_COCKPIT_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/session`);
      if (res.ok) return baseUrl;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }

  throw new Error(`cockpit did not boot: ${String(lastError)}`);
}

async function stopCockpit(): Promise<void> {
  const current = child;
  child = null;
  if (!current || current.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (!current.killed) current.kill('SIGKILL');
      resolve();
    }, 1_000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    current.kill('SIGTERM');
  });
}

afterEach(async () => {
  await stopCockpit();
});

describe('Local Dev Cockpit security boundary', () => {
  it('rejects cross-site or tokenless command POSTs before command execution', async () => {
    const token = 'test-cockpit-token-1234567890';
    const baseUrl = await startCockpit(token);

    const crossSite = await fetch(`${baseUrl}/api/run/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({ error: 'cross_site_request_rejected' });

    const missingToken = await fetch(`${baseUrl}/api/run/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missingToken.status).toBe(403);
    await expect(missingToken.json()).resolves.toMatchObject({ error: 'cockpit_token_required' });

    const validHeaders = {
      'Content-Type': 'application/json',
      'x-nexus-cockpit-token': token,
      Origin: baseUrl,
      'Sec-Fetch-Site': 'same-origin',
    };

    const crossSiteWithToken = await fetch(`${baseUrl}/api/run/vitest-run`, {
      method: 'POST',
      headers: { ...validHeaders, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ pattern: 'safe' }),
    });
    expect(crossSiteWithToken.status).toBe(403);

    const badArgs = await fetch(`${baseUrl}/api/run/vitest-run`, {
      method: 'POST',
      headers: validHeaders,
      body: JSON.stringify({ pattern: '$(touch /tmp/nope)' }),
    });
    expect(badArgs.status).toBe(400);
    await expect(badArgs.json()).resolves.toMatchObject({ error: 'bad_args' });
  });

  it('requires a one-use server confirmation nonce for dangerous commands', async () => {
    const token = 'test-cockpit-token-danger-1234567890';
    const baseUrl = await startCockpit(token);
    const headers = {
      'Content-Type': 'application/json',
      'x-nexus-cockpit-token': token,
      Origin: baseUrl,
      'Sec-Fetch-Site': 'same-origin',
    };

    const missingConfirmation = await fetch(`${baseUrl}/api/run/reset`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(missingConfirmation.status).toBe(403);
    await expect(missingConfirmation.json()).resolves.toMatchObject({ error: 'danger_confirmation_required' });

    const confirmation = await fetch(`${baseUrl}/api/confirm/reset`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(confirmation.status).toBe(200);
    const confirmationJson = await confirmation.json() as { confirmationNonce?: string };
    expect(confirmationJson.confirmationNonce).toMatch(/^[A-Za-z0-9_-]+$/);

    const nonDanger = await fetch(`${baseUrl}/api/confirm/smoke`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(nonDanger.status).toBe(400);
    await expect(nonDanger.json()).resolves.toMatchObject({ error: 'confirmation_not_required' });

    const openGuardPassed = await fetch(`${baseUrl}/api/open`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ target: 'unknown-target' }),
    });
    expect(openGuardPassed.status).toBe(400);
    await expect(openGuardPassed.json()).resolves.toMatchObject({ error: 'unknown_target' });
  });

  it('frontend refreshes a stale cockpit token before retrying a command request', () => {
    const appSource = fs.readFileSync(appPath, 'utf8');

    expect(appSource).toContain('async function fetchWithCockpitToken');
    expect(appSource).toContain("json.error === 'cockpit_token_required'");
    expect(appSource).toContain('cockpitToken = null;');
    expect(appSource).toContain('fetchWithCockpitToken(`/api/run/${cmd}`');
    expect(appSource).toContain('fetchWithCockpitToken(`/api/confirm/${cmd}`');
    expect(appSource).toContain("fetchWithCockpitToken('/api/open'");
  });

  it('frontend reconciles buttons with the running command manifest', () => {
    const appSource = fs.readFileSync(appPath, 'utf8');

    expect(appSource).toContain('async function refreshCommandManifest');
    expect(appSource).toContain("fetch('/api/commands'");
    expect(appSource).toContain('server command registry is stale or missing');
    expect(appSource).toContain('unknownCommandMessage(cmd)');
    expect(appSource).toContain('Restart Cockpit to load this command');
  });

  it('iOS simulator launcher auto-selects available devices without blocking Cockpit by default', () => {
    const simSource = fs.readFileSync(simLocalPath, 'utf8');
    const serverSource = fs.readFileSync(serverPath, 'utf8');

    expect(serverSource).toContain("label: 'Launch iOS Simulator'");
    expect(serverSource).toContain("bin: path.join(SCRIPTS_DIR, 'sim-local.sh')");
    expect(simSource).toContain('SIM_DEVICE="${NEXUS_SIM_DEVICE:-}"');
    expect(simSource).toContain('SIM_UDID_OVERRIDE="${NEXUS_SIM_UDID:-}"');
    expect(simSource).toContain('source "$ROOT/.env.local"');
    expect(simSource).toContain('LOCAL_AUTH_INVITE_CODE="${NEXUS_SIM_AUTH_INVITE_CODE:-${IOS_INVITE_CODE:-LOCAL-DEV-INVITE}}"');
    expect(simSource).toContain('const preferredOrder = ["iPhone 17 Pro"');
    expect(simSource).toContain('state === "Booted"');
    expect(simSource).not.toContain('NEXUS_SIM_DEVICE:-iPhone 15');
    expect(simSource).toContain('NEXUS_SIM_CONSOLE:-0');
    expect(simSource).toContain('NEXUS_SIM_RESOLVE_ONLY:-0');
    expect(simSource).toContain('LAUNCH_ARGS=(--console-pty "${LAUNCH_ARGS[@]}")');
    expect(simSource).toContain('-nexus_local_auth_invite_code "$LOCAL_AUTH_INVITE_CODE"');
  });

  it('cockpit exposes a safe simulator shutdown action', () => {
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const indexSource = fs.readFileSync(path.join(repoRoot, 'scripts/cockpit/index.html'), 'utf8');
    const simDownSource = fs.readFileSync(simDownPath, 'utf8');

    expect(serverSource).toContain("'sim-stop': {");
    expect(serverSource).toContain("label: 'Shutdown iOS Simulator'");
    expect(serverSource).toContain("bin: path.join(SCRIPTS_DIR, 'sim-down.sh')");
    expect(indexSource).toContain('data-cmd="sim-stop"');
    expect(indexSource).toContain('Shutdown iOS Simulator');
    expect(simDownSource).toContain('xcrun simctl shutdown all');
    expect(simDownSource).toContain("pkill -f 'SimulatorTrampoline'");
    expect(simDownSource).toContain("pkill -f 'com.apple.CoreSimulator.CoreSimulatorService'");
    expect(simDownSource).toContain('killall SimulatorTrampoline');
    expect(simDownSource).toContain('killall com.apple.CoreSimulator.CoreSimulatorService');
  });

  it('server command manifest includes simulator shutdown', async () => {
    const token = 'test-cockpit-token-manifest-1234567890';
    const baseUrl = await startCockpit(token);

    const res = await fetch(`${baseUrl}/api/commands`);
    expect(res.status).toBe(200);
    const json = await res.json() as { commands?: Array<{ name: string; label: string }> };
    expect(json.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sim-stop', label: 'Shutdown iOS Simulator' }),
      ]),
    );
  });

  it('server ties child cancellation to the response stream lifecycle', () => {
    const serverSource = fs.readFileSync(serverPath, 'utf8');

    expect(serverSource).toContain("res.on('close'");
    expect(serverSource).toContain("child.on('close', completeRun)");
    expect(serverSource).not.toContain("req.on('close'");
  });

  it('local smoke authenticates portal-scoped checks when local tokens are configured', () => {
    const smokeSource = fs.readFileSync(localSmokePath, 'utf8');

    expect(smokeSource).toContain('source .env.local');
    expect(smokeSource).toContain('PORTAL_READ_TOKEN');
    expect(smokeSource).toContain('PORTAL_WRITE_TOKEN');
    expect(smokeSource).toContain('PORTAL_ADMIN_TOKEN');
    expect(smokeSource).toContain('PORTAL_TOKEN');
    expect(smokeSource).toContain('PORTAL_AUTH_HEADERS=(-H "Authorization: Bearer ${PORTAL_READ_TOKEN}")');
    expect(smokeSource).toContain('PORTAL_AUTH_HEADERS=(-H "Authorization: Bearer ${PORTAL_ADMIN_TOKEN}")');
    expect(smokeSource).toContain('curl -fsS "${PORTAL_AUTH_HEADERS[@]}" "$BASE_URL/api/snapshot"');
    expect(smokeSource).toContain('curl -fsS "${PORTAL_AUTH_HEADERS[@]}" "$BASE_URL/api/cost-by-domain?days=7"');
  });

  it('cockpit status polling uses available portal tokens for snapshot reads', () => {
    const serverSource = fs.readFileSync(serverPath, 'utf8');
    const launcherSource = fs.readFileSync(cockpitLaunchPath, 'utf8');

    expect(launcherSource).toContain('source .env.local');
    expect(launcherSource).toContain('Existing Cockpit process found on $URL; restarting it');
    expect(launcherSource).toContain('lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN');
    expect(serverSource).toContain('function portalReadAuthHeaders()');
    expect(serverSource).toContain('process.env.PORTAL_READ_TOKEN');
    expect(serverSource).toContain('process.env.PORTAL_WRITE_TOKEN');
    expect(serverSource).toContain('process.env.PORTAL_ADMIN_TOKEN');
    expect(serverSource).toContain('process.env.PORTAL_TOKEN');
    expect(serverSource).toContain('headers: portalReadAuthHeaders()');
  });
});
