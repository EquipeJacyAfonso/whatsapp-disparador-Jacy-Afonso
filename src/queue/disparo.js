require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const { enviarMensagem, proximoChip, registrarUso, registrarFalha, statusChip } = require('../services/evolution');
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

// ─── Fila ─────────────────────────────────────────────────────────────────────

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

async function limparJobsTravados() {
  try {
    const ativos = await disparoQueue.getActive();
    if (!ativos.length) {
      console.log('[FILA] Nenhum job travado encontrado.');
      return;
    }
    console.log(`[FILA] ⚠ ${ativos.length} job(s) travado(s) encontrado(s). Reprocessando...`);
    for (const job of ativos) {
      await job.moveToFailed({ message: 'Servidor reiniciado — job reprocessado' }, true);
      if (job.data?.disparoId) {
        await pool.query(`
          UPDATE disparos SET status='pendente', erro=NULL
          WHERE id=$1 AND status NOT IN ('enviado','bloqueado')
        `, [job.data.disparoId]);
      }
    }
    await addLog('info', `Startup: ${ativos.length} job(s) travado(s) reprocessado(s).`);
    console.log(`[FILA] ✅ Jobs travados limpos.`);
  } catch(e) {
    console.error('[FILA] Erro ao limpar jobs travados:', e.message);
  }
}

async function verificarChipConectado(chip) {
  try {
    const state = await statusChip(chip.instancia);
    if (state !== 'open') {
      await disparoQueue.pause();
      await addLog('alerta',
        `Chip ${chip.instancia} desconectado (${state}). Fila pausada automaticamente.`,
        { chipId: chip.id, state }
      );
      console.error(`[ANTIBAN] ⚠ Chip ${chip.instancia} desconectado (${state}). Fila pausada.`);
      throw new Error(`Chip ${chip.nome} desconectado (${state}). Reconecte e retome a campanha.`);
    }
  } catch(e) {
    if (e.message.includes('desconectado')) throw e;
    console.warn(`[FILA] Aviso: não foi possível verificar status do chip ${chip.instancia}: ${e.message}`);
  }
}

// ─── Processador principal ────────────────────────────────────────────────────

disparoQueue.process(1, async (job) => {
  const { disparoId, numero, mensagem, campanhaId, delayMin, delayMax } = job.data;

  // 1. Verifica janela de horário
  try {
    await verificarCondicoes();
  } catch (err) {
    const ms = await msAteJanelaAbrir();
    console.log(`[ANTIBAN] ⏰ ${err.message} — adiando ${Math.round(ms/1000/60)}min`);
    await addLog('info', err.message);
    await disparoQueue.add(job.data, { delay: ms });
    return { ok: false, motivo: 'fora_janela' };
  }

  // 2. Verifica blacklist
  const bl = await pool.query('SELECT 1 FROM blacklist WHERE numero = $1', [numero]);
  if (bl.rows.length) {
    await pool.query(`UPDATE disparos SET status='bloqueado', erro='Na blacklist' WHERE id=$1`, [disparoId]);
    return { ok: false, motivo: 'blacklist' };
  }

  // 3. Busca chip disponível
  let chip;
  try {
    chip = await proximoChip();
    if (await chipEmDescanso(chip)) {
      throw new Error(`Chip ${chip.nome} em descanso entre campanhas.`);
    }
    await verificarChipConectado(chip);
    console.log(`[DISPARO] Chip: ${chip.nome} (${chip.enviados_hoje}/${chip.limite_diario})`);
  } catch (err) {
    await pool.query(`UPDATE disparos SET erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await addLog('aviso', `Chip indisponível: ${err.message}`);
    throw err;
  }

  // 4. Spintax 
  const mensagemFinal = processarSpintax(mensagem);

  // 5. Envia
  try {
    await enviarMensagem(numero, mensagemFinal, chip.instancia);
    await registrarUso(chip.id);

    await pool.query(`
      UPDATE disparos SET status='enviado', enviado_em=NOW(), tentativas=tentativas+1, chip_id=$1 WHERE id=$2
    `, [chip.id, disparoId]);
    await pool.query(`UPDATE campanhas SET enviados=enviados+1 WHERE id=$1`, [campanhaId]);

    await verificarConclusaoCampanha(campanhaId);

    // 🛡️ ANTI-BAN: Delay Protetor para Chips Novos
    let delayExtra = 0;
    if (chip.dias_ativo < 3) {
      delayExtra = delayAleatorio(15000, 30000); 
      console.log(`[ANTIBAN] 🛡️ Chip muito novo (Dia ${chip.dias_ativo + 1}). Injetado +${Math.round(delayExtra/1000)}s de proteção.`);
    }

    const delay = delayAleatorio(delayMin, delayMax) + delayExtra;
    console.log(`[DISPARO] ✅ ${numero} — próxima mensagem na fila em ${Math.round(delay/1000)}s`);
    
    await new Promise(r => setTimeout(r, delay));
    
    return { ok: true, chip: chip.instancia };

  } catch (err) {
    const banDetectado = await processarErroBan(chip.id, chip.instancia, err.message);
    if (banDetectado) {
      await addLog('alerta', `Chip ${chip.instancia} banido`, { numero, campanhaId });
    }

    const threshold = parseInt(await config.get('falhas_ban_threshold', '3'));
    const falhasConsec = await pool.query(`
      SELECT COUNT(*) FROM disparos
      WHERE chip_id=$1 AND status='falha'
        AND criado_em > NOW() - INTERVAL '30 minutes'
    `, [chip.id]);

    if (parseInt(falhasConsec.rows[0].count) >= threshold && !banDetectado) {
      await pool.query(`UPDATE chips SET pausado_ate=NOW()+INTERVAL '30 minutes' WHERE id=$1`, [chip.id]);
      await addLog('alerta', `Chip ${chip.instancia} pausado por ${threshold} falhas em 30min`);
      console.error(`[ANTIBAN] ⚠ Chip ${chip.instancia} pausado (${threshold} falhas)`);
    }

    await registrarFalha(chip.id);
    await pool.query(`UPDATE disparos SET tentativas=tentativas+1, erro=$1 WHERE id=$2`, [err.message, disparoId]);
    await addLog('erro', `Falha ${numero}: ${err.message}`);
    throw err;
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
    const pendentes = await pool.query(`
      SELECT COUNT(*) FROM disparos
      WHERE campanha_id=$1 AND status='pendente'
    `, [campanhaId]);

    if (parseInt(pendentes.rows[0].count) > 0) return; 

    const waiting = await disparoQueue.getWaiting();
    const jobsDaCampanha = waiting.filter(j => j.data?.campanhaId === campanhaId);
    if (jobsDaCampanha.length > 0) return; 

    const camp = await pool.query(
      `SELECT status FROM campanhas WHERE id=$1`, [campanhaId]
    );
    if (!camp.rows.length || camp.rows[0].status === 'concluido') return;

    await pool.query(`
      UPDATE campanhas
      SET status='concluido', finalizado_em=NOW()
      WHERE id=$1 AND status='em_andamento'
    `, [campanhaId]);

    const stats = await pool.query(
      `SELECT enviados, falhas, total_contatos FROM campanhas WHERE id=$1`, [campanhaId]
    );
    const s = stats.rows[0];
    const msg = `Campanha #${campanhaId} concluída — ${s.enviados} enviados, ${s.falhas} falhas de ${s.total_contatos} contatos.`;
    await addLog('info', msg);
    console.log(`[CAMPANHA] ✅ ${msg}`);
  } catch(e) {
    console.error('[CAMPANHA] Erro ao verificar conclusão:', e.message);
  }
}

let monitorInterval = null;

function iniciarMonitorChips() {
  if (monitorInterval) return;
  monitorInterval = setInterval(async () => {
    try {
      const filaAtiva = !(await disparoQueue.isPaused());
      const waiting = await disparoQueue.getWaitingCount();
      if (!filaAtiva || waiting === 0) return; 

      const chips = await pool.query(`SELECT * FROM chips WHERE status='open'`);
      if (!chips.rows.length) return;

      let todosOffline = true;
      for (const chip of chips.rows) {
        const state = await statusChip(chip.instancia);
        if (state === 'open') { todosOffline = false; break; }
      }

      if (todosOffline && waiting > 0) {
        await disparoQueue.pause();
        await addLog('alerta', `Monitor: todos os chips offline com ${waiting} mensagens na fila. Fila pausada.`);
        console.error(`[MONITOR] ⚠ Todos os chips offline. Fila pausada automaticamente.`);
      }
    } catch(e) {
      console.error('[MONITOR] Erro:', e.message);
    }
  }, 2 * 60 * 1000); 
  console.log('[MONITOR] Monitor de chips iniciado (intervalo: 2min)');
}

function pararMonitorChips() {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

// Atualização: bypassWindow permite ignorar a janela de horário para colocar
// as campanhas agendadas na fila sem erros.
async function enfileirarCampanha(campanhaId, bypassWindow = false) {
  const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [campanhaId]);
  if (!campanha.rows.length) throw new Error('Campanha não encontrada');

  const chips = await pool.query(`SELECT COUNT(*) FROM chips WHERE status='open'`);
  if (parseInt(chips.rows[0].count) === 0) throw new Error('Nenhum chip conectado.');

  if (!bypassWindow) {
    const { dentroDaJanela } = require('../services/antiban');
    if (!(await dentroDaJanela())) {
      const ms = await msAteJanelaAbrir();
      const h = Math.round(ms / 1000 / 60 / 60 * 10) / 10;
      const horaInicio = await config.get('horario_inicio', '8');
      throw new Error(`Fora da janela de disparo. Iniciará automaticamente às ${horaInicio}h (${h}h restantes).`);
    }
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
    const mensagem = renderTemplate(template, dados);
    await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [mensagem, row.id]);
    await disparoQueue.add({ disparoId: row.id, numero: row.numero, mensagem, campanhaId, delayMin, delayMax });
  }

  await pool.query(`UPDATE campanhas SET status='em_andamento', iniciado_em=NOW(), data_agendamento=NULL WHERE id=$1`, [campanhaId]);
  await addLog('info', `Campanha #${campanhaId} iniciada — ${disparos.rows.length} mensagens.`);
  return disparos.rows.length;
}

async function pausarCampanha(campanhaId) {
  await disparoQueue.pause();
  await pool.query(`UPDATE campanhas SET status='pausado' WHERE id=$1`, [campanhaId]);
}

async function retomar() {
  const chips = await pool.query(`SELECT COUNT(*) FROM chips WHERE status='open'`);
  if (parseInt(chips.rows[0].count) === 0) {
    throw new Error('Nenhum chip conectado. Conecte ao menos um chip antes de retomar.');
  }
  await disparoQueue.resume();
}

async function limparFila() { await disparoQueue.empty(); }

async function statusFila() {
  const [waiting, active, completed, failed] = await Promise.all([
    disparoQueue.getWaitingCount(), disparoQueue.getActiveCount(),
    disparoQueue.getCompletedCount(), disparoQueue.getFailedCount(),
  ]);
  return { waiting, active, completed, failed };
}

// ─── Scheduler: Robô de Campanhas Agendadas ──────────────────────────────────
let isScheduling = false;
setInterval(async () => {
  if (isScheduling) return;
  isScheduling = true;
  try {
    const res = await pool.query(`SELECT id FROM campanhas WHERE status = 'agendado' AND data_agendamento <= NOW()`);
    for (const row of res.rows) {
      console.log(`[SCHEDULER] Acordando campanha agendada #${row.id}`);
      try {
         await enfileirarCampanha(row.id, true);
      } catch(e) {
         console.error(`[SCHEDULER] Erro ao iniciar campanha ${row.id}:`, e.message);
         await pool.query(`UPDATE campanhas SET status='pausado' WHERE id=$1`, [row.id]);
         await addLog('erro', `Falha ao arrancar campanha agendada #${row.id}: ${e.message}`);
      }
    }
  } catch (e) { }
  isScheduling = false;
}, 30000); // Acorda e verifica a cada 30 segundos

module.exports = {
  enfileirarCampanha, pausarCampanha, retomar, limparFila, statusFila,
  limparJobsTravados, iniciarMonitorChips, pararMonitorChips,
  verificarConclusaoCampanha, disparoQueue,
};