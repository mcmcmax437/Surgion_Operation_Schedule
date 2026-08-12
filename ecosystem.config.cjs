module.exports = {
  apps: [
    {
      name: "surgion-schedule-api",
      script: "server/index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
