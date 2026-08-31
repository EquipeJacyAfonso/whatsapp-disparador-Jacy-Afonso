// Migração: criptografa access_token de contas_oficiais que ainda estejam
// em texto plano (bancos criados antes da introdução do crypto.js).
// Idempotente — pode rodar mais de uma vez sem efeito colateral.
//
// Uso:
//   node src/db/migrate-cripto-token.js
//
// Requer ENCRYPTION_KEY já configurada no .env.

require('dotenv').config();
const pool = require('./index');
const { encrypt, jaCriptografado } = require('../utils/crypto');

async function run() {
  const client = await pool.connect();
  try {
    const contas = await client.query('SELECT id, nome, access_token FROM contas_oficiais');

    if (!contas.rows.length) {
      console.log('✅ Nenhuma conta oficial cadastrada — nada para migrar.');
      return;
    }

    let migradas = 0, jaOk = 0;
    for (const conta of contas.rows) {
      if (!conta.access_token) continue;

      if (jaCriptografado(conta.access_token)) {
        jaOk++;
        continue;
      }

      const criptografado = encrypt(conta.access_token);
      await client.query(
        'UPDATE contas_oficiais SET access_token = $1 WHERE id = $2',
        [criptografado, conta.id]
      );
      migradas++;
      console.log('  → Token da conta "' + conta.nome + '" criptografado.');
    }

    console.log('✅ Migração concluída: ' + migradas + ' token(s) criptografado(s), ' + jaOk + ' já estava(m) OK.');
  } catch (err) {
    console.error('❌ Erro na migração:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
