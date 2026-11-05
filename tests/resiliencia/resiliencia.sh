#!/usr/bin/env bash
# Teste de resiliência contra a stack em execução (docker compose up -d --wait).
#
# Cenário A: consolidado parado. Os lançamentos continuam aceitos (201) e, quando o consolidado
#            volta, o saldo converge sozinho.
# Cenário B: RabbitMQ parado. Os lançamentos continuam aceitos, o outbox acumula pendentes e,
#            quando o broker volta, o relay drena e o saldo converge.
#
# A saída vai para a tela e para docs/evidencias/resiliencia-sh-<data>.txt.
# Sai com código diferente de zero se qualquer verificação falhar.
#
# Uso: bash tests/resiliencia/resiliencia.sh [quantidade] [cliente]

set -uo pipefail

QUANTIDADE="${1:-30}"
CLIENTE="${2:-erp-loja-2}"
TIMEOUT="${TIMEOUT_SEGUNDOS:-120}"
LANCAMENTOS_URL="${LANCAMENTOS_URL:-http://localhost:3001}"
CONSOLIDADO_URL="${CONSOLIDADO_URL:-http://localhost:3002}"

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$RAIZ"
mkdir -p docs/evidencias
ARQUIVO="docs/evidencias/resiliencia-sh-$(date +%Y%m%d-%H%M%S).txt"
FALHAS=0

if ! docker info >/dev/null 2>&1; then
  echo "Docker não está disponível. Inicie o Docker e suba a stack com docker compose up -d --wait." >&2
  exit 2
fi

log() { echo "$1" | tee -a "$ARQUIVO"; }
verificar() {
  if [ "$1" = "1" ]; then log "  [OK]    $2"; else log "  [FALHA] $2"; FALHAS=$((FALHAS + 1)); fi
}

token() { bash "$RAIZ/scripts/obter-token.sh" "$CLIENTE"; }

pendentes() {
  docker compose exec -T postgres psql -U postgres -d lancamentos_db -tAc \
    "SELECT count(*) FROM outbox WHERE status = 'pendente'" | tr -d '[:space:]'
}

fila_consolidado() {
  curl -s -u rabbit:rabbit "http://localhost:15672/api/queues/%2F/consolidado.lancamentos" \
    | grep -o '"messages":[0-9]*' | head -1 | cut -d: -f2
}

lancar() { # data rodada -> imprime quantos retornaram 201
  local data="$1" rodada="$2" criados=0 t i codigo
  t="$(token)"
  for i in $(seq 1 "$QUANTIDADE"); do
    codigo=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$LANCAMENTOS_URL/lancamentos" \
      -H "Authorization: Bearer $t" -H 'Content-Type: application/json' \
      -H "X-Idempotency-Key: res-$rodada-$i" \
      -d "{\"valor\":\"10.00\",\"tipo\":\"credito\",\"data\":\"$data\",\"descricao\":\"resiliencia\"}")
    [ "$codigo" = "201" ] && criados=$((criados + 1))
  done
  echo "$criados"
}

esperar_saldo() { # data esperado -> imprime segundos ou -1
  local data="$1" esperado="$2" t inicio agora total
  t="$(token)"
  inicio=$(date +%s)
  while :; do
    total=$(curl -s "$CONSOLIDADO_URL/consolidado/$data" -H "Authorization: Bearer $t" \
      | grep -o '"totalCreditos":"[0-9.]*"' | cut -d'"' -f4)
    if [ -n "$total" ] && [ "${total%%.*}" = "$esperado" ]; then echo $(( $(date +%s) - inicio )); return; fi
    agora=$(date +%s)
    if [ $((agora - inicio)) -ge "$TIMEOUT" ]; then echo -1; return; fi
    sleep 0.5
  done
}

esperar_outbox_vazio() {
  local inicio agora
  inicio=$(date +%s)
  while :; do
    if [ "$(pendentes)" = "0" ]; then echo $(( $(date +%s) - inicio )); return; fi
    agora=$(date +%s)
    if [ $((agora - inicio)) -ge "$TIMEOUT" ]; then echo -1; return; fi
    sleep 0.5
  done
}

RODADA="$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
ESPERADO=$((QUANTIDADE * 10))
DIA_A="$(date -d "2040-01-01 + $((RANDOM % 3000)) days" +%F 2>/dev/null || date -v+$((RANDOM % 3000))d -j -f %F 2040-01-01 +%F)"
DIA_B="$(date -d "2045-01-01 + $((RANDOM % 3000)) days" +%F 2>/dev/null || date -v+$((RANDOM % 3000))d -j -f %F 2045-01-01 +%F)"

log "Teste de resiliência, rodada $RODADA, $(date '+%Y-%m-%d %H:%M:%S')"
log "Quantidade por cenário: $QUANTIDADE lançamentos de 10.00 (cliente $CLIENTE)"
log ""

docker compose up -d --wait consolidado lancamentos lancamentos-relay rabbitmq >/dev/null
esperar_outbox_vazio >/dev/null

# --- Cenário A: consolidado parado ---
log "=== Cenário A: consolidado parado (data $DIA_A) ==="
docker compose stop consolidado >/dev/null
log "  consolidado parado"
criados="$(lancar "$DIA_A" "$RODADA-a")"
[ "$criados" = "$QUANTIDADE" ] && ok=1 || ok=0
verificar $ok "lançamentos aceitos com o consolidado fora do ar: $criados de $QUANTIDADE (esperado 201 em todos)"
# A API de gerenciamento atualiza as estatísticas de fila a cada ~5 s; espera até aparecer
fila=0
for _ in $(seq 1 20); do
  sleep 1
  fila="$(fila_consolidado)"; fila="${fila:-0}"
  [ "$fila" -ge 1 ] && break
done
log "  mensagens aguardando na fila do consolidado: $fila"
[ "$fila" -ge 1 ] && ok=1 || ok=0
verificar $ok "a fila retém os eventos enquanto o consolidado está fora"
docker compose start consolidado >/dev/null
t="$(esperar_saldo "$DIA_A" "$ESPERADO")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "saldo convergiu para $ESPERADO depois que o consolidado voltou (em $t s)"
log ""

# --- Cenário B: RabbitMQ parado ---
log "=== Cenário B: RabbitMQ parado (data $DIA_B) ==="
docker compose stop rabbitmq >/dev/null
log "  rabbitmq parado"
criados="$(lancar "$DIA_B" "$RODADA-b")"
[ "$criados" = "$QUANTIDADE" ] && ok=1 || ok=0
verificar $ok "lançamentos aceitos com o broker fora do ar: $criados de $QUANTIDADE (esperado 201 em todos)"
sleep 3
pend="$(pendentes)"
log "  eventos pendentes no outbox: $pend"
[ "$pend" -ge "$QUANTIDADE" ] && ok=1 || ok=0
verificar $ok "o outbox acumulou os eventos que não puderam ser publicados"
pronto=$(curl -s -o /dev/null -w '%{http_code}' "$LANCAMENTOS_URL/ready")
[ "$pronto" = "200" ] && ok=1 || ok=0
verificar $ok "API de lançamentos segue pronta (/ready = $pronto)"
docker compose start rabbitmq >/dev/null
t="$(esperar_outbox_vazio)"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "outbox drenou depois que o broker voltou (em $t s)"
t="$(esperar_saldo "$DIA_B" "$ESPERADO")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "saldo convergiu para $ESPERADO (em $t s)"
log ""

if [ "$FALHAS" -gt 0 ]; then log "RESULTADO: $FALHAS verificação(ões) falharam"; exit 1; fi
log "RESULTADO: todas as verificações passaram"
log "Saída salva em $ARQUIVO"
