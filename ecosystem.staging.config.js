// PM2 ecosystem file for the STAGING environment.
//
// Quarter audit item: Staging environment + Blue-green deploy.
//
// Design:
//   - Single VPS, two parallel installs:
//       /home/dominguez/telegram-hub-bot/          (production — port 8200)
//       /home/dominguez/telegram-hub-bot-staging/  (staging    — port 8201)
//   - Each install has its OWN dist/, data/, .env, and node_modules.
//     They share NOTHING at runtime, so a staging migration can't corrupt
//     prod and a staging crash can't take prod down.
//   - PM2 runs four processes total:
//       nexus-hub               (prod TS)        port 8200
//       content-engine          (prod Python)    port 8100
//       nexus-hub-staging       (staging TS)     port 8201
//       content-engine-staging  (staging Python) port 8101
//   - Tests, migrations, hotfixes get verified on staging FIRST. Once green
//     for ~hour, deploy.sh promotes them to prod.
//
// Telegram bot token caveat: Telegram allows only ONE long-polling consumer
// per bot token. Staging needs its OWN bot token (create a second @BotFather
// bot, e.g. "Nexus Hub Staging") OR you can run staging in a "no Telegram"
// mode (set TELEGRAM_BOT_TOKEN to empty in .env.staging — the bot will fail
// to start but the portal + content-engine + crons still come up). This
// covers ~95% of staging use cases without needing a second bot.
//
// Usage:
//   pm2 start ecosystem.staging.config.js   # First-time start
//   pm2 restart nexus-hub-staging           # After ./scripts/deploy-staging.sh
//   pm2 logs nexus-hub-staging              # Tail staging logs

module.exports = {
  apps: [
    {
      name: 'nexus-hub-staging',
      script: 'dist/index.js',
      // CWD points at the staging install — keep this as a string (not
      // __dirname) because this file gets copied alongside the staging
      // dist/ via deploy-staging.sh, and we want it to ALWAYS resolve
      // the staging path regardless of where pm2 was invoked from.
      cwd: '/home/dominguez/telegram-hub-bot-staging',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      // Staging gets a smaller memory cap because we're not paging in the
      // full message history that prod accumulates.
      max_memory_restart: '512M',
      node_args: '--max-old-space-size=512',
      env: {
        NODE_ENV: 'staging',
        // Tell the bot it's the staging instance — code can branch on this
        // (e.g. skip Telegram alerts, log a "STAGING" prefix in messages).
        STAGING: 'true',
        // Different ports than prod so both can run side-by-side
        PORTAL_PORT: '8201',
        CONTENT_ENGINE_PORT: '8101',
        NEXUS_BACKEND_BASE_URL: 'http://127.0.0.1:8201',
        NEXUS_BACKEND_PORT: '8201',
        AI_CALL_TIMEOUT_MS: '180000',
        // Staging DB lives inside the staging install — fully isolated
        DATABASE_PATH: '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
        // The rest of the env (TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, etc.)
        // comes from /home/dominguez/telegram-hub-bot-staging/.env which
        // dotenv loads automatically at startup. KEEP staging credentials
        // separate from prod credentials so a leaked staging .env can't
        // touch the production Telegram bot or ship invoices.
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/dominguez/telegram-hub-bot-staging/logs/error.log',
      out_file: '/home/dominguez/telegram-hub-bot-staging/logs/out.log',
      merge_logs: true,
      // Restart policy — slightly more aggressive than prod because we'd
      // rather have staging restart-loop visibly than mask a problem.
      exp_backoff_restart_delay: 3000,
      max_restarts: 10,
      min_uptime: 30000,
      restart_delay: 5000,
      kill_timeout: 10000,
      listen_timeout: 60000,
    },
    {
      name: 'content-engine-staging',
      script: '/home/dominguez/telegram-hub-bot-staging/content-engine/.venv/bin/python3.12',
      args: 'main.py',
      cwd: '/home/dominguez/telegram-hub-bot-staging/content-engine',
      interpreter: 'none', // Don't run via Node — args is the python entry
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        // Different port than prod content-engine (8100 → 8101)
        CONTENT_ENGINE_PORT: '8101',
        NEXUS_BACKEND_BASE_URL: 'http://127.0.0.1:8201',
        NEXUS_BACKEND_PORT: '8201',
        AI_CALL_TIMEOUT_MS: '180000',
        ENV: 'staging',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/dominguez/telegram-hub-bot-staging/logs/content-engine-error.log',
      out_file: '/home/dominguez/telegram-hub-bot-staging/logs/content-engine-out.log',
      merge_logs: true,
      restart_delay: 5000,
      kill_timeout: 5000,
    },
  ],
};
