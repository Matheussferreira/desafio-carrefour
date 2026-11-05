# Arquitetura Alvo — AWS

Mapeamento 1:1 do ambiente local para serviços gerenciados AWS, com as adaptações necessárias para alta disponibilidade de produção.

## Diagrama

```mermaid
graph TD
    Internet --> WAF[AWS WAF\nOWASP ruleset]
    WAF --> ALB[ALB Application Load Balancer\nTLS termination]

    ALB -->|/lancamentos| ECS_L[ECS Fargate\nServiço Lancamentos\n2 tasks mín, 2 AZs]
    ALB -->|/consolidado| ECS_C[ECS Fargate\nServiço Consolidado\n2 tasks mín, 2 AZs]

    ECS_L -->|lancamentos_db| RDS_L[RDS PostgreSQL 16\nMulti-AZ — lancamentos_db]
    ECS_C -->|consolidado_db| RDS_C[RDS PostgreSQL 16\nMulti-AZ — consolidado_db]

    ECS_L -->|publica eventos| AMQ[Amazon MQ for RabbitMQ\nCluster 3 brokers, 3 AZs]
    AMQ -->|consome eventos| ECS_C

    ECS_C -->|cache| REDIS[ElastiCache Redis\nCluster Mode, 3 shards]

    ECS_L --> SM[Secrets Manager\nsegredos de clientes OIDC, DB passwords]
    ECS_C --> SM

    ECS_L --> CW[CloudWatch Logs + Metrics]
    ECS_C --> CW

    ECS_L --> ECR[ECR — Registry de imagens]
    ECS_C --> ECR

    subgraph "IAM"
        ROLE_L[Task Role: Lancamentos\nSecretsManager:GetSecretValue\nCloudWatchLogs:PutLogEvents]
        ROLE_C[Task Role: Consolidado\nSecretsManager:GetSecretValue\nCloudWatchLogs:PutLogEvents]
    end

    ECS_L -.->|assume| ROLE_L
    ECS_C -.->|assume| ROLE_C

    subgraph "Rede"
        VPC[VPC privada\n2 subnets privadas + 2 públicas]
        SG_L[SG: Lancamentos\nin: ALB:3001, out: RDS:5432 AMQ:5671]
        SG_C[SG: Consolidado\nin: ALB:3002, out: RDS:5432 AMQ:5671 Redis:6379]
    end
```

---

## Mapeamento Local → AWS

| Local | AWS | Notas |
|---|---|---|
| `lancamentos` (Docker) | ECS Fargate Task | Sem gerenciamento de instância; escala por task count |
| `consolidado` (Docker) | ECS Fargate Task | Escala independente do Lançamentos |
| PostgreSQL único (2 DBs) | **Dois RDS PostgreSQL 16 separados** (Multi-AZ) | Local: 2 databases na mesma instância para simplificar. Produção: instâncias separadas — um banco sobrecarregado não degrada o outro |
| RabbitMQ (Docker single-node) | Amazon MQ for RabbitMQ (cluster 3 brokers) | Quorum queues replicadas em 3 AZs; DLQ durável nativa |
| Redis (Docker single-node) | ElastiCache Redis Cluster Mode | 3 shards × 1 réplica; failover automático <30s |
| Nginx/proxy | ALB | Roteamento de path, TLS termination, health checks |
| — | API Gateway (opcional) | Rate limiting centralizado, autenticação por chave de API para integrações B2B |
| Logs (stdout) | CloudWatch Logs | Coletados automaticamente pelo ECS; retenção configurável; alertas em cima de error rate |
| — | X-Ray | Tracing distribuído — **evolução futura** (não implementado neste baseline). Ver [observabilidade.md](observabilidade.md) |
| `.env` | Secrets Manager | Rotação automática; referenciado nas task definitions via `secrets:` |
| Dockerfile | ECR | Registry privado; imagens escaneadas por vulnerabilidade automaticamente |

> **Nota sobre RDS:** No ambiente local, `lancamentos_db` e `consolidado_db` residem na mesma instância PostgreSQL (dentro do mesmo container). Em produção, devem ser instâncias RDS **separadas**: isolamento de falha real (um VACUUM agressivo ou conexão pool exaurido em uma não afeta a outra), políticas de backup independentes e capacidade dimensionada por perfil de carga — Lançamentos é write-heavy, Consolidado é read-heavy.

---

## IAM — Princípio do Menor Privilégio

Cada ECS Task assume uma IAM Role separada. As permissões são restritas ao mínimo necessário:

```json
{
  "Effect": "Allow",
  "Action": [
    "secretsmanager:GetSecretValue"
  ],
  "Resource": [
    "arn:aws:secretsmanager:us-east-1:ACCOUNT:secret:desafio-as/lancamentos/*"
  ]
}
```

Nenhum serviço tem acesso de escrita a secrets ou a recursos do outro serviço. A comunicação interna (serviço → RDS, serviço → Amazon MQ) usa Security Groups com ingress restrito à porta e origem exata.

---

## Escalabilidade e Alta Disponibilidade

**Lançamentos (write-heavy):**
- ECS Auto Scaling por CPU (target 60%): mín 2 tasks em 2 AZs, máx configurável
- O Outbox Relay roda por processo — N tasks = N relays em paralelo, aumentando throughput de publicação linearmente
- RDS Multi-AZ com failover automático < 60s (com read replica para queries de relatório)

**Consolidado (read-heavy):**
- ECS Auto Scaling por request count: mín 2 tasks
- ElastiCache Redis Cluster Mode com read replicas absorve picos de leitura de saldo
- RDS com Read Replica para queries analíticas; o consumer usa a primária (escrita)
- `prefetch=1` por consumer: N tasks = N mensagens em processamento paralelo, sem coordenação

**RabbitMQ:**
- Amazon MQ com 3 brokers em 3 AZs (Quorum Queues — substitui mirroring clássico deprecado no 3.12+)
- Mensagens persistem enquanto a maioria dos nós (2/3) estiver operacional
- DLQ configurada por fila: `consolidado.lancamentos.dlq` durável

---

## Equivalente GCP

Cloud Run (lancamentos + consolidado) → Cloud SQL PostgreSQL (2 instâncias) → Google Cloud Pub/Sub → Memorystore (Redis) → Cloud Armor (WAF) → Cloud Logging → Cloud Trace (tracing futuro).

---

## Estimativa de Custos

Ver [custos.md](custos.md).
