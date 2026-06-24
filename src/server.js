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
const { verificarStartup } = require('./services/health');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
// ─── LIMITE AUMENTADO PARA IMAGENS PESADAS ───
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);

const evolutionService = require('./services/evolution');

app.post('/webhook/evolution', async (req, res) => {
  res.status(200).send('OK');
  try {
    const payload = req.body;
    const instancia = payload.instance;
    if (payload.event === 'messages.upsert') {
      const msg = payload.data;
      if (msg.key.fromMe) return;
      if (instancia && msg.key) {
         await evolutionService.marcarComoLida(instancia, msg.key);
      }
      const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (!texto) return;
      const textoLimpo = texto.trim().toUpperCase();
      const palavrasChave = ['SAIR', 'PARAR', 'STOP', 'CANCELAR', 'REMOVER'];
      if (palavrasChave.includes(textoLimpo)) {
        const numeroRemetente = msg.key.remoteJid.replace('@s.whatsapp.net', '');
        const pool = require('./db');
        await pool.query(
          `INSERT INTO blacklist (numero, motivo) VALUES ($1, $2) ON CONFLICT (numero) DO NOTHING`,
          [numeroRemetente, 'Opt-Out: Solicitado pelo utilizador (Webhook)']
        );
      }
    }
  } catch (erro) { console.error('[WEBHOOK] Erro:', erro.message); }
});

async function startup() {
  console.log('\n🚀 Servidor: http://localhost:' + PORT);
  await verificarStartup();
  console.log('[STARTUP] Verificando jobs travados...');
  await limparJobsTravados();
  iniciarMonitorChips();
  try {
    const pool = require('./db');
    const campanhasAtivas = await pool.query(`SELECT id FROM campanhas WHERE status='em_andamento'`);
    for (const camp of campanhasAtivas.rows) await verificarConclusaoCampanha(camp.id);
  } catch(e) {}
  console.log('⏰ Sistema Online e Pronto');
}

cron.schedule('0 0 * * *', async () => { await resetarContadoresDiarios(); }, { timezone: 'America/Sao_Paulo' });

cron.schedule('0 * * * *', async () => {
  const pool = require('./db'); const cfgSvc = require('./services/config');
  try {
    const intervalo = parseInt(await cfgSvc.get('sync_intervalo', '0'));
    if (intervalo === 0) return;
    const proximaStr = await cfgSvc.get('sync_proxima', '');
    if (!proximaStr || new Date() < new Date(proximaStr)) return;
    const { importarDoSheets } = require('./services/sheets');
    const resultado = await importarDoSheets();
    const prox = new Date(Date.now() + intervalo * 60 * 60 * 1000);
    await cfgSvc.set('sync_proxima', prox.toISOString());
    await pool.query(`INSERT INTO logs (nivel, mensagem) VALUES ('info', $1)`, [`Sync Sheets: ${resultado.importados} novos`]);
  } catch(e) { }
});

cron.schedule('*/30 * * * *', async () => {
  const pool = require('./db');
  try {
    const ativas = await pool.query(`SELECT id FROM campanhas WHERE status='em_andamento'`);
    for (const camp of ativas.rows) await verificarConclusaoCampanha(camp.id);
  } catch(e) {}
});

cron.schedule('0 3 * * 0', async () => {
  const pool = require('./db');
  await pool.query(`DELETE FROM logs WHERE criado_em < NOW() - INTERVAL '7 days'`);
});

app.listen(PORT, startup);

const evolutionWarmup = require('./services/evolution');
setInterval(() => { evolutionWarmup.aquecerChipsInternamente(); }, 45 * 60 * 1000);