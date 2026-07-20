require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS pasta VARCHAR(100) DEFAULT ''`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_campanhas_pasta ON campanhas(pasta)`);
    console.log('✅ Coluna "pasta" adicionada em campanhas!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
