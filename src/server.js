require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const routes = require('./routes');
const { resetarContadoresDiarios, aquecerChipsInternamente } = require('./services/evolution');
const {
  limparJobsTravados,
  iniciarMonitorChips,
  verificarConclusaoCampanha,
} = require('./queue/disparo');
const { verificarStartup } = require('./services/health');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Webhook da Evolution API (Único ponto de entrada para todos os eventos) ──
// Trata: connection.update (status chip), qrcode.updated, messages.upsert (opt-out)
// IMPORTANTE: a Evolution API só suporta 1 webhook por instância — tudo aqui.
const evolutionService = require('./services/evolution');

app.post('/webhook/evolution', async (req, res) => {
  res.status(200).send('OK'); // responde imediatamente antes de processar
  try {
    const payload = req.body;
    const instancia = payload.instance || payload.data?.instance;
    const event = payload.event;
    const data = payload.data;

    // ── Atualização de status de conexão ──────────────────────────────────────
    if (event === 'connection.update') {
      const state = (data && (data.state || data.status)) || 'desconhecido';
      const pool = require('./db');
      await pool.query('UPDATE chips SET status=$1, ultimo_ping=NOW() WHERE instancia=$2', [state, instancia]);
      await pool.query("INSERT INTO logs (nivel, mensagem, dados) VALUES ('info',$1,$2)",
        ['Webhook: chip ' + instancia + ' → ' + state, JSON.stringify({ instancia, state })]);
      console.log('[WEBHOOK] ' + instancia + ' → ' + state);

      const { disparoQueue } = require('./queue/disparo');
      if (state === 'open') {
        // Chip reconectou — retoma fila se estava pausada por falta de chips
        const pausado = await disparoQueue.isPaused();
        if (pausado && await disparoQueue.getWaitingCount() > 0) {
          await disparoQueue.resume();
          console.log('[WEBHOOK] ✅ Fila retomada após reconexão de ' + instancia);
        }
      } else if (['close', 'connecting', 'disconnected'].includes(state)) {
        // Chip desconectou — pausa fila se não houver outros chips online
        const outros = await pool.query(
          "SELECT COUNT(*) FROM chips WHERE status='open' AND instancia!=$1", [instancia]
        );
        const filaAtiva = !(await disparoQueue.isPaused());
        const temMensagens = (await disparoQueue.getWaitingCount() + await disparoQueue.getActiveCount()) > 0;
        if (parseInt(outros.rows[0].count) === 0 && filaAtiva && temMensagens) {
          await disparoQueue.pause();
          console.warn('[WEBHOOK] ⚠ ' + instancia + ' desconectou. Fila pausada.');
        }
      }
      return;
    }

    // ── QR Code atualizado ────────────────────────────────────────────────────
    if (event === 'qrcode.updated') {
      const pool = require('./db');
      await pool.query("UPDATE chips SET status='qr_code', ultimo_ping=NOW() WHERE instancia=$1", [instancia]);
      return;
    }

    // ── Mensagem recebida (opt-out + marcação como lida) ──────────────────────
    if (event === 'messages.upsert') {
      const msg = payload.data;
      if (!msg || msg.key?.fromMe) return;

      // Marca como lida
      if (instancia && msg.key) {
        await evolutionService.marcarComoLida(instancia, msg.key);
      }

      // Detecta opt-out (SAIR, STOP, etc.)
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto) return;

      const textoLimpo = texto.trim().toUpperCase();
      const palavrasChave = ['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'REMOVER'];
      if (palavrasChave.includes(textoLimpo)) {
        const pool = require('./db');
        const { formatarNumero } = require('./services/evolution');
        const numeroRemetente = formatarNumero(msg.key.remoteJid.replace('@s.whatsapp.net', ''));
        await pool.query(
          'INSERT INTO blacklist (numero, motivo) VALUES ($1, $2) ON CONFLICT (numero) DO NOTHING',
          [numeroRemetente, 'Opt-Out automático via WhatsApp']
        );
        console.log('[OPT-OUT] ' + numeroRemetente + ' bloqueado (' + textoLimpo + ')');
      }
      return;
    }

  } catch (erro) {
    console.error('[WEBHOOK] Erro ao processar:', erro.message);
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function startup() {
  console.log('\n🚀 Servidor: http://localhost:' + PORT);

  // Bug 12: verifica se as tabelas existem antes de tentar usar o banco
  try {
    await pool.query('SELECT 1 FROM configuracoes LIMIT 1');
  } catch (e) {
    console.error('[STARTUP] ❌ Tabelas não encontradas. Execute: node src/db/migrate.js');
    console.error('[STARTUP] → Se estiver usando Docker: docker compose run --rm app node src/db/migrate.js');
    process.exit(1);
  }

  await verificarStartup();

  console.log('[STARTUP] Verificando jobs travados...');
  await limparJobsTravados();

  iniciarMonitorChips();

  try {
    const pool = require('./db');
    const campanhasAtivas = await pool.query(`SELECT id FROM campanhas WHERE status='em_andamento'`);
    for (const camp of campanhasAtivas.rows) {
      await verificarConclusaoCampanha(camp.id);
    }
    if (campanhasAtivas.rows.length > 0) {
      console.log(`[STARTUP] Verificadas ${campanhasAtivas.rows.length} campanha(s) ativas.`);
    }
  } catch(e) {
    console.error('[STARTUP] Erro ao verificar campanhas:', e.message);
  }

  // Garante que o usuário admin padrão existe
  try {
    const bcrypt = require('bcryptjs');
    const pool = require('./db');
    const existente = await pool.query('SELECT COUNT(*) FROM usuarios');
    if (parseInt(existente.rows[0].count) === 0) {
      const hash = await bcrypt.hash('admin123', 12);
      await pool.query(
        "INSERT INTO usuarios (nome, email, senha_hash) VALUES ('Administrador', 'admin@disparador.local', $1)",
        [hash]
      );
      console.log('[AUTH] ✅ Usuário admin criado — email: admin@disparador.local / senha: admin123');
      console.log('[AUTH] ⚠ Troque a senha no primeiro acesso!');
    }
  } catch(e) {
    console.warn('[AUTH] Aviso ao verificar usuários:', e.message);
  }

  console.log('⏰ Reset diário configurado para meia-noite (Brasília)');
  console.log('🔍 Monitor de chips ativo (intervalo: 2min)\n');
}

// ─── Crons ────────────────────────────────────────────────────────────────────

cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Reset diário dos chips...');
  await resetarContadoresDiarios();
}, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 * * * *', async () => {
  const pool = require('./db');
  const cfgSvc = require('./services/config');
  try {
    const intervalo = parseInt(await cfgSvc.get('sync_intervalo', '0'));
    if (intervalo === 0) return;
    const proximaStr = await cfgSvc.get('sync_proxima', '');
    if (!proximaStr) return;
    if (new Date() < new Date(proximaStr)) return;
    const { importarDoSheets } = require('./services/sheets');
    const resultado = await importarDoSheets();
    console.log(`[CRON] Sheets sync: ${resultado.importados} novos`);
    const prox = new Date(Date.now() + intervalo * 60 * 60 * 1000);
    await cfgSvc.set('sync_proxima', prox.toISOString());
    await pool.query(
      `INSERT INTO logs (nivel, mensagem) VALUES ('info', $1)`,
      [`Sync Sheets: ${resultado.importados} novos, ${resultado.atualizados} atualizados`]
    );
  } catch(e) {
    console.error('[CRON] Erro sync Sheets:', e.message);
  }
});

cron.schedule('*/30 * * * *', async () => {
  const pool = require('./db');
  try {
    const ativas = await pool.query(`SELECT id FROM campanhas WHERE status='em_andamento'`);
    for (const camp of ativas.rows) {
      await verificarConclusaoCampanha(camp.id);
    }
  } catch(e) {}
});

cron.schedule('0 3 * * 0', async () => {
  const pool = require('./db');
  await pool.query(`DELETE FROM logs WHERE criado_em < NOW() - INTERVAL '7 days'`);
  console.log('[CRON] Logs antigos removidos.');
});

// ─── Aquecimento Interno de Chips ────────────────────────────────────────────
const INTERVALO_AQUECIMENTO = 45 * 60 * 1000;
setInterval(() => {
  aquecerChipsInternamente();
}, INTERVALO_AQUECIMENTO);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, startup);

console.log(`🔥 Aquecimento automático de chips ativado (intervalo: 45min)`);
