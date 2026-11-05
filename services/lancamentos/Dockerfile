# Multi-stage: a imagem final leva só o JavaScript compilado e as dependências de produção,
# roda como usuário sem privilégios e não carrega testes nem ferramentas de desenvolvimento.

FROM node:20-alpine AS base
WORKDIR /app

# Todas as dependências (inclui as de desenvolvimento), para compilar e testar
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Imagem só para os testes unitários: docker compose --profile test run --rm lancamentos-test
FROM deps AS test
COPY tsconfig.json jest.config.ts jest.integration.config.ts openapi.yaml ./
COPY src ./src
COPY tests ./tests
CMD ["npm", "run", "test:unit"]

# Só as dependências de produção
FROM base AS prod-deps
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Imagem final (precisa ser o último estágio: é o que o compose e o CI constroem por padrão)
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3001
CMD ["node", "dist/server.js"]
