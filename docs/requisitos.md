# Requisitos do Sistema

## Premissa de Fuso Horário

O "dia" de um lançamento é determinado **exclusivamente pelo campo `data` informado pelo cliente**, nunca pelo horário de processamento do evento ou pelo relógio do servidor. O fuso de negócio é **America/Sao_Paulo (UTC-3)**. Todos os containers têm a variável `TZ=America/Sao_Paulo`.

---

## Requisitos Funcionais

### Serviço de Lançamentos

| # | Requisito |
|---|---|
| RF-01 | Registrar um lançamento (débito ou crédito) com valor, tipo, descrição opcional e data de competência |
| RF-02 | Validar que `valor` é uma string decimal positiva com até 2 casas e no máximo 999999999.99, que `tipo` é `credito` ou `debito`, e que `data` é uma data real no formato YYYY-MM-DD. Qualquer violação é 400 com `application/problem+json` |
| RF-03 | Suportar chave de idempotência via header `X-Idempotency-Key` (opcional; sem ela, cada request cria um lançamento). Mesma chave com o mesmo corpo devolve o lançamento original (200); com corpo diferente devolve 409 |
| RF-04 | Listar lançamentos com filtro opcional por data de competência |
| RF-05 | Publicar o evento `LancamentoRegistrado` no broker de forma confiável: o evento é gravado na mesma transação do lançamento (Outbox Pattern), garantindo zero perda mesmo que o broker esteja temporariamente indisponível |

### Serviço de Consolidado

| # | Requisito |
|---|---|
| RF-06 | Consumir `LancamentoRegistrado` e atualizar a projeção de saldo diário com upsert atômico (`ON CONFLICT DO UPDATE SET saldo = saldo + delta`) |
| RF-07 | Garantir idempotência: o mesmo `eventoId` nunca altera o saldo duas vezes, independente de quantas vezes o broker o entregue |
| RF-08 | Retornar, para um comerciante e uma data: `totalCreditos`, `totalDebitos`, `resultadoDia`, `saldoAcumulado` (soma de todos os dias até a data) e `ultimoEventoAplicadoEm` (o maior `createdAt` aplicado, que indica atraso mas não garante completude com eventos fora de ordem). Dia sem movimento responde 200 com zeros no dia e o acumulado vigente |
| RF-10 | Consultar um intervalo de datas (`GET /consolidado?inicio=&fim=`), com um item por dia e limite de 92 dias |
| RF-11 | Multi-comerciante: todos os dados, a chave de idempotência e o cache são separados por comerciante, que vem do claim `comerciante_id` do token e nunca do corpo da requisição |
| RF-09 | Servir saldo do cache Redis com fallback transparente no banco (cliente não percebe o miss) |

---

## Requisitos Não-Funcionais

| # | Requisito | Meta | Como é satisfeito |
|---|---|---|---|
| RNF-01 | **Disponibilidade independente** | O Lançamentos responde 2xx mesmo que o Consolidado esteja indisponível | Processos separados; comunicação exclusivamente assíncrona no caminho crítico |
| RNF-02 | **Throughput** | Consolidado suporta 50 req/s no `GET /consolidado/{data}` | Cache Redis (hit <1ms) + fallback Postgres (1-5ms); rate limiter em 6.000 req/min (100 req/s) não bloqueia a 50 req/s |
| RNF-03 | **Perda de requisições** | Menos de 5% sob 50 req/s | Rate limiter de 6.000 req/min por IP + cache absorvendo picos |
| RNF-04 | **Latência** | p95 < 500ms no `GET /consolidado` | Cache hit típico <1ms; miss + Postgres ~5ms; SLO de produção sugerido: p95 < 100ms (cache hit) / p95 < 200ms (miss) |
| RNF-05 | **Consistência eventual** | Saldo reflete todos os lançamentos em até ~5s após o registro; o `ultimoEventoAplicadoEm` da resposta indica o atraso aproximado, e o cache versionado impede servir valor anterior ao evento aplicado | Outbox relay a cada 1s + propagação AMQP <5ms + processamento do consumer |
| RNF-06 | **Sem perda de eventos** | Nenhum `LancamentoRegistrado` pode ser perdido | Outbox: evento gravado na transação do lançamento; broker: fila durável; relay: só marca como publicado após a confirmação do broker (publisher confirms), retenta indefinidamente e pode rodar em várias réplicas sem duplicar (`FOR UPDATE SKIP LOCKED`) |
| RNF-07 | **Idempotência** | Redelivery de evento nunca duplica o saldo | `eventos_processados` com `ON CONFLICT DO NOTHING` na mesma transação do upsert de saldo |
| RNF-08 | **Segurança** | Endpoints de negócio exigem token OAuth2 com escopo e comerciante; valores monetários nunca como float | JWT RS256 do Keycloak validado pelo JWKS (iss, aud, exp), escopo por rota e comerciante amarrado ao cliente (ADR-010); `NUMERIC(15,2)` no banco; `decimal.js` na aplicação |
| RNF-09 | **Entrega at-least-once** | O broker pode entregar a mesma mensagem mais de uma vez; o sistema deve ser resiliente a isso | Ver RNF-07; `prefetch=1` por consumer garante ordenação sequencial por processo |
| RNF-10 | **Graceful shutdown** | O consumer não perde mensagens em processamento ao receber SIGTERM | `stopConsumer()` cancela o consumer tag, aguarda até 8s para in-flight; mensagens novas são requeued durante o shutdown |

---

## Contrato do evento: invariantes de schema

| Campo | Regra |
|---|---|
| `eventoId` | UUID v4 único por evento; nunca reutilizado; PK em `eventos_processados` |
| `schemaVersion` | `"1.1"` nos eventos emitidos hoje. O consumidor aceita `1.0` (comerciante padrão) e qualquer `1.x`, e recusa `2.x`. Política em [eventos.md](eventos.md) |
| `comercianteId` | Obrigatório a partir da 1.1; 1 a 64 caracteres entre letras, números, hífen e sublinhado |
| `data.valor` | String com valor decimal positivo, 2 casas decimais (ex: `"1500.00"`); **nunca float** |
| `data.data` | YYYY-MM-DD real; define qual linha de `saldo_diario` (comerciante e data) é afetada |

---

## Rate Limiting e Testes de Carga

O rate limiter do Consolidado está em `6.000 req/min por IP` (100 req/s). O teste de carga k6 a 50 req/s de um único IP opera com 50% da cota — sem gerar `429` em nenhum momento da janela de 60s.

O Lançamentos está em `1.200 req/min por IP` (20 req/s), calibrado para o cenário de integração ERP em lote. Se o teste de carga for aplicado diretamente ao Lançamentos a mais de 20 req/s de um único IP, o rate limiter atuará como esperado. Isso é intencional: escrita é mais cara que leitura e o limite protege o banco de writes.

Os endpoints `/health`, `/ready` e `/metrics` são **isentos** do rate limiter em ambos os serviços — ver [seguranca.md](seguranca.md) para a justificativa.
