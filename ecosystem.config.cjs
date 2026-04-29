// pm2 process config — used by deploy/oracle-setup.sh
// Run:  pm2 start ecosystem.config.cjs
//       pm2 save
//       pm2 startup   (then run the printed command)

const path = require('path');
const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'greeninvoice-agent',
      script: path.join(ROOT, 'agent', 'index.js'),
      cwd: path.join(ROOT, 'agent'),
      interpreter: 'node',
      // Reload if agent crashes; wait 5 s before restart to avoid tight loops
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 10,
      // Keep only last 7 days of logs, rotate at 10 MB
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(ROOT, 'logs', 'agent-error.log'),
      out_file: path.join(ROOT, 'logs', 'agent-out.log'),
      merge_logs: true,
      // Pass through all env from the shell; .env is loaded by the agent itself
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
