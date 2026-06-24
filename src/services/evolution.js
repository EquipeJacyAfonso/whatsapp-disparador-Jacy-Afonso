require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const config = require('./config');
const { processarSpintax } = require('./antiban');

const AQUECIMENTO_BASE = [15, 25, 40, 60, 80, 100, 120, 150];

function limitePorDia(diasAtivo) {
  const base = AQUECIMENTO_BASE[Math.min(diasAtivo, AQUECIMENTO_BASE.length - 1)];
  const variacao = Math.floor(Math.random() * 7) - 2;
  return Math.max(10, base + variacao);
}

async function getApi(instancia) {
  const url = await config.get('evolution_url', process.env.EVOLUTION_API_URL || 'http://localhost:8080');
  const key = await config.get('evolution_key', process.env.EVOLUTION_API_KEY || '');
  return axios.create({ baseURL: url, headers: { 'apikey': key, 'Content-Type': 'application/json' }, timeout: 15000 });
}

function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, ''); if (!limpo.startsWith('55')) limpo = `55${limpo}`;
  return `${limpo}@s.whatsapp.net`;
}

async function verificarNumero(numero, instancia) {
  const api = await getApi(instancia);
  let numeroLimpo = String(numero).replace(/\D/g, ''); if (!numeroLimpo.startsWith('55')) numeroLimpo = `55${numeroLimpo}`;
  try {
    const r = await api.post(`/chat/whatsappNumbers/${instancia}`, { numbers: [numeroLimpo] });
    if (r.data && r.data.length > 0 && r.data[0].exists) return r.data[0].jid || `${r.data[0].number}@s.whatsapp.net` || `${numeroLimpo}@s.whatsapp.net`;
    return null; 
  } catch (erro) { return `${numeroLimpo}@s.whatsapp.net`; }
}

async function verificarLoteNumeros(numeros, instancia) {
  const api = await getApi(instancia);
  const limpos = numeros.map(n => {
    let num = String(n).replace(/\D/g, ''); if (!num.startsWith('55')) num = `55${num}`; return num;
  });
  try {
    const r = await api.post(`/chat/whatsappNumbers/${instancia}`, { numbers: limpos }); return r.data; 
  } catch(err) {
    const erroMsg = err.response?.data?.message || err.message;
    throw new Error(erroMsg);
  }
}

async function adicionarChip(nome, instancia, limiteDiario = null) {
  const limite = limiteDiario || limitePorDia(0); 
  const result = await pool.query(`INSERT INTO chips (nome, instancia, status, limite_diario, dias_ativo) VALUES ($1, $2, 'desconectado', $3, 0) RETURNING *`, [nome, instancia, limite]);
  return result.rows[0];
}

async function listarChips() { const result = await pool.query('SELECT * FROM chips ORDER BY criado_em ASC'); return result.rows; }

async function removerChip(id) {
  const result = await pool.query('SELECT instancia FROM chips WHERE id = $1', [id]);
  if (result.rows.length > 0) {
    try { const api = await getApi(result.rows[0].instancia); await api.delete(`/instance/delete/${result.rows[0].instancia}`); } catch (e) { }
  }
  await pool.query('DELETE FROM chips WHERE id = $1', [id]);
}

async function atualizarLimiteDiario(id, limite) {
  const result = await pool.query('UPDATE chips SET limite_diario = $1 WHERE id = $2 RETURNING *', [limite, id]); return result.rows[0];
}

async function statusChip(instancia) {
  try {
    const api = await getApi(instancia); const r = await api.get(`/instance/connectionState/${instancia}`);
    const state = r.data?.instance?.state || r.data?.state || 'desconhecido';
    await pool.query(`UPDATE chips SET status = $1, ultimo_ping = NOW() WHERE instancia = $2`, [state, instancia]); return state;
  } catch (e) { await pool.query(`UPDATE chips SET status = 'erro' WHERE instancia = $1`, [instancia]); return 'erro'; }
}

async function qrcodeChip(instancia) {
  const api = await getApi(instancia);
  await api.post('/instance/create', { instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' }).catch(() => null); 
  const qr = await api.get(`/instance/connect/${instancia}`); return qr.data;
}

async function criarInstancia(instancia) {
  const api = await getApi(instancia);
  const r = await api.post('/instance/create', { instanceName: instancia, qrcode: true, integration: 'WHATSAPP-BAILEYS' });
  try { await api.post(`/webhook/set/${instancia}`, { enabled: true, url: "http://app:3000/webhook/evolution", webhookByEvents: false, events: ["MESSAGES_UPSERT"] }); } catch(e) { }
  return r.data;
}

async function proximoChip() {
  const chips = await pool.query(`SELECT * FROM chips WHERE status = 'open' AND enviados_hoje < limite_diario AND (pausado_ate IS NULL OR pausado_ate < NOW()) ORDER BY enviados_hoje ASC, ultimo_uso ASC NULLS FIRST LIMIT 1`);
  if (!chips.rows.length) throw new Error('Nenhum chip conectado disponível ou limite atingido.'); return chips.rows[0];
}

async function registrarUso(chipId) {
  await pool.query(`UPDATE chips SET enviados_hoje = enviados_hoje + 1, total_enviados = total_enviados + 1, ultimo_uso = NOW() WHERE id = $1`, [chipId]);
  await pool.query(`INSERT INTO chip_historico (chip_id, data, enviados) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (chip_id, data) DO UPDATE SET enviados = chip_historico.enviados + 1`, [chipId]);
}

async function registrarFalha(chipId) {
  await pool.query(`INSERT INTO chip_historico (chip_id, data, falhas) VALUES ($1, CURRENT_DATE, 1) ON CONFLICT (chip_id, data) DO UPDATE SET falhas = chip_historico.falhas + 1`, [chipId]);
}

async function resetarContadoresDiarios() {
  const chips = await pool.query(`SELECT id, dias_ativo FROM chips`);
  for (const chip of chips.rows) {
    const novosDias = chip.dias_ativo + 1; const novoLimite = limitePorDia(novosDias);
    await pool.query(`UPDATE chips SET enviados_hoje = 0, dias_ativo = $1, limite_diario = $2, pausado_ate = NULL WHERE id = $3`, [novosDias, novoLimite, chip.id]);
  }
}

async function pausarChip(id, horas = 1) {
  const ate = new Date(Date.now() + horas * 60 * 60 * 1000); await pool.query(`UPDATE chips SET pausado_ate = $1 WHERE id = $2`, [ate, id]); return ate;
}

async function marcarComoLida(instancia, messageKey) {
  try { const api = await getApi(instancia); await api.post(`/chat/markMessageAsRead/${instancia}`, { readMessages: [{ remoteJid: messageKey.remoteJid, fromMe: messageKey.fromMe, id: messageKey.id }] }); } catch (erro) { }
}

async function enviarMensagem(numero, mensagem, instancia) {
  const api = await getApi(instancia); const jidValidado = await verificarNumero(numero, instancia);
  if (!jidValidado || jidValidado === true) throw new Error('O número não possui WhatsApp registado.');
  const numeroFinalParaEnvio = jidValidado.split('@')[0]; const tempoEspera = Math.floor(Math.random() * 3000) + 3000; 
  try { const r = await api.post(`/message/sendText/${instancia}`, { number: numeroFinalParaEnvio, options: { delay: tempoEspera, presence: 'composing' }, textMessage: { text: mensagem } }); return r.data; } catch(err) { throw err; }
}

// ─── A IMAGEM AGORA VAI FUNCIONAR PERFEITAMENTE ───
async function enviarImagem(numero, legenda, mediaUrlOuBase64, instancia) {
  const api = await getApi(instancia); 
  const jidValidado = await verificarNumero(numero, instancia);
  
  if (!jidValidado || jidValidado === true) throw new Error('O número não possui WhatsApp registado.');
  const numeroFinalParaEnvio = jidValidado.split('@')[0]; 
  const tempoEspera = Math.floor(Math.random() * 3000) + 3000; 

  let mediaPura = mediaUrlOuBase64;
  if (mediaPura && mediaPura.includes('base64,')) {
    mediaPura = mediaPura.split('base64,')[1];
  }

  try { 
    const r = await api.post(`/message/sendMedia/${instancia}`, { 
      number: numeroFinalParaEnvio, 
      options: { delay: tempoEspera, presence: 'composing' }, 
      mediaMessage: { mediatype: 'image', caption: legenda || '', media: mediaPura } 
    }); 
    return r.data; 
  } catch(err) { throw err; }
}

async function obterNumeroDaInstancia(instancia) {
  try { const api = await getApi(instancia); const r = await api.get(`/instance/connectionState/${instancia}`); const jid = r.data?.instance?.user?.id || r.data?.user?.id || r.data?.instance?.ownerJid; if (jid) return jid.replace(/[^0-9]/g, ''); return null; } catch (e) { return null; }
}

async function aquecerChipsInternamente() {
  try {
    const res = await pool.query(`SELECT * FROM chips WHERE status = 'open'`); const chipsAtivos = res.rows; if (chipsAtivos.length < 2) return; 
    const remetente = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)]; let destinatario = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)]; while (destinatario.id === remetente.id) destinatario = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];
    const numeroDestinatario = await obterNumeroDaInstancia(destinatario.instancia); if (!numeroDestinatario) return;
    const frasesAquecimento = ["{Olá|Oi|Opa}, {tudo bem?|como vai?|tranquilo?}", "{Bom dia|Boa tarde|Boa noite}! {Sabe me dizer se vai chover hoje?|Tudo certo por aí?}", "Estava a tentar ligar-te, mas {caiu|não deu}. {Tudo ok?|Podes falar agora?}", "Acho que perdi o teu número novo. É {este mesmo|aqui}?", "Teste de {conexão|sistema|sinal}, {tudo ok|recebido}?", "{Desculpa a demora|Foi mal a demora}, {estava em reunião|estava a conduzir}. {Fala aí|Diz lá}.", "Que {calor|frio} {hoje|agora}, {né?|não acha?}"];
    const fraseSorteada = frasesAquecimento[Math.floor(Math.random() * frasesAquecimento.length)];
    await enviarMensagem(numeroDestinatario, processarSpintax(fraseSorteada), remetente.instancia);
  } catch (erro) { }
}

module.exports = {
  enviarMensagem, enviarImagem, formatarNumero, limitePorDia, AQUECIMENTO_BASE, listarChips, adicionarChip, removerChip, statusChip, qrcodeChip, criarInstancia, proximoChip, registrarUso, registrarFalha, resetarContadoresDiarios, pausarChip, atualizarLimiteDiario, verificarNumero, marcarComoLida, aquecerChipsInternamente, verificarLoteNumeros
};