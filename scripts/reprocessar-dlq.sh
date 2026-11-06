#!/usr/bin/env bash
# Devolve as mensagens da DLQ do consolidado à fila principal, pela API de gerenciamento do RabbitMQ.
# Usa scripts/reprocessar-dlq.js, que precisa só do Node 24.
#
# Uso: bash scripts/reprocessar-dlq.sh [--simular] [--limite N]
# Variáveis: RABBITMQ_MGMT_URL (padrão http://localhost:15672), RABBITMQ_USER e RABBITMQ_PASS (padrão rabbit)

set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24 ou superior é necessário para este script." >&2
  exit 2
fi

exec node "$(dirname "$0")/reprocessar-dlq.js" "$@"
