// Migração: adiciona a coluna limite_manual em chips.
//
// Problema que resolve: o cron diário de resetarContadoresDiarios()
// recalculava limite_diario pela tabela de aquecimento TODO dia, mesmo
// quando o admin tinha ajustado manualmente o limite no painel (⚙ → limite).
// Isso revertia silenciosamente qualquer configuração manual à meia-noite.
//
// Com limite_manual = true, o cron passa a preservar o valor definido
// manualmente e só continua avançando dias_ativo (para fins de histórico/
// exibição), sem sobrescrever limite_diario.
//
// Uso:
//   node src/db/migrate-limite-manual.js
//
// Idempotente — seguro rodar mais de uma vez.

require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS limite_manual BOOLEAN DEFAULT false`);
    console.log('✅ Coluna "limite_manual" adicionada/verificada em "chips".');
  } catch (err) {
    console.error('❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
