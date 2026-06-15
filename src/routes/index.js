const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const { importarCSV, renderTemplate } = require('../services/csv');
const { importarDoSheets } = require('../services/sheets');
const { get: cfgGet, getAll: cfgGetAll, set: cfgSet, setMany: cfgSetMany, invalidarCache } = require('../services/config');
const {
  listarChips, adicionarChip, removerChip, statusChip, qrcodeChip,
  criarInstancia, pausarChip, atualizarLimiteDiario, verificarLoteNumeros
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
    await cfgSetMany(req.body);
    invalidarCache();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/config/notificacoes/testar', async (req, res) => {
  try {
    const { enviarNotificacao } = require('../services/notificacoes');
    await enviarNotificacao('✅ Teste de notificação do Disparador funcionando!');
    res.json({ ok: true, message: 'Notificação enviada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Health & Anti-ban ────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const { checkGeral } = require('../services/health');
    const resultado = await checkGeral();
    res.status(resultado.status === 'ok' ? 200 : 503).json({ ok: resultado.status === 'ok', data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

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
    const pausados = await pool.query(`SELECT nome, pausado_ate FROM chips WHERE pausado_ate > NOW()`);
    res.json({ ok: true, data: {
      janela_aberta: await dentroDaJanela(),
      abre_em_horas: Math.round((await msAteJanelaAbrir()) / 1000 / 60 / 60 * 10) / 10,
      config: await cfgGetAll(),
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
    if (!req.body.nome || !req.body.instancia) return res.status(400).json({ ok: false, error: 'Obrigatório' });
    res.json({ ok: true, data: await adicionarChip(req.body.nome, req.body.instancia) });
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
  try { res.json({ ok: true, data: { pausado_ate: await pausarChip(req.params.id, req.body.horas || 1) } }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/chips/:id/limite', async (req, res) => {
  try { res.json({ ok: true, data: await atualizarLimiteDiario(req.params.id, req.body.limite) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/sincronizar', async (req, res) => {
  try {
    const chips = await listarChips();
    const resultados = await Promise.all(chips.map(c => statusChip(c.instancia).then(s => ({ instancia: c.instancia, state: s }))));
    res.json({ ok: true, data: resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Importar & Higienizar (NOVO) ─────────────────────────────────────────────
router.post('/importar/csv', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
    res.json({ ok: true, data: await importarCSV(req.file.buffer.toString('utf-8')) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/importar/sheets', async (req, res) => {
  try { res.json({ ok: true, data: await importarDoSheets(req.body.sheetId, req.body.range) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/contatos/higienizar', async (req, res) => {
  try {
    // Processa de 100 em 100 contatos para não sobrecarregar a Evolution API
    const contatos = await pool.query(`SELECT id, numero FROM contatos WHERE whatsapp_valido IS NULL LIMIT 100`);
    if (!contatos.rows.length) return res.json({ ok: true, data: { concluidos: 0, finalizado: true } });

    const chips = await pool.query(`SELECT instancia FROM chips WHERE status = 'open'`);
    if (!chips.rows.length) throw new Error('Conecte ao menos um chip para higienizar a lista.');

    const instancia = chips.rows[Math.floor(Math.random() * chips.rows.length)].instancia;
    const numeros = contatos.rows.map(c => c.numero);
    
    // Consulta a API
    const resultados = await verificarLoteNumeros(numeros, instancia);

    let validos = 0, invalidos = 0;

    // Atualiza a Base de Dados
    for (const c of contatos.rows) {
      let numLimpo = String(c.numero).replace(/\D/g, '');
      if (!numLimpo.startsWith('55')) numLimpo = `55${numLimpo}`;

      const apiRes = resultados.find(r => r.number === numLimpo || (r.jid && r.jid.includes(numLimpo)));
      const valido = apiRes ? apiRes.exists : false;

      if (valido) validos++; else invalidos++;
      await pool.query(`UPDATE contatos SET whatsapp_valido = $1 WHERE id = $2`, [valido, c.id]);
    }

    res.json({ ok: true, data: { concluidos: contatos.rows.length, validos, invalidos, finalizado: false } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/contatos/invalidos', async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM contatos WHERE whatsapp_valido = false RETURNING id`);
    res.json({ ok: true, data: { removidos: result.rows.length } });
  } catch(err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Blacklist ────────────────────────────────────────────────────────────────
router.get('/blacklist', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const result = await pool.query(`SELECT * FROM blacklist ORDER BY criado_em DESC LIMIT $1 OFFSET $2`, [limit, (page - 1) * limit]);
    const count = await pool.query('SELECT COUNT(*) FROM blacklist');
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/blacklist', async (req, res) => {
  try {
    const limpo = String(req.body.numero).replace(/\D/g, '');
    if (!limpo) return res.status(400).json({ ok: false, error: 'número inválido' });
    await pool.query(`INSERT INTO blacklist (numero, motivo) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [limpo, req.body.motivo]);
    await pool.query('DELETE FROM contatos WHERE numero=$1', [limpo]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/blacklist/:id', async (req, res) => {
  try { await pool.query('DELETE FROM blacklist WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Contatos ─────────────────────────────────────────────────────────────────
router.get('/contatos', async (req, res) => {
  try {
    const { page = 1, limit = 50, busca } = req.query;
    let where = '', params = [];
    if (busca) { params.push(`%${busca}%`); where = ` WHERE nome ILIKE $1 OR numero ILIKE $1`; }
    const result = await pool.query(`SELECT * FROM contatos${where} ORDER BY id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
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
  try { res.json({ ok: true, data: (await pool.query('SELECT * FROM campanhas ORDER BY criado_em DESC')).rows }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/campanhas/:id/relatorio', async (req, res) => {
  try {
    const campanha = await pool.query('SELECT * FROM campanhas WHERE id=$1', [req.params.id]);
    if (!campanha.rows.length) return res.status(404).json({ ok: false, error: 'Não encontrada' });
    const stats = await pool.query(`SELECT status, COUNT(*) as count FROM disparos WHERE campanha_id=$1 GROUP BY status`, [req.params.id]);
    const porChip = await pool.query(`SELECT ch.nome, COUNT(*) as enviados FROM disparos d JOIN chips ch ON ch.id = d.chip_id WHERE d.campanha_id=$1 AND d.status='enviado' GROUP BY ch.nome ORDER BY enviados DESC`, [req.params.id]);
    res.json({ ok: true, data: { campanha: campanha.rows[0], stats: stats.rows, porChip: porChip.rows } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas', async (req, res) => {
  try {
    const { nome, template, delay_min = 20, delay_max = 50 } = req.body;
    if (!nome || !template) return res.status(400).json({ ok: false, error: 'nome e template obrigatórios' });
    
    // 🛡️ ANTI-BAN: Na hora de criar a campanha, só seleciona os contatos VERIFICADOS
    const contatos = await pool.query('SELECT id FROM contatos WHERE whatsapp_valido IS NULL OR whatsapp_valido = true');
    if (!contatos.rows.length) return res.status(400).json({ ok: false, error: 'Nenhum contato válido para criar a campanha.' });
    
    const campanha = await pool.query(
      'INSERT INTO campanhas (nome,template,delay_min,delay_max) VALUES ($1,$2,$3,$4) RETURNING *',
      [nome, template, delay_min, delay_max]
    );
    const campanhaId = campanha.rows[0].id;
    
    const values = contatos.rows.map(c => `(${campanhaId},${c.id})`).join(',');
    await pool.query(`INSERT INTO disparos (campanha_id,contato_id) VALUES ${values}`);
    await pool.query('UPDATE campanhas SET total_contatos=$1 WHERE id=$2', [contatos.rows.length, campanhaId]);
    
    res.json({ ok: true, data: campanha.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/campanhas/:id/template', async (req, res) => {
  try {
    const { template } = req.body;
    const result = await pool.query(`UPDATE campanhas SET template=$1 WHERE id=$2 AND status IN ('rascunho','pausado') RETURNING *`, [template, req.params.id]);
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/campanhas/:id/delay', async (req, res) => {
  try {
    const result = await pool.query(`UPDATE campanhas SET delay_min=$1,delay_max=$2 WHERE id=$3 AND status IN ('rascunho','pausado') RETURNING *`, [req.body.delay_min, req.body.delay_max, req.params.id]);
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/iniciar', async (req, res) => {
  try { res.json({ ok: true, message: `${await enfileirarCampanha(parseInt(req.params.id))} mensagens enfileiradas` }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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

// ─── Fila & Webhook ───────────────────────────────────────────────────────────
router.get('/fila/status', async (req, res) => {
  try { res.json({ ok: true, data: await statusFila() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
router.post('/fila/limpar', async (req, res) => {
  try { await limparFila(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
router.post('/webhook/evolution', async (req, res) => {
  try { res.json({ ok: true }); } catch (err) { res.json({ ok: true }); }
});

router.get('/campanhas/:id/exportar', async (req, res) => {
  try {
    const disparos = await pool.query(`SELECT c.numero, d.status, ch.nome AS chip_nome FROM disparos d JOIN contatos c ON c.id = d.contato_id LEFT JOIN chips ch ON ch.id = d.chip_id WHERE d.campanha_id = $1 ORDER BY d.id`, [req.params.id]);
    const csv = ['numero,status,chip', ...disparos.rows.map(r => `${r.numero},${r.status},${r.chip_nome || ''}`)].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campanha-${req.params.id}-${Date.now()}.csv"`);
    res.send('\uFEFF' + csv); 
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/remover-duplicatas', async (req, res) => {
  try {
    const result = await pool.query(`UPDATE disparos SET status='bloqueado', erro='Duplicata' WHERE campanha_id = $1 AND status = 'pendente' AND contato_id IN (SELECT DISTINCT d2.contato_id FROM disparos d2 WHERE d2.campanha_id != $1 AND d2.status = 'enviado') RETURNING id`, [req.params.id]);
    res.json({ ok: true, data: { removidos: result.rows.length } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 50, nivel } = req.query;
    const params = nivel ? [nivel] : [];
    const result = await pool.query(`SELECT * FROM logs ${nivel ? 'WHERE nivel=$1' : ''} ORDER BY criado_em DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);
    const count = await pool.query(`SELECT COUNT(*) FROM logs ${nivel ? 'WHERE nivel=$1' : ''}`, params);
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;