# Arquitetura do Sistema

## C4, nível 1: Contexto

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

## C4, nível 2: Containers

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
    Container(keycloak, "Keycloak", "Keycloak 26", "Provedor OIDC: emite tokens (client credentials) e publica o JWKS")

    Rel(comerciante, keycloak, "Obtém token (client_id + secret)", "HTTPS")
    Rel(comerciante, lancamentos, "POST /lancamentos, GET /lancamentos (Bearer)", "HTTPS")
    Rel(comerciante, consolidado, "GET /consolidado/{data} (Bearer)", "HTTPS")
    Rel(lancamentos, keycloak, "Busca o JWKS (cache; só na 1ª vez e ao girar a chave)", "HTTP")
    Rel(consolidado, keycloak, "Busca o JWKS (cache; só na 1ª vez e ao girar a chave)", "HTTP")
    Rel(lancamentos, pg_l, "Lê/Escreve", "SQL")
    Rel(lancamentos, mq, "Publica LancamentoRegistrado (via Outbox Relay)", "AMQP")
    Rel(consolidado, mq, "Consome LancamentoRegistrado; NACK → DLX → DLQ", "AMQP")
    Rel(consolidado, pg_c, "Upsert saldo_diario, INSERT eventos_processados", "SQL")
    Rel(consolidado, redis, "GET/SET saldo:e{epoca}:{comerciante}:v{versao}:{data}, INCR saldo:ver:{comerciante}, INCR saldo:epoca na reconexão", "Redis protocol")
```

---

## C4, nível 3: Componentes do Serviço Lancamentos

```mermaid
C4Component
    title Componentes do Serviço Lancamentos

    Container_Boundary(svc, "Serviço Lancamentos") {
        Component(api, "API Routes", "Express Router", "POST /lancamentos (idempotência via X-Idempotency-Key), GET /lancamentos")
        Component(auth, "Auth Middleware", "jose", "Valida JWT RS256 pelo JWKS do Keycloak (iss, aud, exp), exige escopo por rota e comerciante_id do token")
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

## C4, nível 3: Componentes do Serviço Consolidado

```mermaid
C4Component
    title Componentes do Serviço Consolidado

    Container_Boundary(svc, "Serviço Consolidado") {
        Component(api_c, "API Routes", "Express Router", "GET /consolidado/{data} com cache-aside e fallback DB")
        Component(auth_c, "Auth Middleware", "jose", "Valida JWT RS256 pelo JWKS do Keycloak (iss, aud, exp), exige escopo por rota e comerciante_id do token")
        Component(consumer, "Consumer", "amqplib + withRetry", "prefetch=1; erro permanente: 1 tentativa inicial + 3 retries com backoff 1s/2s/4s e NACK sem requeue para a DLQ; falha de banco ou conexão: mensagem retida com espera crescente (1s a 15s) até o banco voltar, sem DLQ")
        Component(retry, "withRetry", "utility pura", "Executa fn até maxRetries+1 vezes; onRetry callback por cada falha intermediária; retorna Result discriminado")
        Component(db_c, "DB Pool", "node-postgres", "Pool para consolidado_db; transações para INSERT eventos_processados + UPSERT saldo_diario")
        Component(redis_c, "Redis Client", "ioredis", "GET saldo:e{epoca}:{comerciante}:v{versao}:{data} → hit retorna JSON; miss → query DB → SETEX 60s; após cada evento incrementa a versão do comerciante; na reconexão incrementa a época global")
        Component(rmq_c, "RabbitMQ Client", "amqplib", "assertExchange + assertQueue + bindQueue; DLX configurado via x-dead-letter-exchange; prefetch=1")
        Component(metrics_c, "Métricas", "prom-client", "consolidado_http_requests_total, consolidado_events_processed_total por tipo e status, consolidado_consumer_retries_total, consolidado_consumer_dlq_total, consolidado_evento_lag_seconds")
    }

    Rel(api_c, auth_c, "Passa por antes de qualquer lógica de negócio")
    Rel(api_c, redis_c, "GET saldo:e{epoca}:{comerciante}:v{versao}:{data}")
    Rel(api_c, db_c, "Fallback: soma de saldo_diario do comerciante até a data")
    Rel(consumer, retry, "withRetry(() => processEvent(raw), 3, [1000,2000,4000])")
    Rel(retry, db_c, "BEGIN → INSERT eventos_processados (ON CONFLICT DO NOTHING) → UPSERT saldo_diario → COMMIT")
    Rel(retry, redis_c, "INCR da versão do comerciante após o COMMIT (falha não-fatal)")
    Rel(consumer, rmq_c, "ACK em sucesso ou skip; NACK(false,false) após esgotar retries → DLQ via DLX")
```

---

## Diagrama de Sequência: Fluxo Feliz

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

    Note over L: O processo lancamentos-relay repete o ciclo a cada 1s (sem pausa se o lote vier cheio)

    L->>DB_L: BEGIN, SELECT outbox WHERE status=pendente ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED
    L->>RMQ: channel.publish(exchange, routingKey, payload, {persistent:true, mandatory:true, messageId:eventoId})
    RMQ-->>L: confirmação (ack) de cada mensagem
    L->>DB_L: UPDATE outbox SET status=publicado WHERE id = ANY(lote), COMMIT

    RMQ->>CONS: Deliver LancamentoRegistrado (prefetch=1)
    CONS->>DB_C: BEGIN TRANSACTION
    CONS->>DB_C: INSERT eventos_processados (eventoId) ON CONFLICT DO NOTHING
    Note over DB_C: rowCount=1 → evento novo, rowCount=0 → já processado, skip + ACK
    CONS->>DB_C: UPSERT saldo_diario (comerciante, data) SET saldo = saldo_diario.saldo + delta, UPSERT comerciante_progresso
    CONS->>DB_C: COMMIT
    CONS->>REDIS: INCR saldo:ver:{comerciante} (invalida o cache do comerciante)
    CONS->>RMQ: channel.ack(msg)

    C->>CONS: GET /consolidado/2026-06-24
    CONS->>REDIS: GET saldo:loja-7:v{versao}:2026-06-24
    alt cache hit
        REDIS-->>CONS: JSON {totalCreditos, totalDebitos, resultadoDia, saldoAcumulado}
    else cache miss
        CONS->>DB_C: SELECT somas FROM saldo_diario WHERE comerciante_id=$1 AND data <= $2
        DB_C-->>CONS: row
        CONS->>REDIS: SETEX saldo:loja-7:v{versao}:2026-06-24 60
    end
    CONS-->>C: 200 {totalCreditos, totalDebitos, resultadoDia, saldoAcumulado, ultimoEventoAplicadoEm, source}
```

---

## Diagrama de Sequência: Fluxo de Falha (Retry + DLQ)

Este diagrama mostra o caminho de uma mensagem cujo processamento falha com um **erro permanente** (um erro que não é de conexão nem de disponibilidade do banco, coberto por `dlq.test.ts`). Falha de banco ou de conexão é diferente: a mensagem fica retida até o banco voltar e não chega à DLQ ([ADR-011](adrs/ADR-011-falha-transitoria-nao-vai-para-dlq.md)). Uma mensagem malformada (JSON inválido ou fora do contrato) também é diferente: vai direto para a DLQ, sem retentativas.

```mermaid
sequenceDiagram
    participant RMQ as RabbitMQ
    participant CONS as Consumer
    participant DLX as lancamentos.events.dlx
    participant DLQ as consolidado.lancamentos.dlq

    RMQ->>CONS: Deliver mensagem (payload inválido)

    Note over CONS: Tentativa inicial (attempt=0)
    CONS->>CONS: processEvent() → lança exceção
    CONS->>CONS: onRetry(err, attempt=1), consumer_retries_total +1
    CONS->>CONS: aguarda 1 000 ms

    Note over CONS: Retry 1 (attempt=1)
    CONS->>CONS: processEvent() → lança exceção
    CONS->>CONS: onRetry(err, attempt=2), consumer_retries_total +1
    CONS->>CONS: aguarda 2 000 ms

    Note over CONS: Retry 2 (attempt=2)
    CONS->>CONS: processEvent() → lança exceção
    CONS->>CONS: onRetry(err, attempt=3), consumer_retries_total +1
    CONS->>CONS: aguarda 4 000 ms

    Note over CONS: Retry 3 (attempt=3), última tentativa
    CONS->>CONS: processEvent() → lança exceção
    Note over CONS: withRetry retorna {ok:false}<br/>consumer_dlq_total +1

    CONS->>RMQ: channel.nack(msg, false, false)
    Note over RMQ: requeue=false → mensagem descartada da fila principal<br/>x-dead-letter-exchange roteia para DLX

    RMQ->>DLX: roteia via DLX com routing key original
    DLX->>DLQ: mensagem chega na DLQ (durável)

    Note over DLQ: Disponível para inspeção manual,<br/>replay ou descarte via management UI ou API
```

**Resumo do comportamento:**
- 4 chamadas a `processEvent` no total (1 inicial + 3 retries)
- 3 incrementos em `consolidado_consumer_retries_total` (um por callback de retry)
- 1 incremento em `consolidado_consumer_dlq_total`
- Tempo mínimo antes do NACK: 1 000 + 2 000 + 4 000 = **7 segundos** (mais tempo de execução das 4 tentativas)

---

## Cenários de falha

O que acontece quando cada peça falha, o que limita o dano e qual teste prova o comportamento. "Lacuna" significa que o comportamento vem do código e da análise, sem teste automatizado dedicado. Os cenários de resiliência (A a E) rodam contra a stack real com `tests/resiliencia`.

| Cenário | Comportamento | Mitigação | O que prova |
|---|---|---|---|
| Consolidado fora do ar | `POST /lancamentos` continua respondendo 201. Os eventos se acumulam na fila `consolidado.lancamentos`. Ao voltar, o consumidor drena e o saldo converge | Processos, bancos e filas separados; broker durável | `tests/resiliencia`, cenário A: 30 de 30 lançamentos aceitos e saldo convergindo na volta |
| Broker (RabbitMQ) fora do ar | Lançamentos segue aceitando (201) e `/ready` da API continua 200, porque a API só depende do banco. O outbox acumula e o relay reconecta com backoff de teto 5 s; na volta, drena | Outbox transacional; relay em processo separado; `ConfirmChannel` e `mandatory` | `tests/resiliencia`, cenário B; `relay.test.ts` (sem confirmação e sem rota mantêm o evento pendente); `reconexao.test.ts` (o consumidor retoma sozinho) |
| Redis fora do ar | O consolidado **segue pronto**: `/ready` depende só do PostgreSQL e do broker. As leituras caem para o banco (`source: "database"`) sem esperar reconexão (o cliente do Redis não tem fila offline e tem tempo máximo por comando) e o processamento dos eventos continua. Os eventos aplicados sem o Redis não avançam a versão do cache, mas a reconexão do cliente avança a **época** global, que faz parte da chave: nenhuma entrada gravada antes da queda é lida depois da volta | Redis fora do `/ready`; cache-aside com fallback; falha de cache tratada como não fatal; época do cache na chave | `tests/resiliencia` cenário C (`/ready` 200, GET 200 do banco em menos de 3 s, eventos aplicados, cache convergindo em menos de 5 s depois da volta); `redis-fora.test.ts` (inclusive a subida da época na reconexão) |
| Banco do consolidado fora do ar | A API de leitura responde 5xx e `/ready` fica 503. O consumidor **retém a mensagem** (sem `ack` nem `nack`) e tenta de novo com espera crescente (1 s a 15 s) até o banco voltar, então **nada vai para a DLQ** e o saldo converge sozinho depois. Lançamentos não é afetado ([ADR-011](adrs/ADR-011-falha-transitoria-nao-vai-para-dlq.md)) | Classificação de erro transitório; retenção em vez de DLQ; métrica `consolidado_consumer_transient_errors_total` | `tests/resiliencia` cenário D (banco do consolidado bloqueado por 30 s, lançamentos 201, fila retém, DLQ sem mensagens novas, saldo converge); `dlq.test.ts` (banco bloqueado de verdade e erro simulado); `erro-transitorio.test.ts` |
| Banco de lançamentos fora do ar | `POST /lancamentos` falha e `/ready` da API fica 503. É a única dependência que o RNF não cobre, por isso o Cloud SQL usa alta disponibilidade regional. O relay não consegue ler o outbox e tenta de novo | Cloud SQL com HA regional e failover automático | **Lacuna** em teste automatizado; o 5xx e o `/ready` vêm do código |
| Evento duplicado | O mesmo `eventoId` altera o saldo uma única vez. Acontece por reentrega do broker ou por falha depois do ack do broker e antes do `COMMIT` do relay | `eventos_processados` com `ON CONFLICT DO NOTHING` na mesma transação do saldo; várias instâncias do relay usam `SKIP LOCKED` | `idempotencia-cache.test.ts` (entregue duas vezes, soma uma); `relay.test.ts` (várias instâncias publicam cada evento uma vez) |
| Evento fora de ordem | O saldo é uma soma, então a ordem não altera o resultado. Um lançamento retroativo corrige o acumulado das datas seguintes. `ultimoEventoAplicadoEm` guarda o maior instante aplicado | Upsert aditivo; cache versionado por comerciante (a versão avança depois do commit) | `saldo-comerciantes.test.ts` (lançamento retroativo; `ultimoEventoAplicadoEm` com eventos fora de ordem; corrida de gravação atrasada no cache) |
| Evento inválido, de versão incompatível ou com erro permanente | Vai para a DLQ: o JSON quebrado e o contrato inválido direto, sem retentativa; um erro permanente de processamento depois de 3 retentativas (1 s, 2 s e 4 s). Evento de outro tipo é reconhecido e ignorado. A DLQ passa a significar "precisa de uma pessoa" e o reprocessamento é por `scripts/reprocessar-dlq` | Contrato versionado ([eventos.md](eventos.md)); `scripts/reprocessar-dlq.ps1` e `.sh` | `dlq.test.ts` (malformado, versão 2.x e erro permanente); `evento-versoes.test.ts`; `tests/resiliencia` cenário E (a mensagem válida volta e é aplicada; a quebrada volta para a DLQ) |
| Provedor de identidade (Keycloak) fora | Tokens já emitidos continuam valendo até expirar (até 300 s) porque a chave pública fica em cache. Sem cache e sem JWKS, a API responde 503, não 401 | JWKS em cache; validação local | `seguranca.test.ts` (503 quando o JWKS cai; a chave em cache continua valendo) |
| Pico acima de 50 req/s | Até 6.000 req/min por IP o consolidado atende; acima disso recebe 429 com `Retry-After`, sem 5xx. No pico de 200 req/s medido, uma instância respondeu cerca de 197 a 199 req/s | Cache Redis, rate limit, escala horizontal ([dimensionamento.md](dimensionamento.md)) | `tests/load/consolidado.js` (pico: só 200 e 429, sem 5xx) e `limite-429.js` (429 com `Retry-After`, determinístico). O rate limit é em memória por instância |

---

## Contrato do evento `LancamentoRegistrado`

O contrato completo, o histórico de versões (1.0 e 1.1) e a política de versionamento estão em [eventos.md](eventos.md).
