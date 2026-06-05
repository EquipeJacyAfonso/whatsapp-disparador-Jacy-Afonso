// Serviço central de proteção anti-ban
// Gerencia: spintax, janela de horário, detecção de ban, intervalo entre campanhas

const pool = require('../db');
const config = require('./config');

// ─── Spintax ─────────────────────────────────────────────────────────────────
// Sintaxe: {opção1|opção2|opção3} — escolhe uma aleatoriamente
// Suporta aninhamento: {Olá|{Oi|Ei}, tudo bem?}
function processarSpintax(texto) {
  let resultado = texto;
  // Processa de dentro pra fora (aninhamento)
  let anterior;
  do {
    anterior = resultado;
    resultado = resultado.replace(/\{([^{}]+)\}/g, (_, opcoes) => {
      const lista = opcoes.split('|');
      return lista[Math.floor(Math.random() * lista.length)].trim();
    });
  } while (resultado !== anterior);
  return resultado;
}

// ─── Janela de horário ────────────────────────────────────────────────────────
async function dentroDaJanela() {
  const horarioAtivo = await config.get('horario_ativo', 'true');
  if (horarioAtivo !== 'true') return true; // janela desativada

  const horaInicio = parseInt(await config.get('horario_inicio', '8'));
  const horaFim    = parseInt(await config.get('horario_fim', '20'));

  const agora = new Date();
  const hora  = agora.getHours();

  return hora >= horaInicio && hora < horaFim;
}

// Retorna quantos ms faltam para a janela abrir
async function msAteJanelaAbrir() {
  const horaInicio = parseInt(await config.get('horario_inicio', '8'));
  const agora = new Date();
  const abertura = new Date(agora);
  abertura.setHours(horaInicio, 0, 0, 0);
  if (abertura <= agora) abertura.setDate(abertura.getDate() + 1); // amanhã
  return abertura - agora;
}

// ─── Detecção de ban ──────────────────────────────────────────────────────────
// Erros que indicam ban ou bloqueio do WhatsApp
const ERROS_BAN = [
  'forbidden',
  'blocked',
  'banned',
  'unauthorized',
  '401',
  '403',
  'invalid session',
  'not connected',
  'close session',
  'logout',
];

function erroIndicaBan(mensagemErro) {
  const msg = String(mensagemErro).toLowerCase();
  return ERROS_BAN.some(e => msg.includes(e));
}

async function processarErroBan(chipId, instancia, mensagemErro) {
  if (!erroIndicaBan(mensagemErro)) return false;

  // Pausa o chip por 24h e marca como banido
  const ate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(
    `UPDATE chips SET status = 'banido', pausado_ate = $1 WHERE id = $2`,
    [ate, chipId]
  );

  await pool.query(
    `INSERT INTO logs (nivel, mensagem, dados) VALUES ('alerta', $1, $2)`,
    [
      `Chip ${instancia} possivelmente banido — pausado por 24h`,
      JSON.stringify({ chipId, instancia, erro: mensagemErro })
    ]
  );

  console.error(`[ANTIBAN] ⚠ Chip ${instancia} detectado como banido. Pausado por 24h.`);
  return true;
}

// ─── Intervalo entre campanhas por chip ───────────────────────────────────────
async function registrarFimCampanhaChip(chipId) {
  await pool.query(
    `UPDATE chips SET ultima_campanha_em = NOW() WHERE id = $1`,
    [chipId]
  );
}

async function chipEmDescanso(chip) {
  const intervaloMin = parseInt(await config.get('intervalo_campanhas_min', '0'));
  if (intervaloMin === 0) return false; // sem intervalo configurado
  if (!chip.ultima_campanha_em) return false;

  const ultimaCampanha = new Date(chip.ultima_campanha_em);
  const minutos = (Date.now() - ultimaCampanha) / 1000 / 60;
  return minutos < intervaloMin;
}

// ─── Verificação completa antes de cada envio ─────────────────────────────────
async function verificarCondicoes() {
  // 1. Janela de horário
  if (!(await dentroDaJanela())) {
    const ms = await msAteJanelaAbrir();
    const horas = Math.round(ms / 1000 / 60 / 60 * 10) / 10;
    throw new Error(`Fora da janela de horário. Disparo retoma em ${horas}h.`);
  }
  return true;
}

module.exports = {
  processarSpintax,
  dentroDaJanela,
  msAteJanelaAbrir,
  erroIndicaBan,
  processarErroBan,
  registrarFimCampanhaChip,
  chipEmDescanso,
  verificarCondicoes,
};
