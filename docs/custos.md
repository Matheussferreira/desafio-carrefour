# Estimativa de custos de infraestrutura e licenças

Todos os valores são **estimativas**, em dólares americanos, para o Google Cloud na região `southamerica-east1` (São Paulo), consultadas em **2026-11-05**. Nada aqui foi cobrado nem medido numa conta real. Os preços unitários dos três itens que mais pesam (Cloud SQL, GKE Autopilot e Memorystore) são **oficiais de São Paulo**; o que ainda não tem confirmação aparece como faixa, e o conjunto precisa ser conferido na calculadora antes de qualquer compromisso de orçamento.

## Fonte e como validar

A calculadora oficial é o [Google Cloud Pricing Calculator](https://cloud.google.com/products/calculator). Escolha a região `southamerica-east1` e refaça as tabelas abaixo; anote a data da validação ao lado do resultado. **Validação na calculadora: não realizada.**

Como foi a consulta: os preços de Cloud SQL, GKE Autopilot e Memorystore foram lidos nas **páginas de preço oficiais com a região `southamerica-east1` selecionada na tabela**, em 2026-11-05, sob demanda, 730 horas por mês. Os itens globais (Pub/Sub, Secret Manager, Cloud KMS, Cloud Armor, Cloud Logging, Prometheus gerenciado, Cloud Trace e balanceador) vêm do texto das páginas oficiais. Cada linha das tabelas leva uma classificação:

| Classe | Significado | Como entra na tabela |
|---|---|---|
| **O** | Preço oficial, igual em todas as regiões, ou lido na tabela oficial de São Paulo | Valor único |
| **H** | Hipótese sem fonte | Faixa informada na linha |

| Item | Preço usado (`southamerica-east1`, sob demanda) | Fonte | Classe |
|---|---|---|---|
| Cloud SQL for PostgreSQL, Enterprise, uso geral, zonal | vCPU US$ 0,062 por hora; memória US$ 0,0105 por GiB-hora; SSD US$ 0,000349315 por GiB-hora | [cloud.google.com/sql/pricing](https://cloud.google.com/sql/pricing) | O |
| Cloud SQL, alta disponibilidade regional | vCPU US$ 0,1239 por hora; memória US$ 0,021 por GiB-hora; SSD US$ 0,00069863 por GiB-hora | idem | O |
| Cloud SQL, backup | US$ 0,000164384 por GiB-hora (US$ 0,12 por GiB-mês) | idem | O |
| GKE Autopilot, pods na plataforma padrão | vCPU US$ 0,0707 por hora; memória US$ 0,0078164 por GiB-hora | [cloud.google.com/kubernetes-engine/pricing](https://cloud.google.com/kubernetes-engine/pricing) | O |
| GKE Autopilot, pods Spot na plataforma padrão | vCPU US$ 0,0212 por hora; memória US$ 0,0023449 por GiB-hora | idem | O |
| GKE, taxa de gerenciamento do cluster | US$ 0,10 por hora (US$ 73,00 por mês); crédito gratuito de US$ 74,40 por mês por conta de faturamento, aplicável a **um** cluster Autopilot ou zonal | idem | O |
| Memorystore for Redis, M1 | Basic US$ 0,087 por GiB-hora; Standard US$ 0,146 por GiB-hora | [cloud.google.com/memorystore/docs/redis/pricing](https://cloud.google.com/memorystore/docs/redis/pricing) | O |
| Pub/Sub | US$ 40 por TiB; 10 GiB gratuitos por mês, por conta de faturamento; o preço é o mesmo em todas as regiões | [cloud.google.com/pubsub/pricing](https://cloud.google.com/pubsub/pricing) | O |
| Secret Manager | US$ 0,06 por versão ativa por mês (6 gratuitas); US$ 0,03 por 10 mil acessos (10 mil gratuitos) | [cloud.google.com/secret-manager/pricing](https://cloud.google.com/secret-manager/pricing) | O |
| Cloud KMS | US$ 0,06 por versão de chave de software por mês; US$ 0,03 por 10 mil operações | [cloud.google.com/kms/pricing](https://cloud.google.com/kms/pricing) | O |
| Cloud Armor Standard | US$ 5 por política por mês; US$ 1 por regra por mês; US$ 0,75 por milhão de requisições (política global); regras gerenciadas somam US$ 0,75 por milhão avaliado | [cloud.google.com/armor/pricing](https://cloud.google.com/armor/pricing) | O |
| Cloud Logging | US$ 0,50 por GiB ingerido (50 GiB gratuitos por projeto por mês); retenção acima de 30 dias a US$ 0,01 por GiB por mês | [cloud.google.com/products/observability/pricing](https://cloud.google.com/products/observability/pricing) | O |
| Managed Service for Prometheus | US$ 0,06 por milhão de amostras (faixa de 0 a 50 bilhões) | idem | O |
| Cloud Trace | US$ 0,20 por milhão de spans; 2,5 milhões gratuitos por conta de faturamento | idem | O |
| Balanceador, regras de encaminhamento | US$ 0,025 por hora para as 5 primeiras regras | [cloud.google.com/load-balancing/pricing](https://cloud.google.com/load-balancing/pricing) | O |
| Balanceador, dados processados | US$ 0,008 a 0,012 por GB conforme a região | idem | faixa |

A alta disponibilidade regional do Cloud SQL **dobra** o custo de vCPU, de memória e de armazenamento da instância (instância principal e instância em espera em outra zona), como mostram os preços acima: 0,1239 contra 0,062 por vCPU-hora, 0,021 contra 0,0105 por GiB-hora e 0,00069863 contra 0,000349315 por GiB-hora. O backup não dobra.

## Premissas

- Volume: pico de 50 req/s no consolidado (requisito), cerca de 1 milhão de requisições por dia (30 milhões por mês) e 100 mil lançamentos por dia (3 milhões de eventos por mês). São premissas de dimensionamento, não medidas.
- 730 horas por mês, preço sob demanda, sem desconto por uso comprometido (ver a seção de otimizações).
- Dois bancos PostgreSQL em instâncias Cloud SQL separadas, como pede o [ADR-004](adrs/ADR-004-banco-por-servico.md).
- Quatro componentes de aplicação em GKE Autopilot: `lancamentos`, `lancamentos-relay`, `consolidado` (com o consumidor) e o Keycloak. O tamanho de cada pod é uma **hipótese**; a capacidade medida do consolidado (cerca de 197 a 199 req/s numa instância, em máquina de desenvolvimento, [testes.md](testes.md)) não foi medida no GKE.
- **Um único cluster GKE na conta de faturamento**, o que zera a taxa de gerenciamento pelo crédito (ver abaixo).
- Broker: Pub/Sub ([ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md)), cerca de 3 milhões de mensagens por mês de menos de 1 KB.
- Cloud NAT fora da conta: nenhum componente precisa de saída para a internet ([arquitetura-alvo-cloud.md](arquitetura-alvo-cloud.md)).
- Moeda: dólar. Não incluo impostos, suporte do Google, câmbio nem horas de operação da equipe.

## Taxa de gerenciamento do cluster GKE

A taxa é de US$ 0,10 por hora por cluster, ou **US$ 73,00 por mês** (0,10 x 730). O crédito gratuito de **US$ 74,40 por mês por conta de faturamento** cobre um cluster Autopilot ou zonal, e por isso a taxa entra como **zero** nos cenários abaixo.

**Esse zero só vale enquanto houver um único cluster na conta de faturamento.** Cada cluster adicional soma US$ 73,00 por mês, e o mesmo vale para um cluster regional do modo Standard, que não é coberto pelo crédito. Consequências práticas:

| Situação | Taxa de cluster |
|---|---|
| Um cluster Autopilot na conta | 0,00 (73,00 menos o crédito de 74,40) |
| Homologação e produção em dois clusters na mesma conta | 73,00 por mês (um fica coberto, o outro paga) |
| Dois clusters de produção (por exemplo um por região, se o DR em outra região for aprovado) | 73,00 por mês |
| Cluster regional no modo Standard | 73,00 por mês, sem crédito |

O crédito que sobra (US$ 1,40) não acumula. Se a empresa já tem outro cluster na mesma conta de faturamento, o crédito já está consumido e a taxa desta solução entra por inteiro: confirme com a área de nuvem.

## Licenças

**Zero.** PostgreSQL, Redis, RabbitMQ, Node.js, Keycloak, Prometheus, Grafana, Jaeger e k6 são software livre. No Cloud SQL e no Memorystore a licença do motor está embutida no preço do serviço. O Cloud SQL tem as edições Enterprise e Enterprise Plus, com preços diferentes; esta estimativa usa a Enterprise. A única licença paga a considerar seria a de ferramentas comerciais de observabilidade ou de WAF de terceiros, que esta solução não usa.

## Cenário A: mínimo viável (um ambiente enxuto, sem alta disponibilidade)

Serve para homologação ou para uma operação pequena que aceita parada. **Não atende produção de um banco**: os bancos são de zona única, o Redis é do nível Basic e há um pod de cada serviço.

| Item | Cl. | US$/mês | Cálculo |
|---|---|---|---|
| GKE Autopilot, 4 pods (2,0 vCPU e 4 GiB no total) | O | 126,05 | (2,0 x 0,0707 + 4 x 0,0078164) x 730 |
| GKE, taxa de gerenciamento do cluster | O | 0,00 | 0,10 x 730 = 73,00, menos o crédito de 74,40 (um cluster na conta) |
| Cloud SQL, computação de 2 x `db-custom-1-3840` (1 vCPU e 3,75 GiB), zonal | O | 148,01 | (2 x 0,062 + 7,5 x 0,0105) x 730 |
| Cloud SQL, SSD de 2 x 20 GB, zonal | O | 10,20 | 40 x 0,000349315 x 730 |
| Cloud SQL, backups de 40 GB | O | 4,80 | 40 x 0,000164384 x 730 |
| Memorystore Redis Basic, 1 GiB | O | 63,51 | 0,087 x 730 |
| Balanceador, 1 regra de encaminhamento | O | 18,25 | 0,025 x 730 |
| Balanceador, 50 GB processados | faixa | 0,40 a 0,60 | 50 x 0,008 a 0,012 |
| Cloud Armor Standard, 1 política, 3 regras, 30 M de requisições | O | 30,50 | 5 + 3 x 1 + 30 x 0,75 |
| Saída para a internet, 50 GB | H | 6,00 a 11,50 | 50 x 0,12 a 0,23 |
| Managed Prometheus, 1.000 séries a cada 15 s | O | 10,37 | 1.000 x 172.800 amostras x 0,06 por milhão |
| Pub/Sub, cerca de 6 GiB de vazão | O | 0,00 | dentro dos 10 GiB gratuitos |
| Secret Manager, 5 versões ativas | O | 0,00 | abaixo das 6 gratuitas |
| Cloud Logging, 10 GiB | O | 0,00 | abaixo dos 50 GiB gratuitos |
| Artifact Registry, 1 GB | H | 0,05 a 0,25 | hipótese |
| **Total estimado** | | **cerca de 418 a 424** (ponto médio 421) | soma dos itens: 411,69 de valores únicos mais 6,45 a 12,35 das faixas |

Observações do cenário A:
- Os três produtos de preço regional (GKE, Cloud SQL e Memorystore) somam **352,57** e entram com valor único. A faixa que sobra, de menos de US$ 6, vem só do balanceador (dados processados), da saída para a internet e do Artifact Registry.
- O Redis do nível Basic não tem réplica nem failover.
- O Pub/Sub custa zero porque cerca de 3 milhões de mensagens por mês de menos de 1 KB ficam em alguns GiB (publicação e entrega), abaixo da franquia gratuita de 10 GiB por mês por conta de faturamento. A franquia é compartilhada com outros projetos da mesma conta.
- Com um segundo cluster na mesma conta, some 73,00 (ver a seção da taxa de cluster).

## Cenário B: produção com alta disponibilidade

Três zonas na região, dois ou mais pods por serviço, bancos com HA regional, Redis Standard, criptografia com chaves próprias (CMEK) e trilha de auditoria.

| Item | Cl. | US$/mês | Cálculo |
|---|---|---|---|
| GKE Autopilot, 8 pods (4,5 vCPU e 9 GiB no total) | O | 283,60 | (4,5 x 0,0707 + 9 x 0,0078164) x 730 |
| GKE, taxa de gerenciamento do cluster | O | 0,00 | 0,10 x 730 = 73,00, menos o crédito de 74,40 (um cluster na conta) |
| Cloud SQL, computação de 2 x `db-custom-2-7680` (2 vCPU e 7,5 GiB), HA regional | O | 591,74 | (4 x 0,1239 + 15 x 0,021) x 730 |
| Cloud SQL, SSD de 2 x 50 GB, HA | O | 51,00 | 100 x 0,00069863 x 730 |
| Cloud SQL, backups e PITR, 100 GB | O | 12,00 | 100 x 0,000164384 x 730 |
| Memorystore Redis Standard, 1 GiB | O | 106,58 | 0,146 x 730 |
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
| **Total estimado** | | **cerca de 1.165 a 1.181** (ponto médio 1.173) | soma dos itens: 1.149,78 de valores únicos mais 15,70 a 30,75 das faixas |

Observações do cenário B:
- O **Cloud SQL domina o custo** (cerca de 56% do total: 654,74 de cerca de 1.170). É a consequência de ter dois bancos com HA regional, como pede o ADR-004. O GKE vem em seguida (cerca de 24%) e o Memorystore Standard em terceiro (cerca de 9%). O broker, que na alternativa com RabbitMQ no GKE custaria algumas centenas de dólares, aqui é praticamente zero.
- Os três produtos de preço regional somam **1.044,92** e entram com valor único. A faixa que sobra, de cerca de US$ 15 de largura, vem do balanceador, da saída para a internet, do Cloud Storage e do Artifact Registry, todos de peso pequeno.
- Os 18 spans por trace foram medidos num `POST /lancamentos` que atravessa API, relay e consolidado (ver [observabilidade.md](observabilidade.md)). A amostragem de 5% é premissa.
- As 1.000 e 1.500 séries do Prometheus são **hipóteses de volume**; o número real depende dos rótulos das métricas. O preço por amostra é oficial.
- O Cloud Armor com regras gerenciadas (WAF pré-configurado) cobra por requisição avaliada, o que dobra a parcela por requisição.
- Com um segundo cluster na mesma conta (por exemplo homologação junto com produção), some 73,00 (ver a seção da taxa de cluster).

## Itens sem preço confirmado, fora dos totais

Estes itens **não entram nos totais** e precisam ser levantados na calculadora antes de qualquer proposta:

| Item | Quando entra | O que fazer |
|---|---|---|
| API Gateway | Se a quota por cliente ficar no gateway | Calcular por milhão de chamadas na calculadora |
| Apigee | Só se houver muitos integradores externos com portal e análise | Calcular na calculadora; tende a ser muito maior que o API Gateway |
| Identity Platform | Não se aplica ao consumo por *client credentials* | Ver a comparação abaixo |
| Cloud Monitoring, políticas de alerta e verificações de disponibilidade | Produção | Confirmar o que é gratuito |
| Cloud DNS | Produção | Calcular por zona e por consulta |
| Cloud SQL Enterprise Plus | Se a empresa exigir a disponibilidade e a manutenção sem parada da edição superior | Calcular na calculadora |
| Logs de auditoria de acesso a dados (Cloud SQL, Secret Manager, KMS) | Auditoria completa | O volume ingerido é premissa; se passar de 60 GiB por mês, entra a faixa paga do Logging |
| Descontos por uso comprometido | Operação contínua | Calcular na calculadora; não estimo percentual |
| Cloud NAT | Só se um componente precisar de saída para a internet | Referência da página: US$ 0,045 por GiB, mais o custo por IP; 100 GB seriam cerca de US$ 4,50 de dados |
| Cluster adicional | Segundo cluster na mesma conta | US$ 73,00 por mês por cluster (seção da taxa de cluster) |

## Gerenciado ou auto gerenciado

### Pub/Sub ou RabbitMQ no GKE

O RabbitMQ em três pods de 1 vCPU e 2 GiB, no preço confirmado do Autopilot em São Paulo:

| Parcela | Cálculo | US$/mês |
|---|---|---|
| vCPU, 3 x 1 | 3 x 0,0707 x 730 | 154,83 |
| Memória, 3 x 2 GiB | 6 x 0,0078164 x 730 | 34,24 |
| **Pods** | | **189,07** |
| Discos SSD, 3 x 50 GB (hipótese H) | 150 GB x 0,17 a 0,35 | 25,50 a 52,50 |
| **Total** | | **214,57 a 241,57** |

A taxa de cluster não entra, porque os pods rodam no mesmo cluster da aplicação.

| | Pub/Sub | RabbitMQ em 3 pods no GKE Autopilot |
|---|---|---|
| Custo mensal estimado | cerca de 0 neste volume (10 vezes o volume: cerca de 1,95) | **214,57 a 241,57** (pods 189,07 mais discos) |
| Quem opera | O Google | A equipe: atualização, filas de quórum, volumes, partição de rede, disco cheio, backup |
| Código | Exige o adaptador do [ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md) | O código de hoje funciona sem mudança |
| Risco | Baixo de operação; médio de semântica (tópico sem assinatura descarta; contagem de tentativas na DLQ) | Médio a alto de operação |

A diferença de custo é de cerca de 215 a 242 dólares por mês, e a decisão pesa mais em **operação e em código**: o Pub/Sub tira o cluster da equipe, ao preço de um adaptador novo e do desvio entre o broker dos testes e o de produção. As horas de operação do RabbitMQ no GKE não estão na conta.

### Keycloak no GKE ou Identity Platform

| | Keycloak no GKE (2 pods de 1 vCPU e 2 GiB) | Identity Platform |
|---|---|---|
| Custo mensal estimado | 126,05 de pods (2 x 0,0707 + 4 x 0,0078164, x 730), mais o banco (um terceiro banco na instância de lançamentos) | Cobrança por usuário ativo mensal (preço não confirmado) |
| Serve a *client credentials* | **Sim.** É o que o código usa | **Não é o caso de uso.** O produto é voltado à autenticação de usuários finais; não confirmei suporte ao fluxo de máquina a máquina e, se não houver, ele não substitui o Keycloak aqui |
| Quem opera | A equipe: atualização, realm, HA, TLS | O Google |

Para um serviço dentro do próprio Google Cloud existe uma terceira via, os tokens de identidade (OIDC) emitidos para contas de serviço, que dispensam o Keycloak, mas não carregam o claim `comerciante_id` nem os escopos; esse vínculo teria de ficar em configuração dos serviços. Isso muda a validação do JWT ([ADR-010](adrs/ADR-010-autenticacao-e-autorizacao-de-consumo.md)) e não serve a integradores externos. Por isso a proposta mantém o Keycloak. Confirme na documentação do Identity Platform antes de decidir diferente.

## Otimizações com valor calculável e práticas de FinOps

| Otimização | Efeito | Cálculo |
|---|---|---|
| Pods Spot (ver a seção abaixo) | Homologação inteira (cenário A): **US$ 126,05 para US$ 37,80, economia de US$ 88,25 (cerca de 70%)**. Produção: só relay e consumidor, economia de US$ 22,06 no relay | Cálculos na seção "Pods Spot". Preços Spot oficiais de São Paulo (classe O) |
| Pub/Sub no lugar de RabbitMQ no GKE | economia de cerca de US$ 215 a 242 por mês | ver a comparação acima; troca custo de operação por trabalho de adaptador |
| Sem Cloud NAT | evita a taxa por IP e por GiB | nenhum componente precisa de saída para a internet |
| Um cluster por conta de faturamento | evita US$ 73,00 por mês por cluster adicional | o crédito de US$ 74,40 cobre só um cluster; agrupar ambientes em namespaces do mesmo cluster tem custo de isolamento a avaliar |
| Descontos por uso comprometido | não calculado | Depois de 3 a 6 meses de uso estável, avaliar com os dados reais |

### Pods Spot

Preço oficial de São Paulo, lido na mesma página e data dos demais: vCPU US$ 0,0212 por hora e memória US$ 0,0023449 por GiB-hora, contra 0,0707 e 0,0078164 sob demanda (cerca de 30%).

| Caso | Sob demanda | Spot | Economia | Cálculo do Spot |
|---|---|---|---|---|
| Cenário A inteiro (2,0 vCPU e 4 GiB) | 126,05 | **37,80** | **88,25** | (2,0 x 0,0212 + 4 x 0,0023449) x 730 |
| Relay no cenário B (2 pods de 0,25 vCPU e 0,5 GiB, 0,5 vCPU e 1 GiB no total) | 31,51 | **9,45** | **22,06** | (0,5 x 0,0212 + 1 x 0,0023449) x 730 |

**Spot só serve ao que tolera interrupção.** O Google pode retomar um pod Spot a qualquer momento, com aviso curto. Para esta solução:

| Componente | Spot? | Por quê |
|---|---|---|
| Consumidor | **Sim, com ressalva** | Idempotente ([ADR-007](adrs/ADR-007-idempotencia.md)): a mensagem em processamento volta e é reaplicada sem duplicar. A ressalva é que hoje o consumidor roda **dentro do pod do consolidado**, junto com a API de leitura; usar Spot só para ele exige separá-lo num Deployment próprio, e isso não existe no código. Enquanto estiver junto, o pod do consolidado não pode ser Spot em produção |
| Relay | **Sim, com ressalva** | Retomar o relay só atrasa a publicação, e `FOR UPDATE SKIP LOCKED` com duas réplicas evita a duplicação ([ADR-008](adrs/ADR-008-relay-processo-separado.md)). A ressalva é o atraso de consistência (`consolidado_evento_lag_seconds`, que o RNF-05 limita em cerca de 5 s) durante a troca de pod, e a retomada simultânea das duas réplicas deixaria o outbox acumular até um pod novo subir (dezenas de segundos, a medir). O encerramento gracioso existe (RNF-10), mas o prazo de aviso do Spot não foi confirmado e pode ser menor que o do desligamento normal. Manter ao menos uma réplica sob demanda |
| API de lançamentos | **Não** | Está no caminho de escrita e a disponibilidade do lançamentos é requisito (RNF-01) |
| API do consolidado | **Não** | Está no caminho de leitura do requisito de 50 req/s |
| Keycloak | **Não** | A emissão de token para integradores depende dele, e o modo de produção tem estado e sessão |

O **cenário A**, por ser homologação que aceita parada, pode usar Spot em tudo: é o caso da primeira linha. Nenhum número de Spot deste documento foi medido; o risco de interrupção não tem preço na tabela e precisa ser observado em operação.

Práticas de governança de custo (aproveitadas de um estudo anterior do mesmo autor, sem os números dele):
- **Rótulos obrigatórios** em todos os recursos: `env`, `owner`, `cost-center`, `app`, `team`, para atribuir custo por ambiente e por equipe.
- **Orçamento e alertas** no Cloud Billing por ambiente.
- **Recommender** para revisão trimestral de dimensionamento.
- **Desligar ambientes de não produção** fora do horário comercial.
- **Custo por transação** como indicador: custo mensal dividido pelos lançamentos do mês.

## O que este documento não afirma

- Não há custo medido numa conta do Google Cloud. Os totais são aritmética sobre preços de tabela e premissas de volume.
- Os preços unitários de Cloud SQL, GKE Autopilot e Memorystore são os oficiais de São Paulo lidos em 2026-11-05, mas a **validação na calculadora não foi feita**, e preços mudam.
- O tamanho dos pods e dos bancos é hipótese a validar com teste de carga no próprio Google Cloud.
- A taxa de cluster zerada depende de haver um único cluster na conta de faturamento.
- Ainda são hipóteses (classe H): armazenamento e saída para a internet, Artifact Registry, Cloud Storage de auditoria e o volume de séries do Prometheus.
- Não incluo impostos, suporte do Google, câmbio nem horas de operação da equipe.
