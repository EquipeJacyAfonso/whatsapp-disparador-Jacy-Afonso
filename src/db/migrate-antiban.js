// node src/db/migrate-antiban.js
require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS ultima_campanha_em TIMESTAMP`);

    await client.query(`
      INSERT INTO configuracoes (chave, valor, descricao) VALUES
        ('horario_ativo',          'true', 'Ativar janela de horário de disparo'),
        ('horario_inicio',         '8',    'Hora de início do disparo (0-23)'),
        ('horario_fim',            '20',   'Hora de fim do disparo (0-23)'),
        ('intervalo_campanhas_min','0',    'Minutos de descanso entre campanhas por chip (0 = desativado)'),
        ('falhas_ban_threshold',   '3',    'Quantidade de falhas seguidas para pausar chip automaticamente')
      ON CONFLICT (chave) DO NOTHING;
    `);

    console.log('✅ Migração anti-ban concluída!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
