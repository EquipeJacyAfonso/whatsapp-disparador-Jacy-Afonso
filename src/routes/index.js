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
const { requireAuth } = require('../services/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Autenticação ─────────────────────────────────────────────────────────────

router.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ ok: false, error: 'Email e senha obrigatórios' });
    const { login } = require('../services/auth');
    const result = await login(email, senha);
    if (!result) return res.status(401).json({ ok: false, error: 'Email ou senha incorretos' });
    res.json({ ok: true, data: result });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ ok: true, data: req.usuario });
});

router.post('/auth/alterar-senha', requireAuth, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;
    const { alterarSenha } = require('../services/auth');
    await alterarSenha(req.usuario.id, senhaAtual, novaSenha);
    res.json({ ok: true, message: 'Senha alterada com sucesso!' });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Configurações ────────────────────────────────────────────────────────────

// Chaves sensíveis nunca devem chegar ao browser (jwt_secret permite forjar tokens de admin).
const CHAVES_SENSIVEIS = ['jwt_secret', 'sheets_credentials', 'evolution_key'];

router.get('/config', requireAuth, async (req, res) => {
  try {
    const all = await cfgGetAll();
    const safe = { ...all };
    for (const chave of CHAVES_SENSIVEIS) {
      if (safe[chave]) safe[chave] = '__configurado__';
    }
    res.json({ ok: true, data: safe });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/config', requireAuth, async (req, res) => {
  try {
    await cfgSetMany(req.body);
    invalidarCache();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────

router.get('/health', async (req, res) => {
  try {
    const { checkGeral } = require('../services/health');
    const resultado = await checkGeral();
    res.status(resultado.status === 'ok' ? 200 : 503).json({ ok: resultado.status === 'ok', data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Notificações ─────────────────────────────────────────────────────────────

router.post('/config/notificacoes/testar', requireAuth, async (req, res) => {
  try {
    const { enviarNotificacao } = require('../services/notificacoes');
    await enviarNotificacao('✅ Teste de notificação do Disparador funcionando!');
    res.json({ ok: true, message: 'Notificação enviada' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Chips ────────────────────────────────────────────────────────────────────

router.get('/chips', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await listarChips() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips', requireAuth, async (req, res) => {
  try {
    const { nome, instancia } = req.body;
    if (!nome || !instancia) return res.status(400).json({ ok: false, error: 'nome e instancia obrigatórios' });
    const chip = await adicionarChip(nome, instancia);
    res.json({ ok: true, data: chip });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/chips/:id', requireAuth, async (req, res) => {
  try { await removerChip(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:instancia/status', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: { state: await statusChip(req.params.instancia) } }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:instancia/qrcode', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await qrcodeChip(req.params.instancia) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/:instancia/criar', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await criarInstancia(req.params.instancia) }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/:id/pausar', requireAuth, async (req, res) => {
  try {
    const { horas = 1 } = req.body;
    const ate = await pausarChip(req.params.id, horas);
    res.json({ ok: true, data: { pausado_ate: ate } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/chips/:id/limite', requireAuth, async (req, res) => {
  try {
    const { limite } = req.body;
    if (!limite || limite < 1) return res.status(400).json({ ok: false, error: 'limite inválido' });
    res.json({ ok: true, data: await atualizarLimiteDiario(req.params.id, limite) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/sincronizar', requireAuth, async (req, res) => {
  try {
    const chips = await listarChips();
    const resultados = await Promise.all(chips.map(c => statusChip(c.instancia).then(s => ({ instancia: c.instancia, state: s }))));
    res.json({ ok: true, data: resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:id/historico', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM chip_historico WHERE chip_id=$1 ORDER BY data DESC LIMIT 30', [req.params.id]);
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Importar ─────────────────────────────────────────────────────────────────

router.post('/importar/csv', upload.single('arquivo'), requireAuth, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
    const resultado = await importarCSV(req.file.buffer.toString('utf-8'));
    res.json({ ok: true, data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/importar/sheets', requireAuth, async (req, res) => {
  try {
    const { sheetId, range } = req.body;
    const resultado = await importarDoSheets(sheetId, range);
    res.json({ ok: true, data: resultado });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Blacklist ────────────────────────────────────────────────────────────────

router.get('/blacklist', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const offset = (page - 1) * limit;
    const result = await pool.query('SELECT * FROM blacklist ORDER BY criado_em DESC LIMIT $1 OFFSET $2', [limit, offset]);
    const count = await pool.query('SELECT COUNT(*) FROM blacklist');
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/blacklist', requireAuth, async (req, res) => {
  try {
    const { numero, motivo } = req.body;
    const { formatarNumero } = require('../services/evolution');
    // Bug 8: normaliza com formatarNumero (garante DDI 55 + DDD + número com 9)
    // para que a verificação na fila encontre o mesmo formato
    const limpo = formatarNumero(String(numero).replace(/\D/g, ''));
    if (!limpo || limpo.length < 12) return res.status(400).json({ ok: false, error: 'número inválido' });
    await pool.query('INSERT INTO blacklist (numero, motivo) VALUES ($1,$2) ON CONFLICT DO NOTHING', [limpo, motivo]);
    await pool.query('DELETE FROM contatos WHERE numero=$1', [limpo]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/blacklist/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM blacklist WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Contatos ─────────────────────────────────────────────────────────────────

router.get('/contatos', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const offset = (page - 1) * limit;
    const busca = req.query.busca;
    let where = '', params = [];
    if (busca) { params.push('%' + busca + '%'); where = ' WHERE nome ILIKE $1 OR numero ILIKE $1'; }
    const countParams = busca ? params : [];
    const result = await pool.query('SELECT * FROM contatos' + where + ' ORDER BY id DESC LIMIT $' + (params.length+1) + ' OFFSET $' + (params.length+2), [...params, limit, offset]);
    const count = await pool.query('SELECT COUNT(*) FROM contatos' + where, countParams);
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/contatos', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM contatos'); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Campanhas ────────────────────────────────────────────────────────────────

router.get('/campanhas', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nome, status, template, total_contatos, enviados, falhas, delay_min, delay_max, criado_em, iniciado_em, finalizado_em, midia_mimetype, midia_nome FROM campanhas ORDER BY criado_em DESC');
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/campanhas/:id/relatorio', requireAuth, async (req, res) => {
  try {
    const campanha = await pool.query('SELECT id, nome, status, total_contatos, enviados, falhas, delay_min, delay_max, criado_em, iniciado_em, finalizado_em, midia_mimetype, midia_nome FROM campanhas WHERE id=$1', [req.params.id]);
    if (!campanha.rows.length) return res.status(404).json({ ok: false, error: 'Não encontrada' });
    const stats = await pool.query('SELECT status, COUNT(*) as count FROM disparos WHERE campanha_id=$1 GROUP BY status', [req.params.id]);
    const porChip = await pool.query(
      'SELECT ch.nome, COUNT(*) as enviados FROM disparos d JOIN chips ch ON ch.id = d.chip_id WHERE d.campanha_id=$1 AND d.status=\'enviado\' GROUP BY ch.nome ORDER BY enviados DESC',
      [req.params.id]
    );
    const porHora = await pool.query(
      "SELECT date_trunc('hour', enviado_em) as hora, COUNT(*) as total FROM disparos WHERE campanha_id=$1 AND status='enviado' GROUP BY hora ORDER BY hora",
      [req.params.id]
    );
    res.json({ ok: true, data: { campanha: campanha.rows[0], stats: stats.rows, porChip: porChip.rows, porHora: porHora.rows } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas', requireAuth, async (req, res) => {
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
    const values = contatos.rows.map(c => '(' + campanhaId + ',' + c.id + ')').join(',');
    await pool.query('INSERT INTO disparos (campanha_id,contato_id) VALUES ' + values);
    await pool.query('UPDATE campanhas SET total_contatos=$1 WHERE id=$2', [contatos.rows.length, campanhaId]);
    res.json({ ok: true, data: campanha.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Upload de imagem para campanha ──────────────────────────────────────────

router.post('/campanhas/:id/midia', upload.single('imagem'), requireAuth, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhuma imagem enviada' });
    const { mimetype, originalname, size } = req.file;
    if (!['image/jpeg', 'image/png'].includes(mimetype)) {
      return res.status(400).json({ ok: false, error: 'Apenas PNG e JPEG são suportados' });
    }
    if (size > 5 * 1024 * 1024) {
      return res.status(400).json({ ok: false, error: 'Imagem muito grande — máximo 5MB' });
    }
    const base64 = req.file.buffer.toString('base64');
    await pool.query(
      'UPDATE campanhas SET midia_base64=$1, midia_mimetype=$2, midia_nome=$3 WHERE id=$4',
      [base64, mimetype, originalname, req.params.id]
    );
    res.json({ ok: true, data: { nome: originalname, mimetype, tamanho: size } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/campanhas/:id/midia', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE campanhas SET midia_base64=NULL, midia_mimetype=NULL, midia_nome=NULL WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/campanhas/:id/template', requireAuth, async (req, res) => {
  try {
    const { template } = req.body;
    if (!template) return res.status(400).json({ ok: false, error: 'template obrigatório' });
    const result = await pool.query(
      "UPDATE campanhas SET template=$1 WHERE id=$2 AND status IN ('rascunho','pausado') RETURNING *",
      [template, req.params.id]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, error: 'Campanha não editável' });
    const pendentes = await pool.query(
      'SELECT d.id, c.numero, c.nome, c.dados FROM disparos d JOIN contatos c ON c.id=d.contato_id WHERE d.campanha_id=$1 AND d.status=\'pendente\'',
      [result.rows[0].id]
    );
    for (const row of pendentes.rows) {
      const msg = renderTemplate(template, { nome: row.nome, numero: row.numero, ...row.dados });
      await pool.query('UPDATE disparos SET mensagem=$1 WHERE id=$2', [msg, row.id]);
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.patch('/campanhas/:id/delay', requireAuth, async (req, res) => {
  try {
    const { delay_min, delay_max } = req.body;
    if (delay_min < 5) return res.status(400).json({ ok: false, error: 'mínimo 5s' });
    if (delay_max <= delay_min) return res.status(400).json({ ok: false, error: 'delay_max deve ser maior' });
    const result = await pool.query(
      "UPDATE campanhas SET delay_min=$1,delay_max=$2 WHERE id=$3 AND status IN ('rascunho','pausado') RETURNING *",
      [delay_min, delay_max, req.params.id]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, error: 'Campanha não editável' });
    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/iniciar', requireAuth, async (req, res) => {
  try {
    const total = await enfileirarCampanha(parseInt(req.params.id));
    res.json({ ok: true, message: total + ' mensagens enfileiradas' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/pausar', requireAuth, async (req, res) => {
  try { await pausarCampanha(parseInt(req.params.id)); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/retomar', requireAuth, async (req, res) => {
  try { await retomar(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/campanhas/:id', requireAuth, async (req, res) => {
  try { await pool.query('DELETE FROM campanhas WHERE id=$1', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Fila ─────────────────────────────────────────────────────────────────────

router.get('/fila/status', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await statusFila() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/fila/limpar', requireAuth, async (req, res) => {
  try { await limparFila(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Webhook Evolution API ────────────────────────────────────────────────────

;

router.post('/webhook/registrar', requireAuth, async (req, res) => {
  try {
    const axios = require('axios');
    const baseUrl = await cfgGet('evolution_url', process.env.EVOLUTION_API_URL);
    const apiKey = await cfgGet('evolution_key', process.env.EVOLUTION_API_KEY);
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ ok: false, error: 'webhookUrl obrigatório' });
    const chips = await listarChips();
    const resultados = [];
    for (const chip of chips) {
      try {
        // Todos os eventos num único registro — sobreescrever com eventos parciais
        // apagava os outros (a Evolution API só guarda 1 webhook por instância).
        await axios.post(baseUrl + '/webhook/set/' + chip.instancia, {
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
        }, { headers: { apikey: apiKey } });
        resultados.push({ instancia: chip.instancia, ok: true });
      } catch(e) {
        resultados.push({ instancia: chip.instancia, ok: false, erro: e.message });
      }
    }
    res.json({ ok: true, data: resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Exportar CSV ─────────────────────────────────────────────────────────────

router.get('/campanhas/:id/exportar', requireAuth, async (req, res) => {
  try {
    const campanha = await pool.query('SELECT nome FROM campanhas WHERE id=$1', [req.params.id]);
    if (!campanha.rows.length) return res.status(404).json({ ok: false, error: 'Não encontrada' });
    const disparos = await pool.query(
      'SELECT c.numero, c.nome, d.status, d.mensagem, d.tentativas, d.erro, d.enviado_em, ch.nome AS chip_nome FROM disparos d JOIN contatos c ON c.id = d.contato_id LEFT JOIN chips ch ON ch.id = d.chip_id WHERE d.campanha_id = $1 ORDER BY d.id',
      [req.params.id]
    );
    const cab = ['numero','nome','status','chip','tentativas','enviado_em','erro','mensagem'];
    const linhas = disparos.rows.map(r => [
      r.numero,
      (r.nome || '').replace(/,/g, ';'),
      r.status,
      r.chip_nome || '',
      r.tentativas,
      r.enviado_em ? new Date(r.enviado_em).toLocaleString('pt-BR') : '',
      (r.erro || '').replace(/,/g, ';').replace(/\n/g, ' '),
      (r.mensagem || '').replace(/,/g, ';').replace(/\n/g, ' ').substring(0, 100),
    ].join(','));
    const csv = [cab.join(','), ...linhas].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="campanha-' + req.params.id + '.csv"');
    res.send('\uFEFF' + csv);
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Duplicatas ───────────────────────────────────────────────────────────────

router.get('/campanhas/:id/duplicatas', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT c.numero, c.nome, COUNT(DISTINCT d2.campanha_id) as recebeu_em_campanhas FROM disparos d1 JOIN contatos c ON c.id = d1.contato_id JOIN disparos d2 ON d2.contato_id = d1.contato_id AND d2.campanha_id != d1.campanha_id AND d2.status = 'enviado' WHERE d1.campanha_id = $1 GROUP BY c.numero, c.nome ORDER BY recebeu_em_campanhas DESC LIMIT 100",
      [req.params.id]
    );
    res.json({ ok: true, data: result.rows, total: result.rows.length });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/remover-duplicatas', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE disparos SET status='bloqueado', erro='Duplicata — já recebeu em campanha anterior' WHERE campanha_id = $1 AND status = 'pendente' AND contato_id IN (SELECT DISTINCT d2.contato_id FROM disparos d2 WHERE d2.campanha_id != $1 AND d2.status = 'enviado') RETURNING id",
      [req.params.id]
    );
    const pendentes = await pool.query("SELECT COUNT(*) FROM disparos WHERE campanha_id=$1 AND status='pendente'", [req.params.id]);
    await pool.query('UPDATE campanhas SET total_contatos=$1 WHERE id=$2', [parseInt(pendentes.rows[0].count), req.params.id]);
    res.json({ ok: true, data: { removidos: result.rows.length } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Logs ─────────────────────────────────────────────────────────────────────

router.get('/logs', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const page  = Math.max(parseInt(req.query.page)  || 1, 1);
    const offset = (page - 1) * limit;
    const { nivel } = req.query;
    const where = nivel ? 'WHERE nivel=$1' : '';
    const params = nivel ? [nivel] : [];
    const result = await pool.query('SELECT * FROM logs ' + where + ' ORDER BY criado_em DESC LIMIT $' + (params.length+1) + ' OFFSET $' + (params.length+2), [...params, limit, offset]);
    const count = await pool.query('SELECT COUNT(*) FROM logs ' + where, params);
    res.json({ ok: true, data: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
