# Dimensionamento

Como dimensionar a solução na AWS para o requisito de 50 req/s no consolidado com no máximo 5% de perda, e como crescer para picos maiores sem superprovisionar de forma permanente. A estrutura vem de um estudo anterior do mesmo autor; os números foram refeitos com as **medições desta solução** e o que não foi medido está dito como hipótese.

## O que foi medido e o que é hipótese

| Dado | Valor | Origem |
|---|---|---|
| Requisito | 50 req/s no `GET /consolidado/{data}`, perda de até 5% | Enunciado |
| Vazão numa instância do consolidado, no pico do k6 | 197 a 199 req/s (7.885, 7.943 e 7.911 respostas em 40 s), sem 5xx | Medido, máquina de desenvolvimento, k6 e serviços no mesmo hardware ([testes.md](testes.md)) |
| Latência no cache quente e frio a 50 req/s | mediana de cerca de 5 ms; p95 de 10,8 a 141,7 ms (`cache_hit`) e de 12,5 a 56,0 ms (`cache_miss`) | Medido (3 execuções) |
| Consulta de saldo acumulado no PostgreSQL, 3 anos de histórico | 0,24 a 1,17 ms | Medido com `EXPLAIN ANALYZE` ([ADR-009](adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md)) |
| Tamanho médio de uma linha | `lancamentos` 160 bytes, `outbox` 496 bytes; com índices, cerca de 1,2 KB por evento | Medido em 635 lançamentos locais, extrapolado |
| Capacidade de uma tarefa Fargate de 0,5 vCPU | **desconhecida** | Hipótese a validar |
| Vazão do consumidor (eventos por segundo) | **desconhecida** | Não medida |

## Demanda

Lei de Little: requisições simultâneas = taxa de chegada x tempo de resposta. A 50 req/s, com mediana de 5 ms, há em média 0,25 requisição em andamento; mesmo com o p95 pior medido (141,7 ms) são cerca de 7. Em outras palavras, o consolidado **não é limitado por concorrência**, e sim pela CPU gasta por requisição (validação do JWT local, consulta ao Redis, serialização). Por isso o dimensionamento parte de CPU, não de número de conexões.

Eventos: 100 mil lançamentos por dia (premissa) são cerca de 1,2 evento por segundo em média. O broker não é limitado por vazão nesse volume; o cluster de 3 nós existe por disponibilidade, não por capacidade.

## Dimensionamento por componente

| Componente | Configuração proposta (cenário de produção) | Por quê | Sinal para escalar |
|---|---|---|---|
| `consolidado` (Fargate) | 2 a N tarefas de 0,5 vCPU e 1 GB, em 2 AZs | Sem estado; escala horizontal | CPU a 60% (target tracking) e requisições por alvo no ALB |
| `lancamentos` (Fargate) | 2 a N tarefas de 0,5 vCPU e 1 GB | Idem. Escrita transacional no banco | CPU a 60% |
| `lancamentos-relay` (Fargate) | 2 tarefas de 0,25 vCPU e 0,5 GB | `FOR UPDATE SKIP LOCKED` divide o trabalho; duas réplicas dão tolerância a falha, não mais vazão necessária | `lancamentos_outbox_pendentes` e `lancamentos_outbox_idade_mais_antigo_segundos` |
| Consumidor | Dentro das tarefas do consolidado | `prefetch=1` por consumidor: mais tarefas, mais mensagens em paralelo | `consolidado_evento_lag_seconds` |
| RDS `lancamentos_db` | `db.t4g.medium` Multi-AZ, 50 GB | Escrita de baixo volume; disco para cerca de um ano sem retenção do outbox (1,2 KB x 100 mil x 365 = 43 GB, extrapolação linear) | CPU, créditos de CPU e `FreeStorageSpace` |
| RDS `consolidado_db` | `db.t4g.medium` Multi-AZ, 50 GB | Leitura por índice (`comerciante_id`, `data`); o cache absorve a maior parte | CPU e conexões |
| Redis | `cache.t4g.small`, primário e réplica | O cache guarda chaves de poucas centenas de bytes com TTL de 60 s; a 50 req/s são no máximo cerca de 3.000 chaves por minuto, muito abaixo da memória do nó. A réplica é por disponibilidade | Memória e taxa de acerto |
| Amazon MQ | Cluster de 3 nós `mq.m7g.medium` | Por disponibilidade (ver [custos.md](custos.md)) | Fila `consolidado.lancamentos` crescendo, memória do broker |

Os tamanhos de banco usam a classe `t4g` (processador de capacidade com crédito). Para carga sustentada, acompanhar o saldo de créditos de CPU; se esgotar, migrar para a família `m`.

## Cenários de carga

A tabela usa a fórmula `N = ceil(carga / (capacidade por tarefa x 0,6))`, com **capacidade por tarefa de 50 req/s como hipótese conservadora** (a vazão medida numa instância foi de cerca de 198 req/s em hardware sem a limitação de 0,5 vCPU do Fargate) e 60% de utilização alvo. O mínimo é 2 tarefas por disponibilidade.

| Cenário | Carga | Tarefas do consolidado | O que muda além disso |
|---|---|---|---|
| Requisito | 50 req/s | 2 | Nada |
| Pico de 3x | 150 req/s | 5 | Verificar conexões ao banco (5 tarefas x 10 conexões do pool) |
| Pico de 10x (por exemplo uma promoção) | 500 req/s | 17 | Ver abaixo |

A 500 req/s com todas as requisições em cache frio, o banco receberia 500 consultas por segundo de cerca de 1 ms cada, o que ocupa em torno de meio núcleo (ordem de grandeza, a partir do `EXPLAIN`). As 17 tarefas abririam cerca de 170 conexões (pool padrão de 10); a fórmula padrão do RDS para `max_connections` numa instância de 4 GiB dá em torno de 450, então cabe, mas passando disso entra o RDS Proxy.

**O que quebraria primeiro a 10x** não é a CPU:

1. **O rate limit por IP** (6.000 por minuto, 100 req/s) em memória por instância. Poucos integradores grandes ou um balanceador compartilhando o IP bloqueariam tráfego legítimo. Precisa ir para o API Gateway ou Redis, por cliente ([testes.md](testes.md)).
2. **O NAT Gateway** pelo volume de saída das tarefas, que também é custo ([custos.md](custos.md)).
3. **O pool de conexões** do banco, citado acima.

O Keycloak **não** está no caminho crítico de leitura: os serviços validam o JWT localmente com a chave pública em cache, então o tráfego dele é de emissão de token, proporcional ao número de integradores e não ao número de requisições.

## Escalonamento

- **Horizontal primeiro.** Serviços sem estado, políticas de target tracking por CPU (60%) e por requisições por alvo, com escala para dentro lenta (para não oscilar) e para fora rápida.
- **Vertical só para banco.** Subir a classe do RDS numa janela de manutenção quando CPU ou conexões saturarem; réplica de leitura para o consolidado se o cache não bastar.
- **Buffer do broker.** Um pico de escrita acumula no RabbitMQ e no outbox sem afetar a latência de lançamentos; o preço é o atraso de consistência (`consolidado_evento_lag_seconds`), que o RNF-05 limita em cerca de 5 segundos.

## Como validar

Nenhum número da coluna "hipótese" vale antes disto:

1. Subir a pilha numa conta AWS com a configuração do cenário B.
2. Rodar `tests/load/consolidado.js` apontando para o ALB, com uma tarefa do consolidado, e achar o ponto em que o p95 passa de 500 ms ou a CPU passa de 60%. Esse é o valor real de "capacidade por tarefa".
3. Repetir com a escala automática ligada e com o pico de 10x.
4. Medir a vazão do consumidor: publicar um volume conhecido de eventos com o consolidado parado, ligá-lo e cronometrar a drenagem.
5. Registrar os resultados em `docs/evidencias/`, com a data, e atualizar esta página.
