# Dimensionamento

Como dimensionar a solução no Google Cloud para o requisito de 50 req/s no consolidado com no máximo 5% de perda, e como crescer para picos maiores sem superprovisionar de forma permanente. A estrutura vem de um estudo anterior do mesmo autor; os números foram refeitos com as **medições desta solução** e o que não foi medido está dito como hipótese.

## O que foi medido e o que é hipótese

| Dado | Valor | Origem |
|---|---|---|
| Requisito | 50 req/s no `GET /consolidado/{data}`, perda de até 5% | Enunciado |
| Vazão numa instância do consolidado, no pico do k6 | 197 a 199 req/s (7.885, 7.943 e 7.911 respostas em 40 s), sem 5xx | Medido, máquina de desenvolvimento, k6 e serviços no mesmo hardware ([testes.md](testes.md)) |
| Latência no cache quente e frio a 50 req/s | mediana de cerca de 5 ms; p95 de 10,8 a 141,7 ms (`cache_hit`) e de 12,5 a 56,0 ms (`cache_miss`) | Medido (3 execuções) |
| Consulta de saldo acumulado no PostgreSQL, 3 anos de histórico | 0,24 a 1,17 ms | Medido com `EXPLAIN ANALYZE` ([ADR-009](adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md)) |
| Tamanho médio de uma linha | `lancamentos` 160 bytes, `outbox` 496 bytes; com índices, cerca de 1,2 KB por evento | Medido em 635 lançamentos locais, extrapolado |
| Spans por trace de um lançamento (API, relay, consolidado) | 18 | Medido num trace do Jaeger |
| Capacidade de um pod de 0,5 vCPU no GKE Autopilot | **desconhecida** | Hipótese a validar |
| Vazão do consumidor (eventos por segundo) | **desconhecida** | Não medida |
| Comportamento com o Pub/Sub | **desconhecido** | O adaptador não existe ([ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md)) |

## Demanda

Lei de Little: requisições simultâneas = taxa de chegada x tempo de resposta. A 50 req/s, com mediana de 5 ms, há em média 0,25 requisição em andamento; mesmo com o p95 pior medido (141,7 ms) são cerca de 7. Em outras palavras, o consolidado **não é limitado por concorrência**, e sim pela CPU gasta por requisição (validação do JWT local, consulta ao Redis, serialização). Por isso o dimensionamento parte de CPU, não de número de conexões.

Eventos: 100 mil lançamentos por dia (premissa) são cerca de 1,2 evento por segundo em média. O broker não é limitado por vazão nesse volume; o Pub/Sub escala sem dimensionamento, e a franquia gratuita cobre a vazão ([custos.md](custos.md)).

## Dimensionamento por componente

No GKE Autopilot o Google cobra e dimensiona pelos **recursos pedidos pelo pod** (`requests`), com valores mínimos por pod e uma relação aceita entre CPU e memória. Os tamanhos abaixo respeitam isso.

| Componente | Configuração proposta (cenário de produção) | Por quê | Sinal para escalar |
|---|---|---|---|
| `consolidado` (GKE Autopilot) | 2 a N pods de 0,5 vCPU e 1 GiB, espalhados por zonas | Sem estado; escala horizontal | HPA: CPU a 60% |
| `lancamentos` (GKE Autopilot) | 2 a N pods de 0,5 vCPU e 1 GiB | Idem. Escrita transacional no banco | HPA: CPU a 60% |
| `lancamentos-relay` (GKE Autopilot) | 2 pods de 0,25 vCPU e 0,5 GiB | `FOR UPDATE SKIP LOCKED` divide o trabalho; duas réplicas dão tolerância a falha, não mais vazão necessária | `lancamentos_outbox_pendentes` e `lancamentos_outbox_idade_mais_antigo_segundos` |
| Consumidor | Dentro dos pods do consolidado | Controle de fluxo de 1 mensagem por instância (equivalente ao `prefetch=1`): mais pods, mais mensagens em paralelo | Atraso da assinatura do Pub/Sub e `consolidado_evento_lag_seconds`, via métrica externa no HPA |
| Cloud SQL `lancamentos_db` | `db-custom-2-7680` com HA regional, 50 GB de SSD com aumento automático | Escrita de baixo volume; disco para cerca de um ano sem retenção do outbox (1,2 KB x 100 mil x 365 = 43 GB, extrapolação linear) | CPU, memória, conexões e espaço em disco |
| Cloud SQL `consolidado_db` | `db-custom-2-7680` com HA regional, 50 GB | Leitura por índice (`comerciante_id`, `data`); o cache absorve a maior parte | CPU e conexões |
| Memorystore Redis | Nível Standard, 1 GiB | O cache guarda chaves de poucas centenas de bytes com TTL de 60 s; a 50 req/s são no máximo cerca de 3.000 chaves por minuto, muito abaixo da memória. A réplica é por disponibilidade | Memória e taxa de acerto |
| Pub/Sub | Um tópico, uma assinatura de pull, um tópico de mensagens mortas | Serviço gerenciado; não há instância para dimensionar. O que se acompanha é o atraso | Mensagens não entregues e idade da mensagem mais antiga da assinatura |

As instâncias de banco usam a série de uso geral personalizada (`db-custom`). Para carga sustentada, acompanhar CPU e conexões; se saturarem, subir a classe numa janela de manutenção.

## Cenários de carga

A tabela usa a fórmula `N = ceil(carga / (capacidade por pod x 0,6))`, com **capacidade por pod de 50 req/s como hipótese conservadora** (a vazão medida numa instância foi de cerca de 198 req/s em hardware sem o limite de 0,5 vCPU do pod) e 60% de utilização alvo. O mínimo é 2 pods por disponibilidade.

| Cenário | Carga | Pods do consolidado | O que muda além disso |
|---|---|---|---|
| Requisito | 50 req/s | 2 | Nada |
| Pico de 3x | 150 req/s | 5 | Verificar conexões ao banco (5 pods x 10 conexões do pool) |
| Pico de 10x (por exemplo uma promoção) | 500 req/s | 17 | Ver abaixo |

A 500 req/s com todas as requisições em cache frio, o banco receberia 500 consultas por segundo de cerca de 1 ms cada, o que ocupa em torno de meio núcleo (ordem de grandeza, a partir do `EXPLAIN`). Os 17 pods abririam cerca de 170 conexões (pool padrão de 10). O limite de conexões do Cloud SQL depende da memória da instância e **deve ser conferido na documentação** do Cloud SQL para a classe escolhida; passando dele, entra um agrupador de conexões (PgBouncer ou o recurso de pool gerenciado do Cloud SQL, se disponível na edição).

**O que quebraria primeiro a 10x** não é a CPU:

1. **O rate limit por IP** (6.000 por minuto, 100 req/s) em memória por instância. Poucos integradores grandes ou um balanceador compartilhando o IP bloqueariam tráfego legítimo. Precisa ir para o API Gateway (quota por cliente) ou para o Redis ([testes.md](testes.md)). O Cloud Armor limita por IP na borda, mas não por cliente.
2. **O pool de conexões** do banco, citado acima.
3. **O custo de saída e de processamento do balanceador**, que cresce com o tráfego ([custos.md](custos.md)).

O Keycloak **não** está no caminho crítico de leitura: os serviços validam o JWT localmente com a chave pública em cache, então o tráfego dele é de emissão de token, proporcional ao número de integradores e não ao número de requisições.

## Escalonamento

- **Horizontal primeiro.** Serviços sem estado, HPA por CPU (60%), com escala para dentro lenta (para não oscilar) e para fora rápida. O Autopilot provisiona os nós; a espera para subir um pod novo (algumas dezenas de segundos por causa dos nós) deve ser medida no primeiro teste e é motivo para manter 2 pods como mínimo.
- **Vertical só para banco.** Subir a classe do Cloud SQL numa janela de manutenção quando CPU ou conexões saturarem; réplica de leitura para o consolidado se o cache não bastar.
- **Buffer do broker.** Um pico de escrita acumula no Pub/Sub e no outbox sem afetar a latência de lançamentos; o preço é o atraso de consistência (`consolidado_evento_lag_seconds`), que o RNF-05 limita em cerca de 5 segundos.

## Como validar

Nenhum número da coluna "hipótese" vale antes disto:

1. Subir a pilha num projeto do Google Cloud com a configuração do cenário B, em `southamerica-east1`.
2. Rodar `tests/load/consolidado.js` apontando para o balanceador, com um pod do consolidado, e achar o ponto em que o p95 passa de 500 ms ou a CPU passa de 60%. Esse é o valor real de "capacidade por pod".
3. Repetir com a escala automática ligada e com o pico de 10x.
4. Medir a vazão do consumidor: publicar um volume conhecido de eventos com o consolidado parado, ligá-lo e cronometrar a drenagem (isto só vale depois de existir o adaptador do Pub/Sub).
5. Registrar os resultados em `docs/evidencias/`, com a data, e atualizar esta página.
