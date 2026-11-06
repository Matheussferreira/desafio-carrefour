# Testes de carga (k6)

Cinco scripts. Todos obtêm o token no Keycloak (client credentials) no `setup()`.

| Script | O que mede | Como rodar |
|---|---|---|
| `consolidado.js` | 50 req/s com cache quente e frio (requisito de 50 req/s e menos de 5% de perda) e um pico de 200 req/s acima da cota do limitador | `docker compose --profile loadtest run --rm k6` |
| `limite-429.js` | Prova determinística do 429: sobe o consolidado com `RATE_LIMIT_MAX=300` e envia 700 requisições seguidas; exige 429 com `Retry-After` | `.\tests\load\limite-429.ps1` ou `bash tests/load/limite-429.sh` |
| `historico-longo.js` | 3 anos de lançamentos diários de um comerciante; custo do saldo acumulado e conferência do valor em 1095 datas | `docker compose --profile loadtest run --rm k6 run /scripts/historico-longo.js` |
| `curto.js` | Só `cache_hit`, 50 req/s por 30 s, para medir rápido ou comparar versões e configurações (`AUTH=login` para os commits anteriores à autenticação por Keycloak, até `98f9fb2`) | `docker compose --profile loadtest run --rm k6 run /scripts/curto.js` |
| `ablacao.js` | 50 req/s na mesma data por 45 s, para comparar configurações da mesma stack (por exemplo com e sem tracing) | `docker compose --profile loadtest run --rm k6 run /scripts/ablacao.js` |

No PowerShell o caminho `/scripts/...` é passado como está. No Git Bash, prefixe o comando com `MSYS_NO_PATHCONV=1` para o caminho não ser convertido para um caminho do Windows.

## consolidado.js

Usa o executor `constant-arrival-rate`, que garante a **taxa de chegada** independentemente da latência de cada resposta. Isso é diferente de "50 VUs em loop", que mediria outra coisa.

**Perda:** qualquer resposta que não seja HTTP 200 nos cenários de 50 req/s. O limitador do consolidado está ligado no valor de produção (6.000 req/min, 100 req/s por IP).

| Cenário | Janela | O que prova |
|---|---|---|
| `cache_hit` | 0 a 60 s | Mesma data repetida, lida do Redis depois da primeira requisição |
| `cache_miss` | 70 a 130 s | 60 datas distintas rotacionando. O cache dessas datas está frio quando o cenário começa (o TTL de 60 s expira antes), então a primeira passagem vai ao PostgreSQL |
| `pico_acima_do_limite` | 140 a 180 s | 200 req/s por 40 s, acima da cota. Prova que só aparecem 200 e 429, todo 429 com `Retry-After` e nenhum 5xx. Se haverá 429 depende do alinhamento da janela do limitador (ver abaixo). Essas respostas não entram no cálculo de perda |

Os cenários rodam em sequência para não somar carga.

### Thresholds (o teste sai com código diferente de zero se violados)

| Métrica | Limite | Significado |
|---|---|---|
| `non_ok_rate` | `rate < 0.05` | Menos de 5% de respostas diferentes de 200 nos cenários de 50 req/s |
| `http_req_failed{scenario:cache_hit}` e `{scenario:cache_miss}` | `rate < 0.05` | Menos de 5% de erros de rede ou HTTP 400 ou mais |
| `http_req_duration{scenario:cache_hit}` e `{scenario:cache_miss}` | `p(95) < 500ms` | Limite de latência |
| `pico_429_sem_retry_after` | `rate == 0` | Todo 429 trouxe `Retry-After` |
| `pico_respostas_outras` | `count == 0` | Nenhum 5xx nem outro status no pico |

O `consolidado.js` não exige mais ao menos um 429 no pico. O limitador usa janela fixa de 1 minuto e 6.000 requisições. Nas três execuções finais o pico recebeu entre 7.885 e 7.943 respostas em 40 s e, conforme a janela virou em relação ao início do pico, houve 2.292, 0 e 713 respostas 429. Exigir 429 ali fazia o teste passar ou falhar pelo alinhamento da janela, não pelo comportamento do serviço. O 429 é provado em `limite-429.js`, que não depende de alinhamento (próxima seção).

### limite-429.js

O limitador do consolidado lê `RATE_LIMIT_MAX` (padrão 6.000 por minuto; valor ausente ou inválido volta ao padrão). O script `limite-429.ps1` (ou `.sh`) sobe o consolidado com `docker-compose.ratelimit.yml`, que define `RATE_LIMIT_MAX=300`, roda o k6 e devolve o serviço ao limite de produção. Um VU envia 700 requisições seguidas (`2 x 300 + 100`), o que leva poucos segundos. Mesmo que a janela vire no meio, cabem no máximo 300 respostas 200 por janela, então o 429 sempre aparece. Os limites: `limite_respostas_429 > 0`, `limite_429_sem_retry_after == 0` e `limite_respostas_outras == 0`. Resultado real: 300 respostas 200 e 400 respostas 429, todas com `Retry-After`, código de saída 0 ([saída](../../docs/evidencias/k6-limite-429-saida.txt)). O limite de produção não foi alterado.

### Data alternativa para cache_hit

```powershell
docker compose --profile loadtest run --rm -e TEST_DATE=2026-01-15 k6
```

## Resultados reais (2026-11-05)

Saídas em `docs/evidencias/`. A tabela compara duas execuções de antes da correção da degradação com as três execuções finais do `consolidado.js` completo (saídas coladas do terminal em `k6-consolidado-saida-final-execucao1.txt` a `3`; o resumo em JSON só existe para a terceira, `k6-consolidado-resumo.json`, porque cada execução sobrescreve o arquivo):

| | Antes (execução 1) | Antes (execução 2) | Final, execuções 1 / 2 / 3 |
|---|---|---|---|
| Código de saída | 0 | 99 | 0 / 99 / 0 |
| `non_ok_rate` | 0,00% | 0,00% | 0,00% / 0,00% / 0,00% |
| p95 `cache_hit` | 70,6 ms | 1,35 s | 64,06 / 10,83 / 141,74 ms |
| p95 `cache_miss` | 69,7 ms | 2,82 s | 56,00 / 18,60 / 12,50 ms |
| Mediana `cache_hit` | 7,0 ms | 7,7 ms | 5,74 / 4,88 / 5,24 ms |
| Maior latência (todos os cenários) | não registrada | não registrada | 3,84 s / 1,49 s / 2,28 s |
| Respostas 429 no pico | 2175 | 0 | 2292 / 0 / 713 |
| 429 sem `Retry-After` | 0 | não se aplica | 0 / 0 / 0 |

A execução final 2 saiu com código 99 apenas porque o limite `pico_respostas_429` (ao menos um 429) ainda existia e o pico não recebeu nenhum; todos os outros limites passaram. Esse limite foi removido do `consolidado.js` e substituído pelo `limite-429.js`, como explicado acima.

O p95 agregado que o k6 imprime inclui o cenário de pico, que oferece 200 req/s por 40 s de propósito. Os limites de latência valem por cenário (`cache_hit` e `cache_miss`).

### Capacidade observada por instância

A vazão média de 74 req/s que o k6 imprime (`http_reqs`) é a média de 188 s de execução, com pausas entre os cenários, e não a capacidade do serviço. No cenário de pico as respostas foram 7.885, 7.943 e 7.911 em 40 s, ou seja, cerca de 197 a 199 req/s, todas 200 ou 429 e nenhuma 5xx, com uma instância do consolidado, o k6 e o Keycloak na mesma máquina. Isso mostra uma folga de pelo menos 3,9 vezes sobre os 50 req/s do requisito, mas não é um teste de saturação: o k6 ofereceu 200 req/s e não procurei o ponto de ruptura.

### Picos isolados de latência (limitação conhecida)

Nas três execuções finais a mediana ficou em cerca de 5 ms, mas apareceram requisições isoladas lentas (máximo de 3,84 s, 1,49 s e 2,28 s) e, na execução 3, o p95 do `cache_hit` foi 141,74 ms, com 71 checagens acima de 500 ms. Não identifiquei a causa desses picos e não vou atribuir uma. Os limites de p95 de 500 ms passaram nas três.

### A degradação encontrada

Na versão com tracing ligado por padrão (commit `71a4ce2`), o `consolidado.js` passou a falhar nos limites de latência (mediana de 0,7 a 3 s e p95 de 4 a 20 s no `cache_hit`, sem 429 no pico porque o serviço não passava de cerca de 25 req/s). A investigação está em `docs/evidencias/regressao-latencia.txt`:

- O bisect de seis commits, cada um em stack nova com o cenário curto (`curto.js`: só `cache_hit`, 50 req/s, 30 s), não mostrou um commit que degrade de forma estável. O mesmo commit variou de 8 a 473 ms de p95 entre rodadas.
- Na stack principal reproduzi a degradação: com o tracing ligado deu p95 de 935 ms com o Jaeger ausente e de 2,0 s com o Jaeger no ar, com o consolidado a 96% e 145% de CPU (no `docker stats` que você mandou ele estava a 152%). Com o tracing desligado a degradação também apareceu em algumas rodadas, então o tracing agrava, mas não explica tudo.
- O nível de log não muda a CPU nem a latência.
- Durante as rodadas ruins o RabbitMQ aparecia com 113% a 147% de CPU: o healthcheck antigo (`rabbitmq-diagnostics ping`) sobe uma VM Erlang nova a cada 10 s. Sem ele, o p95 caiu de 139 a 469 ms para 26, 74 e 30 ms. Em um A/B posterior, em blocos alternados, o healthcheck antigo e o novo deram o mesmo resultado (p95 de cerca de 9 ms), então essa associação não está provada.

**Não consegui provar uma causa única.** O que foi alterado, por ser custo comprovado:

1. O tracing deixou de vir ligado no compose. Sem `OTEL_EXPORTER_OTLP_ENDPOINT`, o SDK nem inicia. Para ligar, use o `docker-compose.tracing.yml` com o profile `observability`. As instrumentações são configuráveis por `OTEL_INSTRUMENTACOES`.
2. O healthcheck do RabbitMQ virou uma checagem de porta (`nc -z`), que não sobe processo Erlang.

Depois disso, as latências por cenário voltaram à casa de dezenas de milissegundos ou menos nas três execuções finais. Se a degradação voltar, `curto.js` e os arquivos de `docs/evidencias/` mostram como comparar.

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
| `RATE_LIMIT_MAX` | `300` no `limite-429.js` | Só informativo para o script; quem aplica é o serviço (variável do consolidado, definida pelo `docker-compose.ratelimit.yml`) |

O `docker-compose.yml` monta `docs/evidencias` em `/evidencias`, para o k6 gravar o resumo em JSON com `--summary-export`.
