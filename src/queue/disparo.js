require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const { enviarMensagem, proximoChip, registrarUso } = require('../services/evolution');
const { renderTemplate } = require('../services/csv');

const DELAY_MIN = parseInt(process.env.DELAY_MIN_SEGUNDOS || '15') * 1000;
const DELAY_MAX = parseInt(process.env.DELAY_MAX_SEGUNDOS || '45') * 1000;

function delayAleatorio() {
  return Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN) + DELAY_MIN);
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

// Processa 1 mensagem por vez para controlar o ritmo
disparoQueue.process(1, async (job) => {
  const { disparoId, numero, mensagem, campanhaId } = job.data;

  // Pega o próximo chip disponível (round-robin por menor uso)
  const chip = await proximoChip();

  try {
    await enviarMensagem(numero, mensagem, chip.instancia);
    await registrarUso(chip.id);

    await pool.query(`
      UPDATE disparos
      SET status = 'enviado', enviado_em = NOW(), tentativas = tentativas + 1, chip_id = $1
      WHERE id = $2
    `, [chip.id, disparoId]);

    await pool.query(`UPDATE campanhas SET enviados = enviados + 1 WHERE id = $1`, [campanhaId]);

    await new Promise(r => setTimeout(r, delayAleatorio()));
    return { ok: true, chip: chip.instancia };
  } catch (err) {
    await pool.query(`
      UPDATE disparos SET tentativas = tentativas + 1, erro = $1 WHERE id = $2
    `, [err.message, disparoId]);
    throw err;
  }
});

disparoQueue.on('failed', async (job, err) => {
  const { disparoId, campanhaId } = job.data;
  if (job.attemptsMade >= job.opts.attempts) {
    await pool.query(`UPDATE disparos SET status = 'falha', erro = $1 WHERE id = $2`, [err.message, disparoId]);
    await pool.query(`UPDATE campanhas SET falhas = falhas + 1 WHERE id = $1`, [campanhaId]);
  }
});

async function enfileirarCampanha(campanhaId) {
  const campanha = await pool.query('SELECT * FROM campanhas WHERE id = $1', [campanhaId]);
  if (!campanha.rows.length) throw new Error('Campanha não encontrada');

  const template = campanha.rows[0].template;

  const disparos = await pool.query(`
    SELECT d.id, c.numero, c.nome, c.dados
    FROM disparos d
    JOIN contatos c ON c.id = d.contato_id
    WHERE d.campanha_id = $1 AND d.status = 'pendente'
  `, [campanhaId]);

  let delay = 0;
  for (const row of disparos.rows) {
    const dados = { nome: row.nome, numero: row.numero, ...row.dados };
    const mensagem = renderTemplate(template, dados);
    await pool.query('UPDATE disparos SET mensagem = $1 WHERE id = $2', [mensagem, row.id]);
    await disparoQueue.add({ disparoId: row.id, numero: row.numero, mensagem, campanhaId }, { delay });
    delay += DELAY_MIN;
  }

  await pool.query(`UPDATE campanhas SET status = 'em_andamento', iniciado_em = NOW() WHERE id = $1`, [campanhaId]);
  return disparos.rows.length;
}

async function pausarCampanha(campanhaId) {
  await disparoQueue.pause();
  await pool.query(`UPDATE campanhas SET status = 'pausado' WHERE id = $1`, [campanhaId]);
}

async function retomar() {
  await disparoQueue.resume();
}

async function statusFila() {
  const [waiting, active, completed, failed] = await Promise.all([
    disparoQueue.getWaitingCount(),
    disparoQueue.getActiveCount(),
    disparoQueue.getCompletedCount(),
    disparoQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

module.exports = { enfileirarCampanha, pausarCampanha, retomar, statusFila, disparoQueue };
