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

function erroEhPermanente(err) {
  const status = err.response && err.response.status;
  return !!status && status >= 400 && status < 500 && status !== 429;
}

// ─── Formatação ───────────────────────────────────────────────────────────────

function formatarNumero(numeroBruto) {
  let limpo = String(numeroBruto).replace(/\D/g, '');

  // Remove zero à esquerda (ex: 011999... → 11999...)
  if (limpo.startsWith('0')) {
    limpo = limpo.substring(1);
  }

  // Adiciona DDI do Brasil se não tiver
  if (!limpo.startsWith('55')) {
    limpo = '55' + limpo;
  }

  // A partir daqui, limpo começa com 55 + DDD (2 dígitos) + número
  const ddd = parseInt(limpo.substring(2, 4));
  const telefone = limpo.substring(4);

  // Números brasileiros no WhatsApp: todos os celulares têm 9 dígitos (com o nono dígito).
  // Se o número vier com 8 dígitos (sem o nono), adiciona o 9.
  // Isso vale para QUALQUER DDD — o nono dígito é obrigatório em todo o Brasil desde 2016.
  if (telefone.length === 8 && (telefone.startsWith('6') || telefone.startsWith('7') ||
      telefone.startsWith('8') || telefone.startsWith('9'))) {
    return '55' + ddd + '9' + telefone;
  }

  // Se já tem 9 dígitos (formato correto), retorna como está
  return limpo;
}

function limparJid(jid) {
  return String(jid).replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
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
  try {
    const serverUrl = await require('./config').get('evolution_url', 'http://app:3000');
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
  if (!numeroLimpo) throw new Error('Número ' + numero + ' não possui WhatsApp registado.');

  console.log('[SEND] → ' + numeroLimpo + ' via ' + instancia);

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

  // BLOQUEIO DO SUCESSO FANTASMA
  if (!r.data || (typeof r.data === 'object' && Object.keys(r.data).length === 0)) {
    console.warn('[SEND] ⚠ Sucesso fantasma detetado para ' + numeroLimpo);
    throw new Error('Falha fantasma: A API aceitou, mas o WhatsApp não confirmou o envio.');
  }

  console.log('[SEND] ✅ ' + numeroLimpo);
  return r.data;
}

async function verificarNumero(numero, instancia) {
  const api = await getApi();
  const numeroCorrigidoLocal = formatarNumero(numero);

  try {
    const r = await api.post('/chat/whatsappNumbers/' + instancia, { numbers: [numeroCorrigidoLocal] });
    
    if (r.data && r.data.length > 0 && r.data[0].exists) {
      const jidBruto = r.data[0].jid || r.data[0].number || numeroCorrigidoLocal;
      return limparJid(jidBruto);
    }
    
    return null; 
    
  } catch (erro) {
    const msgErro = extrairErroAPI(erro);
    console.warn('[VERIFY] Falha na verificação de rede para ' + numeroCorrigidoLocal + ': ' + msgErro);
    
    // A TRAVA DE SEGURANÇA
    if (msgErro.includes('Connection Closed') || msgErro.includes('disconnected') || msgErro.includes('timeout')) {
      throw new Error('Sessão do WhatsApp desconectada ou inacessível: ' + msgErro); 
    }

    // FALLBACK
    console.log('[VERIFY] A usar formatação local (fallback) para: ' + numeroCorrigidoLocal);
    return numeroCorrigidoLocal;
  }
}

// ─── Envio de Imagem PNG/JPEG ─────────────────────────────────────────────────
async function enviarImagem(numero, mensagem, instancia, midiaBase64, mimetype, midiaNome) {
  const api = await getApi();
  const numeroLimpo = await verificarNumero(numero, instancia);
  if (!numeroLimpo) throw new Error('Número ' + numero + ' não possui WhatsApp registado.');

  console.log('[SEND-IMG] → ' + numeroLimpo + ' via ' + instancia);

  api.post('/chat/sendPresence/' + instancia, {
    number: numeroLimpo,
    options: { delay: 1000, presence: 'composing' }
  }).catch(e => console.warn('[PRESENCE] Aviso (' + instancia + '): ' + extrairErroAPI(e)));
  await new Promise(r => setTimeout(r, 1000));

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

  // BLOQUEIO DO SUCESSO FANTASMA (Mídia)
  if (!r.data || (typeof r.data === 'object' && Object.keys(r.data).length === 0)) {
    console.warn('[SEND-MEDIA] ⚠ Sucesso fantasma detetado para ' + numeroLimpo);
    throw new Error('Falha fantasma de mídia: API aceitou, mas WhatsApp falhou.');
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