require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const { enviarMensagem, proximoChip, registrarUso, registrarFalha } = require('../services/evolution');
const { renderTemplate } = require('../services/csv');
const config = require('../services/config');

function delayAleatorio(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

const disparoQueue = new Bull('disparos', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 60000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

async function addLog(nivel, mensagem, dados = null) {
  try {
    await pool.query(
      `INSERT INTO logs (nivel, mensagem, dados) VALUES ($1, $2, $3)`,
      [nivel, mensagem, dados ? JSON.stringify(dados) : null]
    );
  } catch(e) {}
}

disparoQueue.on('error', err => console.error('[FILA] Erro:', err.message));
disparoQueue.on('active', job => console.log(`[FILA] Processando #${job.id} → ${job.data.numero}`));
disparoQueue.on('completed', (job, r) => console.log(`[FILA] ✅ #${job.id} enviado via ${r?.chip||'?'}`));
disparoQueue.on('failed', (job, err) => console.error(`[FILA] ❌ #${job.id} (t${job.attemptsMade}): ${err.message}`));

disparoQueue.process(1, async (job) => {
  const { disparoId, numero, mensagem, campanhaId, delayMin, delayMax } = job.data;

  // Verifica blacklist em tempo real
  const bl = await pool.query('SELECT 1 FROM blacklist WHERE numero = $1', [numero]);
  if (bl.rows.length) {
    await pool.query(`UPDATE disparos SET status = 'bloqueado', erro = 'Na blacklist' WHERE id = $1`, [disparoId]);
    return { ok: false, motivo: 'blacklist' };
  }

  let chip;
  try {
    chip = await proximoChip();
    console.log(`[DISPARO] Chip: ${chip.nome} (${chip.enviados_hoje}/${chip.limite_diario})`);
  } catch (err) {
    await pool.query(`UPDATE disparos SET erro = $1 WHERE id = $2`, [err.message, disparoId]);
    await addLog('erro', `Sem chip disponível: ${err.message}`);
    throw err;
  }

  try {
    await enviarMensagem(numero, mensagem, chip.instancia);
    await registrarUso(chip.id);
    await pool.query(`
      UPDATE disparos SET status='enviado', enviado_em=NOW(), tentativas=tentativas+1, chip_id=$1 WHERE id=$2
    `, [chip.id, disparoId]);
    await pool.query(`UPDATE campanhas SET enviados=enviados+1 WHERE id=$1`, [campanhaId]);

    const delay = delayAleatorio(delayMin, delayMax);
    console.log(`[DISPARO] ✅ ${numero} — próxima em ${Math.round(delay/1000)}s`);
    await new Promise(r => setTimeout(r, delay));
    return { ok: true, chip: chip.instancia };
  } catch (err) {
    await registrarFalha(chip.id);
    await pool.query(`UPDATE disparos SET tentativas=tentativas+1, erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await addLog('erro', `Falha ao enviar para ${numero}: ${err.message}`, { disparoId, campanhaId });
    throw err;
  }
});

disparoQueue.on('failed', async (job, err) => {
  const { disparoId, campanhaId } = job.data;
  if (job.attemptsMade >= job.opts.attempts) {
    await pool.query(`UPDATE disparos SET status='falha', erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await pool.query(`UPDATE campanhas SET falhas=falhas+1 WHERE id=$1`, [campanhaId]);
  }
});

async function enfileirarCampanha(campanhaId) {
  const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [campanhaId]);
  if (!campanha.rows.length) throw new Error('Campanha não encontrada');

  const chips = await pool.query(`SELECT COUNT(*) FROM chips WHERE status='open'`);
  if (parseInt(chips.rows[0].count) === 0) throw new Error('Nenhum chip conectado. Conecte ao menos um chip.');

  const { template, delay_min, delay_max } = campanha.rows[0];

  // Usa delay da campanha ou das configurações do sistema
  const cfgMin = parseInt(await config.get('delay_min', '20'));
  const cfgMax = parseInt(await config.get('delay_max', '50'));
  const delayMin = ((delay_min || cfgMin) * 1000);
  const delayMax = ((delay_max || cfgMax) * 1000);

  const disparos = await pool.query(`
    SELECT d.id, c.numero, c.nome, c.dados FROM disparos d
    JOIN contatos c ON c.id = d.contato_id
    WHERE d.campanha_id=$1 AND d.status='pendente'
  `, [campanhaId]);

  if (!disparos.rows.length) throw new Error('Nenhum disparo pendente.');

  console.log(`[CAMPANHA] Enfileirando ${disparos.rows.length} mensagens...`);
  for (const row of disparos.rows) {
    const dados = { nome: row.nome, numero: row.numero, ...row.dados };
    const mensagem = renderTemplate(template, dados);
    await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [mensagem, row.id]);
    await disparoQueue.add({ disparoId: row.id, numero: row.numero, mensagem, campanhaId, delayMin, delayMax });
  }

  await pool.query(`UPDATE campanhas SET status='em_andamento', iniciado_em=NOW() WHERE id=$1`, [campanhaId]);
  await addLog('info', `Campanha #${campanhaId} iniciada com ${disparos.rows.length} mensagens.`);
  return disparos.rows.length;
}

async function pausarCampanha(campanhaId) {
  await disparoQueue.pause();
  await pool.query(`UPDATE campanhas SET status='pausado' WHERE id=$1`, [campanhaId]);
}

async function retomar() { await disparoQueue.resume(); }
async function limparFila() { await disparoQueue.empty(); }

async function statusFila() {
  const [waiting, active, completed, failed] = await Promise.all([
    disparoQueue.getWaitingCount(), disparoQueue.getActiveCount(),
    disparoQueue.getCompletedCount(), disparoQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

module.exports = { enfileirarCampanha, pausarCampanha, retomar, limparFila, statusFila, disparoQueue };
