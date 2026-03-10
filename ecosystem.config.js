module.exports = {
  apps: [{
    name: 'telegram-hub-bot',
    script: 'dist/index.js',
    cwd: __dirname,  // resolves to wherever this file lives (Mac or server)
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
    },
    // Log settings
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: true,
    // Restart policy
    exp_backoff_restart_delay: 1000,
    max_restarts: 10,
    restart_delay: 5000,
  }],
};
