require('dotenv').config();
const pool = require('./index');
const bcrypt = require('bcryptjs');

async function run() {
  const email = process.argv[2] || 'admin@disparador.local';
  const senha  = process.argv[3] || 'admin123';
  const nome   = process.argv[4] || 'Administrador';
  const hash = await bcrypt.hash(senha, 12);
  await pool.query(`
    INSERT INTO usuarios (nome, email, senha_hash)
    VALUES ($1, $2, $3)
    ON CONFLICT (email) DO UPDATE SET senha_hash = EXCLUDED.senha_hash, ativo = true
  `, [nome, email, hash]);
  console.log('✅ Usuário criado/atualizado: ' + email);
  await pool.end();
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
