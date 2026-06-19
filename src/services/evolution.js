require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const config = require('./config');

const AQUECIMENTO = [20,30,40,50,60,80,100,120,150];

function limitePorDia(diasAtivo) {
  return AQUECIMENTO[Math.min(diasAtivo, AQUECIMENTO.length - 1)];
}

async function getApi() {
  const url = await config.get('evolution_url', process.env.EVOLUTION_API_URL || 'http://localhost:8080');
  const key = await config.get('evolution_key', process.env.EVOLUTION_API_KEY || '');
  return axios.create({
    baseURL: url,
    headers: { 'apikey': key, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

// ─── Formatação ───────────────────────────────────────────────────────────────

function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, '');
  if (!limpo.startsWith('55')) limpo = '55' + limpo;
  return limpo;
}

function limparJid(jid) {
  return String(jid).replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
}

async function verificarNumero(numero, instancia) {
  const api = await getApi();
  const numeroLimpo = formatarNumero(numero);
  try {
    const r = await api.post('/chat/whatsappNumbers/' + instancia, { numbers: [numeroLimpo] });
    if (r.data && r.data.length > 0 && r.data[0].exists) {
      const jidBruto = r.data[0].jid || r.data[0].number || numeroLimpo;
      return limparJid(jidBruto);
    }
    return null;
  } catch (erro) {
    console.warn('[VERIFY] Falha na verificação de ' + numeroLimpo + ': ' + erro.message);
    return numeroLimpo;
  }
}

// ─── Gestão de Chips ─────────────────────────────────────────────────────────

async function adicionarChip(nome, instancia, limiteDiario) {
  const limite = limiteDiario || AQUECIMENTO[0];
  const result = await pool.query(
    "INSERT INTO chips (nome, instancia, status, limite_diario, dias_ativo) VALUES ($1, $2, 'desconectado', $3, 0) RETURNING *",
    [nome, instancia, limite]
  );
  return result.rows[0];
}

async function listarChips() {
  const result = await pool.query('SELECT * FROM chips ORDER BY criado_em ASC');
  return result.rows;
}

async function removerChip(id) {
  const result = await pool.query('SELECT instancia FROM chips WHERE id = $1', [id]);
  if (result.rows.length > 0) {
    const instanciaNome = result.rows[0].instancia;
    try {
      const api = await getApi();
      await api.delete('/instance/delete/' + instanciaNome);
      console.log('[CHIP] Sessão ' + instanciaNome + ' destruída.');
    } catch (e) {
      console.log('[CHIP] Aviso ao deletar: ' + e.message);
    }
  }
  await pool.query('DELETE FROM chips WHERE id = $1', [id]);
}

async function atualizarLimiteDiario(id, limite) {
  const result = await pool.query('UPDATE chips SET limite_diario = $1 WHERE id = $2 RETURNING *', [limite, id]);
  return result.rows[0];
}

async function statusChip(instancia) {
  try {
    const api = await getApi();
    const r = await api.get('/instance/connectionState/' + instancia);
    const state = r.data?.instance?.state || r.data?.state || 'desconhecido';
    await pool.query('UPDATE chips SET status = $1, ultimo_ping = NOW() WHERE instancia = $2', [state, instancia]);
    return state;
  } catch (e) {
    await pool.query("UPDATE chips SET status = 'erro' WHERE instancia = $1", [instancia]);
    return 'erro';
  }
}

async function qrcodeChip(instancia) {
  const api = await getApi();
  await api.post('/instance/create', { instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' }).catch(() => null);
  const qr = await api.get('/instance/connect/' + instancia);
  return qr.data;
}

async function criarInstancia(instancia) {
  const api = await getApi();
  const r = await api.post('/instance/create', { instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
  try {
    await api.post('/webhook/set/' + instancia, {
      enabled: true,
      url: 'http://app:3000/webhook/evolution',
      webhookByEvents: false,
      events: ['MESSAGES_UPSERT']
    });
    console.log('[OPT-OUT] Webhook ativado para: ' + instancia);
  } catch(e) {
    console.log('[OPT-OUT] Erro webhook ' + instancia + ': ' + e.message);
  }
  return r.data;
}

async function proximoChip() {
  const chips = await pool.query(`
    SELECT * FROM chips
    WHERE status = 'open'
      AND enviados_hoje < limite_diario
      AND (pausado_ate IS NULL OR pausado_ate < NOW())
    ORDER BY enviados_hoje ASC, ultimo_uso ASC NULLS FIRST
    LIMIT 1
  `);
  if (!chips.rows.length) {
    const todos = await pool.query("SELECT COUNT(*) FROM chips WHERE status = 'open'");
    if (parseInt(todos.rows[0].count) > 0) throw new Error('Limite diário atingido em todos os chips.');
    throw new Error('Nenhum chip conectado disponível.');
  }
  return chips.rows[0];
}

async function registrarUso(chipId) {
  await pool.query(
    'UPDATE chips SET enviados_hoje = enviados_hoje + 1, total_enviados = total_enviados + 1, ultimo_uso = NOW() WHERE id = $1',
    [chipId]
  );
  await pool.query(
    'INSERT INTO chip_historico (chip_id, data, enviados) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (chip_id, data) DO UPDATE SET enviados = chip_historico.enviados + 1',
    [chipId]
  );
}

async function registrarFalha(chipId) {
  await pool.query(
    'INSERT INTO chip_historico (chip_id, data, falhas) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (chip_id, data) DO UPDATE SET falhas = chip_historico.falhas + 1',
    [chipId]
  );
}

async function resetarContadoresDiarios() {
  const chips = await pool.query('SELECT id, dias_ativo FROM chips');
  for (const chip of chips.rows) {
    const novosDias = chip.dias_ativo + 1;
    const novoLimite = limitePorDia(novosDias);
    await pool.query(
      'UPDATE chips SET enviados_hoje = 0, dias_ativo = $1, limite_diario = $2, pausado_ate = NULL WHERE id = $3',
      [novosDias, novoLimite, chip.id]
    );
  }
}

async function pausarChip(id, horas) {
  horas = horas || 1;
  const ate = new Date(Date.now() + horas * 60 * 60 * 1000);
  await pool.query('UPDATE chips SET pausado_ate = $1 WHERE id = $2', [ate, id]);
  return ate;
}

async function marcarComoLida(instancia, messageKey) {
  try {
    const api = await getApi();
    await api.post('/chat/markMessageAsRead/' + instancia, {
      readMessages: [{ remoteJid: messageKey.remoteJid, fromMe: messageKey.fromMe, id: messageKey.id }]
    });
  } catch (e) { /* silencioso */ }
}

// ─── Envio de Mensagem (texto) ────────────────────────────────────────────────
async function enviarMensagem(numero, mensagem, instancia) {
  const api = await getApi();
  const numeroLimpo = await verificarNumero(numero, instancia);
  if (!numeroLimpo) throw new Error('Número ' + numero + ' não possui WhatsApp registrado.');

  console.log('[SEND] → ' + numeroLimpo + ' via ' + instancia);

  // Presence fire-and-forget (não bloqueia)
  api.post('/chat/sendPresence/' + instancia, { number: numeroLimpo, presence: 'composing', delay: 1000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));

  const r = await api.post('/message/sendText/' + instancia, {
    number: numeroLimpo,
    textMessage: { text: mensagem }
  });

  console.log('[SEND] ✅ ' + numeroLimpo);
  return r.data;
}

// ─── Envio de Imagem PNG/JPEG ─────────────────────────────────────────────────
// midiaBase64 : conteúdo do arquivo em base64 (aceita com ou sem prefixo data:)
// mimetype    : 'image/png' ou 'image/jpeg'
// midiaNome   : nome original do arquivo (ex: 'promo.jpg')
// mensagem    : texto vai como legenda embaixo da imagem
async function enviarImagem(numero, mensagem, instancia, midiaBase64, mimetype, midiaNome) {
  const api = await getApi();
  const numeroLimpo = await verificarNumero(numero, instancia);
  if (!numeroLimpo) throw new Error('Número ' + numero + ' não possui WhatsApp registrado.');

  console.log('[SEND-IMG] → ' + numeroLimpo + ' via ' + instancia);

  // Presence fire-and-forget
  api.post('/chat/sendPresence/' + instancia, { number: numeroLimpo, presence: 'composing', delay: 1000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));

  // Remove prefixo data URI se presente
  const base64Limpo = midiaBase64.replace(/^data:image\/\w+;base64,/, '');

  const r = await api.post('/message/sendMedia/' + instancia, {
    number: numeroLimpo,
    mediatype: 'image',
    mimetype: mimetype || 'image/jpeg',
    caption: mensagem || '',
    media: base64Limpo,
    fileName: midiaNome || 'imagem.jpg',
  });

  console.log('[SEND-IMG] ✅ ' + numeroLimpo);
  return r.data;
}

// ─── Aquecimento Interno ──────────────────────────────────────────────────────
async function obterNumeroDaInstancia(instancia) {
  try {
    const api = await getApi();
    const r = await api.get('/instance/connectionState/' + instancia);
    const jid = r.data?.instance?.user?.id || r.data?.user?.id || r.data?.instance?.ownerJid;
    if (jid) return limparJid(jid);
    return null;
  } catch (e) { return null; }
}

async function aquecerChipsInternamente() {
  try {
    const res = await pool.query("SELECT * FROM chips WHERE status = 'open'");
    const ativos = res.rows;
    if (ativos.length < 2) return;
    const rem = ativos[Math.floor(Math.random() * ativos.length)];
    let dest = ativos[Math.floor(Math.random() * ativos.length)];
    while (dest.id === rem.id) dest = ativos[Math.floor(Math.random() * ativos.length)];
    const numDest = await obterNumeroDaInstancia(dest.instancia);
    if (!numDest) return;
    const frases = ['Oi, tudo bem?', 'Teste de sinal, recebido?', 'Olá, tudo ok?'];
    await enviarMensagem(numDest, frases[Math.floor(Math.random() * frases.length)], rem.instancia);
  } catch (e) { /* silencioso */ }
}

module.exports = {
  enviarMensagem,
  enviarImagem,
  formatarNumero,
  limparJid,
  limitePorDia,
  AQUECIMENTO,
  listarChips,
  adicionarChip,
  removerChip,
  statusChip,
  qrcodeChip,
  criarInstancia,
  proximoChip,
  registrarUso,
  registrarFalha,
  resetarContadoresDiarios,
  pausarChip,
  atualizarLimiteDiario,
  verificarNumero,
  marcarComoLida,
  aquecerChipsInternamente,
};
