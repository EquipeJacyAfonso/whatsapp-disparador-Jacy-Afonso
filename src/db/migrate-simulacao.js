require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO configuracoes (chave, valor, descricao) VALUES
        ('sim_presenca_ativo',       'true', 'Simular ficar "online" antes de enviar (presença)'),
        ('sim_leitura_ativo',        'true', 'Simular leitura de mensagens antigas antes de enviar'),
        ('sim_conversa_ativo',       'true', 'Simular troca de 2-3 mensagens de aquecimento antes da campanha'),
        ('sim_conversa_chance',      '0.6',  'Chance (0-1) de rodar a simulação completa por contato — evita excesso de tráfego')
      ON CONFLICT (chave) DO NOTHING;
    `);
    console.log('✅ Configs de simulação adicionadas!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
