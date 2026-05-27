require('dotenv').config();
const pool = require('./index');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS campanhas (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        template TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'rascunho',
        total_contatos INTEGER DEFAULT 0,
        enviados INTEGER DEFAULT 0,
        falhas INTEGER DEFAULT 0,
        criado_em TIMESTAMP DEFAULT NOW(),
        iniciado_em TIMESTAMP,
        finalizado_em TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS contatos (
        id SERIAL PRIMARY KEY,
        numero VARCHAR(20) NOT NULL,
        nome VARCHAR(255),
        dados JSONB DEFAULT '{}',
        criado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(numero)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chips (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        instancia VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) DEFAULT 'desconectado',
        enviados_hoje INTEGER DEFAULT 0,
        ultimo_uso TIMESTAMP,
        ultimo_ping TIMESTAMP,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS disparos (
        id SERIAL PRIMARY KEY,
        campanha_id INTEGER REFERENCES campanhas(id) ON DELETE CASCADE,
        contato_id INTEGER REFERENCES contatos(id) ON DELETE CASCADE,
        chip_id INTEGER REFERENCES chips(id) ON DELETE SET NULL,
        mensagem TEXT,
        status VARCHAR(50) DEFAULT 'pendente',
        tentativas INTEGER DEFAULT 0,
        erro TEXT,
        enviado_em TIMESTAMP,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_disparos_campanha ON disparos(campanha_id);
      CREATE INDEX IF NOT EXISTS idx_disparos_status ON disparos(status);
      CREATE INDEX IF NOT EXISTS idx_contatos_numero ON contatos(numero);
      CREATE INDEX IF NOT EXISTS idx_chips_status ON chips(status);
    `);

    await client.query('COMMIT');
    console.log('✅ Banco de dados configurado com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
