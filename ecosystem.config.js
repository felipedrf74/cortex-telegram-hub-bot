const path = require('path');

module.exports = {
  apps: [{
    name: 'nexus-hub',
    script: 'dist/index.js',
    cwd: __dirname,
    exec_mode: 'fork',
    instances: 1,           // CRITICAL: only 1 instance — SQLite writer + scheduler must be single-process
    autorestart: true,
    watch: false,
    max_memory_restart: '750M',  // Raised from 500M — bot was hitting 94% heap at 500M
    node_args: '--max-old-space-size=768',  // Match the memory limit
    env: {
      NODE_ENV: 'production',
      GIT_COMMIT: process.env.GIT_COMMIT || 'unknown',
    },
    // Log settings
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    // Restart policy — prevent rapid restart loops (port binds + SQLite locks)
    exp_backoff_restart_delay: 5000,  // Start at 5s, doubles each crash (5s → 10s → 20s → 40s...)
    max_restarts: 15,                 // Max restarts within min_uptime window
    min_uptime: 60000,                // Process must run 60s+ to be considered "stable" (resets restart counter)
    restart_delay: 10000,             // Base delay between restarts
    kill_timeout: 10000,              // Give 10s for graceful shutdown (portal close + DB close)
    listen_timeout: 60000,            // Allow 60s for startup (migrations + connector warmup)
  }, {
    name: 'content-engine',
    script: path.join(__dirname, 'content-engine/.venv/bin/python3.12'),
    args: 'main.py',
    cwd: path.join(__dirname, 'content-engine'),
    interpreter: 'none',
    exec_mode: 'fork',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      ENV: 'production',
      GIT_COMMIT: process.env.GIT_COMMIT || 'unknown',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: path.join(__dirname, 'logs/content-engine-error.log'),
    out_file: path.join(__dirname, 'logs/content-engine-out.log'),
    merge_logs: true,
    restart_delay: 5000,
    kill_timeout: 5000,
  }],
};
