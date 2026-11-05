#!/usr/bin/env bash
# Popula o sistema com lançamentos de exemplo, pela API (nunca direto no banco).
# Opcional. Pode rodar mais de uma vez no mesmo dia: as chaves de idempotência evitam duplicar.
#
# Uso: bash scripts/seed-demo.sh

set -euo pipefail

LANCAMENTOS_URL="${LANCAMENTOS_URL:-http://localhost:3001}"
CONSOLIDADO_URL="${CONSOLIDADO_URL:-http://localhost:3002}"

TOKEN=$(curl -s -X POST "$LANCAMENTOS_URL/auth/login" \
  -H 'Content-Type: application/json' -d '{}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

HOJE=$(date +%F)
ONTEM=$(date -d 'yesterday' +%F 2>/dev/null || date -v-1d +%F)

enviar() {
  local n="$1" valor="$2" tipo="$3" descricao="$4" data="$5"
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LANCAMENTOS_URL/lancamentos" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Idempotency-Key: seed-demo-$data-$n" \
    -d "{\"valor\":\"$valor\",\"tipo\":\"$tipo\",\"descricao\":\"$descricao\",\"data\":\"$data\"}")
  local situacao="criado"
  [ "$status" = "200" ] && situacao="ja existia"
  [ "$status" != "201" ] && [ "$status" != "200" ] && situacao="ERRO HTTP $status"
  printf '%s %-7s %10s  %s\n' "$data" "$tipo" "$valor" "$situacao"
}

enviar 001 1500.00 credito "Venda produto A" "$ONTEM"
enviar 002 200.50 debito "Compra de insumos" "$ONTEM"
enviar 003 3200.00 credito "Venda produto B" "$HOJE"
enviar 004 450.75 debito "Aluguel do ponto" "$HOJE"

echo
echo "Aguardando o consolidado processar os eventos..."
sleep 4

for dia in "$ONTEM" "$HOJE"; do
  curl -s "$CONSOLIDADO_URL/consolidado/$dia" -H "Authorization: Bearer $TOKEN"
  echo
done
