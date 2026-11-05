# Estratégia de testes

Este documento mostra o que cada camada de teste prova, como rodar e a quais requisitos não funcionais (RNF, em [requisitos.md](requisitos.md)) ela dá evidência. Onde há uma saída real salva, ela está em [evidencias/](evidencias/).

## Pirâmide

```mermaid
flowchart TB
    subgraph topo["Sistema completo (poucos, lentos, na stack real)"]
        R["Resiliência: derruba consolidado e RabbitMQ<br/>tests/resiliencia"]
        K["Carga k6: 50 req/s, pico com 429, 3 anos de histórico<br/>tests/load"]
    end
    subgraph meio["Integração (Postgres, RabbitMQ e Redis reais)"]
        I["Outbox, relay, consumidor, idempotência, cache versionado,<br/>multi-comerciante, migrations, reconexão, DLQ, propagação de trace"]
    end
    subgraph base["Unitários (muitos, rápidos, sem infraestrutura)"]
        U["Domínio, validação, segurança do JWT, métricas HTTP,<br/>proteções HTTP, backoff, contratos de evento, telemetria"]
    end
    base --> meio --> topo
```

| Camada | Onde | Infraestrutura | Tempo típico | Como rodar |
|---|---|---|---|---|
| Unitário | `services/*/tests/unit` | Nenhuma (um IdP de teste local publica o JWKS) | cerca de 20 s por serviço | `docker compose run --rm lancamentos npm test` ou `npm run test:unit` dentro do serviço |
| Integração | `services/*/tests/integration` | `docker-compose.integration.yml` (Postgres 5433, RabbitMQ 5673, Redis 6380) | cerca de 1 min no total | `.\test-integration.ps1` ou `bash test-integration.sh` |
| Resiliência | `tests/resiliencia` | A stack principal no ar | cerca de 2 min | `.\tests\resiliencia\resiliencia.ps1` ou `bash tests/resiliencia/resiliencia.sh` |
| Carga | `tests/load` | A stack principal no ar, com Keycloak | cerca de 3 min por cenário | `docker compose --profile loadtest run --rm k6` |
| Custo do JWT | `services/consolidado/tests/benchmark` | Nenhuma | cerca de 1 min | `npm run bench:auth` dentro do serviço |

A integração contínua (`.github/workflows/ci.yml`) roda lint, verificação de tipos, testes unitários, testes de integração, build das duas imagens e validação do compose. Resiliência e carga ficam fora do CI porque dependem da stack inteira e de tempo; são executadas sob demanda.

## O que cada camada prova, por requisito

A tabela de cenários de falha em [arquitetura.md](arquitetura.md) liga cada falha (consolidado, broker, Redis, bancos, duplicidade, ordem, pico) ao teste que a prova e aponta as lacunas.

| RNF | O que exige | Evidência | Camada |
|---|---|---|---|
| RNF-01 Disponibilidade independente | Lançamentos responde 2xx com o consolidado fora do ar | 30 de 30 lançamentos aceitos com o consolidado parado, e o saldo converge quando ele volta ([resiliência](evidencias/)) | Resiliência |
| RNF-01 (variante) | Lançamentos continua aceitando com o RabbitMQ fora | 30 de 30 aceitos com o broker parado, `/ready` da API segue 200, o outbox acumula e drena na volta | Resiliência |
| RNF-02 Throughput e RNF-03 Perda | 50 req/s no consolidado com menos de 5% de perda | k6: `non_ok_rate` em 0,00% nos cenários de cache quente e frio, nas 5 execuções registradas ([saídas](evidencias/)). No pico a 200 req/s o serviço respondeu cerca de 197 a 199 req/s, sem 5xx (ver capacidade abaixo) | Carga |
| RNF-03 (acima da cota) | O excedente é recusado de forma controlada | `limite-429.js`: com `RATE_LIMIT_MAX=300`, 700 requisições seguidas dão 300 respostas 200 e 400 respostas 429, todas com `Retry-After`, nenhum outro status ([saída](evidencias/k6-limite-429-saida.txt)); teste unitário do limitador. No pico do `consolidado.js` só se exige que nada além de 200 e 429 apareça e que todo 429 tenha `Retry-After` | Carga, unitário |
| RNF-04 Latência | p95 abaixo de 500 ms | k6 completo, 3 execuções finais: p95 de 10,8 a 141,7 ms (`cache_hit`) e de 12,5 a 56,0 ms (`cache_miss`), mediana de cerca de 5 ms, limites de p95 cumpridos nas três ([saídas](evidencias/)). Há requisições isoladas lentas, descritas nos limites abaixo | Carga |
| RNF-05 Consistência eventual | Saldo converge em segundos e nunca serve valor anterior ao evento aplicado | Integração: cache versionado, incluindo a corrida de gravação atrasada; resiliência: tempo de convergência medido; métrica `consolidado_evento_lag_seconds` | Integração, resiliência |
| RNF-06 Sem perda de eventos | Evento só é marcado publicado após o broker confirmar | Integração do relay: sem confirmação (nack) e sem rota mantêm o evento pendente; várias instâncias publicam cada evento uma vez | Integração |
| RNF-07 Idempotência | Reentrega não duplica saldo | Integração: o mesmo evento aplicado duas vezes soma uma; chave de idempotência por comerciante e 409 com corpo diferente | Integração |
| RNF-08 Segurança | Token válido, escopo e comerciante | Unitário: assinatura, `alg`, issuer, audiência, expiração, escopo, comerciante, 503 quando o JWKS cai; 413 para corpo grande; cabeçalhos do helmet | Unitário |
| RNF-09 At-least-once | Resiliente a redelivery | Ver RNF-07; integração de reconexão do broker e da DLQ | Integração |
| RNF-10 Graceful shutdown | Sem perda de mensagem em processamento | Cobertura parcial: o comportamento de nack durante o desligamento está no código do consumidor, sem teste automatizado dedicado | Lacuna conhecida |

## O que cada grupo de testes cobre

**Unitários**

- Validação de entrada (zod): valor como string decimal, tipo, data real do calendário, descrição.
- Segurança do JWT com um IdP de teste: aceita token correto; recusa assinatura alheia, `alg: none`, HS256, issuer, audiência, expiração e ausência de `exp`; 403 por escopo; 503 quando o JWKS está fora; a chave em cache continua valendo.
- API pelo supertest: 400 `problem+json`, 404, 401, 413 e cabeçalhos de segurança.
- Métricas HTTP: o contador e o histograma recebem o padrão da rota (por exemplo `/consolidado/:data`), nunca a URL real.
- Contrato do evento: versões 1.0, 1.1 e 2.x, campos obrigatórios, cálculo de delta.
- Backoff do broker e `withRetry`.
- Telemetria: um span que recebe `traceparent` continua o trace e vira filho do span de origem.

**Integração**

- Registro: atomicidade entre lançamento e outbox, idempotência concorrente, isolamento entre comerciantes.
- Relay: confirmação do broker, mensagem sem rota, várias instâncias concorrentes sem duplicar.
- Consumidor: idempotência, saldo acumulado com lançamento retroativo, dia vazio, intervalo.
- Cache: invalidação por versão e a corrida entre leitor lento e evento novo.
- Migrations: upgrade sobre dados existentes em banco temporário.
- Reconexão: `rabbitmqctl close_all_connections` e retomada do consumo.
- DLQ: evento inválido ou esgotado vai para a fila morta.
- Trace: o `traceparent` gravado no outbox chega ao cabeçalho da mensagem.

**Resiliência** (stack real)

- Cenário A: consolidado parado, `N` lançamentos (padrão 30), todos com 201; os eventos ficam na fila; ao voltar, o saldo é igual a `N x 10.00`.
- Cenário B: RabbitMQ parado, `N` lançamentos, todos com 201; o outbox acumula pelo menos `N` pendentes; ao voltar, o relay drena e o saldo converge.

**Carga** (stack real)

- `consolidado.js`: cache quente, cache frio e pico a 200 req/s acima da cota (só 200 e 429, todo 429 com `Retry-After`).
- `limite-429.js`: prova determinística do 429, com o limite do consolidado baixado para 300 por minuto por `RATE_LIMIT_MAX`.
- `historico-longo.js`: 1095 dias de lançamentos de um comerciante e a conferência do acumulado em 1095 datas.

## Capacidade medida e escala

- **Capacidade observada por instância.** No cenário de pico do k6, uma instância do consolidado respondeu 7.885, 7.943 e 7.911 requisições em 40 s, cerca de 197 a 199 req/s, sem 5xx. O número de 74 req/s que o k6 imprime para a execução inteira é uma média que inclui as pausas entre cenários e não deve ser lido como capacidade. A medição é de uma máquina de desenvolvimento, com k6, Keycloak e todos os serviços no mesmo hardware, e o teste não procurou o ponto de saturação. Ela mostra uma folga de pelo menos 3,9 vezes sobre os 50 req/s do RNF-02.
- **Escala horizontal.** O consolidado não guarda estado de requisição: o saldo está no PostgreSQL, o cache no Redis e a autenticação valida o JWT localmente. Mais instâncias atrás de um balanceador somam capacidade. Isso é um argumento de projeto; não medi mais de uma instância.
- **Rate limit em memória por instância.** O limitador atual (`express-rate-limit` com armazenamento em memória) conta por IP em cada instância. Com mais de uma réplica, o limite efetivo passa a ser o limite multiplicado pelo número de réplicas e depende de como o balanceador distribui. Antes de ter mais de uma réplica, o controle precisa ir para o Redis (contador compartilhado, de preferência por cliente `azp` em vez de IP) ou para o API Gateway, que é o desenho de produção em [seguranca.md](seguranca.md).

## Limites deste conjunto de testes

- Não há teste de falha do Redis nem de lentidão do Postgres. O cache é tratado como opcional no código, mas isso não está provado por teste automatizado.
- Não há teste de carga sobre o lançamentos. O requisito de 50 req/s é do consolidado.
- **Regressão de latência encontrada e tratada.** Depois da fase 4, o k6 completo passou a falhar (p95 de segundos). Não consegui provar uma causa única: o bisect não achou um commit estável e a degradação também apareceu com o tracing desligado. Foram corrigidos os custos comprovados (tracing desligado por padrão no compose, healthcheck do RabbitMQ por porta) e as latências por cenário voltaram à casa de dezenas de milissegundos ou menos nas três execuções finais. Investigação completa em `evidencias/regressao-latencia.txt`.
- **Picos isolados de latência (limitação conhecida).** Nas três execuções finais a mediana ficou em cerca de 5 ms, mas houve requisições isoladas lentas (máximo de 3,84 s, 1,49 s e 2,28 s) e, na execução 3, p95 de 141,74 ms no `cache_hit`, com 71 checagens acima de 500 ms. Não identifiquei a causa e não atribuo uma. Os limites de p95 de 500 ms passaram nas três.
- O limite de ao menos um 429 no pico do `consolidado.js` foi removido por ser não determinístico: o limitador usa janela fixa de 1 minuto e o resultado dependia do alinhamento da janela (2.292, 0 e 713 respostas 429 nas três execuções finais). O limite de produção não mudou.
- Os números de carga são de uma máquina de desenvolvimento com Docker Desktop, com todos os serviços e o Keycloak disputando o mesmo hardware. Servem para comparar cenários entre si, e não como capacidade de produção.
- O CI foi escrito e validado só quanto à sintaxe do YAML. Ele ainda não rodou no GitHub.
