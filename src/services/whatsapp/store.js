// Adapter entre o Baileys e o PostgreSQL.
// Substitui o useMultiFileAuthState (que persiste em disco/arquivos)
// por uma implementação que lê e grava na tabela chip_sessions.
//
// O Baileys divide o estado de autenticação em dois objetos:
//   creds → identidade do dispositivo (gerada uma vez, no primeiro QR)
//   keys  → chaves de sessão por conversa (atualizadas a cada mensagem)
// Ambos contêm Buffer objects — usamos BufferJSON para serializar/deserializar
// de forma que o PostgreSQL (JSONB) consiga guardar sem perda.

require('dotenv').config();
const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const pool = require('../../db');

// ─── Serialização ────────────────────────────────────────────────────────────

function serializar(obj) {
  return JSON.stringify(obj, BufferJSON.replacer);
}

function deserializar(dado) {
  if (!dado) return null;
  // O PostgreSQL devolve JSONB já como objeto JS — precisamos re-stringify
  // antes de parsear com o reviver para que os Buffers sejam reconstruídos.
  const str = typeof dado === 'string' ? dado : JSON.stringify(dado);
  return JSON.parse(str, BufferJSON.reviver);
}

// ─── Auth State (interface exigida pelo Baileys) ──────────────────────────────

/**
 * Cria o auth state persistido no PostgreSQL para uma instância/chip.
 * Retorna o mesmo contrato que useMultiFileAuthState:
 *   { state: { creds, keys }, saveCreds }
 *
 * @param {string} instancia - nome do chip (ex: "instancia01")
 */
async function usePostgresAuthState(instancia) {
  // 1. Carrega sessão existente do banco
  const resultado = await pool.query(
    'SELECT creds, keys FROM chip_sessions WHERE instancia = $1',
    [instancia]
  );
  const row = resultado.rows[0];

  // 2. Credenciais: usa as salvas ou inicializa novas (novo chip)
  const creds = row?.creds
    ? deserializar(row.creds)
    : initAuthCreds();

  // 3. Keys: objeto aninhado { tipo: { id: valor } }
  //    Tipos usados pelo Baileys: pre-key, session, sender-key,
  //    app-state-sync-key, app-state-sync-version, sender-key-memory
  let keysStore = row?.keys ? deserializar(row.keys) : {};

  // Bug 8: fila simples de escrita — o Baileys chama keys.set() em paralelo
  // (uma vez por chave nova/processamento de mensagem). Sem isso, duas
  // gravações simultâneas podiam se sobrepor e perder dados uma da outra.
  let _filaEscrita = Promise.resolve();
  function _enfileirar(tarefa) {
    _filaEscrita = _filaEscrita.then(tarefa, tarefa);
    return _filaEscrita;
  }

  // 4. Persiste creds + keys juntos numa única query (evita race condition)
  async function salvarTudo() {
    return _enfileirar(() => pool.query(`
      INSERT INTO chip_sessions (instancia, creds, keys, atualizado_em)
      VALUES ($1, $2::jsonb, $3::jsonb, NOW())
      ON CONFLICT (instancia) DO UPDATE
        SET creds         = EXCLUDED.creds,
            keys          = EXCLUDED.keys,
            atualizado_em = NOW()
    `, [instancia, serializar(creds), serializar(keysStore)]));
  }

  return {
    state: {
      creds,
      keys: {
        /**
         * Baileys chama get() para buscar chaves antes de cifrar/decifrar.
         * @param {string} tipo - categoria da chave
         * @param {string[]} ids - IDs das chaves a buscar
         * @returns {{ [id]: valor }}
         */
        get: async (tipo, ids) => {
          const encontrados = {};
          for (const id of ids) {
            const val = keysStore[tipo]?.[id];
            if (val !== undefined) encontrados[id] = val;
          }
          return encontrados;
        },

        /**
         * Baileys chama set() para gravar chaves novas ou deletar expiradas.
         * Valor null = deletar a chave.
         * @param {{ [categoria]: { [id]: valor | null } }} data
         */
        set: async (data) => {
          for (const [categoria, entradas] of Object.entries(data)) {
            if (!keysStore[categoria]) keysStore[categoria] = {};
            for (const [id, valor] of Object.entries(entradas)) {
              if (valor === null) {
                delete keysStore[categoria][id];
              } else {
                keysStore[categoria][id] = valor;
              }
            }
          }
          await salvarTudo();
        }
      }
    },

    // saveCreds é chamado pelo Baileys sempre que as credenciais mudam
    // (ex: após scan do QR, após registro de pre-keys)
    saveCreds: salvarTudo
  };
}

// ─── QR Code ─────────────────────────────────────────────────────────────────

/**
 * Salva o QR code base64 no banco para o painel buscar via polling.
 * Chamado por session.js cada vez que o Baileys emite um QR novo.
 */
async function salvarQRCode(instancia, base64) {
  // Bug 5: ON CONFLICT só atualiza qrcode_base64 — nunca toca em creds/keys.
  // Antes, o INSERT inicial gravava creds=NULL quando a linha ainda não existia,
  // e na config seguinte usePostgresAuthState lia esse NULL e reiniciava o estado.
  await pool.query(`
    INSERT INTO chip_sessions (instancia, qrcode_base64, atualizado_em)
    VALUES ($1, $2, NOW())
    ON CONFLICT (instancia) DO UPDATE
      SET qrcode_base64 = EXCLUDED.qrcode_base64,
          atualizado_em = NOW()
  `, [instancia, base64]);
  // Nada além disso muda — creds e keys (se existentes) permanecem intactos
  // porque o UPDATE do ON CONFLICT só toca nas colunas listadas no SET.
}

/**
 * Limpa o QR code após scan bem-sucedido (para o painel parar de exibir).
 */
async function limparQRCode(instancia) {
  await pool.query(
    'UPDATE chip_sessions SET qrcode_base64 = NULL WHERE instancia = $1',
    [instancia]
  );
}

/**
 * Retorna o QR code atual (base64) de uma instância.
 * Usado pelo endpoint GET /chips/:instancia/qrcode via polling do painel.
 */
async function obterQRCode(instancia) {
  const r = await pool.query(
    'SELECT qrcode_base64 FROM chip_sessions WHERE instancia = $1',
    [instancia]
  );
  return r.rows[0]?.qrcode_base64 || null;
}

// ─── Utilitários de sessão ────────────────────────────────────────────────────

/**
 * Verifica se um chip já tem credenciais salvas (já foi autenticado).
 * Usado pelo manager para decidir se reconecta ou aguarda QR.
 */
async function sessaoExiste(instancia) {
  const r = await pool.query(
    'SELECT 1 FROM chip_sessions WHERE instancia = $1 AND creds IS NOT NULL',
    [instancia]
  );
  return r.rows.length > 0;
}

/**
 * Remove completamente a sessão de um chip.
 * Chamado por manager.js ao remover um chip — força novo QR na próxima vez.
 */
async function deletarSessao(instancia) {
  await pool.query(
    'DELETE FROM chip_sessions WHERE instancia = $1',
    [instancia]
  );
}

module.exports = {
  usePostgresAuthState,
  salvarQRCode,
  limparQRCode,
  obterQRCode,
  sessaoExiste,
  deletarSessao,
};
