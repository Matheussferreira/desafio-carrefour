# Arquitetura do Sistema

## C4 — Nível 1: Contexto

```mermaid
C4Context
    title Sistema de Controle de Fluxo de Caixa

    Person(comerciante, "Comerciante", "Registra lançamentos e consulta saldo diário")
    System(sistema, "Fluxo de Caixa", "Controla lançamentos e consolida saldo por dia")
    System_Ext(erp, "ERP / Sistema Legado", "Integração futura via API")

    Rel(comerciante, sistema, "Registra lançamentos / Consulta saldo", "HTTPS/REST")
    Rel(erp, sistema, "Envia lançamentos em lote", "HTTPS/REST")
```

---

## C4 — Nível 2: Containers

```mermaid
C4Container
    title Containers do Sistema

    Person(comerciante, "Comerciante")

    Container(lancamentos, "Serviço Lancamentos", "Node.js 20 / Express", "Registra débitos e créditos; publica eventos via Outbox")
    Container(consolidado, "Serviço Consolidado", "Node.js 20 / Express", "Consome eventos e mantém projeção de saldo diário")
    ContainerDb(pg_l, "lancamentos_db", "PostgreSQL 16", "Tabelas: lancamentos, outbox")
    ContainerDb(pg_c, "consolidado_db", "PostgreSQL 16", "Tabelas: saldo_diario (PK comerciante_id + data), comerciante_progresso, eventos_processados")
    Container(mq, "RabbitMQ", "RabbitMQ 3.13", "Exchange: lancamentos.events (topic) + DLX/DLQ")
    Container(redis, "Redis", "Redis 7", "Cache do saldo por comerciante e data, TTL 60s")

    Rel(comerciante, lancamentos, "POST /lancamentos, GET /lancamentos", "HTTPS")
    Rel(comerciante, consolidado, "GET /consolidado/{data}", "HTTPS")
    Rel(lancamentos, pg_l, "Lê/Escreve", "SQL")
    Rel(lancamentos, mq, "Publica LancamentoRegistrado (via Outbox Relay)", "AMQP")
    Rel(consolidado, mq, "Consome LancamentoRegistrado; NACK → DLX → DLQ", "AMQP")
    Rel(consolidado, pg_c, "Upsert saldo_diario, INSERT eventos_processados", "SQL")
    Rel(consolidado, redis, "GET/SET/DEL saldo:{comerciante}:{data}", "Redis protocol")
```

---

## C4 — Nível 3: Componentes do Serviço Lancamentos

```mermaid
C4Component
    title Componentes — Serviço Lancamentos

    Container_Boundary(svc, "Serviço Lancamentos") {
        Component(api, "API Routes", "Express Router", "POST /lancamentos (idempotência via X-Idempotency-Key), GET /lancamentos")
        Component(auth, "Auth Middleware", "jsonwebtoken", "Valida JWT em todas as rotas de negócio")
        Component(relay, "Outbox Relay", "processo lancamentos-relay", "Seleciona o outbox pendente com FOR UPDATE SKIP LOCKED, publica e só marca publicado depois do ack do broker; reconecta com backoff")
        Component(db, "DB Pool", "node-postgres", "Pool de conexões com lancamentos_db; transações ACID para INSERT lancamento + outbox")
        Component(rmq, "RabbitMQ Client", "amqplib", "Conexão persistente; assertExchange + assertQueue na inicialização")
        Component(metrics, "Métricas", "prom-client", "HTTP request counters/histograms, outbox relay counter")
    }

    Rel(api, auth, "Passa por antes de qualquer lógica de negócio")
    Rel(api, db, "BEGIN → INSERT lancamento + INSERT outbox → COMMIT (mesma transação)")
    Rel(relay, db, "SELECT pendente LIMIT 50 FOR UPDATE SKIP LOCKED e UPDATE publicado em lote após o ack")
    Rel(relay, rmq, "publish com persistent, mandatory e messageId=eventoId; aguarda a confirmação")
```

---

## C4 — Nível 3: Componentes do Serviço Consolidado

```mermaid
C4Component
    title Componentes — Serviço Consolidado

    Container_Boundary(svc, "Serviço Consolidado") {
        Component(api_c, "API Routes", "Express Router", "GET /consolidado/{data} com cache-aside e fallback DB")
        Component(auth_c, "Auth Middleware", "jsonwebtoken", "Valida JWT em todas as rotas de negócio")
        Component(consumer, "Consumer", "amqplib + withRetry", "prefetch=1; 1 tentativa inicial + 3 retries com backoff 1s/2s/4s; NACK sem requeue após esgotar → DLQ")
        Component(retry, "withRetry", "utility pura", "Executa fn até maxRetries+1 vezes; onRetry callback por cada falha intermediária; retorna Result discriminado")
        Component(db_c, "DB Pool", "node-postgres", "Pool para consolidado_db; transações para INSERT eventos_processados + UPSERT saldo_diario")
        Component(redis_c, "Redis Client", "ioredis", "GET saldo:{comerciante}:{data} → hit retorna JSON; miss → query DB → SETEX 60s; após cada evento apaga a data e as posteriores do comerciante")
        Component(rmq_c, "RabbitMQ Client", "amqplib", "assertExchange + assertQueue + bindQueue; DLX configurado via x-dead-letter-exchange; prefetch=1")
        Component(metrics_c, "Métricas", "prom-client", "HTTP counters, events_processed_total por tipo/status, consumer_retries_total, consumer_dlq_total")
    }

    Rel(api_c, auth_c, "Passa por antes de qualquer lógica de negócio")
    Rel(api_c, redis_c, "GET saldo:{comerciante}:{data}")
    Rel(api_c, db_c, "Fallback: soma de saldo_diario do comerciante até a data")
    Rel(consumer, retry, "withRetry(() => processEvent(raw), 3, [1000,2000,4000])")
    Rel(retry, db_c, "BEGIN → INSERT eventos_processados (ON CONFLICT DO NOTHING) → UPSERT saldo_diario → COMMIT")
    Rel(retry, redis_c, "invalida a data e as posteriores após o COMMIT (falha não-fatal)")
    Rel(consumer, rmq_c, "ACK em sucesso ou skip; NACK(false,false) após esgotar retries → DLQ via DLX")
```

---

## Diagrama de Sequência — Fluxo Feliz

```mermaid
sequenceDiagram
    participant C as Cliente
    participant L as Lancamentos
    participant DB_L as lancamentos_db
    participant RMQ as RabbitMQ
    participant CONS as Consolidado Consumer
    participant DB_C as consolidado_db
    participant REDIS as Redis

    C->>L: POST /lancamentos {valor, tipo, data}
    L->>DB_L: BEGIN TRANSACTION
    L->>DB_L: INSERT lancamentos
    L->>DB_L: INSERT outbox (status=pendente, payload=LancamentoRegistrado)
    L->>DB_L: COMMIT
    L-->>C: 201 Created {id, valor, tipo, data}

    Note over L: O lancamentos-relay executa a cada 1s

    L->>DB_L: SELECT outbox WHERE status=pendente ORDER BY created_at LIMIT 50
    L->>RMQ: channel.publish(exchange, routingKey, payload, {persistent:true, messageId:eventoId})
    L->>DB_L: UPDATE outbox SET status=publicado WHERE id=$1

    RMQ->>CONS: Deliver LancamentoRegistrado (prefetch=1)
    CONS->>DB_C: BEGIN TRANSACTION
    CONS->>DB_C: INSERT eventos_processados (eventoId) ON CONFLICT DO NOTHING
    Note over DB_C: rowCount=1 → evento novo; rowCount=0 → já processado, skip + ACK
    CONS->>DB_C: UPSERT saldo_diario (comerciante, data) SET saldo = saldo_diario.saldo + delta; UPSERT comerciante_progresso
    CONS->>DB_C: COMMIT
    CONS->>REDIS: invalida saldo:{comerciante}:{data} e as datas posteriores
    CONS->>RMQ: channel.ack(msg)

    C->>CONS: GET /consolidado/2026-06-24
    CONS->>REDIS: GET saldo:loja-7:2026-06-24
    alt cache hit
        REDIS-->>CONS: JSON {totalCreditos, totalDebitos, resultadoDia, saldoAcumulado}
    else cache miss
        CONS->>DB_C: SELECT somas FROM saldo_diario WHERE comerciante_id=$1 AND data <= $2
        DB_C-->>CONS: row
        CONS->>REDIS: SETEX saldo:loja-7:2026-06-24 60
    end
    CONS-->>C: 200 {totalCreditos, totalDebitos, resultadoDia, saldoAcumulado, atualizadoAte, source}
```

---

## Diagrama de Sequência — Fluxo de Falha (Retry + DLQ)

Este diagrama mostra o caminho de uma mensagem que falha em processamento de forma persistente — por exemplo, um payload com valor não-numérico que sempre lança no `new Decimal(valor)`.

```mermaid
sequenceDiagram
    participant RMQ as RabbitMQ
    participant CONS as Consumer
    participant DLX as lancamentos.events.dlx
    participant DLQ as consolidado.lancamentos.dlq

    RMQ->>CONS: Deliver mensagem (payload inválido)

    Note over CONS: Tentativa inicial (attempt=0)
    CONS->>CONS: processEvent() → lança exceção
    CONS->>CONS: onRetry(err, attempt=1) — consumerRetriesTotal +1
    CONS->>CONS: aguarda 1 000 ms

    Note over CONS: Retry 1 (attempt=1)
    CONS->>CONS: processEvent() → lança exceção
    CONS->>CONS: onRetry(err, attempt=2) — consumerRetriesTotal +1
    CONS->>CONS: aguarda 2 000 ms

    Note over CONS: Retry 2 (attempt=2)
    CONS->>CONS: processEvent() → lança exceção
    CONS->>CONS: onRetry(err, attempt=3) — consumerRetriesTotal +1
    CONS->>CONS: aguarda 4 000 ms

    Note over CONS: Retry 3 (attempt=3) — última tentativa
    CONS->>CONS: processEvent() → lança exceção
    Note over CONS: withRetry retorna {ok:false}<br/>consumerDlqTotal +1

    CONS->>RMQ: channel.nack(msg, false, false)
    Note over RMQ: requeue=false → mensagem descartada da fila principal<br/>x-dead-letter-exchange roteia para DLX

    RMQ->>DLX: roteia via DLX com routing key original
    DLX->>DLQ: mensagem chega na DLQ (durável)

    Note over DLQ: Disponível para inspeção manual,<br/>replay ou descarte via management UI ou API
```

**Resumo do comportamento:**
- 4 chamadas a `processEvent` no total (1 inicial + 3 retries)
- 3 incrementos em `consumerRetriesTotal` (um por callback de retry)
- 1 incremento em `consumerDlqTotal`
- Tempo mínimo antes do NACK: 1 000 + 2 000 + 4 000 = **7 segundos** (mais tempo de execução das 4 tentativas)

---

## Contrato do evento `LancamentoRegistrado`

O contrato completo, o histórico de versões (1.0 e 1.1) e a política de versionamento estão em [eventos.md](eventos.md).
