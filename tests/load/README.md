# Testes de carga (k6)

Três scripts. Todos obtêm o token no Keycloak (client credentials) no `setup()`.

| Script | O que mede | Como rodar |
|---|---|---|
| `consolidado.js` | 50 req/s com cache quente e frio (requisito de 50 req/s e menos de 5% de perda) e um pico de 200 req/s acima da cota do limitador | `docker compose --profile loadtest run --rm k6` |
| `historico-longo.js` | 3 anos de lançamentos diários de um comerciante; custo do saldo acumulado e conferência do valor em 1095 datas | `docker compose --profile loadtest run --rm k6 run /scripts/historico-longo.js` |
| `curto.js` | Só `cache_hit`, 50 req/s por 30 s, para medir rápido ou comparar versões e configurações (`AUTH=login` para os commits anteriores à fase 3) | `docker compose --profile loadtest run --rm k6 run /scripts/curto.js` |
| `ablacao.js` | 50 req/s na mesma data por 45 s, para comparar configurações da mesma stack (por exemplo com e sem tracing) | `docker compose --profile loadtest run --rm k6 run /scripts/ablacao.js` |

No PowerShell o caminho `/scripts/...` é passado como está. No Git Bash, prefixe o comando com `MSYS_NO_PATHCONV=1` para o caminho não ser convertido para um caminho do Windows.

## consolidado.js

Usa o executor `constant-arrival-rate`, que garante a **taxa de chegada** independentemente da latência de cada resposta. Isso é diferente de "50 VUs em loop", que mediria outra coisa.

**Perda:** qualquer resposta que não seja HTTP 200 nos cenários de 50 req/s. O limitador do consolidado está ligado no valor de produção (6.000 req/min, 100 req/s por IP).

| Cenário | Janela | O que prova |
|---|---|---|
| `cache_hit` | 0 a 60 s | Mesma data repetida, lida do Redis depois da primeira requisição |
| `cache_miss` | 70 a 130 s | 60 datas distintas rotacionando. O cache dessas datas está frio quando o cenário começa (o TTL de 60 s expira antes), então a primeira passagem vai ao PostgreSQL |
| `pico_acima_do_limite` | 140 a 180 s | 200 req/s por 40 s, acima da cota. Prova que o excedente recebe **429 com `Retry-After`**, sem 5xx. Essas respostas não entram no cálculo de perda |

Os cenários rodam em sequência para não somar carga.

### Thresholds (o teste sai com código diferente de zero se violados)

| Métrica | Limite | Significado |
|---|---|---|
| `non_ok_rate` | `rate < 0.05` | Menos de 5% de respostas diferentes de 200 nos cenários de 50 req/s |
| `http_req_failed{scenario:cache_hit}` e `{scenario:cache_miss}` | `rate < 0.05` | Menos de 5% de erros de rede ou HTTP 400 ou mais |
| `http_req_duration{scenario:cache_hit}` e `{scenario:cache_miss}` | `p(95) < 500ms` | Limite de latência |
| `pico_respostas_429` | `count > 0` | O limitador atuou no pico |
| `pico_429_sem_retry_after` | `rate == 0` | Todo 429 trouxe `Retry-After` |
| `pico_respostas_outras` | `count == 0` | Nenhum 5xx nem outro status no pico |

### Data alternativa para cache_hit

```powershell
docker compose --profile loadtest run --rm -e TEST_DATE=2026-01-15 k6
```

## Resultados reais (2026-11-05)

Saídas em `docs/evidencias/`. A tabela mostra as duas execuções que falharam ou oscilaram antes da correção e as três que passaram depois, todas do `consolidado.js` completo:

| | Antes (execução 1, passou) | Antes (execução 2, falhou) | Depois, execuções 1 / 2 / 3 |
|---|---|---|---|
| Código de saída | 0 | 99 | 0 / 0 / 0 |
| `non_ok_rate` | 0,00% | 0,00% | 0,00% / 0,00% / 0,00% |
| p95 `cache_hit` | 70,6 ms | 1,35 s | 9,68 / 9,71 / 9,32 ms |
| p95 `cache_miss` | 69,7 ms | 2,82 s | 9,58 / 8,92 / 9,21 ms |
| Mediana `cache_hit` | 7,0 ms | 7,7 ms | 4,52 / 4,45 / 4,40 ms |
| Respostas 429 no pico | 2175 | 0 | 2502 / 2001 / 2502 |
| 429 sem `Retry-After` | 0 | não se aplica | 0 / 0 / 0 |

O p95 agregado que o k6 imprime inclui o cenário de pico, que oferece 200 req/s por 40 s de propósito e satura o processo. Os limites de latência valem por cenário (`cache_hit` e `cache_miss`).

### A degradação encontrada

Depois da fase 4, o `consolidado.js` passou a falhar nos limites de latência (mediana de 0,7 a 3 s e p95 de 4 a 20 s no `cache_hit`, sem 429 no pico porque o serviço não passava de cerca de 25 req/s). A investigação está em `docs/evidencias/regressao-latencia.txt`:

- O bisect de seis commits, cada um em stack nova com o cenário curto (`curto.js`: só `cache_hit`, 50 req/s, 30 s), não mostrou um commit que degrade de forma estável. O mesmo commit variou de 8 a 473 ms de p95 entre rodadas.
- Na stack principal reproduzi a degradação: com o tracing ligado deu p95 de 935 ms com o Jaeger ausente e de 2,0 s com o Jaeger no ar, com o consolidado a 96% e 145% de CPU (no `docker stats` que você mandou ele estava a 152%). Com o tracing desligado a degradação também apareceu em algumas rodadas, então o tracing agrava, mas não explica tudo.
- O nível de log não muda a CPU nem a latência.
- Durante as rodadas ruins o RabbitMQ aparecia com 113% a 147% de CPU: o healthcheck antigo (`rabbitmq-diagnostics ping`) sobe uma VM Erlang nova a cada 10 s. Sem ele, o p95 caiu de 139 a 469 ms para 26, 74 e 30 ms. Em um A/B posterior, em blocos alternados, o healthcheck antigo e o novo deram o mesmo resultado (p95 de cerca de 9 ms), então essa associação não está provada.

**Não consegui provar uma causa única.** O que foi alterado, por ser custo comprovado:

1. O tracing deixou de vir ligado no compose. Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, o SDK nem inicia. Para ligar, use o `docker-compose.tracing.yml` com o profile `observability`. As instrumentações são configuráveis por `OTEL_INSTRUMENTACOES`.
2. O healthcheck do RabbitMQ virou uma checagem de porta (`nc -z`), que não sobe processo Erlang.

Depois disso, três execuções seguidas do k6 completo passaram. Se a degradação voltar, `curto.js` e os arquivos de `docs/evidencias/` mostram como comparar.

## historico-longo.js

Grava 1095 dias de lançamentos do comerciante `loja-2` (um crédito por dia, um débito a cada 5 dias), espera o consolidado convergir, e consulta as 1095 datas a 50 req/s com cache frio, conferindo cada acumulado contra o valor calculado no script. Depois mede a última data repetida (cache quente) como contraponto. Pode ser repetido: as chaves de idempotência evitam duplicar o histórico.

Resultado e análise no [ADR-009](../../docs/adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md). Resumo: 1101 respostas conferidas sem divergência; consulta isolada no PostgreSQL de 0,24 a 1,17 ms.

## Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `LANCAMENTOS_URL` | `http://localhost:3001` | API de lançamentos |
| `CONSOLIDADO_URL` | `http://localhost:3002` | API do consolidado |
| `KEYCLOAK_URL` | `http://localhost:8080` | Emissão do token |
| `CLIENT_ID`, `CLIENT_SECRET` | `erp-loja-1` e o segredo de desenvolvimento | Credencial usada |
| `TEST_DATE` | `2026-06-27` | Data do cenário de cache quente |

O `docker-compose.yml` monta `docs/evidencias` em `/evidencias`, para o k6 gravar o resumo em JSON com `--summary-export`.
