#!/usr/bin/env bash
# Confere no Prometheus se cada painel do dashboard tem dado. Uso: bash scripts/verificar-dashboard.sh [minutos]
exec node "$(cd "$(dirname "$0")" && pwd)/verificar-dashboard.js" "$@"
