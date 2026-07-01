// PM2 config for asmltr-insights-collector.
// MUST run on host: reconciles host session tracker, signals host pids (control
// plane), optionally tails local proxy logs. Bind 127.0.0.1.
// The log tailer is an optional integration (off by default); enable via env.
module.exports = {
  apps: [
    {
      name: 'asmltr-insights-collector',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        ASMLTR_INSIGHTS_PORT: process.env.ASMLTR_INSIGHTS_PORT || '3017',
        // ASMLTR_INSIGHTS_TOKEN: set before exposing the dashboard beyond localhost
        // Optional integrations (tailer/tracker paths) come from .env — see .env.example.
      },
      // logs default to ~/.pm2/logs/asmltr-insights-collector-{out,error}.log
    },
  ],
};
