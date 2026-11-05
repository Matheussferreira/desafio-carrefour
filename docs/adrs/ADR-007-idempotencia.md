# ADR-007: Estratégia de Idempotência em Duas Camadas

**Status:** Aceito  
**Data:** 2026-06-24

---

## Contexto

O sistema opera com duas fronteiras onde o mesmo dado pode chegar mais de uma vez:

1. **Fronteira HTTP:** O cliente que faz `POST /lancamentos` pode reenviar a requisição após um timeout de rede, sem saber se a original foi processada.
2. **Fronteira AMQP:** O RabbitMQ entrega mensagens com semântica *at-least-once*. O consumer pode receber e processar uma mensagem, mas o processo pode morrer antes de executar o `channel.ack()`, causando reentrega pelo broker.

Sem proteção em ambas as fronteiras, o sistema produz saldos incorretos, um crédito de R$ 1.500,00 processado duas vezes geraria R$ 3.000,00 no saldo.

---

## Decisão

Implementar **idempotência em duas camadas independentes**, cada uma protegendo sua fronteira específica:

- **Camada 1, HTTP:** `X-Idempotency-Key` header + verificação dentro da transação de banco
- **Camada 2, Consumer:** tabela `eventos_processados` com `ON CONFLICT DO NOTHING` dentro da mesma transação que atualiza o saldo

---

## Camada 1: Idempotência HTTP (Lançamentos)

### Problema

O cliente faz `POST /lancamentos`, a rede cai, e o cliente não sabe se o servidor processou. Ele reenvia. Sem proteção, dois lançamentos idênticos são inseridos.

### Implementação

O cliente pode enviar um header `X-Idempotency-Key` (1 a 255 caracteres) com um valor único por intenção de operação. A chave vale **por comerciante** (`UNIQUE (comerciante_id, idempotency_key)`), e a tabela guarda também um hash do corpo (`request_hash`). O servidor:

```
BEGIN TRANSACTION
  INSERT INTO lancamentos (comerciante_id, ..., idempotency_key, request_hash)
  ON CONFLICT (comerciante_id, idempotency_key) DO NOTHING
  → se inseriu: INSERT INTO outbox (...), COMMIT, retorna 201
  → se houve conflito: SELECT do lançamento existente, COMMIT
      → mesmo hash do corpo: retorna 200 com o original (cabeçalho Idempotent-Replayed: true)
      → hash diferente:      retorna 409 (chave reutilizada com outro conteúdo)
```

Quem resolve a corrida entre dois pedidos simultâneos com a mesma chave é a constraint única: o `ON CONFLICT DO NOTHING` faz o segundo pedido não inserir e cair no ramo de conflito, sem exceção e sem tratar o código `23505`.

### Comportamento observável

| Cenário | Comportamento |
|---|---|
| Primeira chamada | 201 Created com o lançamento criado |
| Segunda chamada, mesma `X-Idempotency-Key` e mesmo corpo | 200 OK com o mesmo lançamento, sem segundo INSERT |
| Mesma `X-Idempotency-Key` com corpo diferente | 409 Conflict (`problem+json`) |
| Duas chamadas simultâneas, mesma chave e mesmo corpo | Uma recebe 201, a outra 200, sem duplicata no banco |
| Sem header `X-Idempotency-Key` | Sem proteção HTTP; cada request cria um lançamento novo |

**Nota:** A ausência de `X-Idempotency-Key` não é um erro, é explicitamente suportada para clientes que gerem garantias de entrega de outra forma. A chave é opcional por design.

---

## Camada 2: Idempotência do Consumer (Consolidado)

### Problema

O broker entrega a mensagem. O consumer processa e persiste o saldo no banco, mas o processo morre antes de executar `channel.ack()`. O broker, sem confirmação, reenvia a mesma mensagem. Sem proteção, o saldo é incrementado duas vezes pelo mesmo lançamento.

### Implementação

A tabela `eventos_processados(evento_id PRIMARY KEY)` registra cada `eventoId` processado. O processamento ocorre em uma única transação:

```sql
BEGIN;
  -- Tentativa de registrar o evento
  INSERT INTO eventos_processados (evento_id)
  VALUES ($1)
  ON CONFLICT (evento_id) DO NOTHING;
  
  -- rowCount = 0 → evento já estava registrado → ROLLBACK + ACK (skip silencioso)
  -- rowCount = 1 → evento novo → continua

  -- Upsert atômico: nunca lê e reescreve, delega o cálculo ao banco
  INSERT INTO saldo_diario (comerciante_id, data, total_creditos, total_debitos, saldo, updated_at)
  VALUES ($1, $2, $3, $4, $5, now())
  ON CONFLICT (comerciante_id, data) DO UPDATE SET
    total_creditos = saldo_diario.total_creditos + EXCLUDED.total_creditos,
    total_debitos  = saldo_diario.total_debitos  + EXCLUDED.total_debitos,
    saldo          = saldo_diario.saldo          + EXCLUDED.saldo,
    updated_at     = now();

COMMIT;
```

A atomicidade da transação é fundamental: se o processo morrer entre o INSERT em `eventos_processados` e o COMMIT, ambas as operações são revertidas. Quando a mensagem for reenviada, a transação tentará novamente com sucesso, sem duplicata e sem dado inconsistente.

### Comportamento observável

| Cenário | Comportamento |
|---|---|
| Primeira entrega do evento | `eventos_processados` rowCount=1 → saldo atualizado → ACK |
| Segunda entrega (redelivery) | `eventos_processados` rowCount=0 → ROLLBACK → ACK silencioso (`skipped`) |
| Crash após COMMIT, antes do ACK | Broker reenvia → segunda tentativa encontra `evento_id` na tabela → skip + ACK |

O `eventsProcessedTotal` counter distingue `status: processed` e `status: skipped` para observabilidade da taxa de duplicatas.

---

## Alternativas Descartadas

### Idempotência HTTP via status code apenas

Usar apenas o código de resposta (201 vs 409 Conflict) sem armazenar a chave de idempotência.

**Descartado:** Com 409 para todo reenvio, o cliente sabe que houve colisão mas não recebe o dado original, o que obriga um GET subsequente. A convenção de retornar 200 com o registro original para o mesmo corpo é mais ergonômica e segue o padrão do Stripe (referência de facto para APIs de pagamento). O 409 ficou reservado para o caso em que a mesma chave chega com outro corpo, que é um erro do cliente.

### Idempotência do consumer via hash do payload

Em vez de usar `evento_id`, usar um hash do payload (`SHA256(payload)`) como chave de idempotência.

**Descartado:** O `evento_id` é gerado pelo produtor (UUID v4) e é único por intenção. Um hash do payload falharia se dois lançamentos legítimos tivessem exatamente os mesmos campos (ex: R$ 100,00 de crédito na mesma data). O `evento_id` não tem esse problema, é único por design, independente do conteúdo.

### Idempotência do consumer via lock pessimista (SELECT FOR UPDATE)

Adquirir um lock na linha de saldo antes de ler e atualizar.

**Descartado:** O `ON CONFLICT DO UPDATE SET saldo = saldo_diario.saldo + delta` é um upsert atômico que não requer lock explícito, o banco garante a atomicidade internamente. Um lock pessimista serializa todos os consumidores desnecessariamente; o upsert funciona corretamente sob múltiplas réplicas do consumer sem lock.

### Idempotência do consumer via Redis (SET NX)

Usar `SET eventoId NX EX 3600` no Redis como lock distribuído antes de processar.

**Descartado:** Introduz uma dependência de disponibilidade do Redis no caminho crítico do consumer. Se o Redis ficar indisponível, o consumer não pode processar nenhuma mensagem, degradação de disponibilidade total em vez de eventual. A tabela `eventos_processados` no Postgres transacional é mais robusta: mesma disponibilidade do banco onde o saldo está sendo atualizado.

---

## Consequências

**Positivas:**
- Idempotência garantida end-to-end: do request HTTP até o saldo persistido no banco
- O consumer pode processar a mesma mensagem quantas vezes for entregue pelo broker sem efeito colateral
- Sem lock explícito: o upsert atômico permite N réplicas do consumer rodando em paralelo
- `eventos_processados` serve como auditoria de todos os eventos que afetaram o saldo

**Negativas:**
- A tabela `eventos_processados` cresce indefinidamente, precisa de política de retenção em produção (particionamento ou archival após N dias)
- O `X-Idempotency-Key` é optional no endpoint; clientes que não o enviem não têm proteção contra retries na camada HTTP
- A corrida entre pedidos concorrentes com a mesma chave é resolvida pela constraint única do banco, não por isolamento SERIALIZABLE, o que evita o custo de serializar toda a tabela
