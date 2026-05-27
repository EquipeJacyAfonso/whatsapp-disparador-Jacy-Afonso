require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../db');

function renderTemplate(template, dados) {
  return template.replace(/\{(\w+)\}/g, (_, key) => dados[key] || '');
}

// Parser CSV simples sem dependências externas
function parseCSV(conteudo) {
  const linhas = conteudo.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
  if (linhas.length < 2) throw new Error('CSV vazio ou sem dados');

  // Detecta separador (vírgula ou ponto-e-vírgula)
  const separador = linhas[0].includes(';') ? ';' : ',';

  const headers = linhas[0].split(separador).map(h => h.replace(/"/g, '').toLowerCase().trim());
  const numeroIdx = headers.findIndex(h => h === 'numero' || h === 'número' || h === 'phone' || h === 'telefone');
  if (numeroIdx === -1) throw new Error('Coluna "numero" não encontrada. Certifique-se de ter uma coluna chamada: numero, número, phone ou telefone');

  const nomeIdx = headers.findIndex(h => h === 'nome' || h === 'name');

  const rows = linhas.slice(1).map(linha => {
    // Suporta campos com aspas
    const cols = [];
    let cur = '', inQ = false;
    for (const ch of linha) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === separador && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  });

  return { headers, rows, numeroIdx, nomeIdx, separador };
}

async function importarCSV(conteudoCSV) {
  const { headers, rows, numeroIdx, nomeIdx } = parseCSV(conteudoCSV);

  let importados = 0, atualizados = 0, ignorados = 0;

  for (const row of rows) {
    const numero = String(row[numeroIdx] || '').replace(/\D/g, '');
    if (!numero || numero.length < 10) { ignorados++; continue; }

    const nome = nomeIdx >= 0 ? (row[nomeIdx] || '') : '';
    const dados = {};
    headers.forEach((h, i) => { if (i !== numeroIdx) dados[h] = row[i] || ''; });

    try {
      const result = await pool.query(`
        INSERT INTO contatos (numero, nome, dados)
        VALUES ($1, $2, $3)
        ON CONFLICT (numero) DO UPDATE
          SET nome = EXCLUDED.nome, dados = EXCLUDED.dados
        RETURNING (xmax = 0) AS inserted
      `, [numero, nome, JSON.stringify(dados)]);

      if (result.rows[0].inserted) importados++;
      else atualizados++;
    } catch (err) {
      console.error(`Erro ao importar ${numero}:`, err.message);
      ignorados++;
    }
  }

  return { importados, atualizados, ignorados, total: rows.length };
}

module.exports = { importarCSV, renderTemplate };
