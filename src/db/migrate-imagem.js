require('dotenv').config();
const pool = require('./index');

async function adicionarColunaImagem() {
  try {
    console.log('⏳ Adicionando suporte a imagens no banco de dados...');
    await pool.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS media_url TEXT;`);
    console.log('✅ SUCESSO! A coluna media_url foi adicionada na tabela campanhas.');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await pool.end();
  }
}

adicionarColunaImagem();