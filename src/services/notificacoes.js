const pool = require('../db');
const config = require('./config');

async function enviarNotificacao(mensagem) {
  try {
    const numAdmin = await config.get('admin_numero', '');
    if (!numAdmin) return;
    const instancia = await config.get('admin_chip_instancia', '');
    if (!instancia) return;
    const { enviarMensagem } = require('./evolution');
    await enviarMensagem(numAdmin, `🤖 *Disparador*\n\n${mensagem}`, instancia);
    console.log(`[NOTIF] ✅ Notificação enviada para ${numAdmin}`);
  } catch(e) {
    console.warn(`[NOTIF] Falha ao enviar notificação: ${e.message}`);
  }
}

async function notificarCampanhaConcluida(campanhaId) {
  try {
    const camp = await pool.query('SELECT * FROM campanhas WHERE id=$1', [campanhaId]);
    if (!camp.rows.length) return;
    const c = camp.rows[0];
    const taxa = c.total_contatos > 0 ? Math.round(c.enviados / c.total_contatos * 100) : 0;
    const duracao = c.finalizado_em && c.iniciado_em
      ? Math.round((new Date(c.finalizado_em) - new Date(c.iniciado_em)) / 1000 / 60)
      : null;
    const msg = `✅ *Campanha concluída!*\n\n📋 *${c.nome}*\n📤 Enviados: ${c.enviados}/${c.total_contatos} (${taxa}%)\n❌ Falhas: ${c.falhas}\n` +
      (duracao ? `⏱ Duração: ${duracao} minutos` : '');
    await enviarNotificacao(msg);
  } catch(e) {}
}

async function notificarChipBanido(nomeChip, instancia) {
  const msg = `⚠️ *Chip banido detectado!*\n\n📱 Chip: *${nomeChip}*\n🔗 Instância: ${instancia}\n\nA fila foi pausada automaticamente.`;
  await enviarNotificacao(msg);
}

async function notificarChipDesconectado(nomeChip, instancia) {
  const msg = `🔴 *Chip desconectado!*\n\n📱 Chip: *${nomeChip}*\n🔗 Instância: ${instancia}\n\nReconecte e retome a campanha.`;
  await enviarNotificacao(msg);
}

async function notificarSyncSheets(resultado) {
  if (!resultado.importados && !resultado.atualizados) return;
  const msg = `🔄 *Sync automático concluído*\n\n✅ Novos: ${resultado.importados}\n🔁 Atualizados: ${resultado.atualizados}\n⚠️ Ignorados: ${resultado.ignorados}`;
  await enviarNotificacao(msg);
}

// Disparado pelo "circuit breaker" da fila quando uma campanha acumula falhas
// seguidas SEM nenhum envio bem-sucedido — sinal forte de bug sistêmico
// (formato de payload errado, API fora do ar, credencial inválida etc.),
// e não de números ruins isolados. A campanha já foi pausada automaticamente
// antes desta função ser chamada.
async function notificarFalhaSistemica(campanhaId, erro) {
  const msg = `🛑 *Campanha pausada automaticamente!*\n\n📋 Campanha #${campanhaId}\n⚠️ Várias falhas seguidas sem nenhum envio confirmado.\n\n🔍 Último erro:\n${erro}\n\nVerifique a Evolution API (Configurações → Testar conexão) antes de retomar.`;
  await enviarNotificacao(msg);
}

module.exports = {
  enviarNotificacao, notificarCampanhaConcluida, notificarChipBanido,
  notificarChipDesconectado, notificarSyncSheets, notificarFalhaSistemica,
};
