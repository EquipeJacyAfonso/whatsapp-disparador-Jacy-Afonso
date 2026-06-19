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
        delay_min INTEGER DEFAULT 20,
        delay_max INTEGER DEFAULT 50,
        midia_base64 TEXT,
        midia_mimetype VARCHAR(50),
        midia_nome VARCHAR(255),
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
      CREATE TABLE IF NOT EXISTS blacklist (
        id SERIAL PRIMARY KEY,
        numero VARCHAR(20) UNIQUE NOT NULL,
        motivo VARCHAR(255),
        criado_em TIMESTAMP DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chips (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        instancia VARCHAR(255) NOT NULL UNIQUE,
        status VARCHAR(50) DEFAULT 'desconectado',
        enviados_hoje INTEGER DEFAULT 0,
        total_enviados INTEGER DEFAULT 0,
        limite_diario INTEGER DEFAULT 20,
        dias_ativo INTEGER DEFAULT 0,
        pausado_ate TIMESTAMP,
        ultima_campanha_em TIMESTAMP,
        ultimo_uso TIMESTAMP,
        ultimo_ping TIMESTAMP,
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

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_disparos_campanha ON disparos(campanha_id);
      CREATE INDEX IF NOT EXISTS idx_disparos_status ON disparos(status);
      CREATE INDEX IF NOT EXISTS idx_disparos_status_campanha ON disparos(campanha_id, status);
      CREATE INDEX IF NOT EXISTS idx_disparos_enviado_em ON disparos(enviado_em);
      CREATE INDEX IF NOT EXISTS idx_contatos_numero ON contatos(numero);
      CREATE INDEX IF NOT EXISTS idx_contatos_dados ON contatos USING gin(dados);
      CREATE INDEX IF NOT EXISTS idx_chips_status ON chips(status);
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
        ('sheets_credentials', '',                       'JSON da Service Account do Google (conteúdo completo)'),
        ('admin_numero',       '',                       'Número para receber notificações (com DDD)'),
        ('admin_chip_instancia', '',                     'Instância do chip usado para notificações'),
        ('horario_ativo',          'true', 'Ativar janela de horário de disparo'),
        ('horario_inicio',         '8',    'Hora de início do disparo (0-23)'),
        ('horario_fim',            '20',   'Hora de fim do disparo (0-23)'),
        ('intervalo_campanhas_min','0',    'Minutos de descanso entre campanhas por chip'),
        ('falhas_ban_threshold',   '3',    'Falhas seguidas para pausar chip automaticamente'),
        ('sync_intervalo', '0',  'Intervalo de sincronização automática com Sheets (horas)'),
        ('sync_proxima',   '',   'Timestamp da próxima sincronização automática')
      ON CONFLICT (chave) DO NOTHING;
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
