require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const { enviarMensagem, enviarImagem, proximoChip, registrarUso, registrarFalha, statusChip } = require('../services/whatsapp/manager');
const { renderTemplate } = require('../services/csv');
const { processarSpintax, verificarCondicoes, processarErroBan, chipEmDescanso, msAteJanelaAbrir, registrarFimCampanhaChip } = require('../services/antiban');
const config = require('../services/config');

function delayAleatorio(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

async function addLog(nivel, mensagem, dados) {
  try {
    await pool.query('INSERT INTO logs (nivel, mensagem, dados) VALUES ($1, $2, $3)',
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
disparoQueue.on('active', job => console.log('[FILA] Processando #' + job.id + ' → ' + job.data.numero));
disparoQueue.on('completed', (job, r) => {
  if (r && r.ok === false) {
    console.log('[FILA] ⚠ #' + job.id + ' finalizado sem sucesso (' + (r.motivo || '?') + ')');
  } else {
    console.log('[FILA] ✅ #' + job.id + ' via ' + (r && r.chip || '?'));
  }
});
disparoQueue.on('failed', (job, err) => console.error('[FILA] ❌ #' + job.id + ': ' + err.message));

// ─── Cleanup de jobs travados no startup ──────────────────────────────────────
async function limparJobsTravados() {
  try {
    const ativos = await disparoQueue.getActive();
    if (!ativos.length) { console.log('[FILA] Nenhum job travado.'); return; }
    console.log('[FILA] ⚠ ' + ativos.length + ' job(s) travado(s). Reprocessando...');
    for (const job of ativos) {
      await job.moveToFailed({ message: 'Servidor reiniciado' }, true);
      if (job.data && job.data.disparoId) {
        await pool.query(
          "UPDATE disparos SET status='pendente', erro=NULL WHERE id=$1 AND status NOT IN ('enviado','bloqueado')",
          [job.data.disparoId]
        );
      }
    }
    await addLog('info', 'Startup: ' + ativos.length + ' job(s) travado(s) reprocessado(s).');
    console.log('[FILA] ✅ Jobs travados limpos.');
  } catch(e) {
    console.error('[FILA] Erro ao limpar jobs travados:', e.message);
  }
}

// ─── Verificação de chip conectado ────────────────────────────────────────────

// ─── Circuit breaker — desliga campanha sozinha se detectar falha sistêmica ───
// Diferente do controle de "falhas por chip" (antiban): aqui o sinal é
// "N falhas seguidas SEM nenhum envio confirmado" numa campanha — isso indica
// bug de configuração/payload/API fora do ar, não números ruins isolados.
// Evita queimar a lista inteira de contatos com o mesmo erro repetido.
const CIRCUIT_BREAKER_MIN_FALHAS = 3;

async function verificarCircuitBreaker(campanhaId, erroDetalhe) {
  try {
    const camp = await pool.query('SELECT status, enviados, falhas FROM campanhas WHERE id=$1', [campanhaId]);
    if (!camp.rows.length) return;
    const c = camp.rows[0];
    if (c.status !== 'em_andamento') return; // já pausada/concluída — nada a fazer
    if (c.enviados > 0) return; // já teve pelo menos 1 sucesso — não é falha sistêmica
    if (c.falhas < CIRCUIT_BREAKER_MIN_FALHAS) return;

    await disparoQueue.pause();
    await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanhaId]);

    const msg = 'Campanha #' + campanhaId + ' pausada automaticamente: ' + c.falhas +
      ' falhas seguidas sem nenhum envio confirmado. Último erro: ' + erroDetalhe;
    await addLog('alerta', msg);
    console.error('[CIRCUIT-BREAKER] ⚠ ' + msg);

    try {
      const { notificarFalhaSistemica } = require('../services/notificacoes');
      await notificarFalhaSistemica(campanhaId, erroDetalhe);
    } catch (e) { /* notificação é best-effort */ }
  } catch (e) {
    console.error('[CIRCUIT-BREAKER] Erro ao verificar:', e.message);
  }
}

// ─── Processador principal ────────────────────────────────────────────────────

disparoQueue.process(1, async (job) => {
  const { disparoId, numero, mensagem, campanhaId, delayMin, delayMax, midiaBase64, midiaMimetype, midiaNome } = job.data;

  // 1. Janela de horário
  try {
    await verificarCondicoes();
  } catch (err) {
    const ms = await msAteJanelaAbrir();
    console.log('[ANTIBAN] ⏰ ' + err.message + ' — adiando ' + Math.round(ms/1000/60) + 'min');
    await addLog('info', err.message);
    await disparoQueue.add(job.data, { delay: ms });
    return { ok: false, motivo: 'fora_janela' };
  }

  // 2. Blacklist — normaliza o número para garantir mesmo formato do cadastro
  const { formatarNumero } = require('../services/whatsapp/manager');
  const numeroNorm = formatarNumero(numero);
  const bl = await pool.query('SELECT 1 FROM blacklist WHERE numero = $1', [numeroNorm]);
  if (bl.rows.length) {
    await pool.query("UPDATE disparos SET status='bloqueado', erro='Na blacklist' WHERE id=$1", [disparoId]);
    return { ok: false, motivo: 'blacklist' };
  }

  // 3. Chip disponível
  let chip;
  try {
    chip = await proximoChip();
    if (await chipEmDescanso(chip)) throw new Error('Chip ' + chip.nome + ' em descanso entre campanhas.');
    console.log('[DISPARO] Chip: ' + chip.nome + ' (' + chip.enviados_hoje + '/' + chip.limite_diario + ')');
  } catch (err) {
    await pool.query('UPDATE disparos SET erro=$1 WHERE id=$2', [err.message, disparoId]);
    await addLog('aviso', 'Chip indisponível: ' + err.message);
    throw err;
  }

  // 4. Spintax (processado uma única vez aqui)
  const mensagemFinal = processarSpintax(mensagem);

  // 5. Envia — texto ou imagem dependendo da campanha
  try {
    if (midiaBase64) {
      // Campanha com imagem: texto vai como legenda
      await enviarImagem(numero, mensagemFinal, chip.instancia, midiaBase64, midiaMimetype, midiaNome);
    } else {
      // Campanha só com texto
      await enviarMensagem(numero, mensagemFinal, chip.instancia);
    }

    await registrarUso(chip.id);
    await pool.query(
      "UPDATE disparos SET status='enviado', enviado_em=NOW(), tentativas=tentativas+1, chip_id=$1 WHERE id=$2",
      [chip.id, disparoId]
    );
    await pool.query('UPDATE campanhas SET enviados=enviados+1 WHERE id=$1', [campanhaId]);
    await verificarConclusaoCampanha(campanhaId);

    const delay = delayAleatorio(delayMin, delayMax);
    console.log('[DISPARO] ✅ ' + numero + ' — próxima em ' + Math.round(delay/1000) + 's');
    await new Promise(r => setTimeout(r, delay));
    return { ok: true, chip: chip.instancia };

  } catch (err) {
    const banDetectado = await processarErroBan(chip.id, chip.instancia, err.message);
    if (banDetectado) await addLog('alerta', 'Chip ' + chip.instancia + ' banido', { numero, campanhaId });

    const threshold = parseInt(await config.get('falhas_ban_threshold', '3'));
    const falhasConsec = await pool.query(
      "SELECT COUNT(*) FROM disparos WHERE chip_id=$1 AND status='falha' AND criado_em > NOW() - INTERVAL '30 minutes'",
      [chip.id]
    );
    if (parseInt(falhasConsec.rows[0].count) >= threshold && !banDetectado) {
      await pool.query("UPDATE chips SET pausado_ate=NOW()+INTERVAL '30 minutes' WHERE id=$1", [chip.id]);
      await addLog('alerta', 'Chip ' + chip.instancia + ' pausado por ' + threshold + ' falhas em 30min');
    }

    await registrarFalha(chip.id);

    if (err.semRetry) {
      // Erro permanente (ex: 400 de formato de payload) — tentar de novo não resolve.
      // Marca como falha definitiva direto, sem gastar os 3 reenvios com backoff.
      await pool.query(
        "UPDATE disparos SET status='falha', tentativas=tentativas+1, erro=$1 WHERE id=$2",
        [err.message, disparoId]
      );
      await pool.query('UPDATE campanhas SET falhas=falhas+1 WHERE id=$1', [campanhaId]);
      await addLog('erro', 'Falha definitiva (sem retry) ' + numero + ': ' + err.message);
      await verificarConclusaoCampanha(campanhaId);
      await verificarCircuitBreaker(campanhaId, err.message);
      return { ok: false, motivo: 'erro_permanente', erro: err.message };
    }

    await pool.query('UPDATE disparos SET tentativas=tentativas+1, erro=$1 WHERE id=$2', [err.message, disparoId]);
    await addLog('erro', 'Falha ' + numero + ': ' + err.message);
    throw err;
  }
});

disparoQueue.on('failed', async (job, err) => {
  const { disparoId, campanhaId } = job.data;
  if (job.attemptsMade >= job.opts.attempts) {
    await pool.query("UPDATE disparos SET status='falha', erro=$1 WHERE id=$2", [err.message, disparoId]);
    await pool.query('UPDATE campanhas SET falhas=falhas+1 WHERE id=$1', [campanhaId]);
    await verificarConclusaoCampanha(campanhaId);
    await verificarCircuitBreaker(campanhaId, err.message);
  }
});

// ─── Conclusão automática de campanhas ───────────────────────────────────────
async function verificarConclusaoCampanha(campanhaId) {
  try {
    const pendentes = await pool.query(
      "SELECT COUNT(*) FROM disparos WHERE campanha_id=$1 AND status='pendente'", [campanhaId]
    );
    if (parseInt(pendentes.rows[0].count) > 0) return;

    const waiting = await disparoQueue.getWaiting();
    if (waiting.filter(j => j.data && j.data.campanhaId === campanhaId).length > 0) return;

    const camp = await pool.query('SELECT status FROM campanhas WHERE id=$1', [campanhaId]);
    if (!camp.rows.length || camp.rows[0].status === 'concluido') return;

    await pool.query(
      "UPDATE campanhas SET status='concluido', finalizado_em=NOW() WHERE id=$1 AND status='em_andamento'",
      [campanhaId]
    );

    // Registra fim de campanha em cada chip usado — habilita o descanso inter-campanha (Anti-ban)
    try {
      const chipsUsados = await pool.query(
        "SELECT DISTINCT chip_id FROM disparos WHERE campanha_id=$1 AND chip_id IS NOT NULL",
        [campanhaId]
      );
      for (const row of chipsUsados.rows) {
        await registrarFimCampanhaChip(row.chip_id);
      }
    } catch(e2) { /* não bloqueia a conclusão da campanha */ }

    const stats = await pool.query('SELECT enviados, falhas, total_contatos FROM campanhas WHERE id=$1', [campanhaId]);
    const s = stats.rows[0];
    const msg = 'Campanha #' + campanhaId + ' concluída — ' + s.enviados + ' enviados, ' + s.falhas + ' falhas de ' + s.total_contatos + ' contatos.';
    await addLog('info', msg);
    console.log('[CAMPANHA] ✅ ' + msg);

    // Notificação WhatsApp (best-effort)
    try {
      const { notificarCampanhaConcluida } = require('../services/notificacoes');
      await notificarCampanhaConcluida(campanhaId);
    } catch(e2) { /* notificação é best-effort */ }

  } catch(e) {
    console.error('[CAMPANHA] Erro ao verificar conclusão:', e.message);
  }
}

// ─── Monitor de chips ─────────────────────────────────────────────────────────
let monitorInterval = null;

function iniciarMonitorChips() {
  if (monitorInterval) return;
  monitorInterval = setInterval(async () => {
    try {
      const filaAtiva = !(await disparoQueue.isPaused());
      const waiting = await disparoQueue.getWaitingCount();
      if (!filaAtiva || waiting === 0) return;
      const chips = await pool.query("SELECT * FROM chips WHERE status='open'");
      if (!chips.rows.length) return;
      let todosOffline = true;
      for (const chip of chips.rows) {
        const state = await statusChip(chip.instancia);
        if (state === 'open') { todosOffline = false; break; }
      }
      if (todosOffline && waiting > 0) {
        await disparoQueue.pause();
        await addLog('alerta', 'Monitor: todos os chips offline com ' + waiting + ' mensagens na fila. Fila pausada.');
        console.error('[MONITOR] ⚠ Todos os chips offline. Fila pausada.');
      }
    } catch(e) { console.error('[MONITOR] Erro:', e.message); }
  }, 2 * 60 * 1000);
  console.log('[MONITOR] Monitor de chips iniciado (2min)');
}

function pararMonitorChips() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
}

// ─── API pública ──────────────────────────────────────────────────────────────

async function enfileirarCampanha(campanhaId) {
  const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [campanhaId]);
  if (!campanha.rows.length) throw new Error('Campanha não encontrada');

  const chips = await pool.query("SELECT COUNT(*) FROM chips WHERE status='open'");
  if (parseInt(chips.rows[0].count) === 0) throw new Error('Nenhum chip conectado.');

  const { dentroDaJanela } = require('../services/antiban');
  if (!(await dentroDaJanela())) {
    const ms = await msAteJanelaAbrir();
    const h = Math.round(ms / 1000 / 60 / 60 * 10) / 10;
    const horaInicio = await config.get('horario_inicio', '8');
    throw new Error('Fora da janela de disparo. Iniciará às ' + horaInicio + 'h (' + h + 'h restantes).');
  }

  const { template, delay_min, delay_max, midia_base64, midia_mimetype, midia_nome } = campanha.rows[0];
  const cfgMin = parseInt(await config.get('delay_min', '20'));
  const cfgMax = parseInt(await config.get('delay_max', '50'));
  const delayMin = (delay_min || cfgMin) * 1000;
  const delayMax = (delay_max || cfgMax) * 1000;

  const disparos = await pool.query(
    'SELECT d.id, c.numero, c.nome, c.dados FROM disparos d JOIN contatos c ON c.id=d.contato_id WHERE d.campanha_id=$1 AND d.status=\'pendente\'',
    [campanhaId]
  );
  if (!disparos.rows.length) throw new Error('Nenhum disparo pendente.');

  // Bug 6: bloqueia re-enfileiramento se já houver jobs aguardando para esta campanha
  // (evita envio duplicado ao clicar Iniciar numa campanha que foi pausada)
  const jobsEsperando = await disparoQueue.getWaiting();
  const jobsDaCampanha = jobsEsperando.filter(j => j.data && j.data.campanhaId === campanhaId);
  if (jobsDaCampanha.length > 0) {
    throw new Error('Campanha já tem ' + jobsDaCampanha.length + ' mensagens na fila. Use o botão Retomar em vez de Iniciar.');
  }

  console.log('[CAMPANHA] Enfileirando ' + disparos.rows.length + ' mensagens...');
  for (const row of disparos.rows) {
    const dados = Object.assign({ nome: row.nome, numero: row.numero }, row.dados);
    const mensagem = renderTemplate(template, dados);
    await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [mensagem, row.id]);
    await disparoQueue.add({
      disparoId: row.id,
      numero: row.numero,
      mensagem,
      campanhaId,
      delayMin,
      delayMax,
      midiaBase64: midia_base64 || null,
      midiaMimetype: midia_mimetype || null,
      midiaNome: midia_nome || null,
    });
  }

  await pool.query("UPDATE campanhas SET status='em_andamento', iniciado_em=NOW() WHERE id=$1", [campanhaId]);
  await addLog('info', 'Campanha #' + campanhaId + ' iniciada — ' + disparos.rows.length + ' mensagens.');
  return disparos.rows.length;
}

async function pausarCampanha(campanhaId) {
  await disparoQueue.pause();
  await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanhaId]);
}

async function retomar() {
  const chips = await pool.query("SELECT COUNT(*) FROM chips WHERE status='open'");
  if (parseInt(chips.rows[0].count) === 0) throw new Error('Nenhum chip conectado. Conecte ao menos um antes de retomar.');
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

module.exports = {
  enfileirarCampanha, pausarCampanha, retomar, limparFila, statusFila,
  limparJobsTravados, iniciarMonitorChips, pararMonitorChips,
  verificarConclusaoCampanha, disparoQueue,
};
