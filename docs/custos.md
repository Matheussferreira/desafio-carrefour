# Estimativa de custos de infraestrutura e licenças

Todos os valores são **estimativas**, em dólares americanos, para o Google Cloud na região `southamerica-east1` (São Paulo), consultadas em **2026-11-05**. Nada aqui foi cobrado nem medido numa conta real. O que não pôde ser confirmado em fonte oficial aparece como **faixa**, com a regra abaixo, e precisa ser validado na calculadora antes de qualquer compromisso de orçamento.

## Fonte e como validar

A calculadora oficial é o [Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator). Escolha a região `southamerica-east1` e refaça as tabelas abaixo; anote a data da validação ao lado do resultado. **Validação na calculadora: não realizada.**

Como foi a consulta: as páginas de preço do Google são montadas por JavaScript e o catálogo de preços por API exige chave, então os valores vieram do **texto das páginas oficiais obtido por busca** e, no caso do Cloud SQL, de um **agregador de terceiros**. Por isso cada linha leva uma classificação:

| Classe | Significado | Como entra na tabela |
|---|---|---|
| **O** | Preço oficial, igual em todas as regiões (confirmado em texto da página do produto) | Valor único |
| **R** | Preço oficial, mas a região da tabela consultada não foi confirmada como São Paulo | De 1,0 a 1,6 vezes o valor de referência. O fator de 1,6 é uma **hipótese** de prêmio regional, a validar |
| **T** | Dado de terceiros para São Paulo (não oficial, sem data) | De 1,0 a 1,25 vezes o valor de referência |
| **H** | Hipótese sem fonte | Faixa informada na linha |

| Item | Referência usada | Fonte | Classe |
|---|---|---|---|
| Pub/Sub | US$ 40 por TiB; 10 GiB gratuitos por mês, por conta de faturamento; o preço é o mesmo em todas as regiões | [cloud.google.com/pubsub/pricing](https://cloud.google.com/pubsub/pricing) | O |
| Secret Manager | US$ 0,06 por versão ativa por mês (6 gratuitas); US$ 0,03 por 10 mil acessos (10 mil gratuitos) | [cloud.google.com/secret-manager/pricing](https://cloud.google.com/secret-manager/pricing) | O |
| Cloud KMS | US$ 0,06 por versão de chave de software por mês; US$ 0,03 por 10 mil operações | [cloud.google.com/kms/pricing](https://cloud.google.com/kms/pricing) | O |
| Cloud Armor Standard | US$ 5 por política por mês; US$ 1 por regra por mês; US$ 0,75 por milhão de requisições (política global); regras gerenciadas somam US$ 0,75 por milhão avaliado | [cloud.google.com/armor/pricing](https://cloud.google.com/armor/pricing) | O |
| Cloud Logging | US$ 0,50 por GiB ingerido (50 GiB gratuitos por projeto por mês); retenção acima de 30 dias a US$ 0,01 por GiB por mês | [cloud.google.com/products/observability/pricing](https://cloud.google.com/products/observability/pricing) | O |
| Managed Service for Prometheus | US$ 0,06 por milhão de amostras (faixa de 0 a 50 bilhões) | idem | O |
| Cloud Trace | US$ 0,20 por milhão de spans; 2,5 milhões gratuitos por conta de faturamento | idem | O |
| Balanceador, regras de encaminhamento | US$ 0,025 por hora para as 5 primeiras regras | [cloud.google.com/load-balancing/pricing](https://cloud.google.com/load-balancing/pricing) | O |
| Balanceador, dados processados | US$ 0,008 a 0,012 por GB conforme a região | idem | faixa |
| GKE Autopilot | US$ 0,0445 por vCPU-hora e US$ 0,0049225 por GiB-hora (perfil de uso geral, pods sob demanda) | [cloud.google.com/kubernetes-engine/pricing](https://cloud.google.com/kubernetes-engine/pricing) | R |
| Memorystore for Redis, Standard M1 | US$ 0,064 por GiB-hora | [cloud.google.com/memorystore/docs/redis/pricing](https://cloud.google.com/memorystore/docs/redis/pricing) | R |
| Cloud SQL for PostgreSQL, Enterprise, São Paulo | US$ 74 por mês para 1 vCPU e 3,75 GB, US$ 148 para 2 vCPU e 7,5 GB, só computação, sob demanda, instância única | [bytebase.com/dbcost](https://www.bytebase.com/dbcost/cloudsql/instance/db-standard-2/) (terceiros) | T |

A alta disponibilidade regional do Cloud SQL **dobra** o custo de computação e de armazenamento da instância (uma instância principal e uma em espera em outra zona). Confirme essa regra na página de preços do Cloud SQL.

## Premissas

- Volume: pico de 50 req/s no consolidado (requisito), cerca de 1 milhão de requisições por dia (30 milhões por mês) e 100 mil lançamentos por dia (3 milhões de eventos por mês). São premissas de dimensionamento, não medidas.
- 730 horas por mês, preço sob demanda, sem desconto por uso comprometido (ver a seção de otimizações).
- Dois bancos PostgreSQL em instâncias Cloud SQL separadas, como pede o [ADR-004](adrs/ADR-004-banco-por-servico.md).
- Quatro componentes de aplicação em GKE Autopilot: `lancamentos`, `lancamentos-relay`, `consolidado` (com o consumidor) e o Keycloak. O tamanho de cada pod é uma **hipótese**; a capacidade medida do consolidado (cerca de 197 a 199 req/s numa instância, em máquina de desenvolvimento, [testes.md](testes.md)) não foi medida no GKE.
- Broker: Pub/Sub ([ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md)), cerca de 3 milhões de mensagens por mês de menos de 1 KB.
- Cloud NAT fora da conta: nenhum componente precisa de saída para a internet ([arquitetura-alvo-cloud.md](arquitetura-alvo-cloud.md)).
- Moeda: dólar. Não incluo impostos, suporte do Google, câmbio nem horas de operação da equipe.

## Licenças

**Zero.** PostgreSQL, Redis, RabbitMQ, Node.js, Keycloak, Prometheus, Grafana, Jaeger e k6 são software livre. No Cloud SQL e no Memorystore a licença do motor está embutida no preço do serviço. O Cloud SQL tem as edições Enterprise e Enterprise Plus, com preços diferentes; esta estimativa usa a Enterprise. A única licença paga a considerar seria a de ferramentas comerciais de observabilidade ou de WAF de terceiros, que esta solução não usa.

## Cenário A: mínimo viável (um ambiente enxuto, sem alta disponibilidade)

Serve para homologação ou para uma operação pequena que aceita parada. **Não atende produção de um banco**: os bancos são de zona única, o Redis é do nível Basic e há um pod de cada serviço.

| Item | Cl. | US$/mês | Cálculo |
|---|---|---|---|
| GKE Autopilot, 4 pods (2,0 vCPU e 4 GiB no total) | R | 79,34 a 126,95 | (2,0 x 0,0445 + 4 x 0,0049225) x 730 |
| Cloud SQL, 2 x `db-custom-1-3840`, zona única | T | 148,00 a 185,00 | 2 x 74 |
| Cloud SQL, SSD de 2 x 20 GB | H | 6,80 a 14,00 | 40 GB x 0,17 a 0,35 |
| Cloud SQL, backups de 40 GB | H | 3,20 a 8,00 | 40 GB x 0,08 a 0,20 |
| Memorystore Redis Basic, 1 GiB | H | 23,36 a 74,75 | 0,5 a 1,6 x (0,064 x 730) |
| Balanceador, 1 regra de encaminhamento | O | 18,25 | 0,025 x 730 |
| Balanceador, 50 GB processados | faixa | 0,40 a 0,60 | 50 x 0,008 a 0,012 |
| Cloud Armor Standard, 1 política, 3 regras, 30 M de requisições | O | 30,50 | 5 + 3 x 1 + 30 x 0,75 |
| Saída para a internet, 50 GB | H | 6,00 a 11,50 | 50 x 0,12 a 0,23 |
| Managed Prometheus, 1.000 séries a cada 15 s | O | 10,37 | 1.000 x 172.800 amostras x 0,06 por milhão |
| Pub/Sub, cerca de 6 GiB de vazão | O | 0,00 | dentro dos 10 GiB gratuitos |
| Secret Manager, 5 versões ativas | O | 0,00 | abaixo das 6 gratuitas |
| Cloud Logging, 10 GiB | O | 0,00 | abaixo dos 50 GiB gratuitos |
| Artifact Registry, 1 GB | H | 0,05 a 0,25 | hipótese |
| **Total estimado** | | **cerca de 326 a 480** (ponto médio 403) | |

Observações do cenário A:
- A faixa larga vem sobretudo do GKE Autopilot e do Memorystore (classes R e H) e do Cloud SQL (classe T). O limite inferior usa o valor de referência sem prêmio regional, e o superior supõe o prêmio de 1,6 vez, que é hipótese.
- O Redis do nível Basic não tem réplica nem failover. O preço do Basic não foi confirmado; a faixa o coloca entre metade do Standard e o Standard com o prêmio regional.
- O Pub/Sub custa zero porque cerca de 3 milhões de mensagens por mês de menos de 1 KB ficam em alguns GiB (publicação e entrega), abaixo da franquia gratuita de 10 GiB por mês por conta de faturamento. A franquia é compartilhada com outros projetos da mesma conta.

## Cenário B: produção com alta disponibilidade

Três zonas na região, dois ou mais pods por serviço, bancos com HA regional, Redis Standard, criptografia com chaves próprias (CMEK) e trilha de auditoria.

| Item | Cl. | US$/mês | Cálculo |
|---|---|---|---|
| GKE Autopilot, 8 pods (4,5 vCPU e 9 GiB no total) | R | 178,52 a 285,64 | (4,5 x 0,0445 + 9 x 0,0049225) x 730 |
| Cloud SQL, 2 x `db-custom-2-7680`, HA regional | T | 592,00 a 740,00 | 2 bancos x 2 (HA) x 148 |
| Cloud SQL, SSD de 2 x 50 GB, dobrado pela HA | H | 34,00 a 70,00 | 200 GB x 0,17 a 0,35 |
| Cloud SQL, backups e PITR, 100 GB | H | 8,00 a 20,00 | 100 GB x 0,08 a 0,20 |
| Memorystore Redis Standard, 1 GiB | R | 46,72 a 74,75 | 0,064 x 730 |
| Balanceador, 1 regra de encaminhamento | O | 18,25 | 0,025 x 730 |
| Balanceador, 200 GB processados | faixa | 1,60 a 2,40 | 200 x 0,008 a 0,012 |
| Cloud Armor Standard, 1 política, 6 regras, 30 M de requisições e regras gerenciadas | O | 56,00 | 5 + 6 x 1 + 30 x 0,75 + 30 x 0,75 |
| Saída para a internet, 100 GB | H | 12,00 a 23,00 | 100 x 0,12 a 0,23 |
| Cloud KMS (CMEK), 6 chaves e 1 milhão de operações | O | 3,36 | 6 x 0,06 + 100 x 0,03 |
| Secret Manager, 16 versões ativas | O | 0,60 | (16 - 6) x 0,06 |
| Cloud Logging, 60 GiB com retenção de 90 dias | O | 6,20 | (60 - 50) x 0,50 + 60 x 2 x 0,01 |
| Managed Prometheus, 1.500 séries a cada 15 s | O | 15,55 | 1.500 x 172.800 amostras x 0,06 por milhão |
| Cloud Trace, 5% de amostragem e 18 spans por trace | O | 4,90 | (27 milhões - 2,5 milhões) x 0,20 por milhão |
| Pub/Sub, cerca de 6 GiB de vazão | O | 0,00 | dentro da franquia; a 10 vezes o volume seria cerca de 1,95 |
| Cloud Storage, logs de auditoria com retenção bloqueada, 100 GB | H | 2,00 a 5,00 | 100 GB x 0,02 a 0,05 |
| Artifact Registry, 2 GB | H | 0,10 a 0,35 | hipótese |
| **Total estimado** | | **cerca de 980 a 1.326** (ponto médio 1.153) | |

Observações do cenário B:
- O **Cloud SQL domina o custo** (cerca de 65% do total: 634 de 980 no limite inferior, 830 de 1.326 no superior). É a consequência de ter dois bancos com HA regional, como pede o ADR-004. O broker, que na alternativa com RabbitMQ gerenciado seria o maior item, aqui é praticamente zero.
- Os 18 spans por trace foram medidos num `POST /lancamentos` que atravessa API, relay e consolidado (ver [observabilidade.md](observabilidade.md)). A amostragem de 5% é premissa.
- As 1.000 e 1.500 séries do Prometheus são **hipóteses de volume**; o número real depende dos rótulos das métricas. O preço por amostra é oficial.
- O Cloud Armor com regras gerenciadas (WAF pré-configurado) cobra por requisição avaliada, o que dobra a parcela por requisição.

## Itens sem preço confirmado, fora dos totais

Não consegui confirmar preço para estes itens, então **não entram nos totais** e precisam ser levantados na calculadora antes de qualquer proposta:

| Item | Quando entra | O que fazer |
|---|---|---|
| Taxa de gerenciamento do cluster GKE | Sempre | A página de preços cita uma taxa por cluster-hora com um crédito mensal por conta de faturamento. Confirme o valor e se o crédito cobre o cluster desta solução |
| API Gateway | Se a quota por cliente ficar no gateway | Calcular por milhão de chamadas na calculadora |
| Apigee | Só se houver muitos integradores externos com portal e análise | Calcular na calculadora; tende a ser muito maior que o API Gateway |
| Identity Platform | Não se aplica ao consumo por *client credentials* | Ver a comparação abaixo |
| Cloud Monitoring, políticas de alerta e verificações de disponibilidade | Produção | Confirmar o que é gratuito |
| Cloud DNS | Produção | Calcular por zona e por consulta |
| Cloud SQL Enterprise Plus | Se a empresa exigir a disponibilidade e a manutenção sem parada da edição superior | Calcular na calculadora |
| Logs de auditoria de acesso a dados (Cloud SQL, Secret Manager, KMS) | Auditoria completa | O volume ingerido é premissa; se passar de 60 GiB por mês, entra a faixa paga do Logging |
| Descontos por uso comprometido | Operação contínua | Calcular na calculadora; não estimo percentual |
| Cloud NAT | Só se um componente precisar de saída para a internet | Referência da página: US$ 0,045 por GiB, mais o custo por IP; 100 GB seriam cerca de US$ 4,50 de dados |

## Gerenciado ou auto gerenciado

### Pub/Sub ou RabbitMQ no GKE

| | Pub/Sub | RabbitMQ em 3 pods no GKE Autopilot |
|---|---|---|
| Custo mensal estimado | cerca de 0 neste volume (10 vezes o volume: cerca de 1,95) | pods: 119,02 a 190,42 (3 x 1 vCPU e 2 GiB); discos SSD de 3 x 50 GB: 25,50 a 52,50 (hipótese H); **total 144,52 a 242,92** |
| Quem opera | O Google | A equipe: atualização, filas de quórum, volumes, partição de rede, disco cheio, backup |
| Código | Exige o adaptador do [ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md) | O código de hoje funciona sem mudança |
| Risco | Baixo de operação; médio de semântica (tópico sem assinatura descarta; contagem de tentativas na DLQ) | Médio a alto de operação |

A diferença de custo é pequena em valor absoluto (algumas centenas de dólares por mês), e a decisão pesa mais em **operação e em código**: o Pub/Sub tira o cluster da equipe, ao preço de um adaptador novo e do desvio entre o broker dos testes e o de produção. As horas de operação do RabbitMQ no GKE não estão na conta.

### Keycloak no GKE ou Identity Platform

| | Keycloak no GKE (2 pods de 1 vCPU e 2 GiB) | Identity Platform |
|---|---|---|
| Custo mensal estimado | 79,34 a 126,95 de pods, mais o banco (um terceiro banco na instância de lançamentos) | Cobrança por usuário ativo mensal (preço não confirmado) |
| Serve a *client credentials* | **Sim.** É o que o código usa | **Não é o caso de uso.** O produto é voltado à autenticação de usuários finais; não confirmei suporte ao fluxo de máquina a máquina e, se não houver, ele não substitui o Keycloak aqui |
| Quem opera | A equipe: atualização, realm, HA, TLS | O Google |

Para um serviço dentro do próprio Google Cloud existe uma terceira via, os tokens de identidade (OIDC) emitidos para contas de serviço, que dispensam o Keycloak, mas não carregam o claim `comerciante_id` nem os escopos; esse vínculo teria de ficar em configuração dos serviços. Isso muda a validação do JWT ([ADR-010](adrs/ADR-010-autenticacao-e-autorizacao-de-consumo.md)) e não serve a integradores externos. Por isso a proposta mantém o Keycloak. Confirme na documentação do Identity Platform antes de decidir diferente.

## Otimizações com valor calculável e práticas de FinOps

| Otimização | Efeito | Cálculo |
|---|---|---|
| Pods Spot no ambiente de homologação (cenário A) | A parcela de CPU cai de US$ 64,97 para US$ 19,42 por mês, **economia de US$ 45,55** | 2,0 vCPU x 0,0133 x 730 contra 2,0 x 0,0445 x 730. A referência de US$ 0,0133 por vCPU-hora de pod Spot é classe R e a memória não foi confirmada. Pods Spot podem ser retomados a qualquer momento: **só para ambiente que aceita parada**, nunca para o relay ou o consumidor em produção |
| Pub/Sub no lugar de RabbitMQ no GKE | economia de cerca de US$ 145 a 243 por mês | ver a comparação acima; troca custo de operação por trabalho de adaptador |
| Sem Cloud NAT | evita a taxa por IP e por GiB | nenhum componente precisa de saída para a internet |
| Descontos por uso comprometido | não calculado | Depois de 3 a 6 meses de uso estável, avaliar com os dados reais |

Práticas de governança de custo (aproveitadas de um estudo anterior do mesmo autor, sem os números dele):
- **Rótulos obrigatórios** em todos os recursos: `env`, `owner`, `cost-center`, `app`, `team`, para atribuir custo por ambiente e por equipe.
- **Orçamento e alertas** no Cloud Billing por ambiente.
- **Recommender** para revisão trimestral de dimensionamento.
- **Desligar ambientes de não produção** fora do horário comercial.
- **Custo por transação** como indicador: custo mensal dividido pelos lançamentos do mês.

## O que este documento não afirma

- Não há custo medido numa conta do Google Cloud. Os totais são aritmética sobre preços de referência e premissas de volume.
- A maior parte da incerteza está nos preços do GKE Autopilot, do Cloud SQL e do Memorystore em São Paulo, que não consegui confirmar em fonte oficial; a faixa existe por isso.
- O tamanho dos pods e dos bancos é hipótese a validar com teste de carga no próprio Google Cloud.
- Não incluo impostos, suporte do Google, câmbio nem horas de operação da equipe.
