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

// ─── Diagnóstico de erros da Evolution API ────────────────────────────────────
// Em vez de propagar só "Request failed with status code 400" (genérico do axios),
// extrai a mensagem real que a API devolveu — isso é o que aparece nos logs do
// painel a partir de agora, sem precisar ir direto no docker logs toda vez.
function extrairErroAPI(err) {
  if (err.response && err.response.data) {
    const d = err.response.data;
    const msgs = d.message || (d.response && d.response.message) || d.error || d;
    const detalhe = Array.isArray(msgs) ? msgs.join('; ') : (typeof msgs === 'string' ? msgs : JSON.stringify(msgs));
    return 'HTTP ' + err.response.status + ' — ' + detalhe;
  }
  if (err.request) return 'Sem resposta da Evolution API (timeout/rede): ' + err.message;
  return err.message;
}

// Erros 4xx (exceto 429, rate-limit) são de configuração/formato — tentar de novo
// não resolve. Usado para a fila não ficar re-tentando (e atrasando tudo) à toa.
function erroEhPermanente(err) {
  const status = err.response && err.response.status;
  return !!status && status >= 400 && status < 500 && status !== 429;
}

// ─── Formatação ───────────────────────────────────────────────────────────────

function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, '');
  if (!limpo.startsWith('55')) limpo = '55' + limpo;
  return limpo;
  // NÃO remova o 9 extra — celulares BR pós-2012 precisam dele
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
    const msgErro = extrairErroAPI(erro);
    console.warn('[VERIFY] Falha na verificação de ' + numeroLimpo + ': ' + msgErro);
    // Se a API estiver offline/desconectada, repassa o erro para a fila parar!
    if (msgErro.includes('Connection Closed') || msgErro.includes('disconnected')) {
      throw new Error(msgErro); 
    }
    return numeroLimpo; // Só aceita forçar o envio se for outro erro menor
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
      console.log('[CHIP] Aviso ao deletar: ' + extrairErroAPI(e));
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
    console.warn('[CHIP] Erro ao checar status de ' + instancia + ': ' + extrairErroAPI(e));
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
  // Registra TODOS os eventos num único webhook — CONNECTION_UPDATE/QRCODE_UPDATED
  // para auto-pause/retomada, e MESSAGES_UPSERT para opt-out.
  // A Evolution API só guarda 1 webhook por instância; registrar duas vezes
  // (aqui e no botão do painel) sobreescrevia metade dos eventos.
  try {
    const serverUrl = await require('./config').get('evolution_url', 'http://app:3000');
    // Usa /api/webhook/evolution como destino — independente de onde o servidor está hospedado
    const webhookBase = serverUrl.replace(/\/evolution.*$/, '').replace(':8080', ':3000').replace('evolution-api', 'app');
    await api.post('/webhook/set/' + instancia, {
      enabled: true,
      url: webhookBase + '/webhook/evolution',
      webhookByEvents: false,
      events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED']
    });
    console.log('[WEBHOOK] Registrado para ' + instancia + ' (3 eventos)');
  } catch(e) {
    console.warn('[WEBHOOK] Erro ao registrar webhook em ' + instancia + ': ' + e.message);
    console.warn('[WEBHOOK] → Configure manualmente em Configurações → Webhook');
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

  // Presence fire-and-forget (não bloqueia, mas agora loga o motivo se falhar)
  api.post('/chat/sendPresence/' + instancia, {
    number: numeroLimpo,
    options: { delay: 1000, presence: 'composing' }
  }).catch(e => console.warn('[PRESENCE] Aviso (' + instancia + '): ' + extrairErroAPI(e)));
  await new Promise(r => setTimeout(r, 1000));

  let r;
  try {
    r = await api.post('/message/sendText/' + instancia, {
      number: numeroLimpo,
      textMessage: { text: mensagem }
    });
  } catch (err) {
    const detalhe = extrairErroAPI(err);
    console.error('[SEND] ❌ ' + numeroLimpo + ': ' + detalhe);
    const erroFinal = new Error(detalhe);
    erroFinal.semRetry = erroEhPermanente(err);
    throw erroFinal;
  }

  // Verificação extra: resposta 200 mas sem corpo reconhecível costuma indicar
  // "sucesso fantasma" (a API aceitou a requisição mas não confirmou o envio).
  // Impede o envio fantasma de registrar sucesso
  if (!r.data || (typeof r.data === 'object' && Object.keys(r.data).length === 0)) {
    console.warn('[SEND] ⚠ Sucesso fantasma detectado para ' + numeroLimpo);
    throw new Error('Falha fantasma: A API aceitou, mas o WhatsApp não confirmou o despacho.');
  }

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

  // Presence fire-and-forget (não bloqueia, mas agora loga o motivo se falhar)
  api.post('/chat/sendPresence/' + instancia, {
    number: numeroLimpo,
    options: { delay: 1000, presence: 'composing' }
  }).catch(e => console.warn('[PRESENCE] Aviso (' + instancia + '): ' + extrairErroAPI(e)));
  await new Promise(r => setTimeout(r, 1000));

  // Remove prefixo data URI se presente
  const base64Limpo = midiaBase64.replace(/^data:image\/\w+;base64,/, '');

  let r;
  try {
    r = await api.post('/message/sendMedia/' + instancia, {
      number: numeroLimpo,
      options: { delay: 1200, presence: 'composing' },
      mediaMessage: {
        mediatype: 'image',
        mimetype: mimetype || 'image/jpeg',
        caption: mensagem || '',
        media: base64Limpo,
        fileName: midiaNome || 'imagem.jpg',
      }
    });
  } catch (err) {
    const detalhe = extrairErroAPI(err);
    console.error('[SEND-IMG] ❌ ' + numeroLimpo + ': ' + detalhe);
    const erroFinal = new Error(detalhe);
    erroFinal.semRetry = erroEhPermanente(err);
    throw erroFinal;
  }

  if (!r.data || (typeof r.data === 'object' && Object.keys(r.data).length === 0)) {
    console.warn('[SEND-MEDIA] ⚠ Sucesso fantasma detectado para ' + numeroLimpo);
    throw new Error('Falha fantasma de mídia: API aceitou, mas WhatsApp falhou.');
  }

  console.log('[SEND] ✅ ' + numeroLimpo + ' (com mídia)');
  return r.data;

  if (!r.data || (typeof r.data === 'object' && Object.keys(r.data).length === 0)) {
    console.warn('[SEND-IMG] ⚠ Resposta vazia/suspeita da API para ' + numeroLimpo + ' — confirme manualmente se chegou.');
  }

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
  extrairErroAPI,
  erroEhPermanente,
};
