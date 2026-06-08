// Notificações via WhatsApp para o número administrativo
// Envia alertas quando campanhas concluem, chips são banidos, etc.

const pool = require('../db');
const config = require('./config');

async function enviarNotificacao(mensagem) {
  try {
    const numAdmin = await config.get('admin_numero', '');
    if (!numAdmin) return; // não configurado — silencioso

    const instancia = await config.get('admin_chip_instancia', '');
    if (!instancia) return;

    // Importa enviarMensagem aqui para evitar circular dependency
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
    const msg = `✅ *Campanha concluída!*\n\n` +
      `📋 *${c.nome}*\n` +
      `📤 Enviados: ${c.enviados}/${c.total_contatos} (${taxa}%)\n` +
      `❌ Falhas: ${c.falhas}\n` +
      (duracao ? `⏱ Duração: ${duracao} minutos` : '');
    await enviarNotificacao(msg);
  } catch(e) {}
}

async function notificarChipBanido(nomeChip, instancia) {
  const msg = `⚠️ *Chip banido detectado!*\n\n` +
    `📱 Chip: *${nomeChip}*\n` +
    `🔗 Instância: ${instancia}\n\n` +
    `A fila foi pausada automaticamente. Verifique o número no celular.`;
  await enviarNotificacao(msg);
}

async function notificarChipDesconectado(nomeChip, instancia) {
  const msg = `🔴 *Chip desconectado!*\n\n` +
    `📱 Chip: *${nomeChip}*\n` +
    `🔗 Instância: ${instancia}\n\n` +
    `Reconecte o chip e retome a campanha no painel.`;
  await enviarNotificacao(msg);
}

async function notificarSyncSheets(resultado) {
  if (!resultado.importados && !resultado.atualizados) return; // nada mudou
  const msg = `🔄 *Sync automático concluído*\n\n` +
    `✅ Novos: ${resultado.importados}\n` +
    `🔁 Atualizados: ${resultado.atualizados}\n` +
    `⚠️ Ignorados: ${resultado.ignorados}`;
  await enviarNotificacao(msg);
}

module.exports = {
  enviarNotificacao,
  notificarCampanhaConcluida,
  notificarChipBanido,
  notificarChipDesconectado,
  notificarSyncSheets,
};
