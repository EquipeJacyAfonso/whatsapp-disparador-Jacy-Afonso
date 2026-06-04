// Rode este script se o banco já existia:
// node src/db/migrate-chips.js

require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS limite_diario INTEGER DEFAULT 80`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS dias_ativo INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS criado_em_data DATE DEFAULT CURRENT_DATE`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS pausado_ate TIMESTAMP`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS total_enviados INTEGER DEFAULT 0`);
    console.log('✅ Colunas de proteção adicionadas aos chips!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
