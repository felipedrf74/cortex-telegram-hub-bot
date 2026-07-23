const path = require('path');
const fs = require('fs');
const { parse: parseDotenv } = require('dotenv');

const releaseDir = process.env.NEXUS_RELEASE_DIR;
if (!releaseDir) throw new Error('NEXUS_RELEASE_DIR is required');
const role = process.env.NEXUS_RELEASE_ROLE || 'staging';
const staging = role === 'staging';
const baseDir = process.env.NEXUS_RELEASE_BASE_DIR
  || (staging ? '/home/dominguez/telegram-hub-bot-staging' : '/home/dominguez/telegram-hub-bot');
const backendPort = staging ? '8201' : '8200';
const contentPort = staging ? '8101' : '8100';
const policyEnvironmentNames = Object.freeze([
  'OLLAMA_ENABLED',
  'AI_CLASSIFY_PRIMARY',
  'LOCAL_LLM_CLASSIFY_SHADOW',
  'CHAT_CORE_V2_LOCAL_CHAT_LLM_MODE',
  'LOCAL_LLM_EVALUATION_MODE',
  'AI_SCRIPT_GENERATION_REQUIRE_LOCAL',
  'AI_SCRIPT_GENERATION_FALLBACK',
  'AI_LOCAL_REASONING_FALLBACK',
  'CLOUD_REASONING_FALLBACK_ENABLED',
  'CLOUD_REASONING_REQUIRE_APPROVED_MODEL',
  'CLOUD_REASONING_ON_UNAPPROVED_MODEL',
  'CLOUD_REASONING_PRIVACY_MODE',
  'CLOUD_REASONING_ALLOW_RAW_PRIVATE_DATA',
  'CLOUD_REASONING_PROVIDER',
  'CLOUD_REASONING_MODEL',
  'APPROVED_REASONING_MODELS',
  'OLLAMA_MODEL',
  'OLLAMA_CLASSIFIER_MODEL',
  'CHAT_CORE_V2_LOCAL_CHAT_MODEL',
  'CHAT_CORE_V2_LOCAL_CHAT_RECIPE_MODEL',
  'CHAT_CORE_V2_LOCAL_CHAT_FAST_MODEL',
]);
const protectedEnvironmentPath = path.join(baseDir, '.env');
const protectedEnvironment = parseDotenv(fs.readFileSync(protectedEnvironmentPath));
const policyEnvironment = Object.fromEntries(policyEnvironmentNames.map((name) => {
  const value = protectedEnvironment[name];
  if (typeof value !== 'string' || value.length < 1 || value.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`protected release environment has an invalid or missing ${name}`);
  }
  return [name, value];
}));

module.exports = {
  apps: [{
    name: staging ? 'nexus-hub-staging' : 'nexus-hub',
    script: 'dist/index.js',
    cwd: releaseDir,
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    // PM2 measures total RSS, while V8's old-space flag limits only one part
    // of the process. Keep 256 MiB above the 768 MiB heap for native addons,
    // code, buffers, and other external allocations.
    max_memory_restart: '1G',
    node_args: '--max-old-space-size=768',
    env: {
      NODE_ENV: role,
      STAGING: staging ? 'true' : 'false',
      PORTAL_PORT: backendPort,
      CONTENT_ENGINE_PORT: contentPort,
      NEXUS_BACKEND_BASE_URL: `http://127.0.0.1:${backendPort}`,
      NEXUS_BACKEND_PORT: backendPort,
      DATABASE_PATH: path.join(baseDir, 'data/bot.db'),
      NEXUS_RELEASE_SHA: process.env.NEXUS_RELEASE_SHA || 'unknown',
      GIT_COMMIT: process.env.NEXUS_RELEASE_SHA || 'unknown',
      ...policyEnvironment,
    },
    error_file: path.join(baseDir, 'logs/error.log'),
    out_file: path.join(baseDir, 'logs/out.log'),
    merge_logs: true,
    exp_backoff_restart_delay: 5000,
    max_restarts: 15,
    min_uptime: 60000,
    restart_delay: 10000,
    kill_timeout: 10000,
    listen_timeout: 60000,
  }, {
    name: staging ? 'content-engine-staging' : 'content-engine',
    script: path.join(releaseDir, 'content-engine/.venv/bin/python3.12'),
    args: 'main.py',
    cwd: path.join(releaseDir, 'content-engine'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: staging ? '300M' : '500M',
    env: {
      ENV: role,
      PYTHONDONTWRITEBYTECODE: '1',
      CONTENT_ENGINE_PORT: contentPort,
      NEXUS_BACKEND_BASE_URL: `http://127.0.0.1:${backendPort}`,
      NEXUS_BACKEND_PORT: backendPort,
      NEXUS_RELEASE_SHA: process.env.NEXUS_RELEASE_SHA || 'unknown',
      GIT_COMMIT: process.env.NEXUS_RELEASE_SHA || 'unknown',
    },
    error_file: path.join(baseDir, 'logs/content-engine-error.log'),
    out_file: path.join(baseDir, 'logs/content-engine-out.log'),
    merge_logs: true,
    restart_delay: 5000,
    kill_timeout: 5000,
  }],
};
