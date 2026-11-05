# Arquitetura alvo: AWS

Mapeamento do ambiente local para serviços AWS na região `sa-east-1` (São Paulo), com as adaptações de alta disponibilidade para produção. Os números de capacidade e custo estão em [dimensionamento.md](dimensionamento.md) e [custos.md](custos.md), e a recuperação de desastres em [disaster-recovery.md](disaster-recovery.md). Nada aqui foi implantado: é desenho alvo, e não há Terraform da AWS no repositório ([evolucoes.md](evolucoes.md)).

## Diagrama

```mermaid
graph TD
    Internet --> WAF["AWS WAF<br/>conjunto gerenciado OWASP"]
    WAF --> ALB["Application Load Balancer<br/>TLS, health check em /health"]

    ALB -->|"/lancamentos"| ECS_L["ECS Fargate<br/>lancamentos<br/>2 tarefas, 2 AZs"]
    ALB -->|"/consolidado"| ECS_C["ECS Fargate<br/>consolidado + consumidor<br/>2 tarefas, 2 AZs"]
    ALB -->|"/realms (token)"| KC["ECS Fargate<br/>Keycloak<br/>2 tarefas"]

    ECS_R["ECS Fargate<br/>lancamentos-relay<br/>2 tarefas"]

    ECS_L --> RDS_L[("RDS PostgreSQL 16<br/>Multi-AZ<br/>lancamentos_db")]
    ECS_R --> RDS_L
    ECS_C --> RDS_C[("RDS PostgreSQL 16<br/>Multi-AZ<br/>consolidado_db")]
    KC --> RDS_L

    ECS_R -->|"publica eventos"| AMQ["Amazon MQ for RabbitMQ<br/>cluster de 3 nós, 3 AZs"]
    AMQ -->|"entrega eventos"| ECS_C

    ECS_C -->|"cache"| REDIS["ElastiCache Redis<br/>1 primário + 1 réplica"]

    ECS_L -.->|"JWKS em cache"| KC
    ECS_C -.->|"JWKS em cache"| KC

    ECS_L --> SM["Secrets Manager"]
    ECS_R --> SM
    ECS_C --> SM
    ECS_L --> CW["CloudWatch Logs e métricas"]
    ECS_R --> CW
    ECS_C --> CW
    ECS_C --> XR["X-Ray via coletor OpenTelemetry"]
    ECR["ECR"] -.->|"imagens"| ECS_L
```

```mermaid
graph LR
    subgraph VPC["VPC em sa-east-1"]
        subgraph PUB["Sub-redes públicas, 2 AZs"]
            ALB2["ALB"]
            NAT["NAT Gateway por AZ"]
        end
        subgraph PRIV["Sub-redes privadas, 2 AZs"]
            TASKS["Tarefas ECS"]
            DATA["RDS, ElastiCache, Amazon MQ"]
        end
    end
    ALB2 --> TASKS
    TASKS --> DATA
    TASKS --> NAT
```

O Keycloak aparece como componente próprio porque é o que o código usa hoje. A alternativa gerenciada (Cognito) exige ajustes na validação do JWT e está comparada em [custos.md](custos.md).

---

## Mapeamento local para AWS

| Local | AWS | Notas |
|---|---|---|
| `lancamentos` (contêiner) | ECS Fargate | Escala por contagem de tarefas |
| `lancamentos-relay` (contêiner) | ECS Fargate | Várias réplicas são seguras por causa do `FOR UPDATE SKIP LOCKED` |
| `consolidado` (contêiner) | ECS Fargate | API de leitura e consumidor no mesmo processo |
| Keycloak (contêiner) | ECS Fargate | Modo de produção, com PostgreSQL e TLS |
| PostgreSQL único com 2 bancos | **Dois RDS PostgreSQL 16 separados**, Multi-AZ | Local: dois bancos na mesma instância por simplicidade. Produção: instâncias separadas, como pede o [ADR-004](adrs/ADR-004-banco-por-servico.md). O banco do Keycloak fica como um terceiro schema na instância de lançamentos |
| RabbitMQ (single-node) | Amazon MQ for RabbitMQ, cluster de 3 nós | Quorum queues em 3 AZs. O tipo de instância de cluster, o menor listado em `sa-east-1`, é o `mq.m7g.medium`; o `mq.t3.micro` só existe como instância única ([custos.md](custos.md)) |
| Redis (single-node) | ElastiCache Redis, 1 primário e 1 réplica | Failover automático. Cluster Mode com vários shards não é necessário a este volume |
| Proxy local | ALB | Roteamento por caminho, TLS, health check em `/health` (ver nota abaixo) |
| Prometheus e Grafana (profile) | CloudWatch e, opcionalmente, Prometheus gerenciado | As métricas `*_http_*`, de outbox e de lag continuam as mesmas |
| Jaeger (profile) | X-Ray via coletor OpenTelemetry (ADOT) | O código já exporta OTLP; só muda o destino |
| `.env` e segredos do compose | Secrets Manager | Referenciado nas definições de tarefa por `secrets:` |
| Dockerfile | ECR | Registro privado, com varredura de vulnerabilidades |
| (sem equivalente) | API Gateway, opcional | Throttling por cliente e plano de uso, que tirariam do código o rate limit em memória |

> **Health check do ALB.** Use `/health` (liveness). O `/ready` do consolidado também faz `PING` no Redis, então uma queda do cache o deixaria 503 e o ALB retiraria todas as tarefas, embora o código saiba servir do banco. Ver o cenário "Redis fora do ar" em [arquitetura.md](arquitetura.md) e o ajuste em [evolucoes.md](evolucoes.md).

> **Bancos separados.** Um VACUUM agressivo ou um pool esgotado numa instância não afeta a outra, as políticas de backup são independentes e a capacidade acompanha o perfil de cada uma: lançamentos é de escrita, consolidado é de leitura.

---

## IAM: menor privilégio

Cada serviço assume um papel de tarefa próprio, restrito aos segredos do próprio serviço.

```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": ["arn:aws:secretsmanager:sa-east-1:ACCOUNT:secret:caixa/lancamentos/*"]
}
```

Nenhum serviço escreve em segredos nem acessa recursos do outro. A comunicação com RDS, Amazon MQ e Redis usa grupos de segurança com entrada restrita à porta e à origem exata:

| Grupo de segurança | Entrada | Saída |
|---|---|---|
| `lancamentos` | ALB na porta 3001 | RDS lançamentos (5432), Keycloak (8080) para o JWKS |
| `lancamentos-relay` | rede interna na porta 3003 (métricas e `/ready`) | RDS lançamentos (5432), Amazon MQ (5671) |
| `consolidado` | ALB na porta 3002 | RDS consolidado (5432), Amazon MQ (5671), Redis (6379), Keycloak (8080) para o JWKS |
| `keycloak` | ALB na porta 8080 | RDS (5432) |

---

## Escalabilidade e alta disponibilidade

**Lançamentos (escrita):**
- Escala automática por CPU (alvo de 60%), no mínimo 2 tarefas em 2 AZs.
- O relay é um serviço à parte: N tarefas são N relays em paralelo, que dividem o trabalho com `SKIP LOCKED` sem duplicar eventos.
- RDS Multi-AZ com failover automático.

**Consolidado (leitura):**
- Escala por CPU e por requisições por alvo, no mínimo 2 tarefas.
- O cache Redis absorve a leitura repetida; com falha do cache a leitura cai para o banco.
- `prefetch=1` por consumidor: N tarefas são N mensagens em processamento paralelo, sem coordenação.

**RabbitMQ:**
- Amazon MQ com 3 nós em 3 AZs e quorum queues. As mensagens persistem enquanto a maioria dos nós (2 de 3) estiver de pé.
- A DLQ `consolidado.lancamentos.dlq` é durável. O reprocessamento é manual hoje ([disaster-recovery.md](disaster-recovery.md)).

---

## Estimativa de custos

Ver [custos.md](custos.md).
