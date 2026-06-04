require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const routes = require('./routes');
const { resetarContadoresDiarios } = require('./services/evolution');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // limite maior para credenciais JSON
app.use(express.static(path.join(__dirname, '../public')));
app.use('/api', routes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Reset diário dos chips à meia-noite (horário de Brasília)
cron.schedule('0 0 * * *', async () => {
  console.log('[CRON] Reset diário dos chips...');
  await resetarContadoresDiarios();
}, { timezone: 'America/Sao_Paulo' });

// Limpa logs com mais de 7 dias toda semana
cron.schedule('0 3 * * 0', async () => {
  const pool = require('./db');
  await pool.query(`DELETE FROM logs WHERE criado_em < NOW() - INTERVAL '7 days'`);
  console.log('[CRON] Logs antigos removidos.');
});

app.listen(PORT, () => {
  console.log(`\n🚀 Servidor: http://localhost:${PORT}`);
  console.log(`⏰ Reset diário configurado para meia-noite (Brasília)\n`);
});
