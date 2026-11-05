#!/usr/bin/env bash
# Obtém um token de acesso no Keycloak (OAuth2 client credentials) e o imprime.
# Os clientes abaixo existem no realm de desenvolvimento (keycloak/realm-caixa.json).
# O comerciante e os escopos estão amarrados ao cliente pelo realm; quem pede o token não escolhe.
#
# Uso: TOKEN=$(bash scripts/obter-token.sh erp-loja-1)

set -euo pipefail

CLIENTE="${1:-erp-loja-1}"
KEYCLOAK_URL="${KEYCLOAK_URL:-http://localhost:8080}"

if [ -z "${SEGREDO:-}" ]; then
  case "$CLIENTE" in
    erp-loja-1) SEGREDO="dev-segredo-erp-loja-1" ;;
    erp-loja-2) SEGREDO="dev-segredo-erp-loja-2" ;;
    bi-loja-1)  SEGREDO="dev-segredo-bi-loja-1" ;;
    contabil-loja-1) SEGREDO="dev-segredo-contabil-loja-1" ;;
    *) echo "Informe SEGREDO para o cliente '$CLIENTE'." >&2; exit 1 ;;
  esac
fi

curl -s -X POST "$KEYCLOAK_URL/realms/caixa/protocol/openid-connect/token" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=$CLIENTE" \
  --data-urlencode "client_secret=$SEGREDO" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p'
