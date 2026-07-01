// PM2 config for asmltr-core.
// MUST run on the host (not Docker): spawns the local `claude` binary, needs
// ~/.claude subscription auth + host FS + CLAUDE.md + skills. Bind 127.0.0.1.
// Port/URLs come from the environment (see .env.example); defaults below.
module.exports = {
  apps: [
    {
      name: 'asmltr-core',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        ASMLTR_CORE_PORT: process.env.ASMLTR_CORE_PORT || '3023',
        ASMLTR_COLLECTOR_URL: process.env.ASMLTR_COLLECTOR_URL || 'http://127.0.0.1:3017/ingest',
        // NOTE: do NOT set ANTHROPIC_API_KEY here — execution must use the local Claude subscription.
      },
      // logs default to ~/.pm2/logs/asmltr-core-{out,error}.log
    },
  ],
};
