# Evoluções futuras

Lista priorizada do que ficou de fora de propósito ou foi descoberto durante o desenvolvimento, cada item com o **gatilho** que justifica fazê-lo. A regra é: não construir antes de o gatilho acontecer. Esforço é uma ordem de grandeza relativa (P pequeno, M médio, G grande), não uma estimativa em horas.

Os limiares numéricos marcados como "heurística" são pontos de partida para a discussão, não medições desta solução.

## Prioridade 0: antes de ir para produção

São correções e provas que o próprio projeto já identificou como lacuna. O gatilho é a decisão de colocar a solução em produção.

| Item | Por que | Gatilho | Esforço |
|---|---|---|---|
| Terraform para a AWS | Hoje não existe IaC da AWS no repositório. Os documentos de [custos](custos.md), [dimensionamento](dimensionamento.md) e [recuperação de desastres](disaster-recovery.md) descrevem um ambiente que ninguém consegue criar de forma reproduzível | Antes do primeiro ambiente numa conta AWS | G |
| Health check do balanceador em `/health` e `/ready` do consolidado sem o Redis | O `/ready` do consolidado faz `PING` no Redis e fica 503 quando ele cai, o que, usado como health check do ALB, retiraria todas as tarefas num problema que o código sabe contornar (leitura cai para o banco). Ver [arquitetura.md](arquitetura.md) | Antes de configurar o ALB | P |
| Teste de falha do Redis | O fallback para o banco não tem teste automatizado ([testes.md](testes.md)) | Junto com o item anterior | P |
| Validação de custos e capacidade na AWS | Todos os números de [custos.md](custos.md) e [dimensionamento.md](dimensionamento.md) são estimativas ou hipóteses | Antes de qualquer compromisso de orçamento | M |
| Reprocessamento da DLQ | Banco do consolidado fora por mais de cerca de 7 s manda eventos para a DLQ e hoje o reprocesso é manual ([disaster-recovery.md](disaster-recovery.md)) | O primeiro incidente com mensagens na DLQ, ou antes de produção | M |
| Rate limit distribuído e por cliente | O limite é em memória, por instância e por IP; atrás de um balanceador todos os clientes compartilham um IP ([seguranca.md](seguranca.md)) | Mais de uma réplica por serviço, o que é o mínimo de produção | M |
| Endurecimento da imagem | O Dockerfile roda como root, instala dependências de desenvolvimento e não usa multi-stage | Antes de publicar a imagem no ECR de produção | P |
| Rodar o CI no GitHub | O fluxo foi escrito e só teve a sintaxe validada | Quando o repositório for publicado | P |

## Prioridade 1: primeiros meses de operação

| Item | O que resolve | Gatilho | Esforço |
|---|---|---|---|
| Retenção do outbox e de `eventos_processados` | Ambas crescem sem limite (cerca de 0,8 KB por evento só no outbox, medido). Sem rotina, o disco de 50 GB dura cerca de um ano a 100 mil lançamentos por dia (extrapolação) | Ocupação do disco acima de 50% ou o outbox passar de um prazo acordado | M |
| Paginação em `GET /lancamentos` | Hoje devolve até 100 linhas fixas | O primeiro cliente com mais de 100 lançamentos no dia | P |
| Advisory lock nas migrations | Duas réplicas subindo juntas podem colidir ao registrar a migration | Quando houver mais de uma réplica, junto com o item de rate limit | P |
| Retentativa sem bloquear a fila | O backoff dorme dentro do consumidor com `prefetch=1`; uma mensagem ruim segura a fila por até 7 s | Observar `consolidado_consumer_retries_total` frequente, ou lag alto sem causa de carga | M |
| Alertas (Prometheus Alertmanager ou CloudWatch) | Hoje há métricas e dashboard, sem alerta | Antes de produção; é pré-requisito para o RNF-05 ser acompanhado | P |
| OpenAPI publicada | O contrato HTTP existe no código e na documentação, mas não como especificação | O primeiro integrador externo | P |
| Teste para o desligamento gracioso (RNF-10) | Cobertura parcial hoje ([testes.md](testes.md)) | Antes de produção, junto com o ECS | P |
| Anonimização ou política para a `descricao` | O campo livre pode conter dado pessoal ([seguranca.md](seguranca.md)) | Parecer do compliance sobre LGPD | M |

## Prioridade 2: crescimento

| Item | O que resolve | Gatilho | Esforço |
|---|---|---|---|
| **Snapshots de saldo** | O saldo acumulado hoje é a soma das linhas de `saldo_diario` até a data (0,24 a 1,17 ms em 3 anos de histórico, [ADR-009](adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md)). Com snapshots, a soma parte do último snapshot e não do início. Também encurta a reconstrução do consolidado depois de um desastre | Consulta de acumulado com p95 acima de 50 ms (heurística) em cache frio, ou comerciantes com histórico bem acima de 3 anos, ou replay completo do outbox acima do RTO do consolidado | M |
| **CDC com Debezium no lugar do polling** | O relay consulta o outbox a cada 1 s. O CDC lê o WAL do PostgreSQL: latência menor e nenhum `SELECT` periódico | A latência do polling deixar de caber no RNF-05, ou o `SELECT` do relay ser relevante na CPU do banco, ou surgirem vários consumidores do evento. O `FOR UPDATE SKIP LOCKED` atual cobre o volume projetado | G |
| Pact (testes de contrato dirigidos pelo consumidor) | Hoje o contrato do evento é testado por `evento-versoes.test.ts` dentro do consolidado, que é o consumidor. Com outro time ou outro consumidor, o produtor precisa saber o que quebra | Um segundo consumidor do evento, ou os dois serviços passarem para equipes diferentes | M |
| Estorno de lançamento | Lançamentos são imutáveis e não há como corrigir um erro. O desenho natural é um evento `LancamentoEstornado` que compensa o original (o consumidor atual ignora tipos desconhecidos, então a introdução é compatível), com trilha de auditoria | O primeiro pedido de correção de lançamento, ou exigência de imutabilidade e auditoria do compliance | M |
| RDS Proxy | Controla o número de conexões quando as tarefas escalam para dezenas | Conexões do banco acima de 70% do `max_connections` ([dimensionamento.md](dimensionamento.md)) | P |
| Cognito no lugar do Keycloak | Menos uma peça para operar. Exige ajuste da validação (ver [custos.md](custos.md)) | A operação do Keycloak ficar cara para a equipe, ou o custo do token do Cognito ser aceitável para o número de integradores | M |

## Prioridade 3: escala e novos requisitos

| Item | O que resolve | Gatilho | Esforço |
|---|---|---|---|
| **Kafka (Amazon MSK) no lugar do RabbitMQ** | Retenção e replay nativos do histórico de eventos, vários consumidores independentes, vazão muito maior | O volume crescer em ordens de grandeza, por exemplo acima de 10 mil mensagens por segundo sustentadas (heurística, hoje são cerca de 1,2 por segundo em média), ou uma necessidade real de replay e de vários consumidores. Antes disso o RabbitMQ atende e custa menos ([ADR-003](adrs/ADR-003-rabbitmq-vs-kafka-vs-sqs.md)) | G |
| **Multi-região ativa** | Disponibilidade e latência além do que o Multi-AZ dá. A estratégia atual é *pilot light* ([disaster-recovery.md](disaster-recovery.md)) | RTO regional exigido abaixo de 2 horas, ou exigência regulatória, e a aprovação da LGPD para dado fora do Brasil | G |
| **Conciliação bancária** | Casar lançamentos com extratos bancários (arquivo ou Open Finance) e apontar divergências | O primeiro cliente pedir conciliação, ou integração com Open Finance. É um novo domínio, com seu próprio contexto delimitado | G |
| Dashboards por comerciante e relatórios | Exportação e filtros além do saldo diário | Pedido de produto | M |

## Como esta lista se conecta ao resto

- A lacuna de cada item vem dos documentos de [testes](testes.md), [segurança](seguranca.md), [arquitetura](arquitetura.md) e [recuperação de desastres](disaster-recovery.md).
- Cada decisão mudaria um ADR: Kafka e CDC revisam o [ADR-003](adrs/ADR-003-rabbitmq-vs-kafka-vs-sqs.md) e o [ADR-005](adrs/ADR-005-outbox-pattern.md); snapshots revisam o [ADR-009](adrs/ADR-009-saldo-acumulado-e-multi-comerciante.md); Cognito revisa o [ADR-010](adrs/ADR-010-autenticacao-e-autorizacao-de-consumo.md).
