#!/usr/bin/env bash
# Ciclo completo dos testes de integração:
#   1. Sobe infra isolada (postgres:5433, rabbitmq:5673, redis:6380)
#   2. Roda os testes de integração dos dois serviços
#   3. Destrói a infra independentemente do resultado
#
# Uso: bash test-integration.sh
# Requer: Docker com Compose v2 e Node 24+. No Windows prefira ./test-integration.ps1

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$ROOT_DIR/docker-compose.integration.yml"

cleanup() {
  echo ""
  echo "-> Derrubando infra de integração..."
  # Sem --remove-orphans: não toca no stack principal (docker-compose.yml)
  docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
}
trap cleanup EXIT

echo "-> Subindo infra isolada (postgres:5433, rabbitmq:5673, redis:6380)..."
docker compose -f "$COMPOSE_FILE" up -d --wait || exit 1

export RABBITMQ_URL="amqp://rabbit:rabbit@localhost:5673"
export REDIS_URL="redis://localhost:6380"

FALHOU=0
for entry in "lancamentos:lancamentos_db" "consolidado:consolidado_db"; do
  servico="${entry%%:*}"
  banco="${entry##*:}"
  echo ""
  echo "=== Integração: $servico ==="
  export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/$banco"
  (
    cd "$ROOT_DIR/services/$servico"
    [ -d node_modules ] || npm ci --no-audit --no-fund
    npm run test:integration
  ) || FALHOU=1
done

echo ""
if [ "$FALHOU" -ne 0 ]; then
  echo "Testes de integração FALHARAM"
  exit 1
fi
echo "Testes de integração concluídos com sucesso"
