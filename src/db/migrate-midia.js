// node src/db/migrate-midia.js
require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS midia_base64 TEXT`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS midia_mimetype VARCHAR(50)`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS midia_nome VARCHAR(255)`);
    console.log('✅ Colunas de mídia adicionadas!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
