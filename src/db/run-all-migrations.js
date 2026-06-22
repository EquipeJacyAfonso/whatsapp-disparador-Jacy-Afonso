const { execSync } = require('child_process');
const path = require('path');

// Lista com a ordem exata de execução. 
// O migrate.js principal deve ser sempre o primeiro.
const migracoes = [
  'migrate.js',
  'migrate-antiban.js',
  'migrate-auth.js',
  'migrate-chips.js',
  'migrate-delay.js',
  'migrate-midia.js',
  'migrate-imagem.js' // Incluí este também caso exista no seu projeto
];

console.log('🚀 Iniciando processo de migração do banco de dados...');

for (const arquivo of migracoes) {
  const caminho = path.join(__dirname, arquivo);
  try {
    console.log(`\n⏳ A executar: ${arquivo}...`);
    
    // stdio: 'inherit' garante que os logs de erro ou sucesso de cada 
    // script individual apareçam aqui no terminal central
    execSync(`node "${caminho}"`, { stdio: 'inherit' });
    
    console.log(`✅ ${arquivo} concluído.`);
  } catch (error) {
    console.error(`\n❌ Erro crítico ao executar a migração ${arquivo}.`);
    console.error('Abortando as migrações restantes para evitar inconsistências no banco de dados.');
    process.exit(1); // Interrompe o processo para não corromper o banco
  }
}

console.log('\n🎉 Todas as migrações foram executadas com sucesso!');