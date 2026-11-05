#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.."

# Sobe o consolidado com RATE_LIMIT_MAX=300, roda a rajada e devolve o serviço ao limite de produção.
saida=1
if docker compose -f docker-compose.yml -f docker-compose.ratelimit.yml up -d --build --wait consolidado; then
  MSYS_NO_PATHCONV=1 docker compose -f docker-compose.yml -f docker-compose.ratelimit.yml \
    --profile loadtest run --rm k6 run /scripts/limite-429.js
  saida=$?
fi
docker compose up -d --wait consolidado
echo "Código de saída do k6: $saida"
exit $saida
