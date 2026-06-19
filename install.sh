#!/bin/bash
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}▶ $1${NC}"; }

echo -e "${BOLD}"
echo "╔══════════════════════════════════════════════════╗"
echo "║        WhatsApp Disparador — Instalação          ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

if [ "$EUID" -ne 0 ]; then err "Execute como root: sudo ./install.sh"; fi
if ! command -v apt-get &>/dev/null; then err "Este script requer Debian/Ubuntu"; fi

INSTALL_DIR="/opt/whatsapp-disparador"
SERVICE_USER="disparador"

step "Atualizando sistema..."
apt-get update -qq
apt-get install -y -qq curl wget gnupg2 lsb-release ca-certificates software-properties-common apt-transport-https > /dev/null
ok "Sistema atualizado"

step "Instalando Node.js 20..."
if command -v node &>/dev/null && [[ $(node -v | cut -d. -f1 | tr -d 'v') -ge 18 ]]; then
  ok "Node.js já instalado: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
  ok "Node.js instalado: $(node -v)"
fi

step "Instalando Redis..."
if systemctl is-active --quiet redis-server 2>/dev/null || systemctl is-active --quiet redis 2>/dev/null; then
  ok "Redis já está rodando"
else
  apt-get install -y -qq redis-server > /dev/null
  systemctl enable redis-server > /dev/null 2>&1 || systemctl enable redis > /dev/null 2>&1
  systemctl start redis-server > /dev/null 2>&1 || systemctl start redis > /dev/null 2>&1
  sleep 1
  redis-cli ping > /dev/null 2>&1 && ok "Redis instalado e rodando" || err "Falha ao iniciar Redis"
fi

step "Verificando PostgreSQL..."
if command -v psql &>/dev/null; then
  ok "PostgreSQL já instalado: $(psql --version)"
else
  apt-get install -y -qq postgresql postgresql-contrib > /dev/null
  systemctl enable postgresql > /dev/null 2>&1
  systemctl start postgresql > /dev/null 2>&1
  ok "PostgreSQL instalado"
fi

step "Configurando banco de dados..."
DB_PASS=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 16)
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='disparador'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE disparador;" > /dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='disparador'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER disparador WITH PASSWORD '${DB_PASS}';" > /dev/null
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE disparador TO disparador;" > /dev/null
sudo -u postgres psql -c "ALTER DATABASE disparador OWNER TO disparador;" > /dev/null
ok "Banco 'disparador' configurado"

step "Instalando pm2..."
if command -v pm2 &>/dev/null; then ok "pm2 já instalado"; else npm install -g pm2 --silent; ok "pm2 instalado"; fi

step "Verificando Docker..."
if command -v docker &>/dev/null; then
  ok "Docker já instalado"
else
  warn "Docker não encontrado. Instalando..."
  curl -fsSL https://get.docker.com | sh > /dev/null 2>&1
  systemctl enable docker > /dev/null 2>&1
  systemctl start docker > /dev/null 2>&1
  ok "Docker instalado"
fi

step "Instalando aplicação em ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
cp -r . "$INSTALL_DIR/" 2>/dev/null || true
cd "$INSTALL_DIR"

if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
fi
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

step "Instalando dependências Node.js..."
npm install --silent
ok "Dependências instaladas"

step "Gerando configuração..."
EVO_KEY=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)

cat > "$INSTALL_DIR/.env" << ENVEOF
DB_HOST=localhost
DB_PORT=5432
DB_NAME=disparador
DB_USER=disparador
DB_PASSWORD=${DB_PASS}

REDIS_HOST=localhost
REDIS_PORT=6379

EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=${EVO_KEY}

DELAY_MIN_SEGUNDOS=20
DELAY_MAX_SEGUNDOS=50

PORT=3000
NODE_ENV=production
ENVEOF
ok ".env gerado"

step "Criando tabelas no banco..."
sudo -u "$SERVICE_USER" node src/db/migrate.js
ok "Tabelas criadas (já inclui anti-ban, mídia e todas as colunas)"

step "Subindo Evolution API..."
if docker ps -a --format '{{.Names}}' | grep -q "^evolution-api$"; then
  docker start evolution-api > /dev/null 2>&1 || true
  ok "Evolution API já existe — iniciada"
else
  docker run -d \
    --name evolution-api \
    --restart always \
    -p 8080:8080 \
    -e AUTHENTICATION_API_KEY="${EVO_KEY}" \
    -e DATABASE_ENABLED=false \
    -v evolution_instances:/evolution/instances \
    atendai/evolution-api:v1.8.2 > /dev/null 2>&1
  ok "Evolution API iniciada (aguarde 10s para ficar pronta)"
  sleep 10
fi

step "Configurando pm2..."
cat > "$INSTALL_DIR/ecosystem.config.js" << PMEOF
module.exports = {
  apps: [{
    name: 'disparador',
    script: 'src/server.js',
    cwd: '${INSTALL_DIR}',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production' },
    error_file: '/var/log/disparador/error.log',
    out_file: '/var/log/disparador/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};
PMEOF

mkdir -p /var/log/disparador
chown -R "$SERVICE_USER":"$SERVICE_USER" /var/log/disparador

pm2 delete disparador 2>/dev/null || true
pm2 start "$INSTALL_DIR/ecosystem.config.js" --env production > /dev/null 2>&1
pm2 save > /dev/null 2>&1
pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
ok "pm2 configurado com auto-restart"

step "Configurando backup automático..."
mkdir -p /var/backups/disparador
cat > /etc/cron.d/disparador-backup << CRONEOF
0 3 * * * root pg_dump -U disparador -h localhost disparador | gzip > /var/backups/disparador/backup-\$(date +\%Y\%m\%d).sql.gz 2>/dev/null
0 4 * * * root find /var/backups/disparador -name "*.sql.gz" -mtime +7 -delete
CRONEOF
chmod 644 /etc/cron.d/disparador-backup
ok "Backup diário configurado em /var/backups/disparador/"

CREDS_FILE="/root/disparador-credenciais.txt"
cat > "$CREDS_FILE" << CREDEOF
╔══════════════════════════════════════════════════════╗
║      WhatsApp Disparador — Credenciais               ║
╚══════════════════════════════════════════════════════╝

Painel:              http://localhost:3000
Evolution API:       http://localhost:8080

Banco de dados:
  Host:              localhost
  Banco:             disparador
  Usuário:           disparador
  Senha:             ${DB_PASS}

Evolution API Key:   ${EVO_KEY}
  (Use esta chave nas Configurações do painel)

Logs da aplicação:   /var/log/disparador/
Backups do banco:    /var/backups/disparador/
Arquivo .env:        ${INSTALL_DIR}/.env

Comandos úteis:
  pm2 status                    # Status da aplicação
  pm2 logs disparador           # Ver logs em tempo real
  pm2 restart disparador        # Reiniciar
  pm2 stop disparador           # Parar
CREDEOF
chmod 600 "$CREDS_FILE"

echo ""
echo -e "${BOLD}${GREEN}"
echo "╔══════════════════════════════════════════════════╗"
echo "║           ✅ Instalação concluída!               ║"
echo "╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "${BOLD}Painel:${NC}            http://$(hostname -I | awk '{print $1}'):3000"
echo -e "${BOLD}Evolution API:${NC}    http://$(hostname -I | awk '{print $1}'):8080"
echo -e "${BOLD}Credenciais:${NC}      ${CREDS_FILE}"
echo ""
echo -e "${YELLOW}Próximos passos:${NC}"
echo "  1. Acesse o painel"
echo "  2. Cole a Evolution API Key nas Configurações"
echo "  3. Adicione um chip e escaneie o QR Code"
echo ""
echo -e "${CYAN}Logs em tempo real:${NC} pm2 logs disparador"
echo ""
