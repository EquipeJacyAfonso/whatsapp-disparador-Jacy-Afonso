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

// ─── Formatação e Verificação ────────────────────────────────────────────────

function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, '');
  if (!limpo.startsWith('55')) {
    limpo = `55${limpo}`;
  }
  return `${limpo}@s.whatsapp.net`;
}

async function verificarNumero(numero, instancia) {
  const api = await getApi(instancia);
  let numeroLimpo = String(numero).replace(/\D/g, ''); 
  if (!numeroLimpo.startsWith('55')) numeroLimpo = `55${numeroLimpo}`;
  
  try {
    const r = await api.post(`/chat/whatsappNumbers/${instancia}`, {
      numbers: [numeroLimpo]
    });
    
    if (r.data && r.data.length > 0 && r.data[0].exists) {
      // Devolve o ID oficial da Meta (ex: 5561...8@s.whatsapp.net)
      return r.data[0].jid || `${r.data[0].number}@s.whatsapp.net` || `${numeroLimpo}@s.whatsapp.net`;
    }
    return null; // Não tem WhatsApp
  } catch (erro) {
    // Se der erro de rede, tenta enviar da forma padrão
    return `${numeroLimpo}@s.whatsapp.net`; 
  }
}

// ─── Chips ────────────────────────────────────────────────────────────────────

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
  const r = await api.get(`/instance/connect/${instancia}`);
  return r.data;
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
    console.log(`[OPT-OUT] Webhook de respostas ativado para o chip: ${instancia}`);
  } catch(e) {
    console.log(`[OPT-OUT] Erro ao ativar webhook em ${instancia}:`, e.message);
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

// ─── Motor Spintax ───────────────────────────────────────────────────────────
function processarSpintax(texto) {
  if (!texto) return '';
  const regex = /\{([^{}]+)\}/g;
  let resultado = texto;
  let ocorreuSubstituicao = true;

  while (ocorreuSubstituicao) {
    ocorreuSubstituicao = false;
    resultado = resultado.replace(regex, (match, opcoesStr) => {
      ocorreuSubstituicao = true;
      const opcoes = opcoesStr.split('|');
      return opcoes[Math.floor(Math.random() * opcoes.length)];
    });
  }
  return resultado;
}

// ─── Marcação de Leitura Automática ──────────────────────────────────────────
async function marcarComoLida(instancia, messageKey) {
  try {
    const api = await getApi(instancia);
    await api.post(`/chat/markMessageAsRead/${instancia}`, {
      readMessages: [
        {
          remoteJid: messageKey.remoteJid,
          fromMe: messageKey.fromMe,
          id: messageKey.id
        }
      ]
    });
    console.log(`[MARK READ] Mensagem de ${messageKey.remoteJid} marcada como lida!`);
  } catch (erro) {
    console.error(`[MARK READ] Erro ao marcar lida na instância ${instancia}:`, erro.message);
  }
}

// ─── Envio de Mensagem Principal ─────────────────────────────────────────────
async function enviarMensagem(numero, mensagemOriginal, instancia) {
  const api = await getApi(instancia);

  // 1. Obtém o número oficial validado pelo próprio WhatsApp
  const jidValidado = await verificarNumero(numero, instancia);
  
  // O jidValidado não pode ser vazio e não pode ser a palavra "true"
  if (!jidValidado || jidValidado === true) {
    throw new Error('O número não possui WhatsApp registado.');
  }

  // 2. Processa o Spintax para gerar o texto final
  const mensagemFinal = processarSpintax(mensagemOriginal);

  // 3. Simular Comportamento usando o JID validado
  const tempoEspera = Math.floor(Math.random() * 3000) + 3000; 
  try {
    await api.post(`/chat/sendPresence/${instancia}`, {
      number: jidValidado,
      presence: 'composing',
      delay: tempoEspera
    });
    await new Promise(resolve => setTimeout(resolve, tempoEspera));
  } catch (erroPresenca) {
    console.log(`[Presence] Aviso: Não simulou digitação para ${jidValidado}`);
  }

  // 4. Enviar a mensagem real
  try {
    const r = await api.post(`/message/sendText/${instancia}`, {
      number: jidValidado,
      textMessage: {
        text: mensagemFinal // Usando a variável corretamente definida
      }
    });
    return r.data;
  } catch(err) {
    console.error(`[ERRO NA API] Falha para ${jidValidado}:`, err.response?.data || err.message);
    throw err;
  }
}

// ─── Aquecimento Entre Chips (Warm-up Interno) ───────────────────────────────

async function obterNumeroDaInstancia(instancia) {
  try {
    const api = await getApi(instancia);
    const r = await api.get(`/instance/connectionState/${instancia}`);
    const jid = r.data?.instance?.user?.id || r.data?.user?.id || r.data?.instance?.ownerJid;
    if (jid) {
      return jid.split('@')[0].split(':')[0]; 
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function aquecerChipsInternamente() {
  try {
    const res = await pool.query(`SELECT * FROM chips WHERE status = 'open'`);
    const chipsAtivos = res.rows;

    if (chipsAtivos.length < 2) {
      console.log('[WARM-UP] Pelo menos 2 chips online são necessários para o aquecimento.');
      return; 
    }

    const remetente = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];
    let destinatario = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];

    while (destinatario.id === remetente.id) {
      destinatario = chipsAtivos[Math.floor(Math.random() * chipsAtivos.length)];
    }

    const numeroDestinatario = await obterNumeroDaInstancia(destinatario.instancia);
    
    if (!numeroDestinatario) {
      return;
    }

    const frasesAquecimento = [
      "{Olá|Oi|Opa}, {tudo bem?|como vai?|tranquilo?}",
      "{Bom dia|Boa tarde|Boa noite}, {consegue me ouvir?|está por aí?|tudo certo?}",
      "Passando para dar um {alô|oi|bom dia}.",
      "{Preciso de|Queria} uma {informação|ajuda}, {pode me ajudar?|tem um minuto?}",
      "Legal, {obrigado|valeu|agradeço}!",
      "Teste de {conexão|sistema|sinal}, {tudo ok|recebido}?"
    ];
    
    const fraseSorteada = frasesAquecimento[Math.floor(Math.random() * frasesAquecimento.length)];
    
    console.log(`[WARM-UP] A aquecer chips: [${remetente.nome}] a enviar mensagem para [${destinatario.nome}]`);
    
    await enviarMensagem(numeroDestinatario, fraseSorteada, remetente.instancia);

  } catch (erro) {
    console.error('[WARM-UP] Erro no aquecimento interno:', erro.message);
  }
}

module.exports = {
  enviarMensagem, formatarNumero, limitePorDia, AQUECIMENTO,
  listarChips, adicionarChip, removerChip, statusChip, qrcodeChip, criarInstancia,
  proximoChip, registrarUso, registrarFalha, resetarContadoresDiarios,
  pausarChip, atualizarLimiteDiario, verificarNumero, marcarComoLida, aquecerChipsInternamente
};