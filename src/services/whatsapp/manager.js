// Pool de sessões Baileys — substitui evolution.js completamente.
// Mantém a mesma interface pública para que disparo.js, routes/index.js
// e server.js não precisem mudar.
//
// Responsabilidades:
//   - Manter um Map de instancia → ChipSession
//   - Inicializar sessões de todos os chips na subida do servidor
//   - Expor as mesmas funções que evolution.js exportava
//   - Exigir proxy residencial/móvel próprio por chip (obrigatório)
//   - Confirmar entrega real via ACK do WhatsApp
//   - Enviar saudação de aquecimento antes da mensagem de campanha
//
// Correções de maturação de chips (revisão):
//   - resetarContadoresDiarios só avança dias_ativo para chips realmente
//     em uso (status 'open' ou que enviaram algo no dia) — chips sem proxy,
//     desconectados ou nunca conectados não "envelhecem" no calendário.
//   - limite_diario definido manualmente pelo admin (limite_manual=true)
//     não é mais sobrescrito pelo cron diário.
//   - enviarSaudacaoAquecimento não envia mais nenhuma mensagem quando as
//     três simulações (presença/leitura/conversa) estão desligadas.
//   - aquecerChipsInternamente respeita a janela de horário configurada.
//   - Troca de número (SIM diferente no mesmo chip) é tratada em session.js
//     (_sincronizarNumeroConectado), que reinicia o aquecimento do zero.

require('dotenv').config();
const pool   = require('../../db');
const { ChipSession }                          = require('./session');
const { processarMensagem, processarStatus, processarQR } = require('./events');
const { obterQRCode, deletarSessao, sessaoExiste }        = require('./store');
const { AQUECIMENTO, limitePorDia }                       = require('./constants');

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

// ─── Validação de proxy (obrigatório por chip) ────────────────────────────────
// Exige proxy residencial/móvel no formato http(s)://usuario:senha@host:porta
// ou http(s)://host:porta.
const PROXY_REGEX = /^https?:\/\/(?:[^:@\/]+:[^:@\/]+@)?[a-zA-Z0-9.\-]+:\d{2,5}$/;

function validarProxy(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
    throw new Error('Proxy obrigatório. Cada chip precisa de um proxy residencial/móvel próprio (formato: http://usuario:senha@host:porta).');
  }
  const limpo = proxyUrl.trim();
  if (!PROXY_REGEX.test(limpo)) {
    throw new Error('Formato de proxy inválido. Use: http://usuario:senha@host:porta ou http://host:porta');
  }
  return limpo;
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

  // Proxy é obrigatório — sem ele, o chip não conecta (evita ban por IP
  // de datacenter compartilhado entre múltiplos chips).
  const result = await pool.query('SELECT proxy FROM chips WHERE instancia = $1', [instancia]);
  const proxyUrl = result.rows[0]?.proxy || null;

  if (!proxyUrl) {
    console.error('[MGR] ⛔ ' + instancia + ' sem proxy configurado — conexão bloqueada.');
    await pool.query("UPDATE chips SET status = 'sem_proxy' WHERE instancia = $1", [instancia]);
    await pool.query(
      "INSERT INTO logs (nivel, mensagem) VALUES ('erro', $1)",
      ['Chip ' + instancia + ' não conectado: proxy obrigatório não configurado.']
    );
    return; // não cria ChipSession sem proxy
  }

  const session = new ChipSession(instancia, _callbacks(), proxyUrl);
  sessoes.set(instancia, session);
  // conectar() é async — não aguardamos mas logamos erros
  session.conectar().catch(e => {
    console.error('[MGR] Erro ao conectar ' + instancia + ':', e.message);
    session._conectando = false; // garante desbloqueio mesmo em erro inesperado
  });
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
    if (resultado?.exists) {
      // Usa o JID oficial do WhatsApp — ele resolve automaticamente se o
      // número tem ou não o 9º dígito, independente do que formatarNumero
      // calculou. limparJid remove o sufixo @s.whatsapp.net.
      return limparJid(resultado.jid || numeroFormatado);
    }
    // Número não tem WhatsApp registrado
    return null;
  } catch (e) {
    console.warn('[MGR] onWhatsApp falhou para ' + numeroFormatado + ': ' + e.message + ' — usando fallback local');
    return numeroFormatado;
  }
}

// ─── Gestão de chips ─────────────────────────────────────────────────────────

async function adicionarChip(nome, instancia, proxy, limiteDiario) {
  const proxyValidado = validarProxy(proxy); // lança erro se ausente/inválido
  const limite = limiteDiario || AQUECIMENTO[0];
  const result = await pool.query(
    "INSERT INTO chips (nome, instancia, status, limite_diario, dias_ativo, proxy) VALUES ($1, $2, 'desconectado', $3, 0, $4) RETURNING *",
    [nome, instancia, limite, proxyValidado]
  );
  return result.rows[0];
}

async function atualizarProxy(id, proxy) {
  const proxyValidado = validarProxy(proxy);
  const result = await pool.query(
    'UPDATE chips SET proxy = $1 WHERE id = $2 RETURNING *',
    [proxyValidado, id]
  );
  if (!result.rows.length) throw new Error('Chip não encontrado');
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

/**
 * Define um limite diário manual, definido pelo admin no painel.
 * Marca limite_manual=true para que o cron diário (resetarContadoresDiarios)
 * NUNCA sobrescreva esse valor com o cálculo automático da tabela de
 * aquecimento — antes, qualquer ajuste manual era revertido silenciosamente
 * à meia-noite.
 */
async function atualizarLimiteDiario(id, limite) {
  const result = await pool.query(
    'UPDATE chips SET limite_diario = $1, limite_manual = true WHERE id = $2 RETURNING *',
    [limite, id]
  );
  return result.rows[0];
}

/**
 * Remove o limite manual de um chip, devolvendo o controle do limite_diario
 * para a tabela de aquecimento automática a partir do próximo reset diário.
 * Útil se o admin quiser "destravar" um chip que ele mesmo configurou antes.
 */
async function removerLimiteManual(id) {
  const result = await pool.query(
    'UPDATE chips SET limite_manual = false WHERE id = $1 RETURNING *',
    [id]
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
  // Proxy é obrigatório — bloqueia a tentativa de conexão sem ele
  const result = await pool.query('SELECT proxy FROM chips WHERE instancia = $1', [instancia]);
  if (!result.rows[0]?.proxy) {
    throw new Error('Configure um proxy residencial/móvel para este chip antes de conectar.');
  }

  if (!sessoes.has(instancia)) {
    await _iniciarSessao(instancia);
  } else {
    const session = sessoes.get(instancia);
    // Bug 7: se _conectando ficou travado por exceção anterior, reseta
    // antes de tentar novamente — sem isso criarInstancia retornava
    // 'connecting' sem QR e sem nenhuma ação real.
    if (session._conectando) {
      console.warn('[MGR] ' + instancia + ' estava com _conectando travado — resetando');
      session._conectando = false;
    }
    if (session.status !== 'open') {
      await session.conectar();
    }
  }
  return { instanceName: instancia, status: sessoes.get(instancia)?.status || 'connecting' };
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

// ─── Envio (com confirmação real de entrega via ACK) ──────────────────────────

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
  const resultado = await session.enviarTextoConfirmado(numeroFormatado, mensagem);

  console.log('[MGR] ' + (resultado.ack ? '✅' : '⚠ sem confirmação de entrega') + ' ' + numeroFormatado + ' (ack=' + resultado.ack + ')');
  return resultado; // { key, ack }
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
  const resultado = await session.enviarImagemConfirmada(
    numeroFormatado, midiaBase64, mimetype, mensagem, midiaNome
  );

  console.log('[MGR] ' + (resultado.ack ? '✅' : '⚠ sem confirmação de entrega') + ' ' + numeroFormatado + ' (imagem, ack=' + resultado.ack + ')');
  return resultado; // { key, ack }
}

async function marcarComoLida(instancia, messageKey) {
  const session = sessoes.get(instancia);
  if (!session) return;
  await session.marcarComoLida(messageKey);
}

// ─── Simulação de comportamento humano antes da campanha ─────────────────────
// Três camadas, cada uma configurável via tabela `configuracoes` (aba Anti-ban):
//   1. Presença online — aparece "online" alguns segundos antes de agir
//   2. Leitura de conversas antigas — re-marca mensagens recentes como lidas
//   3. Conversa de aquecimento — troca 2-3 mensagens curtas antes do texto real
// Tudo com chance configurável (sim_conversa_chance) para não inflar demais
// o volume de mensagens por contato.
const config = require('../config');

const CONVERSAS_AQUECIMENTO = [
  ['Oi! 👋', 'Tudo bem?'],
  ['Olá!', 'Como vai?'],
  ['Opa!', 'Tudo certo por aí?'],
  ['Bom dia!', 'Espero que esteja tudo bem'],
  ['Oii', 'Passando pra falar contigo'],
  ['Oi, tudo bem?', 'Posso te falar uma coisa?'],
  ['Olá, tudo certo?', 'Vi seu contato aqui'],
];

function conversaAleatoria() {
  return CONVERSAS_AQUECIMENTO[Math.floor(Math.random() * CONVERSAS_AQUECIMENTO.length)];
}

/**
 * Roda a simulação completa de comportamento humano antes da mensagem real
 * de campanha: presença online → leitura de conversas antigas → 2-3 mensagens
 * de aquecimento com pausas humanas entre elas.
 * Tudo best-effort — qualquer falha aqui não deve impedir o envio principal.
 *
 * CORREÇÃO: antes, desligar a checkbox "Simular conversa de aquecimento"
 * (sim_conversa_ativo=false) ainda deixava um fallback que enviava 1
 * mensagem extra mesmo assim — a única forma de zerar de vez era via
 * sim_conversa_chance=0, o que não era óbvio pela UI. Agora, com
 * sim_conversa_ativo=false, NENHUMA mensagem extra é enviada.
 */
async function enviarSaudacaoAquecimento(numero, instancia) {
  try {
    const session = sessoes.get(instancia);
    if (!session || session.status !== 'open') return;

    const [presencaAtiva, leituraAtiva, conversaAtiva, chanceStr] = await Promise.all([
      config.get('sim_presenca_ativo', 'true'),
      config.get('sim_leitura_ativo', 'true'),
      config.get('sim_conversa_ativo', 'true'),
      config.get('sim_conversa_chance', '0.6'),
    ]);

    // Se as três simulações estiverem desligadas, não há nada a fazer.
    // Sai ANTES do sorteio de chance — antes, o sorteio rodava primeiro e um
    // fallback dentro do bloco de "conversa" disparava mensagem mesmo com
    // os toggles desmarcados.
    if (presencaAtiva !== 'true' && leituraAtiva !== 'true' && conversaAtiva !== 'true') return;

    const chance = parseFloat(chanceStr);
    // Chance controla se a simulação completa roda neste contato — evita
    // dobrar/triplicar o volume de mensagens em toda campanha.
    if (isNaN(chance) || Math.random() > chance) return;

    // 1. Presença online — "abre o WhatsApp" antes de fazer qualquer coisa
    if (presencaAtiva === 'true') {
      await session.simularPresencaOnline();
    }

    // 2. Leitura de conversas antigas
    if (leituraAtiva === 'true') {
      await session.simularLeituraAntiga(1 + Math.floor(Math.random() * 2)); // 1-2 mensagens
    }

    // 3. Conversa de aquecimento — SÓ roda se o toggle estiver ligado.
    // Sem fallback: toggle desligado = zero mensagens extras, como o nome
    // da opção sugere.
    if (conversaAtiva === 'true') {
      const numeroFormatado = await verificarNumero(numero, instancia);
      if (!numeroFormatado) return;

      const frases = conversaAleatoria();
      for (const frase of frases) {
        await session.enviarTexto(numeroFormatado, frase); // sem exigir ACK — é aquecimento
        const pausa = 1500 + Math.random() * 2500; // 1.5s–4s entre mensagens
        await new Promise(r => setTimeout(r, pausa));
      }
    }
  } catch (e) {
    console.warn('[MGR] Simulação de aquecimento falhou para ' + numero + ': ' + e.message);
    // não propaga — envio principal segue mesmo se a simulação falhar
  }
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

/**
 * Reset diário do aquecimento — roda à meia-noite (America/Sao_Paulo).
 *
 * CORREÇÕES aplicadas nesta revisão:
 *
 * 1. dias_ativo só avança para chips que estão realmente em uso: status
 *    'open' OU que enviaram pelo menos 1 mensagem no dia (enviados_hoje > 0).
 *    Antes, TODOS os chips avançavam — inclusive 'sem_proxy' e
 *    'desconectado' que nunca chegaram a conectar. Isso fazia um chip
 *    "envelhecer" no calendário de aquecimento sem nunca ter enviado nada,
 *    e quando finalmente conectasse, herdava um limite_diario alto (ex: dia
 *    10 = 80-100/dia) sem qualquer histórico real de uso gradual.
 *
 * 2. limite_diario só é recalculado pela tabela de aquecimento se o chip
 *    NÃO tiver limite_manual=true. Limites definidos manualmente pelo admin
 *    (via atualizarLimiteDiario) deixam de ser revertidos silenciosamente
 *    todo dia à meia-noite.
 *
 * Observação: a troca de número (SIM diferente no mesmo chip) já é tratada
 * separadamente em session.js (_sincronizarNumeroConectado), que reinicia
 * dias_ativo/limite_diario/limite_manual no momento da reconexão — não
 * depende deste cron.
 */
async function resetarContadoresDiarios() {
  const chips = await pool.query(
    "SELECT id, dias_ativo, status, limite_manual, enviados_hoje FROM chips"
  );

  for (const chip of chips.rows) {
    const liberarPausa = chip.status !== 'banido'; // só libera pausas temporárias
    const teveUsoHoje = chip.enviados_hoje > 0;
    const podeEnvelhecer = chip.status === 'open' || teveUsoHoje;

    if (!podeEnvelhecer) {
      // Chip nunca conectou (sem_proxy) ou está desconectado sem ter
      // enviado nada — não avança o calendário de aquecimento. Só zera o
      // contador diário para não acumular "dívida" negativa quando conectar.
      await pool.query(
        'UPDATE chips SET enviados_hoje = 0' +
        (liberarPausa ? ', pausado_ate = NULL' : '') +
        ' WHERE id = $1',
        [chip.id]
      );
      continue;
    }

    const novosDias = chip.dias_ativo + 1;

    if (chip.limite_manual) {
      // Preserva o limite definido manualmente — só avança dias_ativo
      // (para fins de exibição/histórico) sem tocar em limite_diario.
      await pool.query(
        'UPDATE chips SET enviados_hoje = 0, dias_ativo = $1' +
        (liberarPausa ? ', pausado_ate = NULL' : '') +
        ' WHERE id = $2',
        [novosDias, chip.id]
      );
    } else {
      const novoLimite = limitePorDia(novosDias);
      await pool.query(
        'UPDATE chips SET enviados_hoje = 0, dias_ativo = $1, limite_diario = $2' +
        (liberarPausa ? ', pausado_ate = NULL' : '') +
        ' WHERE id = $3',
        [novosDias, novoLimite, chip.id]
      );
    }
  }
}

// ─── Aquecimento interno ──────────────────────────────────────────────────────

/**
 * Gera tráfego automático entre dois chips próprios para simular atividade
 * antes de campanhas reais. Chamado periodicamente pelo server.js.
 *
 * CORREÇÃO: agora respeita a janela de horário configurada (mesma checagem
 * usada antes de qualquer envio de campanha). Antes, esse tráfego podia ser
 * gerado 24h por dia — inclusive de madrugada —, o que é exatamente o tipo
 * de padrão "não-humano" que o resto do sistema tenta evitar.
 */
async function aquecerChipsInternamente() {
  try {
    const { dentroDaJanela } = require('../antiban');
    if (!(await dentroDaJanela())) {
      console.log('[MGR] Aquecimento interno pulado — fora da janela de horário.');
      return;
    }

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

    const rem2 = rem; // apenas para clareza — envia via chip remetente
    await enviarMensagemSimples(numeroDest, texto, rem2.instancia);
  } catch (e) {
    console.warn('[MGR] Aquecimento interno: ' + e.message);
  }
}

// Envio simples sem exigir ACK — usado internamente pelo aquecimento
// (não precisa bloquear por confirmação, é só tráfego entre os próprios chips)
async function enviarMensagemSimples(numero, mensagem, instancia) {
  const session = sessoes.get(instancia);
  if (!session || session.status !== 'open') {
    throw new Error('Chip ' + instancia + ' não está conectado (status: ' + (session?.status || 'não encontrado') + ')');
  }
  const numeroFormatado = await verificarNumero(numero, instancia);
  if (!numeroFormatado) {
    throw new Error('Número ' + numero + ' não possui WhatsApp registrado');
  }
  return session.enviarTexto(numeroFormatado, mensagem);
}

// ─── Utilitário para aquecimento bidirecional ────────────────────────────────
// Retorna um Set com os números de todos os chips atualmente conectados.
// Usado pelo events.js para detectar auto-respostas de aquecimento interno.
function obterNumerosChipsConectados() {
  const numeros = new Set();
  for (const [, session] of sessoes) {
    const num = session.obterNumeroProprioConectado();
    if (num) numeros.add(num);
  }
  return numeros;
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

// ─── Exports (mesma interface que evolution.js, + novidades) ─────────────────

module.exports = {
  // Inicialização (chamada pelo server.js no startup)
  inicializarSessoes,

  // Envio
  enviarMensagem,
  enviarImagem,
  marcarComoLida,
  verificarNumero,
  enviarSaudacaoAquecimento,

  // Chips
  adicionarChip,
  listarChips,
  removerChip,
  atualizarLimiteDiario,
  removerLimiteManual,
  atualizarProxy,
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
  obterNumerosChipsConectados,
  validarProxy,
};
