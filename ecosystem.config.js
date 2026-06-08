module.exports = {
  apps: [{
    name: 'disparador',
    script: 'src/server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
    error_file: '/var/log/disparador/error.log',
    out_file: '/var/log/disparador/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
