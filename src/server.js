require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const routes = require('./routes');
const { resetarContadoresDiarios } = require('./services/evolution');
const {
  limparJobsTravados,
  iniciarMonitorChips,
  verificarConclusaoCampanha,
  disparoQueue,
} = require('./queue/disparo');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── Startup ──────────────────────────────────────────────────────────────────
async function startup() {
  console.log('\n🚀 Servidor: http://localhost:' + PORT);

  // FIX 1: Limpa jobs que ficaram presos no restart anterior
  console.log('[STARTUP] Verificando jobs travados...');
  await limparJobsTravados();

  // FIX 2: Inicia monitor de chips desconectados
  iniciarMonitorChips();

  // FIX 1: Verifica se alguma campanha ficou presa em_andamento sem pendentes
  try {
    const pool = require('./db');
    const campanhasAtivas = await pool.query(
      `SELECT id FROM campanhas WHERE status='em_andamento'`
    );
    for (const camp of campanhasAtivas.rows) {
      await verificarConclusaoCampanha(camp.id);
    }
    if (campanhasAtivas.rows.length > 0) {
      console.log(`[STARTUP] Verificadas ${campanhasAtivas.rows.length} campanha(s) ativas.`);
    }
  } catch(e) {
    console.error('[STARTUP] Erro ao verificar campanhas:', e.message);
  }

  console.log('⏰ Reset diário configurado para meia-noite (Brasília)');
  console.log('🔍 Monitor de chips ativo (intervalo: 2min)\n');
}

// ─── Crons ────────────────────────────────────────────────────────────────────

// Reset dos chips à meia-noite
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Reset diário dos chips...');
  await resetarContadoresDiarios();
}, { timezone: 'America/Sao_Paulo' });

// Sincronização automática Sheets → Banco (verifica a cada hora)
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

// Varredura de campanhas presas — toda hora confere se alguma deveria ter concluído
cron.schedule('*/30 * * * *', async () => {
  const pool = require('./db');
  try {
    const ativas = await pool.query(`SELECT id FROM campanhas WHERE status='em_andamento'`);
    for (const camp of ativas.rows) {
      await verificarConclusaoCampanha(camp.id);
    }
  } catch(e) {}
});

// Limpa logs com mais de 7 dias
cron.schedule('0 3 * * 0', async () => {
  const pool = require('./db');
  await pool.query(`DELETE FROM logs WHERE criado_em < NOW() - INTERVAL '7 days'`);
  console.log('[CRON] Logs antigos removidos.');
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, startup);
