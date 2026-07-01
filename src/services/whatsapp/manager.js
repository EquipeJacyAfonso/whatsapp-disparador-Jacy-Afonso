// Pool de sessões Baileys — substitui evolution.js completamente.
// Mantém a mesma interface pública para que disparo.js, routes/index.js
// e server.js não precisem mudar.
//
// Responsabilidades:
//   - Manter um Map de instancia → ChipSession
//   - Inicializar sessões de todos os chips na subida do servidor
//   - Expor as mesmas funções que evolution.js exportava

require('dotenv').config();
const pool   = require('../../db');
const { ChipSession }                          = require('./session');
const { processarMensagem, processarStatus, processarQR } = require('./events');
const { obterQRCode, deletarSessao, sessaoExiste }        = require('./store');

// ─── Pool de sessões ──────────────────────────────────────────────────────────

// Map vivo: instancia (string) → ChipSession
const sessoes = new Map();

// Callbacks injetados em cada ChipSession
function _callbacks() {
  return {
    onStatus: (instancia, status) =>
      processarStatus(instancia, status).catch(e =>
        console.error('[MGR] Erro em processarStatus:', e.message)
      ),
    onMessage: (instancia, msg) => {
      const session = sessoes.get(instancia);
      processarMensagem(instancia, msg, session).catch(e =>
        console.error('[MGR] Erro em processarMensagem:', e.message)
      );
    },
    onQR: (instancia, base64) =>
      processarQR(instancia, base64).catch(() => {}),
  };
}

// ─── Inicialização ────────────────────────────────────────────────────────────

/**
 * Chamado no startup do servidor.
 * Abre uma ChipSession para cada chip não-banido cadastrado no banco.
 */
async function inicializarSessoes() {
  const chips = await pool.query(
    "SELECT instancia FROM chips WHERE status != 'banido' ORDER BY criado_em ASC"
  );
  console.log('[MGR] Inicializando ' + chips.rows.length + ' sessão(ões)...');
  for (const chip of chips.rows) {
    await _iniciarSessao(chip.instancia);
  }
  console.log('[MGR] ✅ Sessões inicializadas');
}

async function _iniciarSessao(instancia) {
  if (sessoes.has(instancia)) return; // já ativa
  const session = new ChipSession(instancia, _callbacks());
  sessoes.set(instancia, session);
  // conectar() é async mas não aguardamos — o status chega via evento
  session.conectar().catch(e =>
    console.error('[MGR] Erro ao conectar ' + instancia + ':', e.message)
  );
}

// ─── Tabela de aquecimento ────────────────────────────────────────────────────

const AQUECIMENTO = [20, 30, 40, 50, 60, 80, 100, 120, 150];

function limitePorDia(diasAtivo) {
  return AQUECIMENTO[Math.min(diasAtivo, AQUECIMENTO.length - 1)];
}

// ─── Formatação de números ────────────────────────────────────────────────────

function formatarNumero(numeroBruto) {
  let limpo = String(numeroBruto).replace(/\D/g, '');

  if (limpo.startsWith('0')) limpo = limpo.substring(1);
  if (!limpo.startsWith('55')) limpo = '55' + limpo;

  // Garante o nono dígito em celulares brasileiros (obrigatório desde 2016)
  const telefone = limpo.substring(4); // remove 55 + DDD
  if (
    telefone.length === 8 &&
    (telefone.startsWith('6') || telefone.startsWith('7') ||
     telefone.startsWith('8') || telefone.startsWith('9'))
  ) {
    const ddd = limpo.substring(2, 4);
    return '55' + ddd + '9' + telefone;
  }

  return limpo;
}

function limparJid(jid) {
  return String(jid)
    .replace(/@s\.whatsapp\.net$/, '')
    .replace(/@c\.us$/, '');
}

// ─── Verificação de número ────────────────────────────────────────────────────

/**
 * Verifica se um número tem WhatsApp usando o socket Baileys (onWhatsApp).
 * Retorna o número formatado se existir, null se não existir,
 * ou o número formatado como fallback se a verificação falhar.
 */
async function verificarNumero(numero, instancia) {
  const numeroFormatado = formatarNumero(numero);
  const session = sessoes.get(instancia);

  if (!session || session.status !== 'open' || !session.socket) {
    // Sem sessão ativa — usa número formatado sem verificar
    return numeroFormatado;
  }

  try {
    const [resultado] = await session.socket.onWhatsApp(numeroFormatado);
    if (resultado?.exists) return numeroFormatado;
    // Número não tem WhatsApp
    return null;
  } catch (e) {
    console.warn('[MGR] onWhatsApp falhou para ' + numeroFormatado + ': ' + e.message + ' — usando fallback');
    return numeroFormatado;
  }
}

// ─── Gestão de chips ─────────────────────────────────────────────────────────

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
  if (!result.rows.length) return;

  const instancia = result.rows[0].instancia;

  // Encerra a sessão Baileys ativa
  const session = sessoes.get(instancia);
  if (session) {
    await session.desconectar();
    sessoes.delete(instancia);
  }

  // Remove credenciais do banco
  await deletarSessao(instancia);
  await pool.query('DELETE FROM chips WHERE id = $1', [id]);

  console.log('[MGR] Chip ' + instancia + ' removido');
}

async function atualizarLimiteDiario(id, limite) {
  const result = await pool.query(
    'UPDATE chips SET limite_diario = $1 WHERE id = $2 RETURNING *',
    [limite, id]
  );
  return result.rows[0];
}

async function pausarChip(id, horas = 1) {
  const ate = new Date(Date.now() + horas * 60 * 60 * 1000);
  await pool.query('UPDATE chips SET pausado_ate = $1 WHERE id = $2', [ate, id]);
  return ate;
}

// ─── Status e QR ─────────────────────────────────────────────────────────────

async function statusChip(instancia) {
  const session = sessoes.get(instancia);
  const status  = session?.status || 'desconectado';

  // Sincroniza com o banco
  await pool.query(
    'UPDATE chips SET status = $1, ultimo_ping = NOW() WHERE instancia = $2',
    [status, instancia]
  );
  return status;
}

async function criarInstancia(instancia) {
  // Se já existe sessão, só garante que está tentando conectar
  if (!sessoes.has(instancia)) {
    await _iniciarSessao(instancia);
  } else {
    const session = sessoes.get(instancia);
    if (session.status === 'desconectado' || session.status === 'erro') {
      await session.conectar();
    }
  }
  return { instanceName: instancia, status: 'connecting' };
}

async function qrcodeChip(instancia) {
  // O QR é salvo no banco pelo store.js quando o Baileys o emite
  // O painel faz polling aqui
  const base64 = await obterQRCode(instancia);
  if (!base64) {
    // QR ainda não chegou — garante que a sessão está tentando conectar
    if (!sessoes.has(instancia)) await _iniciarSessao(instancia);
    return { qrcode: null, message: 'Aguardando QR code...' };
  }
  return { qrcode: { base64 } };
}

// ─── Envio ────────────────────────────────────────────────────────────────────

async function enviarMensagem(numero, mensagem, instancia) {
  const session = sessoes.get(instancia);
  if (!session || session.status !== 'open') {
    throw new Error('Chip ' + instancia + ' não está conectado (status: ' + (session?.status || 'não encontrado') + ')');
  }

  const numeroFormatado = await verificarNumero(numero, instancia);
  if (!numeroFormatado) {
    throw new Error('Número ' + numero + ' não possui WhatsApp registrado');
  }

  console.log('[MGR] → Enviando texto para ' + numeroFormatado + ' via ' + instancia);
  const resultado = await session.enviarTexto(numeroFormatado, mensagem);

  if (!resultado) {
    throw new Error('Envio sem confirmação da API Baileys para ' + numeroFormatado);
  }

  console.log('[MGR] ✅ ' + numeroFormatado);
  return resultado;
}

async function enviarImagem(numero, mensagem, instancia, midiaBase64, mimetype, midiaNome) {
  const session = sessoes.get(instancia);
  if (!session || session.status !== 'open') {
    throw new Error('Chip ' + instancia + ' não está conectado');
  }

  const numeroFormatado = await verificarNumero(numero, instancia);
  if (!numeroFormatado) {
    throw new Error('Número ' + numero + ' não possui WhatsApp registrado');
  }

  console.log('[MGR] → Enviando imagem para ' + numeroFormatado + ' via ' + instancia);
  const resultado = await session.enviarImagem(
    numeroFormatado, midiaBase64, mimetype, mensagem, midiaNome
  );

  if (!resultado) {
    throw new Error('Envio de imagem sem confirmação para ' + numeroFormatado);
  }

  console.log('[MGR] ✅ ' + numeroFormatado + ' (imagem)');
  return resultado;
}

async function marcarComoLida(instancia, messageKey) {
  const session = sessoes.get(instancia);
  if (!session) return;
  await session.marcarComoLida(messageKey);
}

// ─── Rotação de chips ─────────────────────────────────────────────────────────

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
    const online = await pool.query("SELECT COUNT(*) FROM chips WHERE status = 'open'");
    if (parseInt(online.rows[0].count) > 0) {
      throw new Error('Limite diário atingido em todos os chips.');
    }
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
    const novosDias  = chip.dias_ativo + 1;
    const novoLimite = limitePorDia(novosDias);
    await pool.query(
      'UPDATE chips SET enviados_hoje = 0, dias_ativo = $1, limite_diario = $2, pausado_ate = NULL WHERE id = $3',
      [novosDias, novoLimite, chip.id]
    );
  }
}

// ─── Aquecimento interno ──────────────────────────────────────────────────────

async function aquecerChipsInternamente() {
  try {
    const ativos = await pool.query("SELECT * FROM chips WHERE status = 'open'");
    if (ativos.rows.length < 2) return;

    // Bug 6: escolhe remetente aleatório e destinatário por deslocamento fixo
    // (evita o while-loop não-determinístico de antes, que podia sortear
    // os mesmos dois chips repetidamente quando há apenas 2 ativos)
    const idxRem = Math.floor(Math.random() * ativos.rows.length);
    const idxDest = (idxRem + 1 + Math.floor(Math.random() * (ativos.rows.length - 1))) % ativos.rows.length;
    const rem  = ativos.rows[idxRem];
    const dest = ativos.rows[idxDest];

    // Obtém número do chip destinatário via socket
    const sessionDest = sessoes.get(dest.instancia);
    const numeroDest  = sessionDest?.obterNumeroProprioConectado();
    if (!numeroDest) return;

    const frases = [
      '{Oi|Olá|Opa}, tudo bem?',
      'Teste de {conexão|sinal}, recebido?',
      '{Olá|Ei}, tudo ok por aí?',
    ];
    const frase = frases[Math.floor(Math.random() * frases.length)];

    // Aplica spintax simples
    let texto = frase;
    let anterior;
    do {
      anterior = texto;
      texto = texto.replace(/\{([^{}]+)\}/g, (_, ops) => {
        const lista = ops.split('|');
        return lista[Math.floor(Math.random() * lista.length)];
      });
    } while (texto !== anterior);

    await enviarMensagem(numeroDest, texto, rem.instancia);
  } catch (e) {
    console.warn('[MGR] Aquecimento interno: ' + e.message);
  }
}

// ─── Compatibilidade com código legado ───────────────────────────────────────
// extrairErroAPI e erroEhPermanente eram específicos de HTTP/Evolution API.
// Mantemos para não quebrar imports em disparo.js.

function extrairErroAPI(err) {
  return err?.message || String(err);
}

function erroEhPermanente(err) {
  // Com Baileys, erros de formato de payload não existem (é chamada de função JS)
  // Consideramos permanente apenas erros explícitos de número inválido
  const msg = (err?.message || '').toLowerCase();
  return msg.includes('não possui whatsapp') || msg.includes('jid inválido');
}

// ─── Exports (mesma interface que evolution.js) ───────────────────────────────

module.exports = {
  // Inicialização (chamada pelo server.js no startup)
  inicializarSessoes,

  // Envio
  enviarMensagem,
  enviarImagem,
  marcarComoLida,
  verificarNumero,

  // Chips
  adicionarChip,
  listarChips,
  removerChip,
  atualizarLimiteDiario,
  pausarChip,
  statusChip,
  criarInstancia,
  qrcodeChip,

  // Fila
  proximoChip,
  registrarUso,
  registrarFalha,
  resetarContadoresDiarios,

  // Aquecimento
  aquecerChipsInternamente,

  // Utilitários
  formatarNumero,
  limparJid,
  limitePorDia,
  AQUECIMENTO,
  extrairErroAPI,
  erroEhPermanente,
};
