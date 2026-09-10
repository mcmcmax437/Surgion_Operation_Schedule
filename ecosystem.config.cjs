module.exports = {
  apps: [
    {
      name: "surgion-schedule-api",
      script: "server/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      min_uptime: "10s",
      exp_backoff_restart_delay: 1000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
