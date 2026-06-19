# WhatsApp Disparador — v6.0

Sistema completo de disparo em massa via WhatsApp (Evolution API), com proteção anti-ban, múltiplos chips, importação CSV/Sheets e agora **envio de imagens (PNG/JPEG)**.

## Novidades desta versão

- 🖼 **Envio de imagem**: anexe uma PNG ou JPEG à campanha — o texto vira legenda
- 🐛 **3 bugs corrigidos** que faziam o dashboard marcar "enviado" sem a mensagem chegar:
  1. Número formatado incorretamente (com `@s.whatsapp.net`) ao chamar `sendText`
  2. Spintax processado duas vezes, corrompendo templates
  3. Simulação de "digitando..." bloqueando até 6s por mensagem

## Instalação

### Opção 1 — Script automático (Linux)
```bash
chmod +x install.sh && sudo ./install.sh
```

### Opção 2 — Docker Compose
```bash
cp .env.example .env   # edite as variáveis
docker compose up -d
```

### Opção 3 — Manual
```bash
npm install
node src/db/migrate.js      # cria todas as tabelas (já inclui anti-ban e mídia)
npm start
```

### Atualizando de uma versão anterior
Se seu banco já existia antes desta versão, rode a migração de mídia:
```bash
node src/db/migrate-midia.js
```

## Acesso

```
http://localhost:3000
```

## Estrutura

```
whatsapp-disparador/
├── src/
│   ├── server.js
│   ├── db/            # conexão + migrações
│   ├── services/       # evolution, antiban, sheets, csv, health, notificações
│   ├── queue/           # fila Bull
│   └── routes/          # API REST
├── public/
│   └── index.html       # painel
├── install.sh
├── docker-compose.yml
└── Dockerfile
```

## Enviando imagem em campanha

1. Vá em **Campanhas → Nova campanha**
2. Preencha nome e template (texto vira legenda)
3. Em **Imagem**, selecione um PNG ou JPEG (máx. 5MB)
4. Crie a campanha normalmente — todos os contatos recebem a imagem com a legenda personalizada

Para editar a imagem de uma campanha existente, use o botão **🖼 Imagem** na lista de campanhas.
