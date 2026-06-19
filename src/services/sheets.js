require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../db');
const config = require('./config');

async function getSheetsClient() {
  const credsJson = await config.get('sheets_credentials', '');

  let auth;
  if (credsJson && credsJson.trim().startsWith('{')) {
    const tmpFile = path.join(os.tmpdir(), 'sheets-creds.json');
    fs.writeFileSync(tmpFile, credsJson);
    auth = new google.auth.GoogleAuth({
      keyFile: tmpFile,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
  } else {
    throw new Error('Credenciais do Google não configuradas. Configure na aba Configurações.');
  }

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

async function importarDoSheets(sheetId, range) {
  const id = sheetId || await config.get('sheets_id', '');
  const r = range || await config.get('sheets_range', 'Sheet1!A:Z');

  if (!id) throw new Error('ID da planilha não configurado.');

  const sheets = await getSheetsClient();
  const response = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: r });
  const rows = response.data.values;
  if (!rows || rows.length < 2) throw new Error('Planilha vazia ou sem dados');

  const headers = rows[0].map(h => h.toLowerCase().trim());
  const numeroIdx = headers.findIndex(h => ['numero','número','phone','telefone'].includes(h));
  if (numeroIdx === -1) throw new Error('Coluna "numero" não encontrada na planilha');

  const nomeIdx = headers.findIndex(h => h === 'nome' || h === 'name');
  const dataRows = rows.slice(1);

  let importados = 0, atualizados = 0, ignorados = 0;

  for (const row of dataRows) {
    const numero = String(row[numeroIdx] || '').replace(/\D/g, '');
    if (!numero || numero.length < 10) { ignorados++; continue; }

    const bl = await pool.query('SELECT 1 FROM blacklist WHERE numero = $1', [numero]);
    if (bl.rows.length) { ignorados++; continue; }

    const nome = nomeIdx >= 0 ? (row[nomeIdx] || '') : '';
    const dados = {};
    headers.forEach((h, i) => { if (i !== numeroIdx) dados[h] = row[i] || ''; });

    try {
      const result = await pool.query(`
        INSERT INTO contatos (numero, nome, dados) VALUES ($1, $2, $3)
        ON CONFLICT (numero) DO UPDATE SET nome = EXCLUDED.nome, dados = EXCLUDED.dados
        RETURNING (xmax = 0) AS inserted
      `, [numero, nome, JSON.stringify(dados)]);
      if (result.rows[0].inserted) importados++; else atualizados++;
    } catch (err) {
      console.error(`Erro ao importar ${numero}:`, err.message);
      ignorados++;
    }
  }
  return { importados, atualizados, ignorados, total: dataRows.length };
}

module.exports = { importarDoSheets };
