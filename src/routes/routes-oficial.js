// Rotas para gerenciamento da WhatsApp Business Cloud API (oficial).
// Monte este arquivo em src/routes/oficial.js e registre no server.js/routes/index.js:
//   app.use('/api/oficial', require('./routes/oficial'));
// Ou, se preferir manter tudo em um único arquivo de rotas, copie os blocos
// abaixo para dentro do src/routes/index.js existente.

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db');
const { requireAuth } = require('../services/auth');
const {
  adicionarContaOficial, listarContasOficiais, removerContaOficial, atualizarQualidade,
  criarTemplate, sincronizarTemplates, listarTemplates, removerTemplate,
  processarWebhookStatus,
} = require('../services/whatsapp-oficial');

// ─── Contas oficiais ───────────────────────────────────────────────────────────

router.get('/contas', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await listarContasOficiais() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/contas', requireAuth, async (req, res) => {
  try {
    const { nome, phoneNumberId, wabaId, accessToken, limiteDiario } = req.body;
    const conta = await adicionarContaOficial({ nome, phoneNumberId, wabaId, accessToken, limiteDiario });
    res.json({ ok: true, data: conta });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.delete('/contas/:id', requireAuth, async (req, res) => {
  try { await removerContaOficial(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/contas/:id/qualidade', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await atualizarQualidade(req.params.id) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// ─── Templates ────────────────────────────────────────────────────────────────

router.get('/templates', requireAuth, async (req, res) => {
  try {
    const { contaId } = req.query;
    res.json({ ok: true, data: await listarTemplates(contaId ? parseInt(contaId) : null) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

router.post('/templates', requireAuth, async (req, res) => {
  try {
    const { contaId, nome, categoria, idioma, corpo, variaveis, cabecalhoTexto, rodape } = req.body;
    if (!contaId || !nome || !categoria || !corpo) {
      return res.status(400).json({ ok: false, error: 'contaId, nome, categoria e corpo são obrigatórios' });
    }
    const template = await criarTemplate({ contaId, nome, categoria, idioma, corpo, variaveis, cabecalhoTexto, rodape });
    res.json({ ok: true, data: template });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.post('/templates/sincronizar/:contaId', requireAuth, async (req, res) => {
  try { res.json({ ok: true, data: await sincronizarTemplates(req.params.contaId) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

router.delete('/templates/:id', requireAuth, async (req, res) => {
  try { await removerTemplate(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Webhook da Meta (recebe status de entrega) ────────────────────────────────
// Precisa ficar FORA do requireAuth — a Meta chama esse endpoint diretamente.
// O verify token abaixo é o mesmo configurado no App do Meta for Developers.

/**
 * Compara duas strings em tempo constante, evitando timing attacks contra
 * o verify_token do webhook (um atacante não consegue inferir o token
 * caractere-a-caractere medindo o tempo de resposta de "===").
 */
function comparacaoSegura(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  // Buffers de tamanhos diferentes fariam timingSafeEqual lançar exceção —
  // trata isso como "não bate" sem vazar informação de tamanho por exceção.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

router.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || '';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && comparacaoSegura(token, VERIFY_TOKEN)) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.post('/webhook', express.json(), async (req, res) => {
  res.sendStatus(200); // responde rápido — Meta exige resposta em poucos segundos
  await processarWebhookStatus(req.body);
});

module.exports = router;
