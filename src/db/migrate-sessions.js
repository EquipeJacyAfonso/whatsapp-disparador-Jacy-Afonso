// Migração: suporte a sessões Baileys no PostgreSQL
// Substitui o armazenamento de credenciais que a Evolution API fazia
// em /evolution/instances (arquivos locais no container).
//
// Uso:
//   node src/db/migrate-sessions.js
//
// É seguro rodar mais de uma vez (idempotente).

require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Tabela principal de sessões ────────────────────────────────────────────
    // Cada chip tem uma linha. O Baileys divide as credenciais em dois objetos:
    //   creds  → chaves de identidade do dispositivo (geradas uma vez, no primeiro QR)
    //   keys   → chaves de sessão por conversa (atualizadas a cada mensagem)
    // Guardamos os dois em JSONB para não precisar parsear nem serializar na mão.
    await client.query(`
      CREATE TABLE IF NOT EXISTS chip_sessions (
        instancia     VARCHAR(255) PRIMARY KEY,
        creds         JSONB,
        keys          JSONB        DEFAULT '{}',
        qrcode_base64 TEXT,
        atualizado_em TIMESTAMP    DEFAULT NOW()
      );
    `);

    // ── Índice de busca por instância (já coberto pela PK, mas explícito) ──────
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_chip_sessions_instancia
      ON chip_sessions (instancia);
    `);

    // ── Coluna qrcode_base64 (caso a tabela já exista sem ela) ────────────────
    // Guarda o QR atual para o painel buscar via polling enquanto aguarda scan.
    await client.query(`
      ALTER TABLE chip_sessions
      ADD COLUMN IF NOT EXISTS qrcode_base64 TEXT;
    `);

    // ── Coluna atualizado_em (idem) ───────────────────────────────────────────
    await client.query(`
      ALTER TABLE chip_sessions
      ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMP DEFAULT NOW();
    `);

    await client.query('COMMIT');

    console.log('✅ Tabela chip_sessions criada/atualizada com sucesso!');
    console.log('   Colunas: instancia · creds · keys · qrcode_base64 · atualizado_em');
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
