require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    // Número do WhatsApp que está de fato conectado nesse chip
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS numero_conectado VARCHAR(20)`);

    // Distingue "aceito pelo servidor" de "confirmado entregue" nos disparos
    await client.query(`ALTER TABLE disparos ADD COLUMN IF NOT EXISTS confirmado_em TIMESTAMP`);
    await client.query(`ALTER TABLE disparos ADD COLUMN IF NOT EXISTS ack_status VARCHAR(30)`);

    console.log('✅ Colunas de confirmação/número adicionadas!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
