// Camada de lógica de negócio para eventos do WhatsApp.
// Conecta os eventos brutos do Baileys (via ChipSession) às ações do sistema:
//   - Mensagem recebida → opt-out + marcação como lida
//   - Status de conexão → pausa/retomada da fila + notificações + logs
//   - QR code          → log (banco já foi atualizado pelo store.js)
//
// O manager.js passa estas funções como callbacks para cada ChipSession.

require('dotenv').config();
const pool = require('../../db');

// ─── Palavras-chave de opt-out ────────────────────────────────────────────────
const PALAVRAS_OPTOUT = new Set(['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'REMOVER', 'DESCADASTRAR']);

// ─── Mensagens recebidas ──────────────────────────────────────────────────────

/**
 * Processa uma mensagem recebida:
 *   1. Marca como lida (via session)
 *   2. Detecta opt-out e adiciona à blacklist
 *
 * @param {string}      instancia - nome do chip que recebeu
 * @param {object}      msg       - objeto de mensagem do Baileys
 * @param {ChipSession} session   - sessão ativa para marcarComoLida
 */
async function processarMensagem(instancia, msg, session) {
  try {
    // 1. Marca como lida imediatamente
    if (session && msg.key) {
      await session.marcarComoLida(msg.key);
    }

    // 2. Extrai texto da mensagem (suporta texto simples e extended)
    const texto =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.ephemeralMessage?.message?.conversation ||
      '';

    if (!texto.trim()) return;

    const textoLimpo = texto.trim().toUpperCase();
    
    // 3. Lógica de Opt-out
    if (PALAVRAS_OPTOUT.has(textoLimpo)) {
      const jidRemetente = msg.key.remoteJid || '';
      const numero = jidRemetente
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/@c\.us$/, '')
        .replace(/[^0-9]/g, '');

      if (!numero || numero.length < 10) return;

      await pool.query(
        `INSERT INTO blacklist (numero, motivo)
         VALUES ($1, $2)
         ON CONFLICT (numero) DO NOTHING`,
        [numero, 'Opt-out automático: "' + textoLimpo + '" via WhatsApp']
      );
      await pool.query('DELETE FROM contatos WHERE numero = $1', [numero]);

      await _log('info', '[OPT-OUT] ' + numero + ' bloqueado após "' + textoLimpo + '" via ' + instancia);
      console.log('[EVENTS] 🚫 Opt-out: ' + numero + ' (' + textoLimpo + ')');
      return; // Sai da função após o opt-out
    }

    // 4. NOVA LÓGICA: Auto-resposta de aquecimento
    // Se não for um Opt-Out, verifica se a mensagem veio de outro chip do sistema
    const remetenteInterno = await pool.query('SELECT instancia FROM chips WHERE instancia != $1', [instancia]);
    const jidLimpo = msg.key.remoteJid.replace(/[^0-9]/g, ''); // Pega apenas os números de quem enviou
    
    // Verifica se o número que enviou está na nossa base de chips
    const eMensagemDeAquecimento = remetenteInterno.rows.some(r => r.instancia.includes(jidLimpo)); 
    
    if (eMensagemDeAquecimento) {
       const respostas = [
         '{Tudo ótimo|Tudo bem}, e por aí?', 
         'Recebido com sucesso! ✅', 
         '{Estou por aqui|Online agora}.'
       ];
       const { processarSpintax } = require('../antiban');
       const resposta = processarSpintax(respostas[Math.floor(Math.random() * respostas.length)]);
       
       // Aguarda entre 5s a 15s para simular que o "humano" leu e respondeu
       setTimeout(async () => {
         await session.enviarTexto(msg.key.remoteJid, resposta);
       }, Math.floor(Math.random() * 10000) + 5000);
    }

  } catch (e) {
    console.error('[EVENTS] Erro ao processar mensagem de ' + instancia + ': ' + e.message);
  }
}

// ─── Status de conexão ────────────────────────────────────────────────────────

/**
 * Processa mudança de status de um chip:
 *   - 'open'         → retoma fila se estava pausada por falta de chips
 *   - 'desconectado' → pausa fila se não houver mais chips online
 *   - 'banido'       → pausa fila + notificação WhatsApp ao admin
 *   - 'erro'         → log
 *
 * @param {string} instancia
 * @param {string} status - 'open' | 'desconectado' | 'banido' | 'erro' | 'qr_code'
 */
async function processarStatus(instancia, status) {
  try {
    // Loga no banco
    await _log('info', 'Chip ' + instancia + ' → ' + status, { instancia, status });

    // Importação lazy para evitar dependência circular com disparo.js
    const { disparoQueue } = require('../../queue/disparo');

    if (status === 'open') {
      // Chip reconectou — retoma fila se estava pausada e há mensagens aguardando
      const filaEstavaPausada = await disparoQueue.isPaused();
      const mensagensEsperando = await disparoQueue.getWaitingCount();

      if (filaEstavaPausada && mensagensEsperando > 0) {
        await disparoQueue.resume();
        await _log('info', 'Fila retomada após reconexão de ' + instancia);
        console.log('[EVENTS] ▶ Fila retomada — ' + instancia + ' reconectou');
      }
      return;
    }

    if (status === 'desconectado' || status === 'erro') {
      // Verifica se ainda há outros chips online antes de pausar a fila
      const outros = await pool.query(
        "SELECT COUNT(*) FROM chips WHERE status = 'open' AND instancia != $1",
        [instancia]
      );
      const chipsOnline = parseInt(outros.rows[0].count);
      const filaAtiva   = !(await disparoQueue.isPaused());
      const temTrabalho  = (await disparoQueue.getWaitingCount()) + (await disparoQueue.getActiveCount()) > 0;

      if (chipsOnline === 0 && filaAtiva && temTrabalho) {
        await disparoQueue.pause();
        await _log('alerta', 'Fila pausada — ' + instancia + ' desconectou e não há outros chips online');
        console.warn('[EVENTS] ⏸ Fila pausada — nenhum chip online');
      }
      return;
    }

    if (status === 'banido') {
      // Pausa a fila independente de outros chips (chip banido não deve enviar mais)
      const filaAtiva = !(await disparoQueue.isPaused());
      if (filaAtiva) {
        await disparoQueue.pause();
      }

      // Pausa o chip por 24h no banco
      await pool.query(
        `UPDATE chips SET pausado_ate = NOW() + INTERVAL '24 hours' WHERE instancia = $1`,
        [instancia]
      );

      const msg = '⚠️ Chip ' + instancia + ' detectado como banido. Pausado por 24h.';
      await _log('alerta', msg, { instancia });
      console.error('[EVENTS] ⛔ ' + msg);

      // Notificação WhatsApp ao admin (best-effort)
      try {
        const { notificarChipBanido } = require('../notificacoes');
        const chip = await pool.query('SELECT nome FROM chips WHERE instancia = $1', [instancia]);
        await notificarChipBanido(chip.rows[0]?.nome || instancia, instancia);
      } catch (_) { /* notificação é best-effort */ }
    }

  } catch (e) {
    console.error('[EVENTS] Erro ao processar status ' + status + ' de ' + instancia + ': ' + e.message);
  }
}

// ─── QR Code ─────────────────────────────────────────────────────────────────

/**
 * Chamado quando um novo QR é gerado.
 * O store.js já persistiu no banco — aqui só logamos.
 *
 * @param {string} instancia
 * @param {string} _base64 - não usado diretamente (já está no banco)
 */
async function processarQR(instancia, _base64) {
  console.log('[EVENTS] 📷 QR disponível para ' + instancia + ' — acesse o painel para escanear');
  await _log('info', 'QR code gerado para ' + instancia + ' — aguardando scan', { instancia });
}

// ─── Helper interno ───────────────────────────────────────────────────────────

async function _log(nivel, mensagem, dados = null) {
  try {
    await pool.query(
      'INSERT INTO logs (nivel, mensagem, dados) VALUES ($1, $2, $3)',
      [nivel, mensagem, dados ? JSON.stringify(dados) : null]
    );
  } catch (_) { /* não deixa falha de log derrubar o fluxo principal */ }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  processarMensagem,
  processarStatus,
  processarQR,
};
