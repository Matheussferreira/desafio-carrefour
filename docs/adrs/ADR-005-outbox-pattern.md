# ADR-005: Outbox Pattern para Publicação Confiável de Eventos

**Status:** Aceito  
**Data:** 2026-06-24

## Contexto

Ao registrar um lançamento, precisamos garantir que o evento `LancamentoRegistrado` **nunca se perde**, mesmo que o RabbitMQ esteja temporariamente indisponível no momento do registro.

## Problema sem o Outbox

```
1. INSERT INTO lancamentos → OK
2. Publish to RabbitMQ    → FALHA (broker caiu 1ms antes)
   → Lançamento gravado, evento perdido para sempre
```

Ou o oposto:
```
1. Publish to RabbitMQ → OK
2. INSERT INTO lancamentos → FALHA
   → Evento publicado sem dado no banco
```

## Decisão

**Outbox Pattern:** gravar o lançamento e o evento na **mesma transação** de banco de dados. Um processo relay lê os eventos pendentes e os publica no broker.

```
Transação ACID:
  INSERT INTO lancamentos (...)
  INSERT INTO outbox (id, tipo_evento, payload, status='pendente')
  COMMIT  ← se falhar aqui, ambos são desfeitos

Relay (processo lancamentos-relay, a cada 1s):
  BEGIN
  SELECT ... FROM outbox WHERE status='pendente' LIMIT 50 FOR UPDATE SKIP LOCKED
  → publish no RabbitMQ (ConfirmChannel) e aguarda o ack de cada mensagem
  → UPDATE outbox SET status='publicado'
  COMMIT  ← qualquer falha antes daqui desfaz tudo e as linhas continuam pendentes
```

## Alternativas

### Publicar diretamente após o INSERT
Sem outbox, publicação inline.  
**Descartado:** Cria a janela de inconsistência descrita acima. Não há como tornar atômico o INSERT no Postgres e o publish no RabbitMQ (são dois sistemas distintos sem XA transaction).

### Saga Pattern com compensação
Publicar o evento, e se a gravação falhar, publicar um evento de compensação.  
**Descartado:** Complexidade alta. Difícil de debugar. O Outbox é mais simples e suficiente para este volume.

### CDC com Debezium
Capturar as mudanças no WAL do Postgres e publicar automaticamente.  
**Descartado para agora:** Adiciona Kafka Connect + Debezium ao stack, tornando o ambiente local mais pesado. Seria a evolução natural do Outbox para produção em alta escala (ver evoluções futuras no README).

## Consequências

**Positivas:**
- Garantia **at-least-once**: o evento sempre chega ao broker, mesmo após falhas do broker
- O relay pode retentar indefinidamente sem perder eventos
- A tabela `outbox` serve como auditoria de todos os eventos publicados

**Negativas:**
- Latência adicional: o evento chega ao broker com delay de até `outbox_interval_ms` (padrão 1s)
- O relay precisa rodar continuamente; roda como processo próprio (ver ADR-008)
- Possibilidade de duplicatas: se o relay publicar e cair antes de marcar como publicado, o evento será publicado de novo na próxima execução, e por isso o consumidor deve ser idempotente (e é, via `eventos_processados`)
