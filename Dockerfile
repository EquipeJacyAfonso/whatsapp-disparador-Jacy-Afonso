FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production --silent
COPY . .
RUN chmod +x docker-entrypoint.sh
EXPOSE 3000
# Entrypoint aguarda o PostgreSQL, roda migrate.js e sobe o servidor.
# Sem isso, num 'docker compose up' limpo o app tentava conectar antes
# do banco existir e as tabelas nunca eram criadas.
ENTRYPOINT ["./docker-entrypoint.sh"]
