# ADR-003: RabbitMQ vs. Kafka vs. SQS

**Status:** Aceito  
**Data:** 2026-06-24

---

## Contexto

Escolha do message broker para comunicação assíncrona entre Lançamentos e Consolidado.

Parâmetros do sistema:
- Volume: ~50 req/s de pico (≈ 4,3 milhões de mensagens/dia)
- Tamanho da mensagem: < 1 KB
- Padrão de consumo: um único consumer group, sem necessidade de replay
- Restrição operacional: deve rodar em `docker compose up` sem conta em cloud

---

## Decisão

**RabbitMQ 3.13** com topic exchange, fila durável com DLX configurada.

---

## Alternativas Descartadas

### Kafka (descartado: volume não justifica)

Kafka é projetado para volumes de 100k a 1M+ msg/s com múltiplos consumer groups independentes e necessidade de replay histórico. A 50 req/s, Kafka estaria operando a menos de 0,05% da sua capacidade mínima.

**Custo real de usar Kafka aqui:**
- Setup local: ZooKeeper ou KRaft + broker, ~500MB de RAM mínimo vs ~80MB do RabbitMQ
- Operacionalmente mais complexo: partições, offsets, consumer groups precisam de tuning para baixo volume
- DLQ não é nativa: requer tópico separado e lógica explícita de roteamento
- Experiência de debugging pior a esse volume (lag de consumer é menos intuitivo que fila simples)

**Quando Kafka passaria a fazer sentido neste sistema:**

| Trigger | Threshold aproximado |
|---|---|
| Volume de mensagens | Acima de ~5.000 msg/s sustentado, onde o RabbitMQ começaria a ser gargalo de CPU/memória |
| Replay de eventos | Qualquer requisito de reconstruir projeções históricas (ex: novo serviço que precisa ler eventos dos últimos 90 dias) |
| Múltiplos consumers independentes | Se houvesse 3+ serviços consumindo o mesmo evento com velocidades diferentes e sem coordenação |
| Auditoria imutável | Requisito de log imutável de todas as transações para compliance/auditoria |
| Event Sourcing | Se o saldo fosse derivado de uma sequência de eventos em vez de um upsert acumulado |

Nenhum desses triggers existe neste sistema. Usar Kafka aqui seria otimizar para um problema que não existe.

### Amazon SQS + SNS (descartado: vendor lock-in e sem local)

**Por que foi descartado:**
- Sem suporte local sem LocalStack, que adiciona complexidade ao `docker compose up` e divergência entre ambientes
- Polling mínimo de ~1s adiciona latência desnecessária para um consumer que deve ser quasi-realtime
- Vendor lock-in: o sistema ficaria acoplado à AWS sem nenhum ganho funcional a esse volume
- Sem management UI local para debugging

**Quando SQS/SNS seria a escolha correta:** Em um sistema já hospedado na AWS onde a equipe quer eliminar a operação do broker. Nesse caso, SQS para filas simples e SNS+SQS para fan-out são escolhas sólidas: o managed service elimina o custo operacional do Kafka/RabbitMQ. A escolha entre broker self-hosted e SQS é principalmente operacional, não técnica.

### Redis Streams (descartado: Redis já é cache aqui)

Redis Streams pode fazer o papel de broker simples. Descartado porque: não há uma imagem unificada de "Redis como broker + Redis como cache" que seja operacionalmente mais simples que RabbitMQ separado. A semântica de consumer groups do Redis Streams é menos madura para casos de DLQ/redelivery.

---

## Por que RabbitMQ

- A 50 req/s, usa < 1% da capacidade de um RabbitMQ em hardware modesto
- Push-based: broker empurra mensagem para o consumer, latência de entrega < 5ms
- DLX (`x-dead-letter-exchange`) é nativa: mensagens rejeitadas vão automaticamente para a DLQ
- `rabbitmq:3.13-management-alpine` roda em ~80MB de RAM com management UI em `:15672`
- `amqplib` é a biblioteca Node.js mais estável para AMQP 0-9-1

---

## Consequências

**Positivas:**
- Setup trivial no compose, management UI facilita observabilidade durante desenvolvimento
- Semântica de fila durável + ACK/NACK é exatamente o que o padrão Outbox requer

**Negativas:**
- Sem replay nativo: mensagens consumidas são descartadas (mitigado pelo Outbox que preserva no banco)
- Single-node neste setup: sem clustering, sem quorum queues; mensagens não replicadas são perdidas se o broker morrer antes de serem consumidas (ver decisões de produção no README)
- Se o volume crescer para dezenas de milhares de req/s, migrar para Kafka (na AWS, o Amazon MSK) seria necessário
