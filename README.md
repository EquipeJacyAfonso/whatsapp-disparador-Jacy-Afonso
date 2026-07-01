# WhatsApp Disparador — v8.0

Sistema de disparo em massa via WhatsApp usando **Baileys** diretamente (sem Evolution API).

## Arquitetura

```
Disparador → Baileys → WhatsApp Web
```

Sem container extra. Sessões persistidas no PostgreSQL.

## Instalação rápida (Docker)

```bash
cp .env.example .env
# edite .env com suas senhas
docker compose up -d
```

## Instalação manual (pm2)

```bash
npm install
node src/db/migrate.js
npm start
```

## Primeiro acesso

- Painel: http://localhost:3000
- Login: admin@disparador.local / admin123
- **Troque a senha no primeiro acesso**

## Adicionar chip

1. Painel → Chips → Adicionar
2. Clique em "+ Criar" e depois "📷 QR"
3. Escaneie com o WhatsApp

## Estrutura

```
src/
├── server.js
├── db/           migrate.js + helpers
├── services/
│   ├── whatsapp/ manager · session · store · events  ← Baileys
│   ├── antiban.js
│   ├── auth.js
│   ├── config.js
│   ├── csv.js
│   ├── health.js
│   ├── notificacoes.js
│   └── sheets.js
├── queue/disparo.js
└── routes/index.js
public/index.html
```
