require('dotenv').config();
const pool = require('./index');
const bcrypt = require('bcryptjs');

async function run() {
  const client = await pool.connect();
  try {
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
    await client.query(`
      INSERT INTO configuracoes (chave, valor, descricao)
      VALUES ('jwt_secret', '', 'Chave secreta para tokens JWT')
      ON CONFLICT (chave) DO NOTHING;
    `);
    const existente = await client.query('SELECT COUNT(*) FROM usuarios');
    if (parseInt(existente.rows[0].count) === 0) {
      const senhaHash = await bcrypt.hash('admin123', 12);
      await client.query(
        "INSERT INTO usuarios (nome, email, senha_hash) VALUES ('Administrador', 'admin@disparador.local', $1)",
        [senhaHash]
      );
      console.log('✅ Usuário admin criado! Email: admin@disparador.local / Senha: admin123');
    }
    console.log('✅ Migração de autenticação concluída!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
