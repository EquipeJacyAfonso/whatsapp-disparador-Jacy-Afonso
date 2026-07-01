require('dotenv').config();
const pool = require('../db');

async function checkPostgres() {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    return { ok: true, latencia: Date.now() - start + 'ms' };
  } catch(e) { return { ok: false, erro: e.message }; }
}

async function checkRedis() {
  try {
    const Redis = require('ioredis');
    const redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379'),
      connectTimeout: 3000, lazyConnect: true,
    });
    const start = Date.now();
    await redis.connect(); await redis.ping(); await redis.quit();
    return { ok: true, latencia: Date.now() - start + 'ms' };
  } catch(e) { return { ok: false, erro: e.message }; }
}

async function checkChips() {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='open') AS conectados,
        COUNT(*) FILTER (WHERE status='banido') AS banidos,
        COUNT(*) FILTER (WHERE status='desconectado' OR status='erro') AS desconectados,
        COUNT(*) AS total
      FROM chips
    `);
    const r = result.rows[0];
    return {
      ok: true,
      conectados: parseInt(r.conectados), banidos: parseInt(r.banidos),
      desconectados: parseInt(r.desconectados), total: parseInt(r.total),
    };
  } catch(e) { return { ok: false, erro: e.message }; }
}

async function checkFila() {
  try {
    const { statusFila } = require('../queue/disparo');
    const fila = await statusFila();
    return { ok: true, ...fila };
  } catch(e) { return { ok: false, erro: e.message }; }
}

async function checkGeral() {
  const [postgres, redis, chips, fila] = await Promise.all([
    checkPostgres(), checkRedis(), checkChips(), checkFila(),
  ]);
  const tudo_ok = postgres.ok && redis.ok;
  return {
    status: tudo_ok ? 'ok' : 'degradado',
    timestamp: new Date().toISOString(),
    versao: require('../../package.json').version,
    servicos: { postgres, redis, chips, fila },
  };
}

async function verificarStartup() {
  console.log('\n[HEALTH] Verificando dependências...');
  const postgres = await checkPostgres();
  if (!postgres.ok) {
    console.error('[HEALTH] ❌ PostgreSQL: ' + postgres.erro);
    process.exit(1);
  }
  console.log('[HEALTH] ✅ PostgreSQL OK (' + postgres.latencia + ')');
  const redis = await checkRedis();
  if (!redis.ok) {
    console.error('[HEALTH] ❌ Redis: ' + redis.erro);
    process.exit(1);
  }
  console.log('[HEALTH] ✅ Redis OK (' + redis.latencia + ')');
  console.log('[HEALTH] Sistema pronto.\n');
}

module.exports = { checkGeral, verificarStartup, checkPostgres, checkRedis, checkChips };
