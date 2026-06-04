// Serviço de configurações — lê e salva no banco, com cache em memória
const pool = require('../db');

let cache = {};

async function getAll() {
  const result = await pool.query('SELECT chave, valor FROM configuracoes');
  cache = {};
  result.rows.forEach(r => { cache[r.chave] = r.valor; });
  return cache;
}

async function get(chave, fallback = '') {
  if (cache[chave] !== undefined) return cache[chave];
  const result = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [chave]);
  const val = result.rows[0]?.valor ?? fallback;
  cache[chave] = val;
  return val;
}

async function set(chave, valor) {
  await pool.query(`
    INSERT INTO configuracoes (chave, valor, atualizado_em)
    VALUES ($1, $2, NOW())
    ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = NOW()
  `, [chave, valor]);
  cache[chave] = valor;
}

async function setMany(obj) {
  for (const [chave, valor] of Object.entries(obj)) {
    await set(chave, valor);
  }
}

// Invalida o cache (forçar releitura do banco)
function invalidarCache() { cache = {}; }

module.exports = { get, getAll, set, setMany, invalidarCache };
