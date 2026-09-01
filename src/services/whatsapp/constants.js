// Tabela de aquecimento gradual de chips (limite de mensagens/dia por dia
// de vida do número). Extraído para módulo próprio porque tanto manager.js
// quanto session.js precisam dela — session.js precisa saber o limite do
// "dia 1" para reiniciar o aquecimento quando detecta troca de número
// (SIM diferente conectado no mesmo slot de chip), e colocar isso direto
// em manager.js criaria uma dependência circular (manager → session → manager).

const AQUECIMENTO = [20, 30, 40, 50, 60, 80, 100, 120, 150];

function limitePorDia(diasAtivo) {
  return AQUECIMENTO[Math.min(diasAtivo, AQUECIMENTO.length - 1)];
}

module.exports = { AQUECIMENTO, limitePorDia };
