# ADR-003: RabbitMQ vs. Kafka vs. Pub/Sub

**Status:** Aceito  
**Data:** 2026-06-24 (revisado em 2026-11-05)

---

## Contexto

Escolha do message broker para comunicação assíncrona entre Lançamentos e Consolidado.

Parâmetros do sistema:
- Volume: ~50 req/s de pico (≈ 4,3 milhões de mensagens/dia)
- Tamanho da mensagem: < 1 KB
- Padrão de consumo: um único consumer group, sem necessidade de replay
- Restrição operacional: deve rodar em `docker compose up` sem conta em cloud
- Nuvem alvo de produção: Google Cloud (revisão de 2026-11-05)

---

## Decisão

RabbitMQ 3.13 com topic exchange, fila durável com DLX configurada, para desenvolvimento, testes e como implementação de referência. Em produção no Google Cloud o broker é o **Pub/Sub**, decidido no [ADR-012](ADR-012-broker-em-producao-no-gcp.md). O RabbitMQ no GKE fica como plano B, porque o código de hoje o suporta sem alteração.

---

## Alternativas Descartadas

### Kafka (descartado: volume não justifica)

Kafka é projetado para volumes de 100k a 1M+ msg/s com múltiplos consumer groups independentes e necessidade de replay histórico. A 50 req/s, Kafka estaria operando a menos de 0,05% da sua capacidade mínima.

Custo real de usar Kafka aqui:
- Setup local: ZooKeeper ou KRaft + broker, ~500MB de RAM mínimo vs ~80MB do RabbitMQ
- Operacionalmente mais complexo: partições, offsets, consumer groups precisam de tuning para baixo volume
- DLQ não é nativa: requer tópico separado e lógica explícita de roteamento
- Experiência de debugging pior a esse volume (lag de consumer é menos intuitivo que fila simples)

Quando Kafka passaria a fazer sentido neste sistema:

| Trigger | Threshold aproximado |
|---|---|
| Volume de mensagens | Acima de ~5.000 msg/s sustentado, onde o RabbitMQ começaria a ser gargalo de CPU/memória |
| Replay de eventos | Qualquer requisito de reconstruir projeções históricas (ex: novo serviço que precisa ler eventos dos últimos 90 dias) |
| Múltiplos consumers independentes | Se houvesse 3+ serviços consumindo o mesmo evento com velocidades diferentes e sem coordenação |
| Auditoria imutável | Requisito de log imutável de todas as transações para compliance/auditoria |
| Event Sourcing | Se o saldo fosse derivado de uma sequência de eventos em vez de um upsert acumulado |

Nenhum desses triggers existe neste sistema. Usar Kafka aqui seria otimizar para um problema que não existe.

### Google Pub/Sub (descartado como padrão local; escolhido para produção no ADR-012)

Por que não é o broker do ambiente local:
- Não roda em `docker compose up` sem o emulador do Google, que é uma imagem à parte, não tem interface de gerenciamento e se comporta de forma diferente do serviço real em detalhes como prazo de confirmação e política de mensagens mortas.
- Prenderia o desenvolvimento e os testes a uma biblioteca de uma nuvem específica.
- Não há fila para "ver" como no painel do RabbitMQ, o que atrapalha o debug.

Por que é a escolha de produção no Google Cloud: é gerenciado, regional, com replicação entre zonas, sem cluster para operar, e a cobrança é por volume de dados (este sistema cabe na franquia gratuita). Mensagem de menos de 1 KB, um único consumidor e entrega pelo menos uma vez casam com o modelo. O preço é escrever e testar um adaptador: o código de hoje só fala AMQP. O que muda, o que continua valendo (outbox, confirmação, consumidor idempotente) e o que é preciso ter cuidado (tópico sem assinatura descarta; contagem de tentativas na DLQ) está no ADR-012.

Quando seria a escolha também no local: se a equipe adotar o emulador como padrão e o conjunto de testes rodar nos dois adaptadores.

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

Positivas:
- Setup trivial no compose, management UI facilita observabilidade durante desenvolvimento
- Semântica de fila durável + ACK/NACK é exatamente o que o padrão Outbox requer

Negativas:
- Sem replay nativo: mensagens consumidas são descartadas (mitigado pelo Outbox que preserva no banco)
- Single-node neste setup: sem clustering, sem quorum queues; mensagens não replicadas são perdidas se o broker morrer antes de serem consumidas (ver decisões de produção no README)
- Se o volume crescer para dezenas de milhares de req/s, migrar para Kafka (no Google Cloud, o Managed Service for Apache Kafka) seria necessário
- O broker de produção (Pub/Sub) não é o broker dos testes: ver as consequências no ADR-012
