# Recuperação de desastres

Este documento define metas de recuperação (RTO e RPO), a estratégia de backup e o roteiro de operação para a solução na AWS, na região primária `sa-east-1` (São Paulo). Parte da estrutura vem de um estudo anterior do mesmo autor para outro desafio e foi **reescrita para a AWS e para as particularidades desta solução** (outbox, consumidor idempotente, projeção reconstruível).

**Status:** são metas de projeto. Nenhuma foi medida numa conta AWS e nenhum failover regional foi exercitado. O que existe como prova automatizada é a resiliência a falha de componente, descrita no fim.

## O que torna esta solução diferente para DR

1. **O `lancamentos_db` é a fonte de verdade.** Perder um lançamento é perder dinheiro registrado. É o único dado que exige RPO próximo de zero.
2. **O `consolidado_db` é uma projeção.** Cada linha de `saldo_diario` é derivada de eventos. Se for perdido, pode ser reconstruído a partir do `outbox` do lançamentos, desde que o consumidor seja idempotente (ele é, pela tabela `eventos_processados`). Por isso o RPO lógico do consolidado é zero, e o que varia é o tempo de reconstrução.
3. **O broker não guarda a verdade.** O `outbox` mantém todo evento gravado, publicado ou não (nenhuma rotina apaga linhas hoje). Perder o RabbitMQ perde mensagens em trânsito, não lançamentos.
4. **O Redis é só cache.** Pode ser recriado vazio a qualquer momento.

## Metas de recuperação

Duas classes de falha, com mecanismos diferentes.

### Falha de uma zona de disponibilidade (automática)

| Componente | Mecanismo | RTO alvo | RPO alvo |
|---|---|---|---|
| Serviços (ECS Fargate) | Tarefas em 2 AZs; o ECS reagenda as que caíram | 5 minutos | n/a (sem estado) |
| `lancamentos_db` e `consolidado_db` (RDS) | Multi-AZ com réplica síncrona e failover automático | 5 minutos (a documentação da AWS indica de 1 a 2 minutos para o failover; validar no teste) | 0 |
| Amazon MQ (cluster de 3 nós) | Quorum queues replicadas em 3 AZs | 5 minutos | 0 para mensagens confirmadas |
| ElastiCache Redis | Réplica em outra AZ promovida | 5 minutos | n/a (cache) |
| Keycloak | 2 tarefas em AZs distintas | 5 minutos | 0 (banco Multi-AZ) |

### Falha da região `sa-east-1` (manual)

Os alvos são mais frouxos porque a região secundária fica em modo **pilot light**: dados replicados, computação desligada ou mínima.

| Componente | Estratégia | RTO alvo | RPO alvo |
|---|---|---|---|
| `lancamentos_db` | Réplica de leitura entre regiões, promovida no failover | 2 horas | 5 minutos |
| API de lançamentos | Serviço ECS pré-criado na região secundária com contagem zero, escalado no failover | 2 horas | n/a |
| `consolidado_db` | Backup automatizado replicado entre regiões; ou reconstrução por replay do outbox | 4 horas | 0 lógico (a projeção é rederivada) |
| API do consolidado e consumidor | Idem, escalados depois do banco | 4 horas | n/a |
| Amazon MQ | Cluster novo, vazio (as filas são redeclaradas pelos serviços no startup) | 2 horas | Mensagens em trânsito são recuperadas pelo replay do outbox |
| Redis | Recriado vazio | 30 minutos | n/a |
| Keycloak | Imagem e `realm-caixa.json` no repositório, banco restaurado do backup | 2 horas | 15 minutos |

**Escolha da região secundária e LGPD.** O Brasil tem uma única região AWS. A região secundária mais comum para quem está em `sa-east-1` é `us-east-1`, o que significa **transferência internacional de dados pessoais** (a `descricao` do lançamento pode conter dado pessoal, ver [seguranca.md](seguranca.md)). Antes de ativar a réplica entre regiões, é preciso a base legal da LGPD para a transferência e a aprovação do compliance do banco. Se isso não for aprovado, a alternativa é aceitar que uma falha da região inteira significa indisponibilidade até a recuperação da AWS, mantendo só Multi-AZ. Essa decisão é do negócio, não da arquitetura.

## Estratégia de backup

| Dado | Mecanismo | Retenção proposta |
|---|---|---|
| `lancamentos_db` | Backup automatizado do RDS com recuperação para qualquer instante (PITR), mais snapshots manuais mensais | 35 dias de PITR (máximo do RDS) e 12 snapshots mensais; o prazo regulatório de guarda de registros financeiros deve ser confirmado com o compliance |
| `consolidado_db` | Backup automatizado do RDS, retenção menor | 14 dias; é derivável do outbox |
| Cópia entre regiões | Replicação de backups automatizados do RDS para a região secundária, sujeita à decisão da LGPD acima | Mesma do banco de origem |
| Keycloak | Banco com backup do RDS; definição do realm versionada em `keycloak/realm-caixa.json` | Mesma do banco |
| Imagens | ECR com replicação entre regiões para o repositório de DR | Últimas 10 versões |
| Segredos | Secrets Manager com replicação do segredo para a região secundária | n/a |
| Infraestrutura | Hoje não há IaC AWS no repositório. Terraform AWS está em [evolucoes.md](evolucoes.md) | n/a |

O `outbox` cresce sem limite hoje (cerca de 0,8 KB por evento com índices, medido em 635 linhas locais). Quando ele ganhar rotina de retenção, a janela de replay do consolidado passa a ser a janela do outbox, e esse prazo precisa ser compatível com o RTO do consolidado.

## Roteiro de operação: falha da região primária

Comandos de CLI são ilustrativos e **precisam ser validados no primeiro exercício**. Os nomes dos recursos (`lancamentos-db-dr`, por exemplo) são exemplos.

### Fase 1: detecção

1. Alerta do CloudWatch (taxa de erro do ALB, `/ready` fora, `lancamentos_rabbitmq_connected` do relay em 0) e página de status da AWS.
2. Confirmar o escopo: falha de uma AZ é tratada automaticamente e **não aciona este roteiro**. Só falha regional vai adiante.
3. Decidir o failover. A decisão é humana e registrada (quem, quando, por quê), porque ela aceita perder até 5 minutos de lançamentos (RPO).

### Fase 2: banco de lançamentos (fonte de verdade primeiro)

4. Medir o atraso de replicação da réplica entre regiões (métrica `ReplicaLag`) e registrar o instante do último dado replicado. Esse instante é o ponto de corte do RPO.
5. Promover a réplica: `aws rds promote-read-replica --db-instance-identifier lancamentos-db-dr --region us-east-1`.
6. Atualizar o segredo da string de conexão no Secrets Manager da região secundária.

### Fase 3: serviços de lançamentos e tráfego

7. Escalar `lancamentos` e `lancamentos-relay` na região secundária (`aws ecs update-service --desired-count 2`).
8. Redirecionar o tráfego com a verificação de saúde do Route 53 (TTL baixo) para o ALB da região secundária.
9. Smoke test: `.\scripts\obter-token.ps1` apontado para o Keycloak recuperado e um `POST /lancamentos`.

Nesta fase a **escrita já voltou**. O consolidado pode demorar mais, e isso é aceitável: o requisito diz que lançamentos não depende dele.

### Fase 4: broker e consolidado

10. Criar o cluster Amazon MQ na região secundária. As filas, a exchange e a DLQ são declaradas pelos próprios serviços ao conectar.
11. Restaurar o `consolidado_db` do backup mais recente replicado, ou iniciar vazio. Anotar o instante de corte `T` (último dado conhecido).
12. Reenviar ao consolidado o que ele não viu. No `lancamentos_db` promovido:

```sql
-- Recoloca como pendente tudo o que foi publicado a partir de T. O consumidor é idempotente
-- (eventos_processados), então eventos já aplicados são descartados sem alterar o saldo.
UPDATE outbox
SET status = 'pendente', published_at = NULL
WHERE status = 'publicado' AND created_at >= '<T menos uma margem de segurança>';
```

13. Acompanhar `lancamentos_outbox_pendentes` caindo a zero e `consolidado_evento_lag_seconds` voltando ao normal.
14. Se o consolidado foi recriado vazio, use `created_at >= '-infinity'` (replay completo). O tempo depende do volume do outbox e **não foi medido**; vale medir antes de contar com esse caminho (ver [evolucoes.md](evolucoes.md), snapshots de saldo).
15. Se o Redis foi recriado, nada a fazer. O cache começa vazio e se enche com as consultas.

### Fase 5: validação e comunicação

16. Conferir um comerciante por amostragem: a soma dos lançamentos do `lancamentos_db` do dia contra `GET /consolidado/{data}`.
17. Confirmar `consolidado_consumer_dlq_total` estável. Falha de banco ou de conexão durante a recuperação **não** manda mensagens para a DLQ (elas ficam retidas até o banco voltar, [ADR-011](adrs/ADR-011-falha-transitoria-nao-vai-para-dlq.md)). O que estiver na DLQ (`consolidado.lancamentos.dlq`) é dado inválido e pede tratamento manual, ver "Reprocessar a DLQ" abaixo.
18. Comunicar as áreas de negócio e os integradores com o ponto de corte do RPO, para que reenviem lançamentos feitos depois dele.

### Fase 6: failback

19. Reconstruir a região primária como réplica da região em operação. Promover de volta numa janela combinada.
20. Redirecionar o tráfego, repetir a validação e desligar os recursos do modo pilot light.
21. Registrar o post-mortem com linha do tempo, RTO e RPO reais e ações de melhoria.

## Reprocessar a DLQ

A DLQ `consolidado.lancamentos.dlq` recebe só mensagem que não vai passar: JSON quebrado, contrato inválido (por exemplo versão 2.x) ou erro permanente de processamento. Uma queda do banco, mesmo longa, **não** a enche: a mensagem fica retida e é aplicada na volta.

Para devolver as mensagens da DLQ à fila principal depois de corrigir a causa:

```powershell
.\scripts\reprocessar-dlq.ps1 -Simular   # mostra o que seria devolvido, sem alterar nada
.\scripts\reprocessar-dlq.ps1            # devolve tudo
.\scripts\reprocessar-dlq.ps1 -Limite 10 # devolve só 10
```

No Linux, macOS ou Git Bash: `bash scripts/reprocessar-dlq.sh [--simular] [--limite N]`. O script usa a API de gerenciamento do RabbitMQ (porta 15672) e precisa do Node 20. Cada mensagem é publicada na fila principal antes de a cópia da DLQ ser descartada; se a publicação não for confirmada, ela volta para a DLQ e o script para. Reentregar é seguro pela idempotência. Uma mensagem realmente inválida volta para a DLQ quando o consumidor a recusar de novo, e o script só processa as mensagens que a DLQ tinha ao começar, então não entra em laço. As estatísticas de fila do RabbitMQ atualizam a cada cerca de 5 segundos, então uma mensagem recém-chegada pode demorar para aparecer na contagem.

## Política de teste

| Teste | Frequência proposta | O que valida |
|---|---|---|
| Resiliência de componente (`tests/resiliencia`) | A cada mudança relevante e antes de release | Lançamentos segue aceitando com o consolidado, o RabbitMQ e o banco do consolidado parados; o consolidado segue pronto sem o Redis; o saldo converge na volta; o reprocessamento da DLQ funciona |
| Restauração de backup do RDS num ambiente isolado | Trimestral | Que o backup restaura e quanto tempo leva |
| Gameday de failover regional | Semestral | O roteiro acima, ponta a ponta, medindo RTO e RPO reais |
| Replay completo do outbox num consolidado vazio | Semestral, ou quando o outbox dobrar | Tempo de reconstrução |

## O que está provado e o que não está

- **Provado por teste automatizado** (ver [testes.md](testes.md)): lançamentos 201 com o consolidado parado e com o RabbitMQ parado, drenagem do outbox na volta, convergência do saldo, idempotência de reentrega, reconexão do consumidor, 30 s de banco do consolidado fora sem nada na DLQ, consolidado pronto sem o Redis e reprocessamento da DLQ.
- **Não provado:** failover de RDS, promoção de réplica entre regiões, redirecionamento de DNS, replay completo do outbox em volume, restauração de backup. São metas de projeto até o primeiro exercício.
