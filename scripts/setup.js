#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp Disparador v8 — Assistente de instalação
// Uso: node scripts/setup.js
// Sem dependências externas — usa apenas módulos nativos do Node.js
// ─────────────────────────────────────────────────────────────────────────────

const readline = require('readline');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ─── Utilitários ─────────────────────────────────────────────────────────────

const COR = {
  verde:    s => '\x1b[32m' + s + '\x1b[0m',
  amarelo:  s => '\x1b[33m' + s + '\x1b[0m',
  vermelho: s => '\x1b[31m' + s + '\x1b[0m',
  ciano:    s => '\x1b[36m' + s + '\x1b[0m',
  negrito:  s => '\x1b[1m'  + s + '\x1b[0m',
};

function ok(msg)   { console.log(COR.verde('  ✅ ' + msg)); }
function warn(msg) { console.log(COR.amarelo('  ⚠  ' + msg)); }
function err(msg)  { console.log(COR.vermelho('  ❌ ' + msg)); }
function info(msg) { console.log(COR.ciano('  ℹ  ' + msg)); }
function titulo(msg) {
  console.log('');
  console.log(COR.negrito(COR.ciano('▶ ' + msg)));
}

function gerarSenha(tamanho = 20) {
  return crypto.randomBytes(tamanho)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, tamanho);
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, stdio: opts.silencioso ? 'pipe' : 'inherit', ...opts });
}

function temComando(cmd) {
  try { execSync('which ' + cmd, { stdio: 'pipe' }); return true; }
  catch (_) { return false; }
}

// ─── Prompt interativo ───────────────────────────────────────────────────────

function criarPrompt() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function perguntar(rl, pergunta, padrao = '') {
  return new Promise(resolve => {
    const label = padrao
      ? COR.ciano('  ' + pergunta) + COR.amarelo(' [' + padrao + ']') + ': '
      : COR.ciano('  ' + pergunta) + ': ';
    rl.question(label, resposta => {
      resolve(resposta.trim() || padrao);
    });
  });
}

async function escolher(rl, pergunta, opcoes) {
  while (true) {
    console.log('');
    console.log(COR.ciano('  ' + pergunta));
    opcoes.forEach((op, i) => console.log('    ' + COR.amarelo(String(i + 1) + '.') + ' ' + op));
    const resp = await perguntar(rl, 'Escolha (1-' + opcoes.length + ')', '1');
    const idx = parseInt(resp) - 1;
    if (idx >= 0 && idx < opcoes.length) return idx;
    warn('Opção inválida, tente novamente.');
  }
}

// ─── Verificações de ambiente ─────────────────────────────────────────────────

function verificarNodeVersion() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    err('Node.js 18+ necessário. Versão atual: ' + process.version);
    process.exit(1);
  }
  ok('Node.js ' + process.version);
}

function verificarAmbiente(modo) {
  titulo('Verificando ambiente');
  verificarNodeVersion();

  if (modo === 'docker') {
    if (!temComando('docker')) {
      err('Docker não encontrado. Instale em https://docs.docker.com/get-docker/');
      process.exit(1);
    }
    ok('Docker disponível');
    try {
      exec('docker compose version', { silencioso: true });
      ok('Docker Compose disponível');
    } catch (_) {
      err('Docker Compose não encontrado. Atualize o Docker.');
      process.exit(1);
    }
  }

  if (modo === 'manual') {
    if (!temComando('psql')) {
      warn('psql não encontrado — PostgreSQL pode estar em container ou remoto (ok)');
    } else {
      ok('PostgreSQL disponível');
    }
    if (!temComando('redis-cli')) {
      warn('redis-cli não encontrado — Redis pode estar em container ou remoto (ok)');
    } else {
      ok('Redis disponível');
    }
    if (!temComando('pm2')) {
      warn('pm2 não encontrado — instalaremos agora');
    } else {
      ok('pm2 disponível');
    }
  }
}

// ─── Escrita do .env ──────────────────────────────────────────────────────────

function escreverEnv(config) {
  const conteudo = [
    '# Gerado pelo setup.js em ' + new Date().toISOString(),
    '',
    '# PostgreSQL',
    'DB_HOST=' + config.dbHost,
    'DB_PORT=' + config.dbPort,
    'DB_NAME=' + config.dbName,
    'DB_USER=' + config.dbUser,
    'DB_PASSWORD=' + config.dbPassword,
    '',
    '# Redis',
    'REDIS_HOST=' + config.redisHost,
    'REDIS_PORT=' + config.redisPort,
    '',
    '# Disparador',
    'DELAY_MIN_SEGUNDOS=20',
    'DELAY_MAX_SEGUNDOS=50',
    '',
    '# Servidor',
    'PORT=' + config.porta,
    'NODE_ENV=production',
  ].join('\n');

  fs.writeFileSync(path.join(ROOT, '.env'), conteudo + '\n');
  ok('.env criado');
}

// ─── Instalação Docker ────────────────────────────────────────────────────────

async function instalarDocker(config) {
  titulo('Configurando docker-compose.yml');

  // Lê o docker-compose e substitui as senhas padrão pelas geradas
  const dcPath = path.join(ROOT, 'docker-compose.yml');
  let dc = fs.readFileSync(dcPath, 'utf8');

  dc = dc
    .replace(/\$\{DB_PASSWORD:-[^}]+\}/g, config.dbPassword)
    .replace(/disparador123/g, config.dbPassword);

  fs.writeFileSync(dcPath, dc);
  ok('docker-compose.yml atualizado com suas senhas');

  titulo('Subindo containers');
  info('Isso pode levar 1-2 minutos na primeira vez...');
  exec('docker compose up -d --build');

  titulo('Aguardando aplicação ficar pronta');
  let tentativas = 0;
  while (tentativas < 30) {
    try {
      exec('docker compose exec -T app node -e "const h=require(\'http\');h.get(\'http://localhost:' + config.porta + '/api/health\',r=>{process.exit(r.statusCode===200?0:1)}).on(\'error\',()=>process.exit(1))"', { silencioso: true });
      ok('Aplicação respondendo!');
      break;
    } catch (_) {
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 3000));
      tentativas++;
    }
  }
  if (tentativas >= 30) {
    warn('Aplicação demorou mais que o esperado. Veja os logs: docker compose logs app');
  }
}

// ─── Instalação Manual ────────────────────────────────────────────────────────

async function instalarManual(config) {
  titulo('Instalando dependências npm');
  exec('npm install --production');
  ok('Dependências instaladas');

  titulo('Criando tabelas no banco');
  exec('node src/db/migrate.js');
  ok('Banco configurado');

  titulo('Criando usuário admin');
  exec('node src/db/criar-admin.js "' + config.adminEmail + '" "' + config.adminSenha + '" "Administrador"');
  ok('Admin criado: ' + config.adminEmail);

  if (!temComando('pm2')) {
    titulo('Instalando pm2');
    exec('npm install -g pm2');
    ok('pm2 instalado');
  }

  titulo('Iniciando com pm2');
  exec('pm2 delete disparador 2>/dev/null || true', { silencioso: true });
  exec('pm2 start ecosystem.config.js --env production');
  exec('pm2 save');
  ok('Disparador iniciado com pm2');
}

// ─── Criação do admin (Docker) ────────────────────────────────────────────────

async function criarAdminDocker(config) {
  titulo('Criando usuário admin');
  try {
    exec(
      'docker compose exec -T app node src/db/criar-admin.js "' +
      config.adminEmail + '" "' + config.adminSenha + '" "Administrador"'
    );
    ok('Admin criado: ' + config.adminEmail);
  } catch (e) {
    warn('Não foi possível criar admin automaticamente. Use: npm run criar-admin');
  }
}

// ─── Resumo final ────────────────────────────────────────────────────────────

function mostrarResumo(config, modo) {
  console.log('');
  console.log(COR.verde(COR.negrito('╔══════════════════════════════════════════╗')));
  console.log(COR.verde(COR.negrito('║   ✅  Instalação concluída com sucesso!  ║')));
  console.log(COR.verde(COR.negrito('╚══════════════════════════════════════════╝')));
  console.log('');
  console.log(COR.negrito('  Acesse o painel:'));
  console.log('  ' + COR.ciano('http://localhost:' + config.porta));
  console.log('');
  console.log(COR.negrito('  Login:'));
  console.log('  Email: ' + COR.amarelo(config.adminEmail));
  console.log('  Senha: ' + COR.amarelo(config.adminSenha));
  console.log('');

  if (modo === 'docker') {
    console.log(COR.negrito('  Comandos úteis:'));
    console.log('  ' + COR.ciano('docker compose logs -f app') + '   → logs em tempo real');
    console.log('  ' + COR.ciano('docker compose restart app') + '   → reiniciar');
    console.log('  ' + COR.ciano('docker compose down')        + '         → parar tudo');
  } else {
    console.log(COR.negrito('  Comandos úteis:'));
    console.log('  ' + COR.ciano('pm2 logs disparador')    + '   → logs em tempo real');
    console.log('  ' + COR.ciano('pm2 restart disparador') + '   → reiniciar');
    console.log('  ' + COR.ciano('pm2 stop disparador')    + '   → parar');
  }

  console.log('');
  console.log(COR.amarelo('  ⚠  Troque a senha admin no primeiro acesso!'));
  console.log('');

  // Salva credenciais em arquivo local
  const credenciais = [
    'WhatsApp Disparador — Credenciais',
    'Gerado em: ' + new Date().toLocaleString('pt-BR'),
    '',
    'Painel:  http://localhost:' + config.porta,
    'Email:   ' + config.adminEmail,
    'Senha:   ' + config.adminSenha,
    'DB Pass: ' + config.dbPassword,
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, '.credenciais.txt'), credenciais + '\n');
  info('Credenciais salvas em .credenciais.txt (não commite este arquivo!)');
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.clear();
  console.log(COR.verde(COR.negrito('\n  WhatsApp Disparador v8 — Assistente de instalação\n')));

  const rl = criarPrompt();

  try {
    // 1. Modo de instalação
    const modoIdx = await escolher(rl, 'Como deseja instalar?', [
      'Docker Compose (recomendado — instala tudo automaticamente)',
      'Manual com pm2 (para servidores sem Docker)',
    ]);
    const modo = modoIdx === 0 ? 'docker' : 'manual';

    verificarAmbiente(modo);

    // 2. Configurações básicas
    titulo('Configurações');

    const porta = await perguntar(rl, 'Porta do painel', '3000');

    // 3. Banco de dados
    let dbHost, dbPort, dbName, dbUser, dbPassword;

    if (modo === 'docker') {
      // No Docker, banco fica no container — senhas geradas automaticamente
      dbHost     = 'postgres';
      dbPort     = '5432';
      dbName     = 'disparador';
      dbUser     = 'disparador';
      dbPassword = gerarSenha(24);
      info('Senha do banco gerada automaticamente: ' + COR.amarelo(dbPassword));
    } else {
      info('Configure a conexão com o PostgreSQL existente:');
      dbHost     = await perguntar(rl, 'Host do PostgreSQL',  'localhost');
      dbPort     = await perguntar(rl, 'Porta do PostgreSQL', '5432');
      dbName     = await perguntar(rl, 'Nome do banco',       'disparador');
      dbUser     = await perguntar(rl, 'Usuário do banco',    'disparador');
      dbPassword = await perguntar(rl, 'Senha do banco',      gerarSenha(16));
    }

    // 4. Redis
    let redisHost, redisPort;
    if (modo === 'docker') {
      redisHost = 'redis';
      redisPort = '6379';
    } else {
      redisHost = await perguntar(rl, 'Host do Redis',  'localhost');
      redisPort = await perguntar(rl, 'Porta do Redis', '6379');
    }

    // 5. Admin
    titulo('Usuário administrador');
    const adminEmail = await perguntar(rl, 'Email do admin', 'admin@disparador.local');
    const adminSenha = await perguntar(rl, 'Senha do admin (mín. 6 caracteres)', gerarSenha(12));

    if (adminSenha.length < 6) {
      err('Senha muito curta. Use pelo menos 6 caracteres.');
      rl.close();
      process.exit(1);
    }

    // 6. Confirmação
    console.log('');
    console.log(COR.negrito('  Resumo da instalação:'));
    console.log('  Modo:    ' + COR.amarelo(modo === 'docker' ? 'Docker Compose' : 'Manual pm2'));
    console.log('  Painel:  ' + COR.amarelo('http://localhost:' + porta));
    console.log('  Admin:   ' + COR.amarelo(adminEmail));
    console.log('');

    const confirmar = await perguntar(rl, 'Confirmar e instalar? (s/n)', 's');
    if (!confirmar.toLowerCase().startsWith('s')) {
      warn('Instalação cancelada.');
      rl.close();
      process.exit(0);
    }

    rl.close();

    const config = { porta, dbHost, dbPort, dbName, dbUser, dbPassword, redisHost, redisPort, adminEmail, adminSenha };

    // 7. Instala
    titulo('Escrevendo configuração');
    escreverEnv(config);

    if (modo === 'docker') {
      await instalarDocker(config);
      await criarAdminDocker(config);
    } else {
      await instalarManual(config);
    }

    mostrarResumo(config, modo);

  } catch (e) {
    rl.close();
    console.log('');
    err('Erro durante a instalação: ' + e.message);
    console.log('');
    console.log('  Para ajuda: verifique os logs e tente novamente.');
    process.exit(1);
  }
}

main();
