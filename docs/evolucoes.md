# Evoluções futuras

Lista priorizada do que ficou de fora de propósito ou foi descoberto durante o desenvolvimento, cada item com o **gatilho** que justifica fazê-lo. A regra é: não construir antes de o gatilho acontecer. Esforço é uma ordem de grandeza relativa (P pequeno, M médio, G grande), não uma estimativa em horas.

Os limiares numéricos marcados como "heurística" são pontos de partida para a discussão, não medições desta solução.

## Prioridade 0: antes de ir para produção

São correções e provas que o próprio projeto já identificou como lacuna. O gatilho é a decisão de colocar a solução em produção.

| Item | Por que | Gatilho | Esforço |
|---|---|---|---|
| **Adaptador do Pub/Sub** | O broker de produção no Google Cloud é o Pub/Sub, mas o código só tem o adaptador de RabbitMQ. Sem ele, a arquitetura alvo não roda ([ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md)). Inclui interface de broker, publicador com confirmação, assinante com controle de fluxo, tratamento de falha transitória sem estourar o limite de tentativas da DLQ, script de reprocessamento e testes de contrato rodando nos dois adaptadores | Antes do primeiro ambiente no Google Cloud | M |
| Infraestrutura como código do Google Cloud | Hoje não existe IaC no repositório. Os documentos de [custos](custos.md), [dimensionamento](dimensionamento.md) e [recuperação de desastres](disaster-recovery.md) descrevem um ambiente que ninguém consegue criar de forma reproduzível. Tópicos, assinaturas e permissões do Pub/Sub têm de nascer por aqui | Antes do primeiro ambiente num projeto do Google Cloud | G |
| Logs no formato do Cloud Logging | O Cloud Logging lê a gravidade de `severity` e o texto de `message`; o pino emite `level` numérico e `msg`, e falta o campo de correlação com o trace ([observabilidade.md](observabilidade.md)) | Antes do primeiro ambiente no Google Cloud | P |
| Decisão de residência de dados para o DR | A única região do Brasil é `southamerica-east1`; DR em outra região é transferência internacional de dados pessoais ([disaster-recovery.md](disaster-recovery.md)) | Antes de qualquer promessa de recuperação de falha regional | P (decisão do compliance) |
| Validação de custos e capacidade no Google Cloud | Todos os números de [custos.md](custos.md) e [dimensionamento.md](dimensionamento.md) são estimativas ou hipóteses | Antes de qualquer compromisso de orçamento, com a calculadora do Google Cloud e um teste de carga no GKE | M |
| Rate limit distribuído e por cliente | O limite é em memória, por instância e por IP; atrás de um balanceador todos os clientes compartilham um IP ([seguranca.md](seguranca.md)) | Mais de uma réplica por serviço, o que é o mínimo de produção | M |
| Rodar o CI no GitHub | O fluxo foi escrito e só teve a sintaxe validada | Quando o repositório for publicado | P |

## Prioridade 1: primeiros meses de operação

| Item | O que resolve | Gatilho | Esforço |
|---|---|---|---|
| Atualizar o Node.js e o Express | O Node.js 20 sai do suporte pelo calendário público do Node.js (previsto para abril de 2026, a confirmar) e o Express 4 está em manutenção ([ADR-013](adrs/ADR-013-stack-tecnologica.md)). Subir para a LTS vigente e avaliar o Express 5 | Antes do primeiro ambiente de produção, ou ao primeiro aviso de segurança sem correção para a versão atual | P |
| Consumidor em Deployment próprio | Hoje o consumidor roda dentro do pod do consolidado, junto com a API de leitura. Separá-lo permitiria escalar cada um pelo seu sinal (CPU da API, atraso da assinatura para o consumidor) e tornaria o consumidor elegível a pods Spot, que tolera por ser idempotente ([custos.md](custos.md)) | Querer usar pods Spot no consumidor, ou o atraso da assinatura exigir escala independente da API de leitura (`consolidado_evento_lag_seconds` acima do limite do RNF-05 com a API ociosa) | P |
| Retenção do outbox e de `eventos_processados` | Ambas crescem sem limite (cerca de 0,8 KB por evento só no outbox, medido). Sem rotina, o disco de 50 GB dura cerca de um ano a 100 mil lançamentos por dia (extrapolação) | Ocupação do disco acima de 50% ou o outbox passar de um prazo acordado | M |
| Advisory lock nas migrations | Duas réplicas subindo juntas podem colidir ao registrar a migration | Quando houver mais de uma réplica, junto com o item de rate limit | P |
| Retentativa de erro permanente sem bloquear a fila | Falha de banco já não bloqueia nem vai para a DLQ ([ADR-011](adrs/ADR-011-falha-transitoria-nao-vai-para-dlq.md)), mas um erro permanente ainda segura o consumidor por até 7 s (3 retentativas com `prefetch=1`) antes da DLQ | Observar `consolidado_consumer_retries_total` frequente, ou lag alto sem causa de carga | M |
| Roteamento dos alertas (Alertmanager ou canais do Cloud Monitoring) | As regras de `observability/alerts.yml` disparam no Prometheus e aparecem em `/alerts`, mas nada avisa uma pessoa | Antes de produção; é pré-requisito para o RNF-05 e o RNF-03 serem acompanhados | P |
| Anonimização ou política para a `descricao` | O campo livre pode conter dado pessoal ([seguranca.md](seguranca.md)) | Parecer do compliance sobre LGPD | M |

## Prioridade 2: crescimento

| Item | O que resolve | Gatilho | Esforço |
|---|---|---|---|
| **Snapshots de saldo** | O saldo acumulado hoje é a soma das linhas de `saldo_diario` até a data (0,24 a 1,17 ms em 3 anos de histórico, [ADR-009](adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md)). Com snapshots, a soma parte do último snapshot e não do início. Também encurta a reconstrução do consolidado depois de um desastre | Consulta de acumulado com p95 acima de 50 ms (heurística) em cache frio, ou comerciantes com histórico bem acima de 3 anos, ou replay completo do outbox acima do RTO do consolidado | M |
| Fila de retentativa com TTL para erro transitório | Hoje a mensagem fica retida no consumidor até o banco voltar. Uma fila de espera com TTL libera o consumidor e conta tentativas por cabeçalho ([ADR-011](adrs/ADR-011-falha-transitoria-nao-vai-para-dlq.md)) | Mais de uma réplica do consumidor, ou quedas de banco longas o bastante para que reter a mensagem atrapalhe | M |
| **CDC com Debezium no lugar do polling** | O relay consulta o outbox a cada 1 s. O CDC lê o WAL do PostgreSQL: latência menor e nenhum `SELECT` periódico | A latência do polling deixar de caber no RNF-05, ou o `SELECT` do relay ser relevante na CPU do banco, ou surgirem vários consumidores do evento. O `FOR UPDATE SKIP LOCKED` atual cobre o volume projetado | G |
| Pact (testes de contrato dirigidos pelo consumidor) | Hoje o contrato do evento é testado por `evento-versoes.test.ts` dentro do consolidado, que é o consumidor. Com outro time ou outro consumidor, o produtor precisa saber o que quebra | Um segundo consumidor do evento, ou os dois serviços passarem para equipes diferentes | M |
| Estorno de lançamento | Lançamentos são imutáveis e não há como corrigir um erro. O desenho natural é um evento `LancamentoEstornado` que compensa o original (o consumidor atual ignora tipos desconhecidos, então a introdução é compatível), com trilha de auditoria | O primeiro pedido de correção de lançamento, ou exigência de imutabilidade e auditoria do compliance | M |
| Agrupador de conexões (PgBouncer ou pool gerenciado do Cloud SQL, se disponível na edição) | Controla o número de conexões quando os pods escalam para dezenas | Conexões do banco acima de 70% do `max_connections` ([dimensionamento.md](dimensionamento.md)) | P |
| Provedor de identidade gerenciado no lugar do Keycloak | Menos uma peça para operar. O Identity Platform é voltado a usuários finais e não serve a *client credentials*; a alternativa seria tokens de identidade de contas de serviço do Google, que não carregam o comerciante nem os escopos e não servem a integradores externos (ver [custos.md](custos.md)). Exige ajuste da validação | A operação do Keycloak ficar cara para a equipe e existir um provedor que cubra *client credentials* com os claims necessários | M |

## Prioridade 3: escala e novos requisitos

| Item | O que resolve | Gatilho | Esforço |
|---|---|---|---|
| **Kafka (Managed Service for Apache Kafka) no lugar do Pub/Sub ou do RabbitMQ** | Retenção e replay nativos do histórico de eventos, vários consumidores independentes, vazão muito maior | O volume crescer em ordens de grandeza, por exemplo acima de 10 mil mensagens por segundo sustentadas (heurística, hoje são cerca de 1,2 por segundo em média), ou uma necessidade real de replay e de vários consumidores. Antes disso o Pub/Sub e o RabbitMQ atendem e custam menos ([ADR-003](adrs/ADR-003-rabbitmq-vs-kafka-vs-pubsub.md)) | G |
| **Multi-região ativa** | Disponibilidade e latência além do que a alta disponibilidade multizona dá. A estratégia atual é *pilot light* ([disaster-recovery.md](disaster-recovery.md)) | RTO regional exigido abaixo de 2 horas, ou exigência regulatória, e a aprovação da LGPD para dado fora do Brasil | G |
| **Conciliação bancária** | Casar lançamentos com extratos bancários (arquivo ou Open Finance) e apontar divergências | O primeiro cliente pedir conciliação, ou integração com Open Finance. É um novo domínio, com seu próprio contexto delimitado | G |
| Dashboards por comerciante e relatórios | Exportação e filtros além do saldo diário | Pedido de produto | M |

## Como esta lista se conecta ao resto

- A lacuna de cada item vem dos documentos de [testes](testes.md), [segurança](seguranca.md), [arquitetura](arquitetura.md) e [recuperação de desastres](disaster-recovery.md).
- Cada decisão mudaria um ADR: Kafka e CDC revisam o [ADR-003](adrs/ADR-003-rabbitmq-vs-kafka-vs-pubsub.md) e o [ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md) e o [ADR-005](adrs/ADR-005-outbox-pattern.md); snapshots revisam o [ADR-009](adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md); o provedor de identidade gerenciado revisa o [ADR-010](adrs/ADR-010-autenticacao-e-autorizacao-de-consumo.md).
