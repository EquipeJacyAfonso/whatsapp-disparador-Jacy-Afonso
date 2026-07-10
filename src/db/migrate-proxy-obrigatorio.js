require('dotenv').config();
const pool = require('./index');

async function run() {
  const client = await pool.connect();
  try {
    const semProxy = await client.query("SELECT id, nome, instancia FROM chips WHERE proxy IS NULL OR proxy = ''");
    if (semProxy.rows.length) {
      await client.query("UPDATE chips SET status = 'sem_proxy' WHERE proxy IS NULL OR proxy = ''");
      console.log('⚠ ' + semProxy.rows.length + ' chip(s) sem proxy — status marcado como "sem_proxy". Configure antes de reconectar:');
      semProxy.rows.forEach(c => console.log('   - ' + c.nome + ' (' + c.instancia + ')'));
    } else {
      console.log('✅ Todos os chips já têm proxy configurado.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}
run();