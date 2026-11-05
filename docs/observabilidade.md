# Observabilidade — Estado Atual e Evolução Futura

## O que está implementado

### Métricas Prometheus — sempre ligadas

Ambos os serviços expõem `/metrics` sem autenticação, prontos para scraping pelo Prometheus.

**Lançamentos (`:3001/metrics`):**

| Métrica | Tipo | Labels | Descrição |
|---|---|---|---|
| `lancamentos_http_requests_total` | Counter | `method, route, status` | Volume de requisições HTTP |
| `lancamentos_http_request_duration_seconds` | Histogram | `method, route, status` | Latência das requisições; buckets: 5ms a 2.5s |
| `lancamentos_created_total` | Counter | `tipo` (`credito`\|`debito`) | Lançamentos criados por tipo |
| `lancamentos_outbox_events_published_total` | Counter | n/a | Eventos publicados e confirmados pelo broker (processo `lancamentos-relay`) |
| `lancamentos_outbox_publish_failures_total` | Counter | n/a | Lotes do outbox que falharam (sem confirmação, sem rota ou conexão caída) |
| `lancamentos_rabbitmq_connected` | Gauge | n/a | 1 quando o relay está conectado ao RabbitMQ |
| Métricas Node.js default | — | — | Heap, GC, CPU, event loop lag |

**Consolidado (`:3002/metrics`):**

| Métrica | Tipo | Labels | Descrição |
|---|---|---|---|
| `consolidado_http_requests_total` | Counter | `method, route, status` | Volume de requisições HTTP |
| `consolidado_http_request_duration_seconds` | Histogram | `method, route, status` | Latência das requisições; buckets: 5ms a 2.5s |
| `consolidado_events_processed_total` | Counter | `tipo, status` | Eventos processados; `status`: `processed`, `skipped`, `dlq`, `invalid` |
| `consolidado_consumer_retries_total` | Counter | — | Cada vez que `withRetry` chama o callback `onRetry`; uma mensagem que esgota os retries contribui **3** para este contador (não 4 — a última tentativa falha sem callback) |
| `consolidado_consumer_dlq_total` | Counter | — | Mensagens enviadas à DLQ após esgotar retries; deve ser próximo de zero em operação normal |
| `consolidado_rabbitmq_connected` | Gauge | n/a | 1 quando o consumidor está conectado ao RabbitMQ |
| Métricas Node.js default | — | — | Heap, GC, CPU, event loop lag |

> **Interpretação de `consumer_retries_total`:** O valor N neste counter não significa N execuções de `processEvent` que falharam — significa N callbacks de retry chamados. Uma mensagem que falha 4 vezes (1 inicial + 3 retries) contribui com 3 para `consumer_retries_total` e 1 para `consumer_dlq_total`. Para saber o total de tentativas, some `consumer_retries_total + consumer_dlq_total` (onde cada entry na DLQ representa 1 tentativa não contada no retries counter).

### Logs Estruturados (pino)

Todos os logs são JSON estruturado com nível (`info`, `warn`, `error`, `debug`). O `correlationId` é gerado no `POST /lancamentos` (do header `X-Correlation-Id` ou gerado automaticamente) e propagado no payload do evento, aparecendo nos logs do consumer:

```json
// Log do lancamentos:
{"level":"info","correlationId":"7f3e9c1a","eventoId":"550e8400","lancamentoId":"a1b2c3d4","msg":"Lancamento registered"}

// Log do consolidado (mesmo correlationId):
{"level":"info","correlationId":"7f3e9c1a","eventoId":"550e8400","data":"2024-01-15","tipo":"credito","valor":"1500.00","msg":"Event processed"}
```

Rastrear um lançamento de ponta a ponta (sem tracing distribuído):
```bash
docker compose logs lancamentos | grep "7f3e9c1a"
docker compose logs consolidado | grep "7f3e9c1a"
```

### Health Checks

| Endpoint | Tipo | Verifica |
|---|---|---|
| `GET /health` | Liveness | Processo vivo; retorna `{"status":"ok"}` incondicionalmente |
| `GET /ready` — lancamentos | Readiness | `SELECT 1` no banco + canal RabbitMQ inicializado |
| `GET /ready` — consolidado | Readiness | `SELECT 1` no banco + `PING` no Redis + canal RabbitMQ |

O Docker Compose usa `/ready` como healthcheck de `lancamentos`, `lancamentos-relay` e `consolidado`, e `docker compose up --wait` só retorna quando os três estão saudáveis. O `/ready` do consolidado e do relay fica 503 quando a conexão com o RabbitMQ cai; o da API de lançamentos depende apenas do banco.

### Graceful Shutdown

Ao receber SIGTERM, o consumer do Consolidado:

1. Cancela o consumer tag via `channel.cancel(consumerTag)` — o broker para de enviar novas mensagens
2. Seta `shuttingDown = true` — mensagens recebidas durante o shutdown são requeued (não perdidas)
3. Aguarda até 8s para a mensagem em processamento (`inFlight > 0`) terminar
4. Fecha o canal e a conexão AMQP

Isso garante que métricas Prometheus e logs de conclusão do evento em processamento são emitidos antes do processo encerrar.

### Prometheus + Grafana (profile opcional)

```bash
docker compose --profile observability up -d
# Prometheus: http://localhost:9090
# Grafana:    http://localhost:3000  (admin/admin)
```

O dashboard **"Fluxo de Caixa — Overview"** é provisionado automaticamente via
`observability/grafana/provisioning/dashboards/caixa-flow.json`. Painéis:

- Taxa de requisições e latência p50/p95 — Lançamentos
- Taxa de eventos processados por status (`processed`/`skipped`/`dlq`/`invalid`) — Consolidado
- Contadores de retries e DLQ do consumer (com thresholds coloridos)
- Heap Node.js de ambos os serviços

---

## O que NÃO está implementado — Tracing Distribuído

### Por que não foi incluído neste baseline

O SDK do OpenTelemetry (`@opentelemetry/sdk-node` + auto-instrumentations) exige inicialização assíncrona antes de qualquer `import` de módulo instrumentado. Isso altera a estrutura do `server.ts` de forma não-trivial, adiciona ~5 dependências novas com risco de conflito de versão, e modifica o bootstrap de startup — área que já tem comportamento crítico (conexão ao banco, ao broker, migrações). O risco de instabilizar o `docker compose up` não justificou o ganho para 2 serviços onde o `correlationId` nos logs já cobre 95% dos casos de diagnóstico.

### Como implementar quando necessário

**1. Instalar dependências em ambos os serviços:**
```bash
npm install @opentelemetry/sdk-node \
            @opentelemetry/auto-instrumentations-node \
            @opentelemetry/exporter-trace-otlp-grpc
```

**2. Criar `src/tracing.ts` (carregado ANTES de qualquer import no `server.ts`):**
```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { Resource } from '@opentelemetry/resources';
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: process.env.SERVICE_NAME ?? 'lancamentos',
  }),
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://jaeger:4317',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
```

**3. Modificar `server.ts` para importar tracing primeiro:**
```typescript
import './tracing'; // DEVE ser o primeiro import
import app from './app';
// ... restante igual
```

**4. Adicionar Jaeger ao `docker-compose.yml` (no profile `observability`):**
```yaml
jaeger:
  image: jaegertracing/all-in-one:1.58
  profiles: ["observability"]
  environment:
    COLLECTOR_OTLP_ENABLED: "true"
  ports:
    - "16686:16686"  # UI
    - "4317:4317"    # OTLP gRPC
```

**5. Propagar contexto via AMQP:**

A `AmqplibInstrumentation` do auto-instrumentations injeta e extrai `traceparent`/`tracestate` nos headers da mensagem automaticamente. O span do consumer será filho do span do publisher sem código adicional.

**O que você ganha:**

- Um trace único cobrindo: `POST /lancamentos` → INSERT banco → outbox relay → RabbitMQ publish → consumer → DB upsert → Redis DEL
- Visibilidade de latência por hop (quanto tempo o evento ficou na fila, quanto tempo o Postgres levou no upsert)
- Correlação automática com logs via `trace_id` / `span_id` injetados no contexto do pino

**Prioridade:** Alta quando o sistema crescer para 4+ serviços ou quando investigação de latência por `correlationId` nos logs se tornar insuficiente.

---

## SLOs Sugeridos para Produção

| Indicador | Objetivo | Alerta |
|---|---|---|
| Disponibilidade `POST /lancamentos` | > 99.9% em 30 dias | < 99.5% em janela de 1h |
| Latência `POST /lancamentos` p99 | < 200ms | > 500ms por 5min |
| Taxa de erro `POST /lancamentos` | < 0.1% | > 1% por 5min |
| Disponibilidade `GET /consolidado` | > 99.5% em 30 dias | < 99% em janela de 1h |
| Latência `GET /consolidado` p95 | < 100ms (cache hit) / < 500ms (miss) | > 200ms por 5min |
| Taxa de mensagens na DLQ | < 0.01% do total | Qualquer mensagem na DLQ → alerta imediato |
| Lag de consistência (lançamento → saldo) | < 5s em p99 | > 30s → investigar relay ou broker |

Alertas baseados em `consumer_dlq_total` e `consumer_retries_total` são especialmente importantes: um spike de retries indica problema transiente (ex: banco sobrecarregado); mensagens na DLQ indicam problema persistente (ex: payload inválido ou bug no processamento) que requer intervenção manual.
