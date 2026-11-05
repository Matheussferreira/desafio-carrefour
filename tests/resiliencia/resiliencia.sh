#!/usr/bin/env bash
# Teste de resiliência contra a stack em execução (docker compose up -d --wait).
#
# Cenário A: consolidado parado. Os lançamentos continuam aceitos (201) e, quando o consolidado
#            volta, o saldo converge sozinho.
# Cenário B: RabbitMQ parado. Os lançamentos continuam aceitos, o outbox acumula pendentes e,
#            quando o broker volta, o relay drena e o saldo converge.
# Cenário C: Redis parado. O consolidado segue pronto (/ready 200) e o GET vem do banco (200); os eventos
#            continuam sendo aplicados. Mede por quanto tempo um cache antigo ainda pode ser servido na volta.
# Cenário D: banco do consolidado fora por 30 s (só ele, o de lançamentos segue no ar). Lançamentos continuam
#            aceitos, as mensagens ficam retidas na fila principal, nada vai para a DLQ e o saldo converge na volta.
# Cenário E: reprocessar a DLQ com scripts/reprocessar-dlq: o evento válido volta à fila e é aplicado; a
#            mensagem quebrada é recusada de novo e volta para a DLQ.
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

contagem_fila() { # fila campo -> número (a API atualiza as estatísticas a cada ~5 s)
  curl -s -u rabbit:rabbit "http://localhost:15672/api/queues/%2F/$1" \
    | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2 | { read -r v; echo "${v:-0}"; }
}

psql_admin() { docker compose exec -T postgres psql -U postgres -d postgres -c "$1" >/dev/null; }

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

docker compose up -d --wait consolidado lancamentos lancamentos-relay rabbitmq redis >/dev/null
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
# O cronômetro da drenagem começa quando o broker está saudável: a subida do RabbitMQ em si
# (dezenas de segundos) não depende desta solução e é registrada à parte.
subida_ini=$(date +%s)
docker compose up -d --wait rabbitmq >/dev/null
log "  rabbitmq saudável depois de $(( $(date +%s) - subida_ini )) s"
t="$(esperar_outbox_vazio)"
[ "$t" -ge 0 ] && ok=1 || ok=0
[ "$t" -ge 0 ] && [ "$t" -lt 15 ] && ok=1 || ok=0
verificar $ok "outbox drenou em menos de 15 s depois que o broker voltou (em $t s)"
t="$(esperar_saldo "$DIA_B" "$ESPERADO")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "saldo convergiu para $ESPERADO (em $t s)"
log ""

# --- Cenário C: Redis parado ---
DIA_C="$(date -d "2050-01-01 + $((RANDOM % 3000)) days" +%F 2>/dev/null || date -v+$((RANDOM % 3000))d -j -f %F 2050-01-01 +%F)"
log "=== Cenário C: Redis parado (data $DIA_C) ==="
criados="$(lancar "$DIA_C" "$RODADA-c1")"
[ "$criados" = "$QUANTIDADE" ] && ok=1 || ok=0
verificar $ok "lançamentos aceitos com tudo no ar: $criados de $QUANTIDADE"
t="$(esperar_saldo "$DIA_C" "$ESPERADO")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "saldo convergiu para $ESPERADO com o Redis no ar (em $t s)"
tk="$(token)"
curl -s -o /dev/null "$CONSOLIDADO_URL/consolidado/$DIA_C" -H "Authorization: Bearer $tk"   # aquece o cache
docker compose stop redis >/dev/null
log "  redis parado"
pronto=$(curl -s -o /dev/null -w '%{http_code}' "$CONSOLIDADO_URL/ready")
[ "$pronto" = "200" ] && ok=1 || ok=0
verificar $ok "consolidado segue pronto sem o Redis (/ready = $pronto)"
resposta=$(curl -s -w ' %{http_code} %{time_total}' "$CONSOLIDADO_URL/consolidado/$DIA_C" -H "Authorization: Bearer $tk")
codigo=$(echo "$resposta" | awk '{print $(NF-1)}'); tempo=$(echo "$resposta" | awk '{print $NF}')
echo "$resposta" | grep -q '"source":"database"' && ok=1 || ok=0
[ "$codigo" = "200" ] && [ "$ok" = "1" ] && ok=1 || ok=0
verificar $ok "GET devolve 200 vindo do banco (source = database, HTTP $codigo)"
awk "BEGIN{exit !($tempo < 3)}" && ok=1 || ok=0
verificar $ok "o GET sem Redis não fica esperando a reconexão ($tempo s)"
criados="$(lancar "$DIA_C" "$RODADA-c2")"
[ "$criados" = "$QUANTIDADE" ] && ok=1 || ok=0
verificar $ok "lançamentos aceitos com o Redis fora do ar: $criados de $QUANTIDADE"
t="$(esperar_saldo "$DIA_C" "$((ESPERADO * 2))")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "o consumidor aplicou os eventos novos sem o Redis e o GET mostra $((ESPERADO * 2)) (em $t s)"
docker compose up -d --wait redis >/dev/null
log "  redis de volta"
# Os eventos aplicados com o Redis fora não avançaram a versão do cache; a reconexão sobe a época
# do cache, então uma entrada antiga que sobreviveu à parada não pode mais ser servida.
t="$(esperar_saldo "$DIA_C" "$((ESPERADO * 2))")"
log "  defasagem do cache depois da volta do Redis: $t s (limite: 5 s)"
[ "$t" -ge 0 ] && [ "$t" -lt 5 ] && ok=1 || ok=0
verificar $ok "depois da volta do Redis o GET mostra o saldo correto em menos de 5 s"
log ""

# --- Cenário D: banco do consolidado fora por 30 s ---
DIA_D="$(date -d "2055-01-01 + $((RANDOM % 3000)) days" +%F 2>/dev/null || date -v+$((RANDOM % 3000))d -j -f %F 2055-01-01 +%F)"
log "=== Cenário D: banco do consolidado fora por 30 s (data $DIA_D) ==="
dlq_antes="$(contagem_fila consolidado.lancamentos.dlq messages)"
inicio_falha=$(date +%s)
psql_admin "ALTER DATABASE consolidado_db ALLOW_CONNECTIONS false"
psql_admin "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'consolidado_db'"
log "  consolidado_db bloqueado (lancamentos_db segue no ar)"
liberar_banco() { psql_admin "ALTER DATABASE consolidado_db ALLOW_CONNECTIONS true"; log "  consolidado_db liberado"; }
trap liberar_banco EXIT
criados="$(lancar "$DIA_D" "$RODADA-d")"
[ "$criados" = "$QUANTIDADE" ] && ok=1 || ok=0
verificar $ok "lançamentos aceitos com o banco do consolidado fora: $criados de $QUANTIDADE"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$LANCAMENTOS_URL/ready")" = "200" ] && ok=1 || ok=0
verificar $ok "API de lançamentos segue pronta"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$CONSOLIDADO_URL/ready")" = "503" ] && ok=1 || ok=0
verificar $ok "o consolidado sai de prontidão enquanto o banco dele está fora"
restante=$((30 - ($(date +%s) - inicio_falha)))
[ "$restante" -gt 0 ] && sleep "$restante"
sleep 6   # estatísticas de fila do RabbitMQ atualizam a cada ~5 s
msgs="$(contagem_fila consolidado.lancamentos messages)"
retidas="$(contagem_fila consolidado.lancamentos messages_unacknowledged)"
log "  na fila principal depois de 30 s de queda: $msgs mensagem(ns) ($retidas retida(s) pelo consumidor)"
[ "$msgs" -ge 1 ] && ok=1 || ok=0
verificar $ok "as mensagens ficam retidas na fila principal, não são descartadas"
[ "$(contagem_fila consolidado.lancamentos.dlq messages)" = "$dlq_antes" ] && ok=1 || ok=0
verificar $ok "nada foi para a DLQ durante os 30 s de queda"
liberar_banco
trap - EXIT
t="$(esperar_saldo "$DIA_D" "$ESPERADO")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "saldo convergiu para $ESPERADO depois que o banco voltou (em $t s)"
sleep 6
[ "$(contagem_fila consolidado.lancamentos.dlq messages)" = "$dlq_antes" ] && ok=1 || ok=0
verificar $ok "a DLQ continua sem mensagens novas"
transitorios=$(curl -s "$CONSOLIDADO_URL/metrics" | sed -n 's/^consolidado_consumer_transient_errors_total \([0-9]*\).*/\1/p')
[ "${transitorios:-0}" -ge 1 ] && ok=1 || ok=0
verificar $ok "a métrica consolidado_consumer_transient_errors_total registrou a espera (${transitorios:-0})"
log ""

# --- Cenário E: reprocessar a DLQ ---
DIA_E="$(date -d "2060-01-01 + $((RANDOM % 3000)) days" +%F 2>/dev/null || date -v+$((RANDOM % 3000))d -j -f %F 2060-01-01 +%F)"
log "=== Cenário E: reprocessar a DLQ com scripts/reprocessar-dlq.sh (data $DIA_E) ==="
COMERCIANTE="$(node -e "console.log(JSON.parse(Buffer.from(process.argv[1].split('.')[1], 'base64url')).comerciante_id)" "$(token)")"
curl -s -u rabbit:rabbit -X DELETE "http://localhost:15672/api/queues/%2F/consolidado.lancamentos.dlq/contents" >/dev/null
node -e "
const base = { properties: { delivery_mode: 2, headers: { 'x-first-death-reason': 'rejected' } }, routing_key: 'consolidado.lancamentos.dlq', payload_encoding: 'string' };
const evento = JSON.stringify({ eventoId: require('crypto').randomUUID(), schemaVersion: '1.1', tipo: 'LancamentoRegistrado',
  comercianteId: process.argv[1], correlationId: 'res-dlq', createdAt: new Date().toISOString(),
  data: { lancamentoId: require('crypto').randomUUID(), valor: '7.00', tipo: 'credito', descricao: null, data: process.argv[2] } });
for (const payload of [evento, '{\"quebrado\":']) console.log(JSON.stringify({ ...base, payload }));
" "$COMERCIANTE" "$DIA_E" | while read -r corpo; do
  curl -s -u rabbit:rabbit -H 'content-type: application/json' -X POST \
    "http://localhost:15672/api/exchanges/%2F/amq.default/publish" -d "$corpo" >/dev/null
done
for _ in $(seq 1 30); do
  [ "$(contagem_fila consolidado.lancamentos.dlq messages_ready)" -ge 2 ] && break
  sleep 1
done
[ "$(contagem_fila consolidado.lancamentos.dlq messages_ready)" = "2" ] && ok=1 || ok=0
verificar $ok "a DLQ recebeu 1 evento válido e 1 mensagem quebrada"
saida="$(bash "$RAIZ/scripts/reprocessar-dlq.sh" 2>&1)"; codigo=$?
echo "$saida" | while read -r linha; do log "  $linha"; done
[ "$codigo" = "0" ] && ok=1 || ok=0
verificar $ok "reprocessar-dlq.sh terminou sem erro"
t="$(esperar_saldo "$DIA_E" "7")"
[ "$t" -ge 0 ] && ok=1 || ok=0
verificar $ok "o evento válido voltou à fila principal e foi aplicado (saldo 7.00, em $t s)"
for _ in $(seq 1 30); do
  [ "$(contagem_fila consolidado.lancamentos.dlq messages)" = "1" ] && break
  sleep 1
done
[ "$(contagem_fila consolidado.lancamentos.dlq messages)" = "1" ] && ok=1 || ok=0
verificar $ok "a mensagem quebrada foi recusada de novo e voltou para a DLQ (reentregar não conserta dado inválido)"
curl -s -u rabbit:rabbit -X DELETE "http://localhost:15672/api/queues/%2F/consolidado.lancamentos.dlq/contents" >/dev/null
log ""

if [ "$FALHAS" -gt 0 ]; then log "RESULTADO: $FALHAS verificação(ões) falharam"; exit 1; fi
log "RESULTADO: todas as verificações passaram"
log "Saída salva em $ARQUIVO"
