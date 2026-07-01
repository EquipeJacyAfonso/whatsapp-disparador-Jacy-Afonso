// Gerencia UMA conexão Baileys por chip/instância.
// O manager.js mantém um Map de instância → ChipSession.
//
// Responsabilidades:
//   - Abrir e manter o socket WebSocket com o WhatsApp
//   - Gerar QR code e persistir no banco para o painel
//   - Reconectar automaticamente com backoff exponencial
//   - Emitir eventos de status para o manager (open, close, banido)
//   - Enviar mensagens de texto, imagem e presença

require('dotenv').config();
const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const pool = require('../../db');
const { usePostgresAuthState, salvarQRCode, limparQRCode } = require('./store');

// ─── Códigos que indicam ban / deslogamento permanente ───────────────────────
// Nesses casos não reconectamos — o usuário precisa escanear o QR novamente.
const CODIGOS_PERMANENTES = new Set([
  DisconnectReason.loggedOut,     // 401 — usuário deslogou pelo celular
  DisconnectReason.forbidden,     // 403 — conta banida
  DisconnectReason.badSession,    // 500 — sessão corrompida
]);

const MAX_TENTATIVAS = 5;
const DELAY_BASE_MS  = 2000; // backoff exponencial: 2s, 4s, 8s, 16s, 30s

// ─── ChipSession ─────────────────────────────────────────────────────────────

class ChipSession {
  /**
   * @param {string} instancia - nome único do chip (ex: "instancia01")
   * @param {object} callbacks
   * @param {Function} callbacks.onStatus   - (instancia, status) → void
   * @param {Function} callbacks.onMessage  - (instancia, msg) → void
   * @param {Function} callbacks.onQR       - (instancia, base64) → void
   */
  constructor(instancia, callbacks = {}) {
    this.instancia   = instancia;
    this.socket      = null;
    this.status      = 'desconectado';
    this.callbacks   = callbacks;
    this._tentativas = 0;
    this._encerrando = false; // true quando desconectar() foi chamado explicitamente
    this._conectando = false; // true durante a fase de handshake do socket
  }

  // ── Conexão ────────────────────────────────────────────────────────────────

  async conectar() {
    if (this._encerrando) return;
    // Bug 1: evita criar 2 sockets simultâneos (ex: criarInstancia chamado
    // enquanto uma reconexão automática já está em andamento)
    if (this._conectando || this.status === 'open') return;
    this._conectando = true;

    const { state, saveCreds } = await usePostgresAuthState(this.instancia);
    const { version } = await fetchLatestBaileysVersion();

    this.socket = makeWASocket({
      version,
      browser: ['Windows', 'Chrome', '120.0.0.0'], // <-- ADICIONE ESTA LINHA!
      auth: state,
      printQRInTerminal: false,
      // Logger silencioso — nossos console.log já cobrem o necessário
      logger: pino({ level: 'silent' }),
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 15_000,
      retryRequestDelayMs: 250,
      // Não busca histórico de mensagens — reduz tráfego e tempo de conexão
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    // Persiste credenciais sempre que o Baileys as atualizar
    this.socket.ev.on('creds.update', saveCreds);

    // Eventos de conexão / QR
    this.socket.ev.on('connection.update', (update) => this._onConnectionUpdate(update));

    // Mensagens recebidas (opt-out, marcação de lida)
    this.socket.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        this.callbacks.onMessage?.(this.instancia, msg);
      }
    });

    this._conectando = false;
  }

  async _onConnectionUpdate({ connection, lastDisconnect, qr }) {
    // ── QR code chegou ────────────────────────────────────────────────────────
    // Bug 7: qr e connection podem vir juntos no mesmo evento — processa o QR
    // mas NÃO retorna antes de checar connection (sem early return indevido)
    if (qr) {
      try {
        const base64 = await QRCode.toDataURL(qr);
        await salvarQRCode(this.instancia, base64);
        await this._setStatus('qr_code');
        this.callbacks.onQR?.(this.instancia, base64);
        console.log('[SESSION] 📷 QR gerado para ' + this.instancia);
      } catch (e) {
        console.error('[SESSION] Erro ao gerar QR de ' + this.instancia + ': ' + e.message);
      }
      // Não retorna — connection pode vir preenchido no mesmo evento
    }

    // ── Conectado com sucesso ─────────────────────────────────────────────────
    if (connection === 'open') {
      this._tentativas = 0;
      await limparQRCode(this.instancia);
      await this._setStatus('open');
      this.callbacks.onStatus?.(this.instancia, 'open');
      console.log('[SESSION] ✅ ' + this.instancia + ' conectado');
      return;
    }

    // ── Desconectado ──────────────────────────────────────────────────────────
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      const razao  = lastDisconnect?.error?.message || 'desconhecido';

      // Descobre se é uma situação permanente (ban, logout) ou transitória
      const permanente = CODIGOS_PERMANENTES.has(codigo)
        || razao.toLowerCase().includes('banned')
        || razao.toLowerCase().includes('forbidden');

      if (permanente || this._encerrando) {
        const novoStatus = permanente ? 'banido' : 'desconectado';
        await this._setStatus(novoStatus);
        this.callbacks.onStatus?.(this.instancia, novoStatus);
        if (permanente) {
          console.error('[SESSION] ⛔ ' + this.instancia + ' banido/deslogado (código ' + codigo + ') — requer novo QR');
        }
        return;
      }

      // Situação transitória — reconecta com backoff exponencial
      await this._setStatus('desconectado');
      this.callbacks.onStatus?.(this.instancia, 'desconectado');
      console.warn('[SESSION] ⚠ ' + this.instancia + ' desconectado (' + razao + ')');
      this._reconectar();
    }
  }

  _reconectar() {
    if (this._encerrando || this._tentativas >= MAX_TENTATIVAS) {
      if (this._tentativas >= MAX_TENTATIVAS) {
        console.error('[SESSION] ❌ ' + this.instancia + ' — máx. de reconexões atingido, desistindo');
        this._setStatus('erro').catch(() => {});
      }
      return;
    }
    this._tentativas++;
    // 2s, 4s, 8s, 16s, 30s (cap)
    const delay = Math.min(DELAY_BASE_MS * Math.pow(2, this._tentativas - 1), 30_000);
    console.log('[SESSION] 🔄 Reconectando ' + this.instancia + ' em ' + Math.round(delay / 1000) + 's' +
      ' (tentativa ' + this._tentativas + '/' + MAX_TENTATIVAS + ')');
    setTimeout(() => this.conectar(), delay);
  }

  // ── Desconexão intencional ────────────────────────────────────────────────

  async desconectar() {
    this._encerrando = true;
    this._conectando = false;
    try {
      await this.socket?.logout();
    } catch (_) {}
    try {
      this.socket?.end(undefined);
    } catch (_) {}
    this.socket = null;
    await this._setStatus('desconectado');
  }

  // ── Envio de mensagens ────────────────────────────────────────────────────

  /**
   * Envia mensagem de texto.
   * @param {string} jid - número formatado (55...) — converte para JID internamente
   * @param {string} texto
   */
  async enviarTexto(jid, texto) {
    this._checarConexao();
    const jidCompleto = this._toJid(jid);
    // Simula "digitando..." por 500ms antes de enviar
    await this._enviarPresenca(jidCompleto);
    return this.socket.sendMessage(jidCompleto, { text: texto });
  }

  /**
   * Envia imagem com legenda.
   * @param {string} jid
   * @param {string} base64 - conteúdo da imagem em base64 (com ou sem prefixo data:)
   * @param {string} mimetype - 'image/jpeg' | 'image/png'
   * @param {string} caption - texto/legenda
   * @param {string} fileName - nome do arquivo
   */
  async enviarImagem(jid, base64, mimetype, caption, fileName) {
    this._checarConexao();
    const jidCompleto = this._toJid(jid);
    const buffer = Buffer.from(
      base64.replace(/^data:image\/\w+;base64,/, ''),
      'base64'
    );
    await this._enviarPresenca(jidCompleto);
    return this.socket.sendMessage(jidCompleto, {
      image:    buffer,
      mimetype: mimetype  || 'image/jpeg',
      caption:  caption   || '',
      fileName: fileName  || 'imagem.jpg',
    });
  }

  /**
   * Marca mensagem como lida.
   * @param {object} messageKey - { remoteJid, fromMe, id }
   */
  async marcarComoLida(messageKey) {
    if (!this.socket || this.status !== 'open') return;
    try {
      await this.socket.readMessages([messageKey]);
    } catch (_) { /* silencioso — não crítico */ }
  }

  /**
   * Retorna o número do próprio chip conectado (para aquecimento interno).
   */
  obterNumeroProprioConectado() {
    const jid = this.socket?.user?.id;
    if (!jid) return null;
    // JID format: "5511999...@s.whatsapp.net:0" ou "5511999...@s.whatsapp.net"
    return jid.split(':')[0].split('@')[0];
  }

  // ── Helpers internos ──────────────────────────────────────────────────────

  _checarConexao() {
    if (!this.socket || this.status !== 'open') {
      throw new Error('Chip ' + this.instancia + ' não está conectado (status: ' + this.status + ')');
    }
  }

  _toJid(numero) {
    // Remove @s.whatsapp.net caso já venha formatado, garante sufixo correto
    const limpo = String(numero).replace(/@s\.whatsapp\.net$/, '').replace(/\D/g, '');
    return limpo + '@s.whatsapp.net';
  }

  async _enviarPresenca(jid) {
    try {
      await this.socket.sendPresenceUpdate('composing', jid);
      await new Promise(r => setTimeout(r, 500));
      await this.socket.sendPresenceUpdate('paused', jid);
    } catch (_) { /* não crítico */ }
  }

  async _setStatus(status) {
    this.status = status;
    try {
      await pool.query(
        'UPDATE chips SET status = $1, ultimo_ping = NOW() WHERE instancia = $2',
        [status, this.instancia]
      );
    } catch (e) {
      console.error('[SESSION] Erro ao atualizar status no banco:', e.message);
    }
  }
}

module.exports = { ChipSession };
