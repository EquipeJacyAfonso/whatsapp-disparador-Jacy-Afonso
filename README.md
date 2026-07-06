# WhatsApp Disparador — v8.0

Sistema de disparo em massa via WhatsApp usando **Baileys** diretamente.
Sem Evolution API. Sem container extra. Sessões no PostgreSQL.

---

## Instalação

### Opção 1 — Wizard interativo (local ou servidor remoto)

```bash
node scripts/setup.js
# Pergunta o modo (Docker ou pm2), configura .env e sobe tudo
```

### Opção 2 — Docker Compose (direto)

```bash
cp .env.example .env   # edite as senhas
docker compose up -d
```

### Opção 3 — Servidor Linux bare-metal (pm2)

```bash
chmod +x install.sh && sudo ./install.sh
```

---

## Local vs Servidor Remoto

A única diferença entre os dois cenários é **uma variável de ambiente**:

```env
# Local — deixe vazio (padrão)
PUBLIC_URL=

# Servidor remoto — informe o endereço público
PUBLIC_URL=https://meusite.com.br
# ou
PUBLIC_URL=http://IP_DO_SERVIDOR:3000
```

Tudo o mais (banco, fila, chips, envio) funciona **idêntico** nos dois ambientes.
O Baileys faz conexões WebSocket para os servidores do WhatsApp — isso funciona
de qualquer lugar com internet, sem configuração extra.

---

## Primeiro acesso

- Painel: `http://localhost:3000` (local) ou `http://SEU_IP:3000` (remoto)
- Login padrão: **admin@disparador.local** / **admin123**
- **Troque a senha no primeiro acesso** (Painel → ícone de cadeado)

---

## Adicionar chip

1. Painel → **Chips** → Adicionar → preencha nome e instância
2. Clique em **+ Criar** e depois em **📷 QR**
3. Escaneie com o WhatsApp do celular

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `DB_HOST` | `localhost` | Host do PostgreSQL |
| `DB_PORT` | `5432` | Porta do PostgreSQL |
| `DB_NAME` | `disparador` | Nome do banco |
| `DB_USER` | `disparador` | Usuário do banco |
| `DB_PASSWORD` | — | Senha do banco |
| `REDIS_HOST` | `localhost` | Host do Redis |
| `REDIS_PORT` | `6379` | Porta do Redis |
| `PORT` | `3000` | Porta do painel |
| `PUBLIC_URL` | *(vazio)* | URL pública (servidor remoto) |
| `COFFEE_BREAK_CHANCE` | `0.10` | Chance de micro-pausa (0 = desativado) |

---

## Comandos rápidos (Makefile)

```bash
make setup          # wizard de instalação
make start          # sobe os containers
make stop           # para tudo
make restart        # reinicia o app
make logs           # logs em tempo real
make migrate        # roda migrações (Docker)
make migrate-local  # roda migrações (manual)
make admin EMAIL=x@x.com SENHA=abc123
```

---

## Estrutura

```
src/
├── server.js
├── db/              migrate.js + auxiliares
├── services/
│   ├── whatsapp/    manager · session · store · events  ← Baileys
│   ├── antiban.js   janela horária · ban · spintax
│   ├── auth.js      JWT
│   ├── config.js    configurações no banco
│   ├── csv.js       importação CSV
│   ├── health.js    health check
│   ├── notificacoes.js
│   └── sheets.js    Google Sheets
├── queue/disparo.js fila Bull + circuit breaker
└── routes/index.js  API REST
public/index.html    painel
scripts/setup.js     wizard de instalação
```
