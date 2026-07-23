require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ─── Contas oficiais (WhatsApp Business Cloud API) ────────────────────────
    // Cada linha é um número de telefone oficial cadastrado no Meta Business
    // Manager. access_token é o token permanente do System User (não o
    // temporário de 24h) — gerado no Meta Business Suite.
    await client.query(`
      CREATE TABLE IF NOT EXISTS contas_oficiais (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        phone_number_id VARCHAR(100) NOT NULL UNIQUE,
        waba_id VARCHAR(100) NOT NULL,
        access_token TEXT NOT NULL,
        numero_display VARCHAR(30),
        status VARCHAR(50) DEFAULT 'ativo',
        limite_diario INTEGER DEFAULT 1000,
        enviados_hoje INTEGER DEFAULT 0,
        total_enviados INTEGER DEFAULT 0,
        qualidade VARCHAR(20),
        ultimo_ping TIMESTAMP,
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    // ─── Templates sincronizados/criados via painel ───────────────────────────
    // Espelha os templates cadastrados na Meta. status reflete o processo de
    // aprovação: PENDING, APPROVED, REJECTED.
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_templates (
        id SERIAL PRIMARY KEY,
        conta_id INTEGER REFERENCES contas_oficiais(id) ON DELETE CASCADE,
        meta_template_id VARCHAR(100),
        nome VARCHAR(255) NOT NULL,
        categoria VARCHAR(30) NOT NULL,
        idioma VARCHAR(10) DEFAULT 'pt_BR',
        status VARCHAR(30) DEFAULT 'PENDING',
        corpo TEXT NOT NULL,
        variaveis JSONB DEFAULT '[]',
        cabecalho_tipo VARCHAR(20),
        cabecalho_texto TEXT,
        rodape TEXT,
        motivo_rejeicao TEXT,
        criado_em TIMESTAMP DEFAULT NOW(),
        atualizado_em TIMESTAMP DEFAULT NOW(),
        UNIQUE(conta_id, nome, idioma)
      );
    `);

    // ─── Campanhas: tipo de envio e vínculo com conta/template oficiais ──────
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS tipo_envio VARCHAR(20) DEFAULT 'baileys'`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS conta_oficial_id INTEGER REFERENCES contas_oficiais(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE campanhas ADD COLUMN IF NOT EXISTS template_id INTEGER REFERENCES whatsapp_templates(id) ON DELETE SET NULL`);

    // ─── Disparos: rastreamento específico da Cloud API ──────────────────────
    await client.query(`ALTER TABLE disparos ADD COLUMN IF NOT EXISTS wamid VARCHAR(150)`); // id da mensagem retornado pela Meta
    await client.query(`ALTER TABLE disparos ADD COLUMN IF NOT EXISTS conta_oficial_id INTEGER REFERENCES contas_oficiais(id) ON DELETE SET NULL`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_templates_conta ON whatsapp_templates(conta_id);
      CREATE INDEX IF NOT EXISTS idx_templates_status ON whatsapp_templates(status);
      CREATE INDEX IF NOT EXISTS idx_campanhas_tipo_envio ON campanhas(tipo_envio);
    `);

    await client.query('COMMIT');
    console.log('✅ Tabelas de API oficial (Cloud API) criadas com sucesso!');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
