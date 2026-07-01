require('dotenv').config();
const pool = require('./index');
async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS delay_min INTEGER DEFAULT 20`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS delay_max INTEGER DEFAULT 50`);
    console.log('✅ Colunas delay_min e delay_max adicionadas!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
