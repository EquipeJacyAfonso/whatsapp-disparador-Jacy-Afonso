#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# WhatsApp Disparador v8 — Instalador automático para Ubuntu/Debian
# Uso: chmod +x install.sh && sudo ./install.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

ok()   { echo -e "${GREEN}  ✅ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠  $1${NC}"; }
err()  { echo -e "${RED}  ❌ $1${NC}"; exit 1; }
info() { echo -e "${CYAN}  ℹ  $1${NC}"; }
step() { echo -e "\n${BOLD}${BLUE}▶ $1${NC}"; }

echo -e "${BOLD}"
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║      WhatsApp Disparador v8 — Instalação         ║"
echo "  ║         Baileys direto · Sem Evolution API        ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo -e "${NC}"

# ─── Verifica root ────────────────────────────────────────────────────────────
[ "$EUID" -ne 0 ] && err "Execute como root: sudo ./install.sh"

# ─── Detecta SO ───────────────────────────────────────────────────────────────
command -v apt-get &>/dev/null || err "Requer Debian/Ubuntu"

INSTALL_DIR="/opt/whatsapp-disparador"
SERVICE_USER="disparador"

# ─── PASSO 1: Sistema ─────────────────────────────────────────────────────────
step "Atualizando sistema..."
apt-get update -qq
apt-get install -y -qq curl wget gnupg2 lsb-release ca-certificates \
  software-properties-common apt-transport-https > /dev/null
ok "Sistema atualizado"

# ─── PASSO 2: Node.js 20 ─────────────────────────────────────────────────────
step "Node.js 20..."
if command -v node &>/dev/null && [[ $(node -v | cut -d. -f1 | tr -d 'v') -ge 18 ]]; then
  ok "Node.js já instalado: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
  ok "Node.js instalado: $(node -v)"
fi

# ─── PASSO 3: Redis ───────────────────────────────────────────────────────────
step "Redis..."
if systemctl is-active --quiet redis-server 2>/dev/null || systemctl is-active --quiet redis 2>/dev/null; then
  ok "Redis já rodando"
else
  apt-get install -y -qq redis-server > /dev/null
  systemctl enable redis-server > /dev/null 2>&1 || true
  systemctl start redis-server  > /dev/null 2>&1 || true
  sleep 1
  redis-cli ping > /dev/null 2>&1 && ok "Redis instalado" || err "Falha ao iniciar Redis"
fi

# ─── PASSO 4: PostgreSQL ──────────────────────────────────────────────────────
step "PostgreSQL..."
if command -v psql &>/dev/null; then
  ok "PostgreSQL já instalado: $(psql --version | head -1)"
else
  apt-get install -y -qq postgresql postgresql-contrib > /dev/null
  systemctl enable postgresql > /dev/null 2>&1
  systemctl start  postgresql > /dev/null 2>&1
  ok "PostgreSQL instalado"
fi

# ─── PASSO 5: Banco de dados ──────────────────────────────────────────────────
step "Configurando banco..."
DB_PASS=$(openssl rand -base64 20 | tr -dc 'a-zA-Z0-9' | head -c 20)

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='disparador'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE disparador;" > /dev/null
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='disparador'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER disparador WITH PASSWORD '${DB_PASS}';" > /dev/null
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE disparador TO disparador;" > /dev/null
sudo -u postgres psql -c "ALTER DATABASE disparador OWNER TO disparador;" > /dev/null
ok "Banco 'disparador' configurado"

# ─── PASSO 6: pm2 ────────────────────────────────────────────────────────────
step "pm2..."
command -v pm2 &>/dev/null && ok "pm2 já instalado" || { npm install -g pm2 --silent; ok "pm2 instalado"; }

# ─── PASSO 7: Copia aplicação ─────────────────────────────────────────────────
step "Instalando em ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
cp -r . "$INSTALL_DIR/" 2>/dev/null || true
cd "$INSTALL_DIR"

# Cria usuário do sistema
id "$SERVICE_USER" &>/dev/null || useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"

# ─── PASSO 8: Dependências npm ────────────────────────────────────────────────
step "Dependências npm..."
npm install --production --silent
ok "Dependências instaladas (@whiskeysockets/baileys, qrcode, pino...)"

# ─── PASSO 9: .env ───────────────────────────────────────────────────────────
step "Configuração (.env)..."
cat > "$INSTALL_DIR/.env" << ENVEOF
DB_HOST=localhost
DB_PORT=5432
DB_NAME=disparador
DB_USER=disparador
DB_PASSWORD=${DB_PASS}

REDIS_HOST=localhost
REDIS_PORT=6379

DELAY_MIN_SEGUNDOS=20
DELAY_MAX_SEGUNDOS=50

PORT=3000
NODE_ENV=production
ENVEOF
ok ".env gerado"

# ─── PASSO 10: Migrações ─────────────────────────────────────────────────────
step "Criando tabelas..."
sudo -u "$SERVICE_USER" node src/db/migrate.js
ok "Tabelas criadas"

# ─── PASSO 11: Usuário admin ─────────────────────────────────────────────────
step "Criando admin..."
ADMIN_SENHA=$(openssl rand -base64 12 | tr -dc 'a-zA-Z0-9' | head -c 12)
sudo -u "$SERVICE_USER" node src/db/criar-admin.js "admin@disparador.local" "$ADMIN_SENHA" "Administrador"
ok "Admin criado"

# ─── PASSO 12: pm2 ────────────────────────────────────────────────────────────
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
    max_memory_restart: '600M',
    env: { NODE_ENV: 'production' },
    error_file: '/var/log/disparador/error.log',
    out_file:   '/var/log/disparador/out.log',
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
ok "pm2 configurado"

# ─── PASSO 13: Backup automático ─────────────────────────────────────────────
step "Backup automático..."
mkdir -p /var/backups/disparador
cat > /etc/cron.d/disparador-backup << CRONEOF
0 3 * * * root pg_dump -U disparador -h localhost disparador | gzip > /var/backups/disparador/backup-\$(date +\%Y\%m\%d).sql.gz 2>/dev/null
0 4 * * * root find /var/backups/disparador -name "*.sql.gz" -mtime +7 -delete
CRONEOF
chmod 644 /etc/cron.d/disparador-backup
ok "Backup diário às 3h em /var/backups/disparador/"

# ─── Salva credenciais ────────────────────────────────────────────────────────
CREDS_FILE="/root/disparador-credenciais.txt"
cat > "$CREDS_FILE" << CREDEOF
WhatsApp Disparador v8 — Credenciais
Gerado em: $(date)

Painel:          http://$(hostname -I | awk '{print $1}'):3000

Banco de dados:
  Host:          localhost
  Banco:         disparador
  Usuário:       disparador
  Senha:         ${DB_PASS}

Admin do painel:
  Email:         admin@disparador.local
  Senha:         ${ADMIN_SENHA}

Logs:            /var/log/disparador/
Backups:         /var/backups/disparador/
Instalação:      ${INSTALL_DIR}

Comandos úteis:
  pm2 status               → status da aplicação
  pm2 logs disparador      → logs em tempo real
  pm2 restart disparador   → reiniciar
CREDEOF
chmod 600 "$CREDS_FILE"

# ─── Resumo ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}"
echo "  ╔══════════════════════════════════════════════════╗"
echo "  ║          ✅  Instalação concluída!               ║"
echo "  ╚══════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  ${BOLD}Painel:${NC}  http://$(hostname -I | awk '{print $1}'):3000"
echo -e "  ${BOLD}Login:${NC}   admin@disparador.local"
echo -e "  ${BOLD}Senha:${NC}   ${YELLOW}${ADMIN_SENHA}${NC}"
echo ""
echo -e "  ${CYAN}Credenciais completas:${NC} ${CREDS_FILE}"
echo ""
echo -e "  ${YELLOW}Próximos passos:${NC}"
echo "    1. Acesse o painel e troque a senha admin"
echo "    2. Vá em Chips → Adicionar → criar instância → escanear QR"
echo "    3. Importe contatos e crie uma campanha"
echo ""
echo -e "  ${CYAN}Logs em tempo real:${NC} pm2 logs disparador"
echo ""
