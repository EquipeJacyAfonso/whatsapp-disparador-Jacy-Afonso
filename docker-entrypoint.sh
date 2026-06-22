#!/bin/sh
set -e

echo "[ENTRYPOINT] Aguardando PostgreSQL ficar pronto..."
until node -e "
const { Pool } = require('pg');
const p = new Pool({ host: process.env.DB_HOST, port: process.env.DB_PORT, database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
p.query('SELECT 1').then(() => { p.end(); process.exit(0); }).catch(() => { p.end(); process.exit(1); });
" 2>/dev/null; do
  echo "[ENTRYPOINT] PostgreSQL ainda não pronto — aguardando 2s..."
  sleep 2
done
echo "[ENTRYPOINT] ✅ PostgreSQL pronto"

echo "[ENTRYPOINT] Rodando migrações..."
# Executar todas as migrações em lote
node src/db/run-all-migrations.js
echo "[ENTRYPOINT] ✅ Migrações concluídas"

echo "[ENTRYPOINT] Iniciando servidor..."
exec node src/server.js
