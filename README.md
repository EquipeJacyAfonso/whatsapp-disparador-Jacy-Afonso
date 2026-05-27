# WhatsApp Disparador — Guia de Instalação Completo

## Pré-requisitos

- Node.js 18+
- PostgreSQL (já instalado)
- Redis
- Docker (recomendado para Evolution API)

---

## 1. Instalar Redis (se não tiver)

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install redis-server -y
sudo systemctl enable redis && sudo systemctl start redis

# Verificar
redis-cli ping  # deve retornar PONG
```

---

## 2. Subir a Evolution API com Docker

```bash
docker run -d \
  --name evolution-api \
  -p 8080:8080 \
  -e AUTHENTICATION_API_KEY=minha_chave_secreta \
  -e DATABASE_ENABLED=false \
  -v evolution_instances:/evolution/instances \
  --restart always \
  atendai/evolution-api:latest
```

> Acesse http://localhost:8080 para confirmar que está rodando.

---

## 3. Configurar Google Sheets

### 3.1 Criar Service Account

1. Acesse https://console.cloud.google.com
2. Crie um projeto (ou use um existente)
3. Ative a API "Google Sheets API"
4. Vá em **Credenciais → Criar credencial → Conta de serviço**
5. Baixe o JSON da conta de serviço
6. Salve em `credentials/google-service-account.json`

### 3.2 Compartilhar a planilha

- Abra sua planilha no Google Sheets
- Clique em **Compartilhar**
- Cole o e-mail da service account (termina em `@...iam.gserviceaccount.com`)
- Dê permissão de **Visualizador**

### 3.3 Formato da planilha

A primeira linha deve ser o cabeçalho. A coluna `numero` é obrigatória:

| numero      | nome   | cidade     | produto   |
|-------------|--------|------------|-----------|
| 11999998888 | Maria  | São Paulo  | Plano A   |
| 21988887777 | João   | Rio        | Plano B   |

---

## 4. Instalar e configurar o sistema

```bash
# Clonar / entrar na pasta
cd whatsapp-disparador

# Instalar dependências
npm install

# Copiar e editar as variáveis de ambiente
cp .env.example .env
nano .env
```

### Preencha o .env:

```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=disparador
DB_USER=postgres
DB_PASSWORD=sua_senha_postgres

REDIS_HOST=localhost
REDIS_PORT=6379

EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=minha_chave_secreta      # igual ao AUTHENTICATION_API_KEY do Docker
EVOLUTION_INSTANCE=instancia01

GOOGLE_SHEETS_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
GOOGLE_SERVICE_ACCOUNT_JSON=./credentials/google-service-account.json

MENSAGENS_POR_HORA=60
DELAY_MIN_SEGUNDOS=20
DELAY_MAX_SEGUNDOS=50

PORT=3000
```

---

## 5. Criar o banco de dados

```bash
# No PostgreSQL, crie o banco
psql -U postgres -c "CREATE DATABASE disparador;"

# Rode a migração
npm run setup
```

---

## 6. Iniciar o servidor

```bash
npm start
# ou em modo dev (reinicia automaticamente)
npm run dev
```

Acesse: **http://localhost:3000**

---

## 7. Conectar o WhatsApp

1. Acesse o painel → aba **Configuração**
2. Clique em **Criar instância**
3. Clique em **Obter QR Code**
4. Escaneie com o WhatsApp do celular (igual ao WhatsApp Web)
5. O status no topo deve mudar para **Conectado**

---

## 8. Fluxo de uso

```
1. Importar → Cole o ID da planilha → Importar agora
2. Campanhas → Nova campanha → Nome + Template → Criar
3. Campanhas → Clique em ▶ Iniciar
4. Dashboard → Acompanhe o progresso em tempo real
```

### Exemplo de template com variáveis:
```
Olá {nome}! 👋

Temos uma novidade especial para você em {cidade}.
Seu plano {produto} está com condições exclusivas este mês.

Responda SIM para saber mais!
```

---

## Limites recomendados por número

| Semana | Máx/dia |
|--------|---------|
| 1ª     | 30      |
| 2ª     | 80      |
| 3ª+    | 150     |

Ajuste `DELAY_MIN_SEGUNDOS` e `DELAY_MAX_SEGUNDOS` no `.env` para controlar o ritmo.

---

## Estrutura de arquivos

```
whatsapp-disparador/
├── src/
│   ├── server.js           # Servidor Express
│   ├── db/
│   │   ├── index.js        # Conexão PostgreSQL
│   │   └── migrate.js      # Criação das tabelas
│   ├── services/
│   │   ├── evolution.js    # Integração Evolution API
│   │   └── sheets.js       # Importação Google Sheets
│   ├── queue/
│   │   └── disparo.js      # Fila Bull + Redis
│   └── routes/
│       └── index.js        # Rotas da API REST
├── public/
│   └── index.html          # Painel de controle
├── credentials/
│   └── google-service-account.json
├── .env
└── package.json
```

---

## Problemas comuns

**Redis não conecta**
```bash
sudo systemctl start redis
```

**Evolution API retorna 401**
- Verifique se `EVOLUTION_API_KEY` no `.env` é igual ao `AUTHENTICATION_API_KEY` do Docker

**Erro ao importar planilha**
- Confirme que o e-mail da service account tem acesso à planilha
- Confirme que o ID da planilha está correto (parte da URL entre `/d/` e `/edit`)

**Número não recebe mensagem**
- Certifique-se de incluir o DDD (ex: `11999998888`, não `999998888`)
- O sistema adiciona `55` automaticamente para números brasileiros
