require('dotenv').config();
const { google } = require('googleapis');
const pool = require('../db');

// Renderiza o template substituindo variáveis como {nome}, {cidade}, etc.
function renderTemplate(template, dados) {
  return template.replace(/\{(\w+)\}/g, (_, key) => dados[key] || '');
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// Importa contatos do Google Sheets para o PostgreSQL
// Espera que a primeira linha seja o cabeçalho
// A coluna "numero" é obrigatória; as demais viram campos dinâmicos
async function importarDoSheets(sheetId, range = 'Sheet1!A:Z') {
  const sheets = await getSheetsClient();

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range,
  });

  const rows = response.data.values;
  if (!rows || rows.length < 2) throw new Error('Planilha vazia ou sem dados');

  const headers = rows[0].map(h => h.toLowerCase().trim());
  const numeroIdx = headers.indexOf('numero');
  if (numeroIdx === -1) throw new Error('Coluna "numero" não encontrada na planilha');

  const nomeIdx = headers.indexOf('nome');
  const dataRows = rows.slice(1);

  let importados = 0;
  let atualizados = 0;
  let ignorados = 0;

  for (const row of dataRows) {
    const numero = String(row[numeroIdx] || '').replace(/\D/g, '');
    if (!numero || numero.length < 10) { ignorados++; continue; }

    const nome = nomeIdx >= 0 ? (row[nomeIdx] || '') : '';

    // Todos os campos da planilha vão para o JSONB "dados"
    const dados = {};
    headers.forEach((header, i) => {
      if (i !== numeroIdx) dados[header] = row[i] || '';
    });

    try {
      const result = await pool.query(`
        INSERT INTO contatos (numero, nome, dados)
        VALUES ($1, $2, $3)
        ON CONFLICT (numero) DO UPDATE
          SET nome = EXCLUDED.nome,
              dados = EXCLUDED.dados
        RETURNING (xmax = 0) AS inserted
      `, [numero, nome, JSON.stringify(dados)]);

      if (result.rows[0].inserted) importados++;
      else atualizados++;
    } catch (err) {
      console.error(`Erro ao importar número ${numero}:`, err.message);
      ignorados++;
    }
  }

  return { importados, atualizados, ignorados, total: dataRows.length };
}

module.exports = { importarDoSheets, renderTemplate };
