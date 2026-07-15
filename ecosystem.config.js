module.exports = {
  apps: [
    {
      name: "oktrek",
      script: "./server.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
      log_file: "./logs/combined.log",
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      max_memory_restart: "300M",
      restart_delay: 3000,
    },
  ],
};
