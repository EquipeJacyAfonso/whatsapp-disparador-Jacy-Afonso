// Integração com a WhatsApp Business Cloud API (Meta) — via oficial e
// sancionada de envio, em paralelo ao Baileys (não-oficial).
//
// Documentação de referência:
//   https://developers.facebook.com/docs/whatsapp/cloud-api
//   https://developers.facebook.com/docs/whatsapp/message-templates
//
// Diferenças-chave frente ao Baileys:
//   - Sem QR code — autenticação via access_token (System User) + phone_number_id
//   - Envio inicial de conversa exige template pré-aprovado pela Meta
//   - Templates têm categoria (MARKETING, UTILITY, AUTHENTICATION), idioma e variáveis
//   - Status de entrega chega via webhook (não via socket) — precisa endpoint público
//
// Segurança: access_token é armazenado CRIPTOGRAFADO (AES-256-GCM, ver
// src/utils/crypto.js) — nunca gravamos nem lemos o token em texto plano
// do banco. A chave de criptografia vive fora do banco (ENCRYPTION_KEY no .env).

require('dotenv').config();
const axios = require('axios');
const pool = require('../db');
const { encrypt, decrypt } = require('../utils/crypto');

const GRAPH_VERSION = 'v20.0';
const GRAPH_BASE = 'https://graph.facebook.com/' + GRAPH_VERSION;

function _client(accessToken) {
  return axios.create({
    baseURL: GRAPH_BASE,
    headers: { Authorization: 'Bearer ' + accessToken },
    timeout: 20000,
  });
}

// ─── Contas oficiais ───────────────────────────────────────────────────────────

async function adicionarContaOficial({ nome, phoneNumberId, wabaId, accessToken, limiteDiario }) {
  if (!nome || !phoneNumberId || !wabaId || !accessToken) {
    throw new Error('nome, phoneNumberId, wabaId e accessToken são obrigatórios');
  }

  // Valida credenciais consultando o número na Graph API antes de salvar —
  // evita cadastrar token/ID inválido silenciosamente. Usa o token em claro
  // (ainda só em memória, nunca tocou o banco).
  let numeroDisplay = null;
  try {
    const client = _client(accessToken);
    const { data } = await client.get('/' + phoneNumberId, {
      params: { fields: 'display_phone_number,verified_name,quality_rating' },
    });
    numeroDisplay = data.display_phone_number;
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    throw new Error('Falha ao validar conta na Meta: ' + msg);
  }

  // Só a partir daqui o token é criptografado antes de ir para o banco.
  const tokenCriptografado = encrypt(accessToken);

  const result = await pool.query(
    `INSERT INTO contas_oficiais (nome, phone_number_id, waba_id, access_token, numero_display, limite_diario)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, nome, phone_number_id, waba_id, numero_display, status, limite_diario, criado_em`,
    [nome, phoneNumberId, wabaId, tokenCriptografado, numeroDisplay, limiteDiario || 1000]
  );
  return result.rows[0];
}

async function listarContasOficiais() {
  // access_token (mesmo criptografado) nunca sai para o frontend
  const result = await pool.query(
    `SELECT id, nome, phone_number_id, waba_id, numero_display, status, limite_diario,
            enviados_hoje, total_enviados, qualidade, ultimo_ping, criado_em
     FROM contas_oficiais ORDER BY criado_em ASC`
  );
  return result.rows;
}

async function removerContaOficial(id) {
  await pool.query('DELETE FROM contas_oficiais WHERE id=$1', [id]);
}

/**
 * Busca uma conta oficial e devolve com o access_token JÁ DESCRIPTOGRAFADO.
 * Única porta de entrada para o token em claro dentro deste módulo —
 * todas as funções abaixo passam por aqui, então a descriptografia fica
 * centralizada e não precisa ser repetida em cada função.
 */
async function _obterConta(id) {
  const result = await pool.query('SELECT * FROM contas_oficiais WHERE id=$1', [id]);
  if (!result.rows.length) throw new Error('Conta oficial não encontrada');
  const conta = result.rows[0];
  return { ...conta, access_token: decrypt(conta.access_token) };
}

/**
 * Consulta o rating de qualidade do número na Meta e atualiza localmente.
 * A Meta usa isso pra throttle automático — GREEN/YELLOW/RED.
 */
async function atualizarQualidade(id) {
  const conta = await _obterConta(id);
  try {
    const client = _client(conta.access_token);
    const { data } = await client.get('/' + conta.phone_number_id, {
      params: { fields: 'quality_rating,status' },
    });
    await pool.query(
      'UPDATE contas_oficiais SET qualidade=$1, status=$2, ultimo_ping=NOW() WHERE id=$3',
      [data.quality_rating || null, data.status === 'CONNECTED' ? 'ativo' : (data.status || 'ativo').toLowerCase(), id]
    );
    return { qualidade: data.quality_rating, status: data.status };
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    throw new Error('Falha ao consultar qualidade: ' + msg);
  }
}

// ─── Templates ──────────────────────────────────────────────────────────────

/**
 * Cria um template na Meta (fica em PENDING até revisão — pode levar de
 * minutos a alguns dias) e espelha localmente.
 *
 * @param {object} dados
 * @param {number} dados.contaId
 * @param {string} dados.nome        - só minúsculas, números e underscore
 * @param {string} dados.categoria   - 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
 * @param {string} dados.idioma      - ex: 'pt_BR'
 * @param {string} dados.corpo       - texto com variáveis no formato {{1}}, {{2}}...
 * @param {string[]} dados.variaveis - nomes amigáveis das variáveis, na ordem ({{1}}, {{2}}...)
 * @param {string} [dados.cabecalhoTexto]
 * @param {string} [dados.rodape]
 */
async function criarTemplate({ contaId, nome, categoria, idioma, corpo, variaveis, cabecalhoTexto, rodape }) {
  if (!/^[a-z0-9_]+$/.test(nome)) {
    throw new Error('Nome do template deve conter apenas letras minúsculas, números e underscore (ex: promo_junho_2026)');
  }
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(categoria)) {
    throw new Error('Categoria inválida. Use MARKETING, UTILITY ou AUTHENTICATION.');
  }

  const conta = await _obterConta(contaId);

  const components = [];
  if (cabecalhoTexto) {
    components.push({ type: 'HEADER', format: 'TEXT', text: cabecalhoTexto });
  }
  components.push({
    type: 'BODY',
    text: corpo,
    ...(variaveis && variaveis.length
      ? { example: { body_text: [variaveis.map((_, i) => 'exemplo' + (i + 1))] } }
      : {}),
  });
  if (rodape) {
    components.push({ type: 'FOOTER', text: rodape });
  }

  let metaTemplateId = null;
  let statusMeta = 'PENDING';
  try {
    const client = _client(conta.access_token);
    const { data } = await client.post('/' + conta.waba_id + '/message_templates', {
      name: nome,
      language: idioma || 'pt_BR',
      category: categoria,
      components,
    });
    metaTemplateId = data.id;
    statusMeta = data.status || 'PENDING';
  } catch (e) {
    const msg = e.response?.data?.error?.error_user_msg || e.response?.data?.error?.message || e.message;
    throw new Error('Falha ao criar template na Meta: ' + msg);
  }

  const result = await pool.query(
    `INSERT INTO whatsapp_templates
       (conta_id, meta_template_id, nome, categoria, idioma, status, corpo, variaveis, cabecalho_tipo, cabecalho_texto, rodape)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      contaId, metaTemplateId, nome, categoria, idioma || 'pt_BR', statusMeta, corpo,
      JSON.stringify(variaveis || []), cabecalhoTexto ? 'TEXT' : null, cabecalhoTexto || null, rodape || null,
    ]
  );
  return result.rows[0];
}

/**
 * Busca todos os templates já existentes na Meta para a conta e sincroniza
 * localmente (insere novos, atualiza status dos existentes). Útil para
 * templates criados direto no Meta Business Manager, fora do painel.
 */
async function sincronizarTemplates(contaId) {
  const conta = await _obterConta(contaId);
  const client = _client(conta.access_token);

  let templates = [];
  try {
    const { data } = await client.get('/' + conta.waba_id + '/message_templates', {
      params: { limit: 200 },
    });
    templates = data.data || [];
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    throw new Error('Falha ao sincronizar templates: ' + msg);
  }

  let novos = 0, atualizados = 0;
  for (const t of templates) {
    const bodyComp = (t.components || []).find(c => c.type === 'BODY');
    const headerComp = (t.components || []).find(c => c.type === 'HEADER');
    const footerComp = (t.components || []).find(c => c.type === 'FOOTER');
    if (!bodyComp) continue;

    const existente = await pool.query(
      'SELECT id FROM whatsapp_templates WHERE conta_id=$1 AND nome=$2 AND idioma=$3',
      [contaId, t.name, t.language]
    );

    if (existente.rows.length) {
      await pool.query(
        `UPDATE whatsapp_templates SET meta_template_id=$1, status=$2, corpo=$3, categoria=$4,
           cabecalho_tipo=$5, cabecalho_texto=$6, rodape=$7, atualizado_em=NOW() WHERE id=$8`,
        [
          t.id, t.status, bodyComp.text, t.category,
          headerComp?.format || null, headerComp?.text || null, footerComp?.text || null,
          existente.rows[0].id,
        ]
      );
      atualizados++;
    } else {
      await pool.query(
        `INSERT INTO whatsapp_templates
           (conta_id, meta_template_id, nome, categoria, idioma, status, corpo, cabecalho_tipo, cabecalho_texto, rodape)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          contaId, t.id, t.name, t.category, t.language, t.status, bodyComp.text,
          headerComp?.format || null, headerComp?.text || null, footerComp?.text || null,
        ]
      );
      novos++;
    }
  }
  return { novos, atualizados, total: templates.length };
}

async function listarTemplates(contaId) {
  const where = contaId ? 'WHERE conta_id=$1' : '';
  const params = contaId ? [contaId] : [];
  const result = await pool.query(
    `SELECT t.*, c.nome as conta_nome FROM whatsapp_templates t
     JOIN contas_oficiais c ON c.id = t.conta_id ${where} ORDER BY t.criado_em DESC`,
    params
  );
  return result.rows;
}

async function removerTemplate(id) {
  const tpl = await pool.query('SELECT t.*, c.access_token, c.waba_id FROM whatsapp_templates t JOIN contas_oficiais c ON c.id=t.conta_id WHERE t.id=$1', [id]);
  if (!tpl.rows.length) return;
  const t = tpl.rows[0];

  // Tenta remover na Meta também (best-effort — se falhar, remove local mesmo assim)
  try {
    const tokenClaro = decrypt(t.access_token);
    const client = _client(tokenClaro);
    await client.delete('/' + t.waba_id + '/message_templates', { params: { name: t.nome } });
  } catch (e) {
    console.warn('[OFICIAL] Falha ao remover template na Meta (removendo local mesmo assim): ' + e.message);
  }

  await pool.query('DELETE FROM whatsapp_templates WHERE id=$1', [id]);
}

// ─── Envio ──────────────────────────────────────────────────────────────────

/**
 * Envia uma mensagem de template pela Cloud API.
 * @param {number} contaId
 * @param {string} numero - com DDI, ex: 5511999999999
 * @param {object} template - linha de whatsapp_templates
 * @param {string[]} valores - valores das variáveis do corpo, na ordem {{1}}, {{2}}...
 * @returns {{ wamid: string }}
 */
async function enviarTemplate(contaId, numero, template, valores = []) {
  const conta = await _obterConta(contaId);

  if (template.status !== 'APPROVED') {
    throw new Error('Template "' + template.nome + '" ainda não foi aprovado pela Meta (status: ' + template.status + ')');
  }

  const components = [];
  if (valores.length) {
    components.push({
      type: 'body',
      parameters: valores.map(v => ({ type: 'text', text: String(v) })),
    });
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: numero,
    type: 'template',
    template: {
      name: template.nome,
      language: { code: template.idioma },
      ...(components.length ? { components } : {}),
    },
  };

  try {
    const client = _client(conta.access_token);
    const { data } = await client.post('/' + conta.phone_number_id + '/messages', payload);
    const wamid = data.messages?.[0]?.id;
    if (!wamid) throw new Error('Resposta da Meta sem ID de mensagem');
    return { wamid };
  } catch (e) {
    const errData = e.response?.data?.error;
    const msg = errData?.error_user_msg || errData?.message || e.message;
    const err = new Error('Falha ao enviar via Cloud API: ' + msg);
    // Erros de número inválido/bloqueio são permanentes — não adianta retry
    if (errData?.code === 131026 || errData?.code === 131047 || errData?.code === 132001) {
      err.semRetry = true;
    }
    throw err;
  }
}

async function registrarUsoOficial(contaId) {
  await pool.query(
    'UPDATE contas_oficiais SET enviados_hoje = enviados_hoje + 1, total_enviados = total_enviados + 1, ultimo_ping = NOW() WHERE id = $1',
    [contaId]
  );
}

async function resetarContadoresDiariosOficial() {
  await pool.query('UPDATE contas_oficiais SET enviados_hoje = 0');
}

/**
 * Escolhe a próxima conta oficial disponível (dentro do limite diário) por
 * rotação round-robin simples — mesma lógica de proximoChip do Baileys.
 */
async function proximaContaOficial() {
  const contas = await pool.query(`
    SELECT * FROM contas_oficiais
    WHERE status = 'ativo' AND enviados_hoje < limite_diario
    ORDER BY enviados_hoje ASC, ultimo_ping ASC NULLS FIRST
    LIMIT 1
  `);
  if (!contas.rows.length) {
    throw new Error('Nenhuma conta oficial disponível (todas atingiram o limite diário ou estão inativas).');
  }
  // Descriptografa o token antes de devolver — quem chama (disparo-oficial.js)
  // vai usar essa conta para enviar via enviarTemplate(), que passa de novo
  // por _obterConta(id) e descriptografa a partir do banco — então aqui
  // devolvemos os dados sem o token em claro, mantendo o mesmo contrato
  // de antes (o token nunca precisou sair desta função).
  const conta = contas.rows[0];
  return conta;
}

// ─── Webhook — atualização de status de entrega ───────────────────────────────
// A Meta envia POST assíncrono para o webhook configurado no App, com o
// status de cada mensagem: sent → delivered → read (ou failed).
async function processarWebhookStatus(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const statuses = value?.statuses || [];

    for (const s of statuses) {
      const wamid = s.id;
      const status = s.status; // sent | delivered | read | failed
      await pool.query(
        "UPDATE disparos SET ack_status=$1, confirmado_em=NOW() WHERE wamid=$2",
        [status, wamid]
      );
      if (status === 'failed') {
        const erro = s.errors?.[0]?.title || 'Falha reportada pela Meta';
        await pool.query("UPDATE disparos SET status='falha', erro=$1 WHERE wamid=$2", [erro, wamid]);
      }
    }
  } catch (e) {
    console.error('[OFICIAL] Erro ao processar webhook de status:', e.message);
  }
}

module.exports = {
  adicionarContaOficial,
  listarContasOficiais,
  removerContaOficial,
  atualizarQualidade,
  criarTemplate,
  sincronizarTemplates,
  listarTemplates,
  removerTemplate,
  enviarTemplate,
  registrarUsoOficial,
  resetarContadoresDiariosOficial,
  proximaContaOficial,
  processarWebhookStatus,
};
