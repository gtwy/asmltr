// PM2 config for the asmltr connector manager.
// Host process: it spawns per-instance child processes (connectors). Bind 127.0.0.1.
// Ports/URLs come from the environment (see .env.example); defaults below.
module.exports = {
  apps: [
    {
      name: 'asmltr-connector-manager',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      kill_timeout: 5000, // give child connectors time to SIGTERM-stop
      env: {
        NODE_ENV: 'production',
        ASMLTR_MANAGER_PORT: process.env.ASMLTR_MANAGER_PORT || '3024',
        ASMLTR_CORE_URL: process.env.ASMLTR_CORE_URL || 'http://127.0.0.1:3023/v2/handle',
        ASMLTR_COLLECTOR_URL: process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest',
      },
      // logs default to ~/.pm2/logs/asmltr-connector-manager-{out,error}.log
    },
  ],
};
