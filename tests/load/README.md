# Testes de carga (k6)

Três scripts. Todos obtêm o token no Keycloak (client credentials) no `setup()`.

| Script | O que mede | Como rodar |
|---|---|---|
| `consolidado.js` | 50 req/s com cache quente e frio (requisito de 50 req/s e menos de 5% de perda) e um pico de 200 req/s acima da cota do limitador | `docker compose --profile loadtest run --rm k6` |
| `historico-longo.js` | 3 anos de lançamentos diários de um comerciante; custo do saldo acumulado e conferência do valor em 1095 datas | `docker compose --profile loadtest run --rm k6 run /scripts/historico-longo.js` |
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

## Resultados reais desta máquina (2026-11-05)

Resultados em `docs/evidencias/`. Foram duas execuções completas de `consolidado.js`, com a mesma stack e o mesmo código:

| | Execução 1 | Execução 2 |
|---|---|---|
| Resultado | Passou (código de saída 0) | **Falhou** nos limites de latência (código de saída 99) |
| `non_ok_rate` | 0,00% | 0,00% |
| `http_req_failed` | 0,00% | 0,00% |
| p95 `cache_hit` | 70,6 ms | 1,35 s |
| p95 `cache_miss` | 69,7 ms | 2,82 s |
| Mediana `cache_hit` / `cache_miss` | 7,0 / 6,3 ms | 7,7 / 129 ms |
| Respostas 429 no pico | 2175, todas com `Retry-After` | 0 (o servidor não alcançou a cota no período) |
| Iterações descartadas | 325 | 2720 |

A segunda execução também registrou uma duração mínima negativa em uma requisição (relógio da máquina virtual do Docker saltando), sinal de que a máquina estava sob pressão.

Como ler:

- Em nenhuma execução houve perda (`non_ok_rate` 0%) nos cenários de 50 req/s. O que variou foi a **latência**, e muito.
- A máquina é de desenvolvimento, com 8 GB de RAM e outros programas pesados abertos. Durante as medições a CPU do host ficou em 100% e a memória livre chegou a cerca de 340 MB. O RabbitMQ chegou a falhar o healthcheck por demora (mais de 5 s) em um momento. Nessas condições, o resultado do k6 depende mais do estado da máquina que do código.
- Por isso **não afirmo um p95 de capacidade**. O que os dados sustentam é: zero perda a 50 req/s em ambas, p95 dentro de 500 ms quando a máquina estava menos ocupada, e p95 muito acima quando estava saturada. Para um número de capacidade, rodar em uma máquina dedicada, sem outros programas.
- O pico acima da cota foi demonstrado na execução 1: o limitador devolveu 429 com `Retry-After` e não houve 5xx. Na execução 2 o servidor ficou lento demais para chegar a 100 req/s no intervalo.

Para um número de latência mais estável nesta máquina, a comparação entre configurações deve ser alternada (ver `docs/evidencias/custo-tracing-ablacao.txt`) e olhar a **mediana**, que variou pouco entre execuções (cerca de 6 ms), enquanto o p95 variou de 75 a 150 ms para a mesma configuração.

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
