require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const config = require('./config');

const AQUECIMENTO = [20,30,40,50,60,80,100,120,150];

function limitePorDia(diasAtivo) {
  return AQUECIMENTO[Math.min(diasAtivo, AQUECIMENTO.length - 1)];
}

async function getApi(instancia) {
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
  // Retorna APENAS os dígitos com código do país — sem @s.whatsapp.net
  let limpo = String(numero).replace(/\D/g, '');
  if (!limpo.startsWith('55')) limpo = `55${limpo}`;
  return limpo;
}

// Remove o sufixo JID se presente — garante número limpo
function limparJid(jid) {
  return String(jid).replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
}

async function verificarNumero(numero, instancia) {
  const api = await getApi(instancia);
  const numeroLimpo = formatarNumero(numero);

  try {
    const r = await api.post(`/chat/whatsappNumbers/${instancia}`, {
      numbers: [numeroLimpo]
    });

    if (r.data && r.data.length > 0 && r.data[0].exists) {
      const jidBruto = r.data[0].jid || r.data[0].number || numeroLimpo;
      return limparJid(jidBruto);
    }
    return null; // número não tem WhatsApp
  } catch (erro) {
    console.warn(`[VERIFY] Não foi possível verificar ${numeroLimpo}: ${erro.message}`);
    return numeroLimpo;
  }
}

// ─── Gestão de Chips ─────────────────────────────────────────────────────────

async function adicionarChip(nome, instancia, limiteDiario = null) {
  const limite = limiteDiario || AQUECIMENTO[0];
  const result = await pool.query(
    `INSERT INTO chips (nome, instancia, status, limite_diario, dias_ativo)
     VALUES ($1, $2, 'desconectado', $3, 0) RETURNING *`,
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
      const api = await getApi(instanciaNome);
      await api.delete(`/instance/delete/${instanciaNome}`);
      console.log(`[CHIP] Sessão ${instanciaNome} destruída da Evolution API.`);
    } catch (e) {
      console.log(`[CHIP] Aviso ao deletar na Evolution: ${e.message}`);
    }
  }
  await pool.query('DELETE FROM chips WHERE id = $1', [id]);
}

async function atualizarLimiteDiario(id, limite) {
  const result = await pool.query(
    'UPDATE chips SET limite_diario = $1 WHERE id = $2 RETURNING *',
    [limite, id]
  );
  return result.rows[0];
}

async function statusChip(instancia) {
  try {
    const api = await getApi(instancia);
    const r = await api.get(`/instance/connectionState/${instancia}`);
    const state = r.data?.instance?.state || r.data?.state || 'desconhecido';
    await pool.query(`UPDATE chips SET status = $1, ultimo_ping = NOW() WHERE instancia = $2`, [state, instancia]);
    return state;
  } catch (e) {
    await pool.query(`UPDATE chips SET status = 'erro' WHERE instancia = $1`, [instancia]);
    return 'erro';
  }
}

async function qrcodeChip(instancia) {
  const api = await getApi(instancia);
  await api.post('/instance/create', {
    instanceName: instancia,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  }).catch(() => null);
  const qr = await api.get(`/instance/connect/${instancia}`);
  return qr.data;
}

async function criarInstancia(instancia) {
  const api = await getApi(instancia);
  const r = await api.post('/instance/create', {
    instanceName: instancia,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  });
  try {
    await api.post(`/webhook/set/${instancia}`, {
      enabled: true,
      url: "http://app:3000/webhook/evolution",
      webhookByEvents: false,
      events: ["MESSAGES_UPSERT"]
    });
    console.log(`[OPT-OUT] Webhook ativado para: ${instancia}`);
  } catch(e) {
    console.log(`[OPT-OUT] Erro ao ativar webhook em ${instancia}: ${e.message}`);
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
    const todos = await pool.query(`SELECT COUNT(*) FROM chips WHERE status = 'open'`);
    if (parseInt(todos.rows[0].count) > 0) {
      throw new Error('Limite diário atingido em todos os chips.');
    }
    throw new Error('Nenhum chip conectado disponível.');
  }
  return chips.rows[0];
}

async function registrarUso(chipId) {
  await pool.query(`
    UPDATE chips SET enviados_hoje = enviados_hoje + 1, total_enviados = total_enviados + 1, ultimo_uso = NOW()
    WHERE id = $1
  `, [chipId]);
  await pool.query(`
    INSERT INTO chip_historico (chip_id, data, enviados)
    VALUES ($1, CURRENT_DATE, 1)
    ON CONFLICT (chip_id, data) DO UPDATE SET enviados = chip_historico.enviados + 1
  `, [chipId]);
}

async function registrarFalha(chipId) {
  await pool.query(`
    INSERT INTO chip_historico (chip_id, data, falhas)
    VALUES ($1, CURRENT_DATE, 1)
    ON CONFLICT (chip_id, data) DO UPDATE SET falhas = chip_historico.falhas + 1
  `, [chipId]);
}

async function resetarContadoresDiarios() {
  const chips = await pool.query(`SELECT id, dias_ativo FROM chips`);
  for (const chip of chips.rows) {
    const novosDias = chip.dias_ativo + 1;
    const novoLimite = limitePorDia(novosDias);
    await pool.query(`
      UPDATE chips SET enviados_hoje = 0, dias_ativo = $1, limite_diario = $2, pausado_ate = NULL
      WHERE id = $3
    `, [novosDias, novoLimite, chip.id]);
  }
  console.log(`[CRON] Reset diário: ${chips.rows.length} chip(s) atualizados.`);
}

async function pausarChip(id, horas = 1) {
  const ate = new Date(Date.now() + horas * 60 * 60 * 1000);
  await pool.query(`UPDATE chips SET pausado_ate = $1 WHERE id = $2`, [ate, id]);
  return ate;
}

async function marcarComoLida(instancia, messageKey) {
  try {
    const api = await getApi(instancia);
    await api.post(`/chat/markMessageAsRead/${instancia}`, {
      readMessages: [{
        remoteJid: messageKey.remoteJid,
        fromMe: messageKey.fromMe,
        id: messageKey.id
      }]
    });
  } catch (erro) {
    // Silencioso
  }
}

// ─── Envio de Mensagem Principal (Texto) ─────────────────────────────────────
async function enviarMensagem(numero, mensagem, instancia) {
  const api = await getApi(instancia);
  const numeroLimpo = await verificarNumero(numero, instancia);

  if (!numeroLimpo) throw new Error(`Número ${numero} não possui WhatsApp registrado.`);

  const numeroFinal = limparJid(numeroLimpo);
  console.log(`[SEND] → ${numeroFinal} via ${instancia}`);

  // Presence fire-and-forget (não bloqueia a fila)
  api.post(`/chat/sendPresence/${instancia}`, {
    number: numeroFinal,
    presence: 'composing',
    delay: 1000
  }).catch(() => {});

  const r = await api.post(`/message/sendText/${instancia}`, {
    number: numeroFinal,
    options: {
      delay: 1000,
      presence: "composing"
    },
    textMessage: { text: mensagem }
  });

  console.log(`[SEND] ✅ Entregue para ${numeroFinal}`);
  return r.data;
}

// ─── Envio de Imagem PNG/JPEG (Mídia) ────────────────────────────────────────
async function enviarImagem(numero, mensagem, instancia, midiaBase64, mimetype, midiaNome) {
  const api = await getApi(instancia);
  const numeroLimpo = await verificarNumero(numero, instancia);

  if (!numeroLimpo) throw new Error(`Número ${numero} não possui WhatsApp registrado.`);

  // Garante que o número está 100% limpo, sem o @s.whatsapp.net
  const numeroFinal = limparJid(numeroLimpo);
  console.log(`[SEND-IMG] → ${numeroFinal} via ${instancia}`);

  // Presence fire-and-forget
  api.post(`/chat/sendPresence/${instancia}`, {
    number: numeroFinal,
    presence: 'composing',
    delay: 1000
  }).catch(() => {});

  // Extrai apenas o Base64 puro
  const base64Limpo = midiaBase64.replace(/^data:image\/\w+;base64,/, '');

  // ESTRUTURA PLANA (FLAT): Sem "mediaMessage". É assim que a v1.8.2 processa mídias.
  const r = await api.post(`/message/sendMedia/${instancia}`, {
    number: numeroFinal,
    options: {
      delay: 1000,
      presence: "composing"
    },
    mediatype: 'image',
    mimetype: mimetype || 'image/jpeg',
    caption: mensagem || '',
    media: base64Limpo,
    fileName: midiaNome || 'imagem.jpg'
  });

  console.log(`[SEND-IMG] ✅ Entregue para ${numeroFinal}`);
  return r.data;
}

// ─── Aquecimento Interno entre Chips ─────────────────────────────────────────
async function obterNumeroDaInstancia(instancia) {
  try {
    const api = await getApi(instancia);
    const r = await api.get(`/instance/connectionState/${instancia}`);
    const jid = r.data?.instance?.user?.id || r.data?.user?.id || r.data?.instance?.ownerJid;
    if (jid) return limparJid(jid);
    return null;
  } catch (e) {
    return null;
  }
}

async function aquecerChipsInternamente() {
  try {
    const res = await pool.query(`SELECT * FROM chips WHERE status = 'open'`);
    const chipsAtivos = res.rows;
    if (chipsAtivos.length < 2) return;

    const remetente = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];
    let destinatario = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];
    while (destinatario.id === remetente.id) {
      destinatario = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];
    }

    const numeroDestinatario = await obterNumeroDaInstancia(destinatario.instancia);
    if (!numeroDestinatario) return;

    const frases = [
      "Oi, tudo bem?",
      "Teste de conexão, tudo ok?",
      "Olá, recebido?"
    ];
    const frase = frases[Math.floor(Math.random() * frases.length)];
    await enviarMensagem(numeroDestinatario, frase, remetente.instancia);
    console.log(`[WARMUP] ${remetente.instancia} → ${destinatario.instancia}`);
  } catch (erro) {
    // Silencioso em background
  }
}

module.exports = {
  enviarMensagem, enviarImagem, formatarNumero, limparJid, limitePorDia, AQUECIMENTO,
  listarChips, adicionarChip, removerChip, statusChip, qrcodeChip, criarInstancia,
  proximoChip, registrarUso, registrarFalha, resetarContadoresDiarios,
  pausarChip, atualizarLimiteDiario, verificarNumero, marcarComoLida, aquecerChipsInternamente
};