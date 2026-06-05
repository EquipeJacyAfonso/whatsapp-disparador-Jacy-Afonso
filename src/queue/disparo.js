require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const { enviarMensagem, proximoChip, registrarUso, registrarFalha } = require('../services/evolution');
const { renderTemplate } = require('../services/csv');
const { processarSpintax, verificarCondicoes, processarErroBan, chipEmDescanso, msAteJanelaAbrir } = require('../services/antiban');
const config = require('../services/config');

function delayAleatorio(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

async function addLog(nivel, mensagem, dados = null) {
  try {
    await pool.query(`INSERT INTO logs (nivel, mensagem, dados) VALUES ($1, $2, $3)`,
      [nivel, mensagem, dados ? JSON.stringify(dados) : null]);
  } catch(e) {}
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

disparoQueue.on('error', err => console.error('[FILA] Erro:', err.message));
disparoQueue.on('active', job => console.log(`[FILA] Processando #${job.id} → ${job.data.numero}`));
disparoQueue.on('completed', (job, r) => console.log(`[FILA] ✅ #${job.id} via ${r?.chip||'?'}`));
disparoQueue.on('failed', (job, err) => console.error(`[FILA] ❌ #${job.id}: ${err.message}`));

disparoQueue.process(1, async (job) => {
  const { disparoId, numero, mensagem, campanhaId, delayMin, delayMax } = job.data;

  // 1. Verifica janela de horário
  try {
    await verificarCondicoes();
  } catch (err) {
    // Fora da janela — adia o job para quando a janela abrir
    const ms = await msAteJanelaAbrir();
    console.log(`[ANTIBAN] ⏰ ${err.message} — adiando job por ${Math.round(ms/1000/60)}min`);
    await addLog('info', err.message);
    // Recoloca na fila com delay
    await disparoQueue.add(job.data, { delay: ms });
    // Marca atual como cancelado para não ser reprocessado
    return { ok: false, motivo: 'fora_janela' };
  }

  // 2. Verifica blacklist
  const bl = await pool.query('SELECT 1 FROM blacklist WHERE numero = $1', [numero]);
  if (bl.rows.length) {
    await pool.query(`UPDATE disparos SET status='bloqueado', erro='Na blacklist' WHERE id=$1`, [disparoId]);
    return { ok: false, motivo: 'blacklist' };
  }

  // 3. Busca chip disponível (já exclui chips em descanso e banidos)
  let chip;
  try {
    chip = await proximoChip();

    // Verifica intervalo entre campanhas
    if (await chipEmDescanso(chip)) {
      throw new Error(`Chip ${chip.nome} em descanso entre campanhas.`);
    }

    console.log(`[DISPARO] Chip: ${chip.nome} (${chip.enviados_hoje}/${chip.limite_diario})`);
  } catch (err) {
    await pool.query(`UPDATE disparos SET erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await addLog('aviso', `Chip indisponível: ${err.message}`);
    throw err;
  }

  // 4. Aplica spintax à mensagem (variação por envio)
  const mensagemFinal = processarSpintax(mensagem);

  // 5. Envia
  try {
    await enviarMensagem(numero, mensagemFinal, chip.instancia);
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
    // Detecta se o erro indica ban
    const banDetectado = await processarErroBan(chip.id, chip.instancia, err.message);
    if (banDetectado) {
      await addLog('alerta', `Chip ${chip.instancia} banido durante disparo`, { numero, campanhaId });
    }

    // Conta falhas consecutivas para pausa automática
    const threshold = parseInt(await config.get('falhas_ban_threshold', '3'));
    const falhasConsec = await pool.query(`
      SELECT COUNT(*) FROM disparos
      WHERE chip_id=$1 AND status='falha'
        AND criado_em > NOW() - INTERVAL '30 minutes'
    `, [chip.id]);

    if (parseInt(falhasConsec.rows[0].count) >= threshold && !banDetectado) {
      const pausaMs = 30 * 60 * 1000; // 30 min
      await pool.query(`UPDATE chips SET pausado_ate=NOW()+INTERVAL '30 minutes' WHERE id=$1`, [chip.id]);
      await addLog('alerta', `Chip ${chip.instancia} pausado por ${threshold} falhas em 30min`);
      console.error(`[ANTIBAN] ⚠ Chip ${chip.instancia} pausado automaticamente (${threshold} falhas)`);
    }

    await registrarFalha(chip.id);
    await pool.query(`UPDATE disparos SET tentativas=tentativas+1, erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await addLog('erro', `Falha ao enviar para ${numero}: ${err.message}`);
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
  if (parseInt(chips.rows[0].count) === 0) throw new Error('Nenhum chip conectado.');

  // Verifica janela antes de enfileirar
  const { dentroDaJanela } = require('../services/antiban');
  const naJanela = await dentroDaJanela();
  if (!naJanela) {
    const { msAteJanelaAbrir: msAte } = require('../services/antiban');
    const ms = await msAte();
    const h = Math.round(ms / 1000 / 60 / 60 * 10) / 10;
    const horaInicio = await config.get('horario_inicio', '8');
    throw new Error(`Fora da janela de disparo. O envio iniciará automaticamente às ${horaInicio}h (${h}h restantes).`);
  }

  const { template, delay_min, delay_max } = campanha.rows[0];
  const cfgMin = parseInt(await config.get('delay_min', '20'));
  const cfgMax = parseInt(await config.get('delay_max', '50'));
  const delayMin = (delay_min || cfgMin) * 1000;
  const delayMax = (delay_max || cfgMax) * 1000;

  const disparos = await pool.query(`
    SELECT d.id, c.numero, c.nome, c.dados FROM disparos d
    JOIN contatos c ON c.id=d.contato_id
    WHERE d.campanha_id=$1 AND d.status='pendente'
  `, [campanhaId]);

  if (!disparos.rows.length) throw new Error('Nenhum disparo pendente.');

  console.log(`[CAMPANHA] Enfileirando ${disparos.rows.length} mensagens...`);
  for (const row of disparos.rows) {
    const dados = { nome: row.nome, numero: row.numero, ...row.dados };
    // Renderiza variáveis do contato — spintax será processado no momento do envio
    const mensagem = renderTemplate(template, dados);
    await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [mensagem, row.id]);
    await disparoQueue.add({ disparoId: row.id, numero: row.numero, mensagem, campanhaId, delayMin, delayMax });
  }

  await pool.query(`UPDATE campanhas SET status='em_andamento', iniciado_em=NOW() WHERE id=$1`, [campanhaId]);
  await addLog('info', `Campanha #${campanhaId} iniciada — ${disparos.rows.length} mensagens.`);
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
