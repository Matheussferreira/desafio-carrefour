# ADR-002: Comunicação Assíncrona via Message Broker

**Status:** Aceito  
**Data:** 2026-06-24

## Contexto

O Lançamentos precisa notificar o Consolidado sempre que um novo lançamento é registrado, sem criar dependência de disponibilidade entre eles.

## Decisão

Comunicação **assíncrona** via RabbitMQ. O Lançamentos publica `LancamentoRegistrado`; o Consolidado consome. Não há chamada HTTP síncrona entre os serviços no caminho crítico.

## Alternativas consideradas

### Chamada HTTP síncrona (REST)
Após gravar o lançamento, o serviço faz `POST http://consolidado/eventos`.

Por que foi descartado:  
Cria acoplamento de disponibilidade, exatamente o que o requisito proíbe. Se o Consolidado estiver lento ou fora, o request ao Lançamentos travaria ou falharia.

### HTTP com circuit breaker (opossum)
Chamada síncrona protegida: abre o circuito se o Consolidado falhar, ignorando a atualização.

Por que foi descartado:  
Com o circuito aberto, os lançamentos feitos durante a falha nunca chegam ao Consolidado: perda de dados. Um reprocessamento manual seria necessário.

### gRPC assíncrono (streaming)
Protocolo binário, mais eficiente.

Por que foi descartado:  
Overhead de configuração (TLS, protobuf, codegen) injustificado para 50 req/s. O broker resolve durabilidade, buffering e redelivery de graça.

## Consequências

Positivas:
- Lançamentos nunca bloqueia no caminho crítico
- Eventos se acumulam na fila enquanto o Consolidado estiver fora; zero perda
- Natural suporte a múltiplos consumidores futuros (ex: serviço de notificações)

Negativas:
- Consistência eventual: o saldo pode estar desatualizado por alguns segundos
- Complexidade de observabilidade: monitorar filas, DLQ, lag de consumo
- Necessidade de idempotência explícita no consumidor
