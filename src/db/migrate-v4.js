// Execute se o banco já existia: node src/db/migrate-v4.js
require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS blacklist (
        id SERIAL PRIMARY KEY,
        numero VARCHAR(20) UNIQUE NOT NULL,
        motivo VARCHAR(255),
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS chip_historico (
        id SERIAL PRIMARY KEY,
        chip_id INTEGER REFERENCES chips(id) ON DELETE CASCADE,
        data DATE DEFAULT CURRENT_DATE,
        enviados INTEGER DEFAULT 0,
        falhas INTEGER DEFAULT 0,
        UNIQUE(chip_id, data)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracoes (
        chave VARCHAR(100) PRIMARY KEY,
        valor TEXT,
        descricao VARCHAR(255),
        atualizado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        nivel VARCHAR(20) DEFAULT 'info',
        mensagem TEXT,
        dados JSONB,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS limite_diario INTEGER DEFAULT 20`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS dias_ativo INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS pausado_ate TIMESTAMP`);
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS total_enviados INTEGER DEFAULT 0`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS delay_min INTEGER DEFAULT 20`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS delay_max INTEGER DEFAULT 50`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_disparos_status_campanha ON disparos(campanha_id, status);
      CREATE INDEX IF NOT EXISTS idx_disparos_enviado_em ON disparos(enviado_em);
      CREATE INDEX IF NOT EXISTS idx_blacklist_numero ON blacklist(numero);
      CREATE INDEX IF NOT EXISTS idx_logs_criado ON logs(criado_em DESC);
    `);
    await client.query(`
      INSERT INTO configuracoes (chave, valor, descricao) VALUES
        ('evolution_url',      'http://localhost:8080',  'URL da Evolution API'),
        ('evolution_key',      '',                       'Chave de autenticação da Evolution API'),
        ('evolution_instance', 'instancia01',            'Nome da instância padrão'),
        ('delay_min',          '20',                     'Delay mínimo entre mensagens (segundos)'),
        ('delay_max',          '50',                     'Delay máximo entre mensagens (segundos)'),
        ('sheets_id',          '',                       'ID padrão da planilha Google Sheets'),
        ('sheets_range',       'Sheet1!A:Z',             'Range padrão da planilha'),
        ('sheets_credentials', '',                       'JSON da Service Account do Google')
      ON CONFLICT (chave) DO NOTHING;
    `);
    console.log('✅ Migração v4 concluída!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
