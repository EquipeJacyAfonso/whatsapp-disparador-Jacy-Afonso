require('dotenv').config();
const axios = require('axios');
const pool = require('../db');

const BASE_URL = process.env.EVOLUTION_API_URL;
const API_KEY  = process.env.EVOLUTION_API_KEY;

function clientePara(instancia) {
  return axios.create({
    baseURL: BASE_URL,
    headers: { 'apikey': API_KEY, 'Content-Type': 'application/json' },
    timeout: 15000,
  });
}

function formatarNumero(numero) {
  const limpo = String(numero).replace(/\D/g, '');
  return (limpo.startsWith('55') ? limpo : `55${limpo}`) + '@s.whatsapp.net';
}

// ─── Chips (instâncias) ───────────────────────────────────────────────────────

async function listarChips() {
  const result = await pool.query('SELECT * FROM chips ORDER BY criado_em ASC');
  return result.rows;
}

async function adicionarChip(nome, instancia) {
  const result = await pool.query(
    'INSERT INTO chips (nome, instancia, status) VALUES ($1, $2, $3) RETURNING *',
    [nome, instancia, 'desconectado']
  );
  return result.rows[0];
}

async function removerChip(id) {
  await pool.query('DELETE FROM chips WHERE id = $1', [id]);
}

async function statusChip(instancia) {
  try {
    const api = clientePara(instancia);
    const r = await api.get(`/instance/connectionState/${instancia}`);
    const state = r.data?.instance?.state || r.data?.state || 'desconhecido';
    await pool.query(`UPDATE chips SET status = $1, ultimo_ping = NOW() WHERE instancia = $2`, [state, instancia]);
    return state;
  } catch (e) {
    await pool.query(`UPDATE chips SET status = 'erro' WHERE instancia = $1`, [instancia]);
    return 'erro';
  }
}

async function qrcodeChip(instancia) {
  const api = clientePara(instancia);
  const r = await api.get(`/instance/connect/${instancia}`);
  return r.data;
}

async function criarInstancia(instancia) {
  const api = clientePara(instancia);
  const r = await api.post('/instance/create', {
    instanceName: instancia,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  });
  return r.data;
}

// Retorna o próximo chip conectado em round-robin
async function proximoChip() {
  const chips = await pool.query(
    `SELECT * FROM chips WHERE status = 'open' ORDER BY enviados_hoje ASC, ultimo_uso ASC NULLS FIRST LIMIT 1`
  );
  if (!chips.rows.length) throw new Error('Nenhum chip conectado disponível');
  return chips.rows[0];
}

async function registrarUso(chipId) {
  await pool.query(
    `UPDATE chips SET enviados_hoje = enviados_hoje + 1, ultimo_uso = NOW() WHERE id = $1`,
    [chipId]
  );
}

// ─── Envio ────────────────────────────────────────────────────────────────────

async function enviarMensagem(numero, mensagem, instancia) {
  const api = clientePara(instancia);
  const r = await api.post(`/message/sendText/${instancia}`, {
    number: formatarNumero(numero),
    text: mensagem,
  });
  return r.data;
}

module.exports = {
  enviarMensagem, formatarNumero,
  listarChips, adicionarChip, removerChip, statusChip, qrcodeChip, criarInstancia,
  proximoChip, registrarUso,
};
