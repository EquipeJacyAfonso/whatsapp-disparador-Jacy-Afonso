require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE chips ADD COLUMN IF NOT EXISTS ultima_campanha_em TIMESTAMP`);
    await client.query(`
      INSERT INTO configuracoes (chave, valor, descricao) VALUES
        ('horario_ativo',          'true', 'Ativar janela de horário de disparo'),
        ('horario_inicio',         '8',    'Hora de início (0-23)'),
        ('horario_fim',            '20',   'Hora de fim (0-23)'),
        ('intervalo_campanhas_min','0',    'Minutos de descanso entre campanhas'),
        ('falhas_ban_threshold',   '3',    'Falhas para pausar chip'),
        ('sync_intervalo',         '0',    'Intervalo sync Sheets (horas)'),
        ('sync_proxima',           '',     'Próxima sincronização')
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
