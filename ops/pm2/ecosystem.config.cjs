/**
 * =============================================
 * Web2App Studio - PM2 Ecosystem Configuration
 * =============================================
 * Production process manager config.
 *
 * Jalankan:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save            # save current process list
 *   pm2 startup         # generate systemd unit
 *
 * Common commands:
 *   pm2 ls              # list processes
 *   pm2 logs            # tail all logs
 *   pm2 logs web2app-api
 *   pm2 monit           # real-time monitoring
 *   pm2 restart all
 *   pm2 reload all      # zero-downtime reload
 *   pm2 stop all
 *   pm2 delete all
 * =============================================
 */

const path = require('path');

const APP_DIR = '/var/www/web2app-studio';
const NODE_PATH = '/usr/bin/node';

module.exports = {
  apps: [
    // ===========================================
    // [1] API SERVER (main backend)
    // ===========================================
    {
      name: 'web2app-api',
      script: path.join(APP_DIR, 'api/src/server.js'),
      interpreter: NODE_PATH,
      cwd: path.join(APP_DIR, 'api'),

      // Instances & mode
      instances: 1,                  // 1 instance cukup untuk MVP; naik ke 'max' untuk cluster
      exec_mode: 'fork',             // 'fork' (default) atau 'cluster'

      // Environment
      env: {
        NODE_ENV: 'production',
      },
      env_production: {
        NODE_ENV: 'production',
      },

      // Auto-restart
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '500M',

      // Logging
      log_file: '/var/log/pm2/web2app-api.log',
      error_file: '/var/log/pm2/web2app-api.error.log',
      out_file: '/var/log/pm2/web2app-api.out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // Misc
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 8000,
    },

    // ===========================================
    // [2] BUILD WORKER (background job processor)
    // ===========================================
    {
      name: 'web2app-worker',
      script: path.join(APP_DIR, 'api/src/workers/build.worker.js'),
      interpreter: NODE_PATH,
      cwd: path.join(APP_DIR, 'api'),

      instances: 1,                  // Naikkan untuk parallel processing
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
      },

      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      max_memory_restart: '1G',     // Worker lebih boros memory (Capacitor + Gradle)

      log_file: '/var/log/pm2/web2app-worker.log',
      error_file: '/var/log/pm2/web2app-worker.error.log',
      out_file: '/var/log/pm2/web2app-worker.out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],

  // =============================================
  // DEPLOYMENT (opsional, untuk CI/CD)
  // =============================================
  deploy: {
    production: {
      user: 'webapp',
      host: 'ssh://webapp@web2appstudio.my.id',
      ref: 'origin/main',
      repo: 'git@github.com:YOUR_USERNAME/web2app-studio.git',
      path: APP_DIR,
      'pre-deploy': 'git fetch --all',
      'post-deploy':
        'cd api && npm ci --only=production && pm2 reload ecosystem.config.cjs',
      'pre-setup': '',
    },
  },
};
