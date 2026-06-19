// node src/db/migrate-auth.js
require('dotenv').config();
const pool = require('./index');
const bcrypt = require('bcryptjs');

async function run() {
  const client = await pool.connect();
  try {
    // Tabela de usuários
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        senha_hash VARCHAR(255) NOT NULL,
        ativo BOOLEAN DEFAULT true,
        criado_em TIMESTAMP DEFAULT NOW(),
        ultimo_acesso TIMESTAMP
      );
    `);

    // Chave JWT no banco de configurações
    await client.query(`
      INSERT INTO configuracoes (chave, valor, descricao)
      VALUES ('jwt_secret', '', 'Chave secreta para tokens JWT (gerada automaticamente)')
      ON CONFLICT (chave) DO NOTHING;
    `);

    // Verifica se já existe algum admin
    const existente = await client.query('SELECT COUNT(*) FROM usuarios');
    if (parseInt(existente.rows[0].count) === 0) {
      const senhaHash = await bcrypt.hash('admin123', 12);
      await client.query(
        "INSERT INTO usuarios (nome, email, senha_hash) VALUES ('Administrador', 'admin@disparador.local', $1)",
        [senhaHash]
      );
      console.log('✅ Usuário admin criado!');
      console.log('   Email: admin@disparador.local');
      console.log('   Senha: admin123');
      console.log('   ⚠ TROQUE A SENHA no primeiro acesso!');
    } else {
      console.log('ℹ Usuários já existem — nenhum admin criado.');
    }

    console.log('✅ Migração de autenticação concluída!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
run();
