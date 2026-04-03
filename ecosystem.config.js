module.exports = {
  apps: [{
    name: 'nexus-hub',
    script: 'dist/index.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,           // CRITICAL: only 1 instance — Telegram long-polling allows only one
    autorestart: true,
    watch: false,
    max_memory_restart: '750M',  // Raised from 500M — bot was hitting 94% heap at 500M
    node_args: '--max-old-space-size=768',  // Match the memory limit
    env: {
      NODE_ENV: 'production',
    },
    // Log settings
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    // Restart policy — prevent rapid restart loops that cause Telegram 409 conflicts
    exp_backoff_restart_delay: 5000,  // Start at 5s, doubles each crash (5s → 10s → 20s → 40s...)
    max_restarts: 15,                 // Max restarts within min_uptime window
    min_uptime: 60000,                // Process must run 60s+ to be considered "stable" (resets restart counter)
    restart_delay: 10000,             // Base delay between restarts
    kill_timeout: 10000,              // Give 10s for graceful shutdown (bot.stop() + DB close)
    listen_timeout: 60000,            // Allow 60s for startup (Telegram polling lock may take time)
  }],
};
