const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const { importarCSV, renderTemplate } = require('../services/csv');
const { importarDoSheets } = require('../services/sheets');
const { get: cfgGet, getAll: cfgGetAll, set: cfgSet, setMany: cfgSetMany, invalidarCache } = require('../services/config');
const {
  listarChips, adicionarChip, removerChip, statusChip, qrcodeChip,
  criarInstancia, pausarChip, atualizarLimiteDiario
} = require('../services/evolution');
const { enfileirarCampanha, pausarCampanha, retomar, limparFila, statusFila } = require('../queue/disparo');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Configurações ────────────────────────────────────────────────────────────

router.get('/config', async (req, res) => {
  try {
    const all = await cfgGetAll();
    const safe = { ...all };
    if (safe.sheets_credentials) safe.sheets_credentials = '__configurado__';
    res.json({ ok: true, data: safe });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/config', async (req, res) => {
  try {
    const dados = req.body;
    await cfgSetMany(dados);
    invalidarCache();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  try {
    const { checkGeral } = require('../services/health');
    const resultado = await checkGeral();
    const status = resultado.status === 'ok' ? 200 : 503;
    res.status(status).json({ ok: resultado.status === 'ok', data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/config/notificacoes/testar', async (req, res) => {
  try {
    const { enviarNotificacao } = require('../services/notificacoes');
    await enviarNotificacao('✅ Teste de notificação do Disparador funcionando!');
    res.json({ ok: true, message: 'Notificação enviada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Anti-ban (NOVO) ──────────────────────────────────────────────────────────

router.post('/antiban/spintax/testar', (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto) return res.status(400).json({ ok: false, error: 'texto vazio' });
    const { processarSpintax } = require('../services/antiban');
    const variacoes = [];
    for(let i=0; i<5; i++) variacoes.push(processarSpintax(texto));
    res.json({ ok: true, data: variacoes });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/antiban/status', async (req, res) => {
  try {
    const { dentroDaJanela, msAteJanelaAbrir } = require('../services/antiban');
    const c = await cfgGetAll();
    const ativo = await dentroDaJanela();
    const ms = await msAteJanelaAbrir();
    const hrs = Math.round(ms / 1000 / 60 / 60 * 10) / 10;

    const pausados = await pool.query(`SELECT nome, pausado_ate FROM chips WHERE pausado_ate > NOW()`);

    res.json({ ok: true, data: {
      janela_aberta: ativo,
      abre_em_horas: hrs,
      config: c,
      chips_pausados: pausados.rows
    }});
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Chips ────────────────────────────────────────────────────────────────────

router.get('/chips', async (req, res) => {
  try { res.json({ ok: true, data: await listarChips() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips', async (req, res) => {
  try {
    const { nome, instancia } = req.body;
    if (!nome || !instancia) return res.status(400).json({ ok: false, error: 'nome e instancia obrigatórios' });
    const chip = await adicionarChip(nome, instancia);
    res.json({ ok: true, data: chip });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/chips/:id', async (req, res) => {
  try { await removerChip(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:instancia/status', async (req, res) => {
  try { res.json({ ok: true, data: { state: await statusChip(req.params.instancia) } }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:instancia/qrcode', async (req, res) => {
  try { res.json({ ok: true, data: await qrcodeChip(req.params.instancia) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/:instancia/criar', async (req, res) => {
  try { res.json({ ok: true, data: await criarInstancia(req.params.instancia) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/:id/pausar', async (req, res) => {
  try {
    const { horas = 1 } = req.body;
    const ate = await pausarChip(req.params.id, horas);
    res.json({ ok: true, data: { pausado_ate: ate } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/chips/:id/limite', async (req, res) => {
  try {
    const { limite } = req.body;
    if (!limite || limite < 1) return res.status(400).json({ ok: false, error: 'limite inválido' });
    res.json({ ok: true, data: await atualizarLimiteDiario(req.params.id, limite) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/sincronizar', async (req, res) => {
  try {
    const chips = await listarChips();
    const resultados = await Promise.all(chips.map(c => statusChip(c.instancia).then(s => ({ instancia: c.instancia, state: s }))));
    res.json({ ok: true, data: resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:id/historico', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM chip_historico WHERE chip_id=$1 ORDER BY data DESC LIMIT 30`, [req.params.id]);
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Importar ─────────────────────────────────────────────────────────────────

router.post('/importar/csv', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
    const resultado = await importarCSV(req.file.buffer.toString('utf-8'));
    res.json({ ok: true, data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/importar/sheets', async (req, res) => {
  try {
    const { sheetId, range } = req.body;
    const resultado = await importarDoSheets(sheetId, range);
    res.json({ ok: true, data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Blacklist ────────────────────────────────────────────────────────────────

router.get('/blacklist', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const result = await pool.query(`SELECT * FROM blacklist ORDER BY criado_em DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const count = await pool.query('SELECT COUNT(*) FROM blacklist');
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/blacklist', async (req, res) => {
  try {
    const { numero, motivo } = req.body;
    const limpo = String(numero).replace(/\D/g, '');
    if (!limpo) return res.status(400).json({ ok: false, error: 'número inválido' });
    await pool.query(`INSERT INTO blacklist (numero, motivo) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [limpo, motivo]);
    await pool.query('DELETE FROM contatos WHERE numero=$1', [limpo]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/blacklist/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM blacklist WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Contatos ─────────────────────────────────────────────────────────────────

router.get('/contatos', async (req, res) => {
  try {
    const { page = 1, limit = 50, busca } = req.query;
    const offset = (page - 1) * limit;
    let where = '', params = [];
    if (busca) { params.push(`%${busca}%`); where = ` WHERE nome ILIKE $1 OR numero ILIKE $1`; }
    const result = await pool.query(`SELECT * FROM contatos${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const count = await pool.query(`SELECT COUNT(*) FROM contatos${where}`, params);
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/contatos', async (req, res) => {
  try { await pool.query('DELETE FROM contatos'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Campanhas ────────────────────────────────────────────────────────────────

router.get('/campanhas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM campanhas ORDER BY criado_em DESC');
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/campanhas/:id/relatorio', async (req, res) => {
  try {
    const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!campanha.rows.length) return res.status(404).json({ ok: false, error: 'Não encontrada' });
    const stats = await pool.query(`SELECT status, COUNT(*) as count FROM disparos WHERE campanha_id=$1 GROUP BY status`, [req.params.id]);
    const porChip = await pool.query(`
      SELECT ch.nome, COUNT(*) as enviados FROM disparos d
      JOIN chips ch ON ch.id = d.chip_id
      WHERE d.campanha_id=$1 AND d.status='enviado'
      GROUP BY ch.nome ORDER BY enviados DESC
    `, [req.params.id]);
    const porHora = await pool.query(`
      SELECT date_trunc('hour', enviado_em) as hora, COUNT(*) as total
      FROM disparos WHERE campanha_id=$1 AND status='enviado'
      GROUP BY hora ORDER BY hora
    `, [req.params.id]);
    res.json({ ok: true, data: { campanha: campanha.rows[0], stats: stats.rows, porChip: porChip.rows, porHora: porHora.rows } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas', async (req, res) => {
  try {
    const { nome, template, delay_min = 20, delay_max = 50 } = req.body;
    if (!nome || !template) return res.status(400).json({ ok: false, error: 'nome e template obrigatórios' });
    if (delay_min < 5) return res.status(400).json({ ok: false, error: 'delay_min mínimo 5s' });
    if (delay_max <= delay_min) return res.status(400).json({ ok: false, error: 'delay_max deve ser maior que delay_min' });
    const campanha = await pool.query(
      'INSERT INTO campanhas (nome,template,delay_min,delay_max) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome, template, delay_min, delay_max]
    );
    const campanhaId = campanha.rows[0].id;
    const contatos = await pool.query('SELECT id FROM contatos');
    if (!contatos.rows.length) return res.status(400).json({ ok: false, error: 'Nenhum contato importado' });
    const values = contatos.rows.map(c => `(${campanhaId},${c.id})`).join(',');
    await pool.query(`INSERT INTO disparos (campanha_id,contato_id) VALUES ${values}`);
    await pool.query('UPDATE campanhas SET total_contatos=$1 WHERE id=$2', [contatos.rows.length, campanhaId]);
    res.json({ ok: true, data: campanha.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/campanhas/:id/template', async (req, res) => {
  try {
    const { template } = req.body;
    if (!template) return res.status(400).json({ ok: false, error: 'template obrigatório' });
    const result = await pool.query(
      `UPDATE campanhas SET template=$1 WHERE id=$2 AND status IN ('rascunho','pausado') RETURNING *`,
      [template, req.params.id]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, error: 'Campanha não editável' });
    const pendentes = await pool.query(`
      SELECT d.id, c.numero, c.nome, c.dados FROM disparos d JOIN contatos c ON c.id=d.contato_id
      WHERE d.campanha_id=$1 AND d.status='pendente'
    `, [result.rows[0].id]);
    for (const row of pendentes.rows) {
      const msg = renderTemplate(template, { nome: row.nome, numero: row.numero, ...row.dados });
      await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [msg, row.id]);
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/campanhas/:id/delay', async (req, res) => {
  try {
    const { delay_min, delay_max } = req.body;
    if (delay_min < 5) return res.status(400).json({ ok: false, error: 'mínimo 5s' });
    if (delay_max <= delay_min) return res.status(400).json({ ok: false, error: 'delay_max deve ser maior' });
    const result = await pool.query(
      `UPDATE campanhas SET delay_min=$1,delay_max=$2 WHERE id=$3 AND status IN ('rascunho','pausado') RETURNING *`,
      [delay_min, delay_max, req.params.id]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, error: 'Campanha não editável' });
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/iniciar', async (req, res) => {
  try {
    const total = await enfileirarCampanha(parseInt(req.params.id));
    res.json({ ok: true, message: `${total} mensagens enfileiradas` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/pausar', async (req, res) => {
  try { await pausarCampanha(parseInt(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/retomar', async (req, res) => {
  try { await retomar(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/campanhas/:id', async (req, res) => {
  try { await pool.query('DELETE FROM campanhas WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Fila ─────────────────────────────────────────────────────────────────────

router.get('/fila/status', async (req, res) => {
  try { res.json({ ok: true, data: await statusFila() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/fila/limpar', async (req, res) => {
  try { await limparFila(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Webhooks Evolution API ───────────────────────────────────────────────────

router.post('/webhook/evolution', async (req, res) => {
  try {
    const { event, instance, data } = req.body;
    if (!event || !instance) return res.json({ ok: true }); 

    console.log(`[WEBHOOK] Evento: ${event} — instância: ${instance}`);

    const mapaStatus = {
      'connection.update': async () => {
        const state = data?.state || data?.status || 'desconhecido';
        await pool.query(`UPDATE chips SET status=$1, ultimo_ping=NOW() WHERE instancia=$2`, [state, instance]);

        await pool.query(`INSERT INTO logs (nivel, mensagem, dados) VALUES ($1,$2,$3)`,
          ['info', `Webhook: chip ${instance} → ${state}`, JSON.stringify({ instance, state })]);

        if (state === 'open') {
          const { disparoQueue } = require('../queue/disparo');
          const pausado = await disparoQueue.isPaused();
          if (pausado) {
            const waiting = await disparoQueue.getWaitingCount();
            if (waiting > 0) {
              await disparoQueue.resume();
              await pool.query(`INSERT INTO logs (nivel, mensagem) VALUES ('info', $1)`,
                [`Webhook: fila retomada automaticamente após reconexão de ${instance}`]);
            }
          }
        }

        if (['close', 'connecting', 'disconnected'].includes(state)) {
          const { disparoQueue } = require('../queue/disparo');
          const active = await disparoQueue.getActiveCount();
          const waiting = await disparoQueue.getWaitingCount();
          if ((active > 0 || waiting > 0) && !(await disparoQueue.isPaused())) {
            const outrosConectados = await pool.query(`SELECT COUNT(*) FROM chips WHERE status='open' AND instancia!=$1`, [instance]);
            if (parseInt(outrosConectados.rows[0].count) === 0) {
              await disparoQueue.pause();
            }
          }
        }
      },
      'qrcode.updated': async () => {
        await pool.query(`UPDATE chips SET status='qr_code', ultimo_ping=NOW() WHERE instancia=$1`, [instance]);
      },
    };

    const handler = mapaStatus[event];
    if (handler) await handler();

    res.json({ ok: true });
  } catch (err) {
    console.error('[WEBHOOK] Erro:', err.message);
    res.json({ ok: true }); 
  }
});

router.post('/webhook/registrar', async (req, res) => {
  try {
    const { cfgGet } = require('../services/config');
    const axios = require('axios');
    const baseUrl = await cfgGet('evolution_url', process.env.EVOLUTION_API_URL);
    const apiKey  = await cfgGet('evolution_key', process.env.EVOLUTION_API_KEY);
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ ok: false, error: 'webhookUrl obrigatório' });

    const chips = await listarChips();
    const resultados = [];

    for (const chip of chips) {
      try {
        await axios.post(`${baseUrl}/webhook/set/${chip.instancia}`, {
          webhook: {
            enabled: true,
            url: webhookUrl,
            events: ['CONNECTION_UPDATE', 'QRCODE_UPDATED', 'MESSAGES_UPSERT'],
          }
        }, { headers: { apikey: apiKey } });
        resultados.push({ instancia: chip.instancia, ok: true });
      } catch(e) {
        resultados.push({ instancia: chip.instancia, ok: false, erro: e.message });
      }
    }

    res.json({ ok: true, data: resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Exportação e Duplicatas ──────────────────────────────────────────────────

router.get('/campanhas/:id/exportar', async (req, res) => {
  try {
    const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!campanha.rows.length) return res.status(404).json({ ok: false, error: 'Não encontrada' });

    const disparos = await pool.query(`
      SELECT c.numero, c.nome, d.status, d.mensagem, d.tentativas, d.erro, d.enviado_em, ch.nome AS chip_nome
      FROM disparos d JOIN contatos c ON c.id = d.contato_id LEFT JOIN chips ch ON ch.id = d.chip_id
      WHERE d.campanha_id = $1 ORDER BY d.id
    `, [req.params.id]);

    const cabecalho = ['numero','nome','status','chip','tentativas','enviado_em','erro','mensagem'];
    const linhas = disparos.rows.map(r => [
      r.numero, (r.nome || '').replace(/,/g, ';'), r.status, (r.chip_nome || ''), r.tentativas,
      r.enviado_em ? new Date(r.enviado_em).toLocaleString('pt-BR') : '',
      (r.erro || '').replace(/,/g, ';').replace(/\n/g, ' '),
      (r.mensagem || '').replace(/,/g, ';').replace(/\n/g, ' ').substring(0, 100),
    ].join(','));

    const csv = [cabecalho.join(','), ...linhas].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campanha-${req.params.id}-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv); 
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/campanhas/:id/duplicatas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.numero, c.nome, COUNT(DISTINCT d2.campanha_id) as recebeu_em_campanhas
      FROM disparos d1 JOIN contatos c ON c.id = d1.contato_id
      JOIN disparos d2 ON d2.contato_id = d1.contato_id AND d2.campanha_id != d1.campanha_id AND d2.status = 'enviado'
      WHERE d1.campanha_id = $1 GROUP BY c.numero, c.nome ORDER BY recebeu_em_campanhas DESC LIMIT 100
    `, [req.params.id]);
    res.json({ ok: true, data: result.rows, total: result.rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/remover-duplicatas', async (req, res) => {
  try {
    const result = await pool.query(`
      UPDATE disparos SET status='bloqueado', erro='Duplicata — já recebeu em campanha anterior'
      WHERE campanha_id = $1 AND status = 'pendente' AND contato_id IN (
          SELECT DISTINCT d2.contato_id FROM disparos d2 WHERE d2.campanha_id != $1 AND d2.status = 'enviado'
      ) RETURNING id
    `, [req.params.id]);
    const pendentes = await pool.query(`SELECT COUNT(*) FROM disparos WHERE campanha_id=$1 AND status='pendente'`, [req.params.id]);
    await pool.query(`UPDATE campanhas SET total_contatos=$1 WHERE id=$2`, [parseInt(pendentes.rows[0].count), req.params.id]);
    res.json({ ok: true, data: { removidos: result.rows.length } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 50, nivel } = req.query;
    const offset = (page - 1) * limit;
    let where = nivel ? `WHERE nivel=$1` : '';
    const params = nivel ? [nivel] : [];
    const result = await pool.query(`SELECT * FROM logs ${where} ORDER BY criado_em DESC LIMIT ${limit} OFFSET ${offset}`, params);
    const count = await pool.query(`SELECT COUNT(*) FROM logs ${where}`, params);
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;