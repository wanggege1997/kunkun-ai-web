module.exports = {
  apps: [
    {
      name: "kunkunai",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: "/www/wwwroot/kunkunai.top",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      time: true,
    },
  ],
};
