# WhatsApp Disparador v8 — Comandos rápidos
# Uso: make <comando>

.PHONY: setup start stop restart logs migrate admin build help

# Instalação interativa (Docker ou manual)
setup:
	node scripts/setup.js

# Docker
build:
	docker compose build

start:
	docker compose up -d

stop:
	docker compose down

restart:
	docker compose restart app

logs:
	docker compose logs -f app

# Banco
migrate:
	docker compose exec app node src/db/migrate.js

migrate-local:
	node src/db/migrate.js

# Admin (uso: make admin EMAIL=meu@email.com SENHA=minhasenha)
admin:
	docker compose exec app node src/db/criar-admin.js "$(EMAIL)" "$(SENHA)"

admin-local:
	node src/db/criar-admin.js "$(EMAIL)" "$(SENHA)"

# Status
status:
	docker compose ps

# Limpa tudo (CUIDADO: apaga banco)
clean:
	docker compose down -v

help:
	@echo ""
	@echo "  WhatsApp Disparador v8"
	@echo ""
	@echo "  make setup          → Instalação interativa"
	@echo "  make start          → Sobe todos os containers"
	@echo "  make stop           → Para todos os containers"
	@echo "  make restart        → Reinicia o app"
	@echo "  make logs           → Logs em tempo real"
	@echo "  make status         → Status dos containers"
	@echo "  make migrate        → Roda migrações (Docker)"
	@echo "  make migrate-local  → Roda migrações (manual)"
	@echo "  make admin EMAIL=x SENHA=y  → Cria/reseta admin"
	@echo "  make clean          → Remove containers e volumes"
	@echo ""
