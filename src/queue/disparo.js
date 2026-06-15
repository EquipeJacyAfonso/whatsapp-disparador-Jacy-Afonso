require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const { enviarMensagem, enviarImagem, proximoChip, registrarUso, registrarFalha, statusChip } = require('../services/evolution');
const { renderTemplate } = require('../services/csv');
const { processarSpintax, verificarCondicoes, processarErroBan, chipEmDescanso, msAteJanelaAbrir } = require('../services/antiban');
const config = require('../services/config');

function delayAleatorio(minMs, maxMs) { return Math.floor(Math.random() * (maxMs - minMs) + minMs); }
async function addLog(nivel, mensagem, dados = null) { try { await pool.query(`INSERT INTO logs (nivel, mensagem, dados) VALUES ($1, $2, $3)`, [nivel, mensagem, dados ? JSON.stringify(dados) : null]); } catch(e) {} }

const disparoQueue = new Bull('disparos', {
  redis: { host: process.env.REDIS_HOST || 'localhost', port: parseInt(process.env.REDIS_PORT || '6379') },
  defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 60000 }, removeOnComplete: 100, removeOnFail: 200 },
});

disparoQueue.on('error', err => console.error('[FILA] Erro:', err.message));
disparoQueue.on('active', job => console.log(`[FILA] Processando #${job.id} → ${job.data.numero}`));
disparoQueue.on('completed', (job, r) => console.log(`[FILA] ✅ #${job.id} via ${r?.chip||'?'}`));
disparoQueue.on('failed', (job, err) => console.error(`[FILA] ❌ #${job.id}: ${err.message}`));

async function limparJobsTravados() {
  try {
    const ativos = await disparoQueue.getActive(); if (!ativos.length) return;
    for (const job of ativos) {
      await job.moveToFailed({ message: 'Servidor reiniciado — job reprocessado' }, true);
      if (job.data?.disparoId) await pool.query(`UPDATE disparos SET status='pendente', erro=NULL WHERE id=$1 AND status NOT IN ('enviado','bloqueado')`, [job.data.disparoId]);
    }
  } catch(e) {}
}

async function verificarChipConectado(chip) {
  try {
    const state = await statusChip(chip.instancia);
    if (state !== 'open') {
      await disparoQueue.pause(); await addLog('alerta', `Chip ${chip.instancia} desconectado. Fila pausada.`, { chipId: chip.id, state });
      throw new Error(`Chip desconectado (${state}).`);
    }
  } catch(e) { if (e.message.includes('desconectado')) throw e; }
}

disparoQueue.process(1, async (job) => {
  const { disparoId, numero, mensagem, campanhaId, delayMin, delayMax, mediaUrl } = job.data;

  try { await verificarCondicoes(); } catch (err) {
    const ms = await msAteJanelaAbrir(); await addLog('info', err.message);
    await disparoQueue.add(job.data, { delay: ms }); return { ok: false, motivo: 'fora_janela' };
  }

  const bl = await pool.query('SELECT 1 FROM blacklist WHERE numero = $1', [numero]);
  if (bl.rows.length) { await pool.query(`UPDATE disparos SET status='bloqueado', erro='Na blacklist' WHERE id=$1`, [disparoId]); return { ok: false, motivo: 'blacklist' }; }

  let chip;
  try { chip = await proximoChip(); if (await chipEmDescanso(chip)) throw new Error(`Chip em descanso.`); await verificarChipConectado(chip); } 
  catch (err) { await pool.query(`UPDATE disparos SET erro=$1 WHERE id=$2`, [err.message, disparoId]); throw err; }

  const mensagemFinal = processarSpintax(mensagem);

  try {
    // A MÁGICA ACONTECE AQUI: Texto ou Imagem?
    if (mediaUrl) {
      await enviarImagem(numero, mensagemFinal, mediaUrl, chip.instancia);
      console.log(`[DISPARO] 📸 Imagem enviada para ${numero}`);
    } else {
      await enviarMensagem(numero, mensagemFinal, chip.instancia);
    }
    
    await registrarUso(chip.id);
    await pool.query(`UPDATE disparos SET status='enviado', enviado_em=NOW(), tentativas=tentativas+1, chip_id=$1 WHERE id=$2`, [chip.id, disparoId]);
    await pool.query(`UPDATE campanhas SET enviados=enviados+1 WHERE id=$1`, [campanhaId]);
    await verificarConclusaoCampanha(campanhaId);

    let delayExtra = 0; if (chip.dias_ativo < 3) delayExtra = delayAleatorio(15000, 30000); 
    const delay = delayAleatorio(delayMin, delayMax) + delayExtra;
    await new Promise(r => setTimeout(r, delay)); return { ok: true, chip: chip.instancia };
  } catch (err) {
    const banDetectado = await processarErroBan(chip.id, chip.instancia, err.message);
    if (banDetectado) await addLog('alerta', `Chip ${chip.instancia} banido`, { numero, campanhaId });

    const threshold = parseInt(await config.get('falhas_ban_threshold', '3'));
    const falhasConsec = await pool.query(`SELECT COUNT(*) FROM disparos WHERE chip_id=$1 AND status='falha' AND criado_em > NOW() - INTERVAL '30 minutes'`, [chip.id]);
    if (parseInt(falhasConsec.rows[0].count) >= threshold && !banDetectado) {
      await pool.query(`UPDATE chips SET pausado_ate=NOW()+INTERVAL '30 minutes' WHERE id=$1`, [chip.id]);
      await addLog('alerta', `Chip pausado por falhas.`);
    }
    await registrarFalha(chip.id);
    await pool.query(`UPDATE disparos SET tentativas=tentativas+1, erro=$1 WHERE id=$2`, [err.message, disparoId]); throw err;
  }
});

disparoQueue.on('failed', async (job, err) => {
  const { disparoId, campanhaId } = job.data;
  if (job.attemptsMade >= job.opts.attempts) {
    await pool.query(`UPDATE disparos SET status='falha', erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await pool.query(`UPDATE campanhas SET falhas=falhas+1 WHERE id=$1`, [campanhaId]);
    await verificarConclusaoCampanha(campanhaId);
  }
});

async function verificarConclusaoCampanha(campanhaId) {
  try {
    const pendentes = await pool.query(`SELECT COUNT(*) FROM disparos WHERE campanha_id=$1 AND status='pendente'`, [campanhaId]);
    if (parseInt(pendentes.rows[0].count) > 0) return; 
    const waiting = await disparoQueue.getWaiting(); if (waiting.filter(j => j.data?.campanhaId === campanhaId).length > 0) return; 
    const camp = await pool.query(`SELECT status FROM campanhas WHERE id=$1`, [campanhaId]);
    if (!camp.rows.length || camp.rows[0].status === 'concluido') return;
    await pool.query(`UPDATE campanhas SET status='concluido', finalizado_em=NOW() WHERE id=$1 AND status='em_andamento'`, [campanhaId]);
    await addLog('info', `Campanha #${campanhaId} concluída.`);
  } catch(e) { }
}

let monitorInterval = null;
function iniciarMonitorChips() {
  if (monitorInterval) return;
  monitorInterval = setInterval(async () => {
    try {
      if (!(await disparoQueue.isPaused()) && (await disparoQueue.getWaitingCount()) > 0) {
        const chips = await pool.query(`SELECT * FROM chips WHERE status='open'`); let todosOffline = true;
        for (const chip of chips.rows) { if (await statusChip(chip.instancia) === 'open') { todosOffline = false; break; } }
        if (todosOffline) { await disparoQueue.pause(); await addLog('alerta', `Fila pausada, chips offline.`); }
      }
    } catch(e) { }
  }, 2 * 60 * 1000); 
}
function pararMonitorChips() { if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; } }

async function enfileirarCampanha(campanhaId, bypassWindow = false) {
  const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [campanhaId]);
  if (!campanha.rows.length) throw new Error('Campanha não encontrada');
  const chips = await pool.query(`SELECT COUNT(*) FROM chips WHERE status='open'`);
  if (parseInt(chips.rows[0].count) === 0) throw new Error('Nenhum chip conectado.');
  if (!bypassWindow) {
    const { dentroDaJanela } = require('../services/antiban');
    if (!(await dentroDaJanela())) throw new Error(`Fora da janela de disparo.`);
  }

  const { template, delay_min, delay_max, media_url } = campanha.rows[0];
  const delayMin = (delay_min || 20) * 1000; const delayMax = (delay_max || 50) * 1000;

  const disparos = await pool.query(`SELECT d.id, c.numero, c.nome, c.dados FROM disparos d JOIN contatos c ON c.id=d.contato_id WHERE d.campanha_id=$1 AND d.status='pendente'`, [campanhaId]);
  if (!disparos.rows.length) throw new Error('Nenhum disparo pendente.');

  for (const row of disparos.rows) {
    const mensagem = renderTemplate(template, { nome: row.nome, numero: row.numero, ...row.dados });
    await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [mensagem, row.id]);
    await disparoQueue.add({ disparoId: row.id, numero: row.numero, mensagem, campanhaId, delayMin, delayMax, mediaUrl: media_url });
  }
  await pool.query(`UPDATE campanhas SET status='em_andamento', iniciado_em=NOW(), data_agendamento=NULL WHERE id=$1`, [campanhaId]);
  return disparos.rows.length;
}

async function pausarCampanha(campanhaId) { await disparoQueue.pause(); await pool.query(`UPDATE campanhas SET status='pausado' WHERE id=$1`, [campanhaId]); }
async function retomar() { const chips = await pool.query(`SELECT COUNT(*) FROM chips WHERE status='open'`); if (parseInt(chips.rows[0].count) === 0) throw new Error('Conecte ao menos um chip.'); await disparoQueue.resume(); }
async function limparFila() { await disparoQueue.empty(); }
async function statusFila() { const [waiting, active, completed, failed] = await Promise.all([ disparoQueue.getWaitingCount(), disparoQueue.getActiveCount(), disparoQueue.getCompletedCount(), disparoQueue.getFailedCount() ]); return { waiting, active, completed, failed }; }

let isScheduling = false;
setInterval(async () => {
  if (isScheduling) return; isScheduling = true;
  try {
    const res = await pool.query(`SELECT id FROM campanhas WHERE status = 'agendado' AND data_agendamento <= NOW()`);
    for (const row of res.rows) {
      try { await enfileirarCampanha(row.id, true); } catch(e) { await pool.query(`UPDATE campanhas SET status='pausado' WHERE id=$1`, [row.id]); }
    }
  } catch (e) { } isScheduling = false;
}, 30000); 

module.exports = {
  enfileirarCampanha, pausarCampanha, retomar, limparFila, statusFila,
  limparJobsTravados, iniciarMonitorChips, pararMonitorChips, verificarConclusaoCampanha, disparoQueue,
};