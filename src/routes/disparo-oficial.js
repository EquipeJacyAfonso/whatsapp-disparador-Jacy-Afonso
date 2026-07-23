// Processador de fila para campanhas enviadas via WhatsApp Business Cloud API
// (oficial), em paralelo à fila do Baileys em src/queue/disparo.js.
//
// Diferenças-chave em relação ao processador Baileys:
//   - Não há simulação de comportamento humano (não faz sentido/nao é
//     necessário na API oficial — a Meta não pune por "parecer bot")
//   - Não há verificação de número via onWhatsApp (a Cloud API não expõe isso;
//     erros de número inválido vêm como resposta de erro no próprio envio)
//   - Confirmação de entrega chega via webhook assíncrono, não via socket —
//     por isso não bloqueamos aguardando ACK aqui, o status é atualizado
//     depois por processarWebhookStatus quando a Meta notificar
//   - Requer variáveis do template renderizadas na ordem certa

require('dotenv').config();
const Bull = require('bull');
const pool = require('../db');
const {
  enviarTemplate, proximaContaOficial, registrarUsoOficial,
} = require('../services/whatsapp-oficial');

function delayAleatorio(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs) + minMs);
}

async function addLog(nivel, mensagem, dados) {
  try {
    await pool.query('INSERT INTO logs (nivel, mensagem, dados) VALUES ($1, $2, $3)',
      [nivel, mensagem, dados ? JSON.stringify(dados) : null]);
  } catch (e) {}
}

const disparoOficialQueue = new Bull('disparos-oficial', {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

disparoOficialQueue.on('error', err => console.error('[FILA-OFICIAL] Erro:', err.message));
disparoOficialQueue.on('completed', (job, r) => {
  console.log('[FILA-OFICIAL] ✅ #' + job.id + ' via conta ' + (r && r.conta || '?') + ' (wamid=' + (r && r.wamid) + ')');
});
disparoOficialQueue.on('failed', (job, err) => console.error('[FILA-OFICIAL] ❌ #' + job.id + ': ' + err.message));

// ─── Processador ────────────────────────────────────────────────────────────

disparoOficialQueue.process(3, async (job) => {
  // Concorrência 3: a Cloud API aguenta throughput bem maior que Baileys
  // (não há simulação de digitação/presença bloqueando o event loop)
  const { disparoId, numero, campanhaId, templateId, valores, delayMin, delayMax } = job.data;

  const tplResult = await pool.query('SELECT * FROM whatsapp_templates WHERE id=$1', [templateId]);
  if (!tplResult.rows.length) {
    await pool.query("UPDATE disparos SET status='falha', erro='Template não encontrado' WHERE id=$1", [disparoId]);
    throw new Error('Template não encontrado');
  }
  const template = tplResult.rows[0];

  let conta;
  try {
    conta = await proximaContaOficial();
  } catch (err) {
    await pool.query('UPDATE disparos SET erro=$1 WHERE id=$2', [err.message, disparoId]);
    await addLog('aviso', 'Conta oficial indisponível: ' + err.message);
    throw err;
  }

  try {
    const { wamid } = await enviarTemplate(conta.id, numero, template, valores);

    await registrarUsoOficial(conta.id);
    await pool.query(
      "UPDATE disparos SET status='enviado', enviado_em=NOW(), tentativas=tentativas+1, wamid=$1, conta_oficial_id=$2 WHERE id=$3",
      [wamid, conta.id, disparoId]
    );
    await pool.query('UPDATE campanhas SET enviados=enviados+1 WHERE id=$1', [campanhaId]);
    await verificarConclusaoCampanhaOficial(campanhaId);

    // Delay entre mensagens — a Cloud API tem limites de throughput por
    // tier de conta (80/1k/10k/100k msgs/24h), não precisa ser tão
    // conservador quanto o Baileys, mas ainda evita rajadas que estourem
    // rate limit da Graph API (padrão: 80 req/s por app).
    const delay = delayAleatorio(delayMin || 1000, delayMax || 3000);
    await new Promise(r => setTimeout(r, delay));

    return { ok: true, conta: conta.nome, wamid };

  } catch (err) {
    if (err.semRetry) {
      await pool.query(
        "UPDATE disparos SET status='falha', tentativas=tentativas+1, erro=$1, conta_oficial_id=$2 WHERE id=$3",
        [err.message, conta.id, disparoId]
      );
      await pool.query('UPDATE campanhas SET falhas=falhas+1 WHERE id=$1', [campanhaId]);
      await addLog('erro', 'Falha definitiva (sem retry) ' + numero + ': ' + err.message);
      await verificarConclusaoCampanhaOficial(campanhaId);
      return { ok: false, motivo: 'erro_permanente', erro: err.message };
    }
    await pool.query('UPDATE disparos SET tentativas=tentativas+1, erro=$1 WHERE id=$2', [err.message, disparoId]);
    await addLog('erro', 'Falha ' + numero + ': ' + err.message);
    throw err;
  }
});

disparoOficialQueue.on('failed', async (job, err) => {
  const { disparoId, campanhaId } = job.data;
  if (job.attemptsMade >= job.opts.attempts) {
    await pool.query("UPDATE disparos SET status='falha', erro=$1 WHERE id=$2", [err.message, disparoId]);
    await pool.query('UPDATE campanhas SET falhas=falhas+1 WHERE id=$1', [campanhaId]);
    await verificarConclusaoCampanhaOficial(campanhaId);
  }
});

async function verificarConclusaoCampanhaOficial(campanhaId) {
  try {
    const pendentes = await pool.query(
      "SELECT COUNT(*) FROM disparos WHERE campanha_id=$1 AND status='pendente'", [campanhaId]
    );
    if (parseInt(pendentes.rows[0].count) > 0) return;

    const [waiting, delayed] = await Promise.all([
      disparoOficialQueue.getWaiting(),
      disparoOficialQueue.getDelayed(),
    ]);
    if ([...waiting, ...delayed].filter(j => j.data && j.data.campanhaId === campanhaId).length > 0) return;

    const camp = await pool.query('SELECT status FROM campanhas WHERE id=$1', [campanhaId]);
    if (!camp.rows.length || camp.rows[0].status === 'concluido') return;

    await pool.query(
      "UPDATE campanhas SET status='concluido', finalizado_em=NOW() WHERE id=$1 AND status='em_andamento'",
      [campanhaId]
    );

    const stats = await pool.query('SELECT enviados, falhas, total_contatos FROM campanhas WHERE id=$1', [campanhaId]);
    const s = stats.rows[0];
    await addLog('info', 'Campanha oficial #' + campanhaId + ' concluída — ' + s.enviados + ' enviados, ' + s.falhas + ' falhas de ' + s.total_contatos + ' contatos.');

    try {
      const { notificarCampanhaConcluida } = require('../services/notificacoes');
      await notificarCampanhaConcluida(campanhaId);
    } catch (e2) {}
  } catch (e) {
    console.error('[CAMPANHA-OFICIAL] Erro ao verificar conclusão:', e.message);
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Enfileira uma campanha do tipo 'oficial'. Diferente do Baileys, aqui é
 * obrigatório informar o template e os valores das variáveis por contato
 * (renderizados a partir do template.corpo + dados do contato).
 */
async function enfileirarCampanhaOficial(campanhaId) {
  const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [campanhaId]);
  if (!campanha.rows.length) throw new Error('Campanha não encontrada');
  const c = campanha.rows[0];

  if (c.tipo_envio !== 'oficial') throw new Error('Campanha não é do tipo "oficial"');
  if (!c.template_id) throw new Error('Campanha sem template vinculado');
  if (!c.conta_oficial_id) throw new Error('Campanha sem conta oficial vinculada');

  const tpl = await pool.query('SELECT * FROM whatsapp_templates WHERE id=$1', [c.template_id]);
  if (!tpl.rows.length) throw new Error('Template não encontrado');
  if (tpl.rows[0].status !== 'APPROVED') {
    throw new Error('Template "' + tpl.rows[0].nome + '" ainda não foi aprovado pela Meta (status atual: ' + tpl.rows[0].status + ')');
  }
  const variaveisTpl = tpl.rows[0].variaveis || [];

  const disparos = await pool.query(
    "SELECT d.id, c.numero, c.nome, c.dados FROM disparos d JOIN contatos c ON c.id=d.contato_id WHERE d.campanha_id=$1 AND d.status='pendente'",
    [campanhaId]
  );
  if (!disparos.rows.length) throw new Error('Nenhum disparo pendente.');

  const [jobsW, jobsD] = await Promise.all([
    disparoOficialQueue.getWaiting(),
    disparoOficialQueue.getDelayed(),
  ]);
  const jaNaFila = [...jobsW, ...jobsD].filter(j => j.data && j.data.campanhaId === campanhaId);
  if (jaNaFila.length > 0) {
    throw new Error('Campanha já tem ' + jaNaFila.length + ' mensagens na fila.');
  }

  const { formatarNumero } = require('../services/whatsapp/manager');

  console.log('[CAMPANHA-OFICIAL] Enfileirando ' + disparos.rows.length + ' mensagens...');
  for (const row of disparos.rows) {
    const dados = Object.assign({ nome: row.nome, numero: row.numero }, row.dados);
    // Monta os valores das variáveis do template na ordem definida em
    // whatsapp_templates.variaveis — cada item é o nome do campo do contato.
    const valores = variaveisTpl.map(campo => dados[campo] || '');

    await disparoOficialQueue.add({
      disparoId: row.id,
      numero: formatarNumero(row.numero),
      campanhaId,
      templateId: c.template_id,
      valores,
      delayMin: (c.delay_min || 2) * 1000,
      delayMax: (c.delay_max || 5) * 1000,
    });
  }

  await pool.query("UPDATE campanhas SET status='em_andamento', iniciado_em=NOW() WHERE id=$1", [campanhaId]);
  await addLog('info', 'Campanha oficial #' + campanhaId + ' iniciada — ' + disparos.rows.length + ' mensagens.');
  return disparos.rows.length;
}

async function pausarCampanhaOficial(campanhaId) {
  await disparoOficialQueue.pause();
  await pool.query("UPDATE campanhas SET status='pausado' WHERE id=$1", [campanhaId]);
}

async function retomarOficial() {
  await disparoOficialQueue.resume();
}

module.exports = {
  disparoOficialQueue,
  enfileirarCampanhaOficial,
  pausarCampanhaOficial,
  retomarOficial,
  verificarConclusaoCampanhaOficial,
};
