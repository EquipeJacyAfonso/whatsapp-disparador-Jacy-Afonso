const express = require('express');
const router = express.Router();
const multer = require('multer');
const pool = require('../db');
const { importarCSV, renderTemplate } = require('../services/csv');
const { listarChips, adicionarChip, removerChip, statusChip, qrcodeChip, criarInstancia } = require('../services/evolution');
const { enfileirarCampanha, pausarCampanha, retomar, statusFila } = require('../queue/disparo');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Chips ────────────────────────────────────────────────────────────────────

router.get('/chips', async (req, res) => {
  try {
    const chips = await listarChips();
    res.json({ ok: true, data: chips });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips', async (req, res) => {
  try {
    const { nome, instancia } = req.body;
    if (!nome || !instancia) return res.status(400).json({ ok: false, error: 'nome e instancia são obrigatórios' });
    const chip = await adicionarChip(nome, instancia);
    res.json({ ok: true, data: chip });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/chips/:id', async (req, res) => {
  try {
    await removerChip(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:instancia/status', async (req, res) => {
  try {
    const state = await statusChip(req.params.instancia);
    res.json({ ok: true, data: { state } });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.get('/chips/:instancia/qrcode', async (req, res) => {
  try {
    const data = await qrcodeChip(req.params.instancia);
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/:instancia/criar', async (req, res) => {
  try {
    const data = await criarInstancia(req.params.instancia);
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/chips/sincronizar', async (req, res) => {
  try {
    const chips = await listarChips();
    const resultados = await Promise.all(chips.map(c => statusChip(c.instancia).then(s => ({ instancia: c.instancia, state: s }))));
    res.json({ ok: true, data: resultados });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Importar CSV ─────────────────────────────────────────────────────────────

router.post('/importar/csv', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
    const conteudo = req.file.buffer.toString('utf-8');
    const resultado = await importarCSV(conteudo);
    res.json({ ok: true, data: resultado });
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
  try {
    await pool.query('DELETE FROM contatos');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Campanhas ────────────────────────────────────────────────────────────────

router.get('/campanhas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM campanhas ORDER BY criado_em DESC');
    res.json({ ok: true, data: result.rows });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas', async (req, res) => {
  try {
    const { nome, template } = req.body;
    if (!nome || !template) return res.status(400).json({ ok: false, error: 'nome e template são obrigatórios' });
    const campanha = await pool.query('INSERT INTO campanhas (nome, template) VALUES ($1, $2) RETURNING *', [nome, template]);
    const campanhaId = campanha.rows[0].id;
    const contatos = await pool.query('SELECT id FROM contatos');
    if (!contatos.rows.length) return res.status(400).json({ ok: false, error: 'Nenhum contato importado ainda' });
    const values = contatos.rows.map(c => `(${campanhaId}, ${c.id})`).join(',');
    await pool.query(`INSERT INTO disparos (campanha_id, contato_id) VALUES ${values}`);
    await pool.query('UPDATE campanhas SET total_contatos = $1 WHERE id = $2', [contatos.rows.length, campanhaId]);
    res.json({ ok: true, data: campanha.rows[0] });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Editar template de uma campanha (só em rascunho ou pausado)
router.patch('/campanhas/:id/template', async (req, res) => {
  try {
    const { template } = req.body;
    if (!template) return res.status(400).json({ ok: false, error: 'template obrigatório' });
    const result = await pool.query(
      `UPDATE campanhas SET template = $1 WHERE id = $2 AND status IN ('rascunho','pausado') RETURNING *`,
      [template, req.params.id]
    );
    if (!result.rows.length) return res.status(400).json({ ok: false, error: 'Campanha não encontrada ou não editável' });
    // Atualiza mensagens ainda pendentes
    const campanha = result.rows[0];
    const pendentes = await pool.query(`
      SELECT d.id, c.numero, c.nome, c.dados FROM disparos d
      JOIN contatos c ON c.id = d.contato_id
      WHERE d.campanha_id = $1 AND d.status = 'pendente'
    `, [campanha.id]);
    for (const row of pendentes.rows) {
      const dados = { nome: row.nome, numero: row.numero, ...row.dados };
      const msg = renderTemplate(template, dados);
      await pool.query('UPDATE disparos SET mensagem = $1 WHERE id = $2', [msg, row.id]);
    }
    res.json({ ok: true, data: campanha });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/iniciar', async (req, res) => {
  try {
    const total = await enfileirarCampanha(parseInt(req.params.id));
    res.json({ ok: true, message: `${total} mensagens enfileiradas` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/:id/pausar', async (req, res) => {
  try {
    await pausarCampanha(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/campanhas/retomar', async (req, res) => {
  try {
    await retomar();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.delete('/campanhas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM campanhas WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Fila ─────────────────────────────────────────────────────────────────────

router.get('/fila/status', async (req, res) => {
  try {
    res.json({ ok: true, data: await statusFila() });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

module.exports = router;
