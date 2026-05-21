#!/usr/bin/env node

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';
const DEFAULT_ZONE = 'nexushub.me';
const PUBLIC_STATUS_PATH = '/public-status';

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const includeStaging = args.has('--include-staging');
const skipBotManagement = args.has('--skip-bot-management');
const help = args.has('--help') || args.has('-h');

const zoneName = readOption('--zone') ?? process.env.CLOUDFLARE_ZONE_NAME ?? DEFAULT_ZONE;
const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? '';

function readOption(name) {
  const rawArgs = process.argv.slice(2);
  const index = rawArgs.indexOf(name);
  if (index === -1) return undefined;
  return rawArgs[index + 1];
}

function usage() {
  console.log(`Usage: scripts/cloudflare-edge-unblock.mjs [--apply] [--zone nexushub.me] [--include-staging] [--skip-bot-management]

Applies the Nexus Hub edge posture:
  - nexushub.me/www.nexushub.me allow AI fetchers through Cloudflare edge checks
  - api.nexushub.me allows AI/monitor UAs only on /public-status
  - api.nexushub.me and portal.nexushub.me block AI fetchers on other paths
  - Cloudflare managed robots / AI crawler protection are disabled unless --skip-bot-management is set

Dry-run is the default. Set CLOUDFLARE_API_TOKEN or CF_API_TOKEN before --apply.`);
}

function quoteSet(values) {
  return `{${values.map((value) => `"${value}"`).join(' ')}}`;
}

const aiFetchers = [
  'Claude',
  'ClaudeBot',
  'Claude-Web',
  'Anthropic',
  'anthropic-ai',
  'GPT',
  'GPTBot',
  'OpenAI',
  'ChatGPT-User',
  'OAI-SearchBot',
  'Perplexity',
  'PerplexityBot',
  'Perplexity-User',
  'YouBot',
  'cohere-ai',
  'Amazonbot',
  'Applebot-Extended',
  'Google-Extended',
];

const monitorFetchers = ['UptimeRobot', 'StatusCake'];

function userAgentExpression(parts) {
  return `(${parts.map((part) => `(http.user_agent contains "${part}")`).join(' or ')})`;
}

const aiUaExpression = userAgentExpression(aiFetchers);
const publicStatusUaExpression = userAgentExpression([...aiFetchers, ...monitorFetchers]);
const apiPublicStatusHosts = includeStaging ? ['api.nexushub.me', 'api-staging.nexushub.me'] : ['api.nexushub.me'];

const skipActionParameters = {
  phases: ['http_request_sbfm', 'http_request_firewall_managed', 'http_ratelimit'],
  products: ['bic', 'securityLevel', 'uaBlock', 'waf', 'zoneLockdown'],
};

const desiredRules = [
  {
    ref: 'nexus_marketing_ai_crawler_skip_v1',
    description: 'Nexus Hub: allow AI fetchers on marketing site',
    expression: `(http.host in ${quoteSet(['nexushub.me', 'www.nexushub.me'])}) and ${aiUaExpression}`,
    action: 'skip',
    action_parameters: skipActionParameters,
    enabled: true,
  },
  {
    ref: 'nexus_api_public_status_ai_monitor_skip_v1',
    description: 'Nexus Hub: allow AI and monitor fetchers on API public status only',
    expression: `(http.host in ${quoteSet(apiPublicStatusHosts)}) and (http.request.uri.path eq "${PUBLIC_STATUS_PATH}") and ${publicStatusUaExpression}`,
    action: 'skip',
    action_parameters: skipActionParameters,
    enabled: true,
  },
  {
    ref: 'nexus_api_ai_fetcher_block_except_public_status_v1',
    description: 'Nexus Hub: block AI fetchers on API except public status',
    expression: `(http.host in ${quoteSet(['api.nexushub.me', 'portal.nexushub.me'])}) and (http.request.uri.path ne "${PUBLIC_STATUS_PATH}") and ${aiUaExpression}`,
    action: 'block',
    enabled: true,
  },
];

const desiredBotManagement = {
  is_robots_txt_managed: false,
  ai_bots_protection: 'disabled',
};

async function cf(path, options = {}) {
  const res = await fetch(`${CF_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const errors = Array.isArray(body.errors) ? body.errors.map((err) => err.message).join('; ') : res.statusText;
    throw new Error(`Cloudflare API ${options.method ?? 'GET'} ${path} failed (${res.status}): ${errors}`);
  }
  return body.result;
}

async function findZoneId() {
  const result = await cf(`/zones?name=${encodeURIComponent(zoneName)}&status=active`);
  const zone = Array.isArray(result) ? result.find((candidate) => candidate.name === zoneName) : undefined;
  if (!zone?.id) {
    throw new Error(`Cloudflare zone not found or inactive: ${zoneName}`);
  }
  return zone.id;
}

async function getEntrypointRuleset(zoneId) {
  try {
    return await cf(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`);
  } catch (err) {
    if (String(err.message).includes('(404)')) return null;
    throw err;
  }
}

function ruleKey(rule) {
  return rule.ref || rule.description;
}

function upsertRules(existingRules = []) {
  const desiredKeys = new Set(desiredRules.map(ruleKey));
  const preserved = existingRules.filter((rule) => !desiredKeys.has(ruleKey(rule)));
  return [...desiredRules, ...preserved];
}

async function applyRuleset(zoneId) {
  const existing = await getEntrypointRuleset(zoneId);
  const rules = upsertRules(existing?.rules ?? []);
  if (!existing) {
    await cf(`/zones/${zoneId}/rulesets`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Nexus Hub edge protection',
        description: 'Nexus Hub AI crawler and public-status edge rules',
        kind: 'zone',
        phase: 'http_request_firewall_custom',
        rules,
      }),
    });
    return { mode: 'created', rules: rules.length };
  }

  await cf(`/zones/${zoneId}/rulesets/${existing.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      name: existing.name,
      description: existing.description || 'Nexus Hub AI crawler and public-status edge rules',
      kind: existing.kind,
      phase: existing.phase,
      rules,
    }),
  });
  return { mode: 'updated', rules: rules.length };
}

async function applyBotManagement(zoneId) {
  const current = await cf(`/zones/${zoneId}/bot_management`);
  const payload = { ...current, ...desiredBotManagement };
  await cf(`/zones/${zoneId}/bot_management`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  return {
    previous: {
      is_robots_txt_managed: current.is_robots_txt_managed,
      ai_bots_protection: current.ai_bots_protection,
    },
    next: desiredBotManagement,
  };
}

function printPlan() {
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    zone: zoneName,
    includeStaging,
    botManagement: skipBotManagement ? 'skipped' : desiredBotManagement,
    rules: desiredRules.map((rule) => ({
      ref: rule.ref,
      action: rule.action,
      expression: rule.expression,
      action_parameters: rule.action_parameters,
    })),
  }, null, 2));
}

async function main() {
  if (help) {
    usage();
    return;
  }

  printPlan();

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply after setting CLOUDFLARE_API_TOKEN or CF_API_TOKEN.');
    return;
  }

  if (!token) {
    console.error('\nMissing CLOUDFLARE_API_TOKEN/CF_API_TOKEN; refusing to mutate Cloudflare.');
    process.exitCode = 2;
    return;
  }

  const zoneId = await findZoneId();
  console.log(`\nResolved Cloudflare zone ${zoneName}: ${zoneId}`);

  if (!skipBotManagement) {
    const botManagement = await applyBotManagement(zoneId);
    console.log('Bot Management updated:', JSON.stringify(botManagement, null, 2));
  }

  const ruleset = await applyRuleset(zoneId);
  console.log('Ruleset updated:', JSON.stringify(ruleset, null, 2));
  console.log('\nRun scripts/cloudflare-edge-verify.sh after Cloudflare propagation.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
