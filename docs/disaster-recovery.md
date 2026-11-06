# Recuperação de desastres

Este documento define metas de recuperação (RTO e RPO), a estratégia de backup e o roteiro de operação para a solução no Google Cloud, na região primária `southamerica-east1` (São Paulo). Parte da estrutura vem de um estudo anterior do mesmo autor para outro desafio e foi **reescrita para as particularidades desta solução** (outbox, consumidor idempotente, projeção reconstruível) e para a restrição de residência de dados descrita abaixo.

**Status:** são metas de projeto. Nenhuma foi medida numa conta do Google Cloud e nenhum failover regional foi exercitado. O que existe como prova automatizada é a resiliência a falha de componente no ambiente local, descrita no fim.

## O que torna esta solução diferente para DR

1. **O `lancamentos_db` é a fonte de verdade.** Perder um lançamento é perder dinheiro registrado. É o único dado que exige RPO próximo de zero.
2. **O `consolidado_db` é uma projeção.** Cada linha de `saldo_diario` é derivada de eventos. Se for perdido, pode ser reconstruído a partir do `outbox` do lançamentos, desde que o consumidor seja idempotente (ele é, pela tabela `eventos_processados`). Por isso o RPO lógico do consolidado é zero, e o que varia é o tempo de reconstrução.
3. **O broker não guarda a verdade.** O `outbox` mantém todo evento gravado, publicado ou não (nenhuma rotina apaga linhas hoje). Perder o Pub/Sub ou o conteúdo de uma assinatura perde mensagens em trânsito, não lançamentos.
4. **O Redis é só cache.** Pode ser recriado vazio a qualquer momento.

## Restrição de residência: a única região do Brasil é `southamerica-east1`

O Google Cloud tem **uma única região no Brasil**, `southamerica-east1` (São Paulo). As regiões mais próximas ficam fora do país (por exemplo, `southamerica-west1`, em Santiago, no Chile). Replicar dados para outra região é, portanto, **transferência internacional de dados pessoais** pela LGPD, e a `descricao` do lançamento pode conter dado pessoal ([seguranca.md](seguranca.md)). Isso não é uma decisão de arquitetura; é de compliance e do negócio. Há dois caminhos:

| Alternativa | O que oferece | O que não oferece | O que é preciso |
|---|---|---|---|
| **A. DR multizona dentro de `southamerica-east1`** (padrão desta proposta) | Sobrevive à falha de uma zona, de forma automática | **Não sobrevive à falha da região inteira.** Numa falha regional, a solução fica indisponível até o Google restabelecer a região | Nada além da aprovação do risco residual |
| **B. DR em outra região** (por exemplo `southamerica-west1`) | Sobrevive à falha regional, em modo *pilot light* | Mantém o dado pessoal fora do Brasil | Base legal e mecanismo de transferência da LGPD (por exemplo, as cláusulas-padrão contratuais previstas no regulamento de transferência internacional da ANPD), parecer do jurídico e do encarregado (DPO) e aprovação do compliance do banco |

Enquanto a alternativa B não for aprovada, **vale a A**, e as metas de falha regional abaixo ficam como desenho condicional. Para reduzir o risco da A sem transferir dado pessoal: manter os backups e as exportações **dentro de `southamerica-east1`**, restringir o armazenamento do Pub/Sub à região (política de armazenamento de mensagens) e manter o outbox como fonte para reconstruir a projeção.

## Metas de recuperação

### Falha de uma zona (automática)

| Componente | Mecanismo | RTO alvo | RPO alvo |
|---|---|---|---|
| Serviços (GKE Autopilot regional) | Pods espalhados por zonas; o Kubernetes reagenda os que caíram | 5 minutos | n/a (sem estado) |
| `lancamentos_db` e `consolidado_db` (Cloud SQL) | HA regional: réplica síncrona do disco em outra zona e failover automático | 5 minutos (a documentação do Google indica cerca de um a dois minutos; validar no teste) | 0 |
| Pub/Sub | Serviço regional, com as mensagens replicadas entre zonas | Sem intervenção | 0 para mensagens confirmadas |
| Memorystore Redis (nível Standard) | Réplica em outra zona promovida | 5 minutos | n/a (cache) |
| Keycloak | 2 pods em zonas distintas | 5 minutos | 0 (banco com HA) |

### Falha da região `southamerica-east1` (só com a alternativa B aprovada)

Os alvos são mais frouxos porque a região secundária fica em modo **pilot light**: dados replicados, computação mínima ou desligada.

| Componente | Estratégia | RTO alvo | RPO alvo |
|---|---|---|---|
| `lancamentos_db` | Réplica de leitura entre regiões, promovida no failover | 2 horas | 5 minutos |
| API e relay de lançamentos | Implantação pré-criada no cluster da região secundária com zero réplicas, escalada no failover | 2 horas | n/a |
| `consolidado_db` | Backup replicado entre regiões; ou reconstrução por replay do outbox | 4 horas | 0 lógico (a projeção é rederivada) |
| API do consolidado e consumidor | Idem, escalados depois do banco | 4 horas | n/a |
| Pub/Sub | Tópico e assinatura recriados na região secundária (as filas são declaradas pela infraestrutura como código, não pelos serviços) | 2 horas | Mensagens em trânsito são recuperadas pelo replay do outbox |
| Redis | Recriado vazio | 30 minutos | n/a |
| Keycloak | Imagem e `realm-caixa.json` no repositório, banco restaurado do backup | 2 horas | 15 minutos |

## Estratégia de backup

| Dado | Mecanismo | Retenção proposta |
|---|---|---|
| `lancamentos_db` | Backups automáticos do Cloud SQL e recuperação para qualquer instante (PITR), mais exportações mensais para um bucket do Cloud Storage em `southamerica-east1` | PITR pelo maior prazo permitido na edição (conferir o máximo na documentação) e 35 backups diários; 12 exportações mensais. O prazo regulatório de guarda de registros financeiros deve ser confirmado com o compliance |
| `consolidado_db` | Backup automático, retenção menor | 14 backups; é derivável do outbox |
| Cópia entre regiões | Replicação de backups para a região secundária, **sujeita à decisão da LGPD** acima | Mesma do banco de origem |
| Keycloak | Banco com backup do Cloud SQL; definição do realm versionada em `keycloak/realm-caixa.json` | Mesma do banco |
| Imagens | Artifact Registry. As imagens não contêm dado pessoal, então uma cópia em outra região não é transferência de dado pessoal (confirmar com o jurídico) | Últimas 10 versões |
| Segredos | Secret Manager com replicação restrita a `southamerica-east1` por padrão; segredos de acesso são replicados à região secundária só se a alternativa B for aprovada | n/a |
| Chaves de criptografia | Cloud KMS (CMEK) na mesma região dos dados. A perda de uma chave torna o dado ilegível: proteger contra a destruição acidental com o período de espera da destruição de versões | n/a |
| Logs de auditoria | Cloud Audit Logs roteados para um bucket com retenção bloqueada (*bucket lock*) em `southamerica-east1` | Prazo definido pelo compliance |
| Infraestrutura | Hoje não há infraestrutura como código do Google Cloud no repositório ([evolucoes.md](evolucoes.md)) | n/a |

O `outbox` cresce sem limite hoje (cerca de 0,8 KB por evento com índices, medido em 635 linhas locais). Quando ele ganhar rotina de retenção, a janela de replay do consolidado passa a ser a janela do outbox, e esse prazo precisa ser compatível com o RTO do consolidado.

## Roteiro de operação: falha da região primária (alternativa B)

Comandos de CLI são ilustrativos e **precisam ser validados no primeiro exercício**. Os nomes dos recursos (`lancamentos-db-dr`, por exemplo) são exemplos.

### Fase 1: detecção

1. Alerta do Cloud Monitoring (taxa de erro do balanceador, `/ready` fora, `lancamentos_rabbitmq_connected` do relay em 0 ou o equivalente do Pub/Sub) e o painel de status do Google Cloud.
2. Confirmar o escopo: falha de uma zona é tratada automaticamente e **não aciona este roteiro**. Só falha regional vai adiante.
3. Decidir o failover. A decisão é humana e registrada (quem, quando, por quê), porque ela aceita perder até 5 minutos de lançamentos (RPO) e move dado pessoal para fora do Brasil, o que só vale com a alternativa B aprovada.

### Fase 2: banco de lançamentos (fonte de verdade primeiro)

4. Medir o atraso de replicação da réplica entre regiões (métrica de atraso de replicação do Cloud SQL) e registrar o instante do último dado replicado. Esse instante é o ponto de corte do RPO.
5. Promover a réplica: `gcloud sql instances promote-replica lancamentos-db-dr`.
6. Atualizar o segredo da string de conexão no Secret Manager da região secundária.

### Fase 3: serviços de lançamentos e tráfego

7. Escalar `lancamentos` e `lancamentos-relay` no cluster da região secundária: `kubectl scale deployment lancamentos lancamentos-relay --replicas=2`.
8. Redirecionar o tráfego: o balanceador global com verificação de saúde passa a usar o *backend* da região secundária, ou o Cloud DNS (TTL baixo) aponta para o balanceador dela.
9. Smoke test: `.\scripts\obter-token.ps1` apontado para o Keycloak recuperado e um `POST /lancamentos`.

Nesta fase a **escrita já voltou**. O consolidado pode demorar mais, e isso é aceitável: o requisito diz que lançamentos não depende dele.

### Fase 4: broker e consolidado

10. Criar o tópico, a assinatura e o tópico de mensagens mortas na região secundária pela infraestrutura como código. Os serviços não os criam sozinhos ([ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md)).
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
17. Confirmar `consolidado_consumer_dlq_total` estável. Falha de banco ou de conexão durante a recuperação **não** manda mensagens para a DLQ (elas ficam retidas até o banco voltar, [ADR-011](adrs/ADR-011-falha-transitoria-nao-vai-para-dlq.md)). O que estiver na DLQ é dado inválido e pede tratamento manual, ver "Reprocessar a DLQ" abaixo.
18. Comunicar as áreas de negócio e os integradores com o ponto de corte do RPO, para que reenviem lançamentos feitos depois dele.

### Fase 6: failback

19. Reconstruir a região primária como réplica da região em operação. Promover de volta numa janela combinada.
20. Redirecionar o tráfego, repetir a validação e reduzir os recursos do modo pilot light.
21. Registrar o post-mortem com linha do tempo, RTO e RPO reais e ações de melhoria.

## Reprocessar a DLQ

A DLQ recebe só mensagem que não vai passar: JSON quebrado, contrato inválido (por exemplo versão 2.x) ou erro permanente de processamento. Uma queda do banco, mesmo longa, **não** a enche: a mensagem fica retida e é aplicada na volta.

No **ambiente local (RabbitMQ)**, para devolver as mensagens da fila `consolidado.lancamentos.dlq` à fila principal depois de corrigir a causa:

```powershell
.\scripts\reprocessar-dlq.ps1 -Simular   # mostra o que seria devolvido, sem alterar nada
.\scripts\reprocessar-dlq.ps1            # devolve tudo
.\scripts\reprocessar-dlq.ps1 -Limite 10 # devolve só 10
```

No Linux, macOS ou Git Bash: `bash scripts/reprocessar-dlq.sh [--simular] [--limite N]`. O script usa a API de gerenciamento do RabbitMQ (porta 15672) e precisa do Node 20. Cada mensagem é publicada na fila principal antes de a cópia da DLQ ser descartada; se a publicação não for confirmada, ela volta para a DLQ e o script para. Reentregar é seguro pela idempotência. Uma mensagem realmente inválida volta para a DLQ quando o consumidor a recusar de novo, e o script só processa as mensagens que a DLQ tinha ao começar, então não entra em laço.

**Em produção com o Pub/Sub** este script não serve: ele fala com a API do RabbitMQ. O equivalente é ler a assinatura do tópico de mensagens mortas e republicar no tópico principal, e é parte do trabalho do adaptador ([ADR-012](adrs/ADR-012-broker-em-producao-no-gcp.md)).

## Política de teste

| Teste | Frequência proposta | O que valida |
|---|---|---|
| Resiliência de componente (`tests/resiliencia`) | A cada mudança relevante e antes de release | Lançamentos segue aceitando com o consolidado, o broker e o banco do consolidado parados; o consolidado segue pronto sem o Redis; o saldo converge na volta; o reprocessamento da DLQ funciona. Hoje roda contra o RabbitMQ local |
| Restauração de backup do Cloud SQL num ambiente isolado | Trimestral | Que o backup e o PITR restauram e quanto tempo leva |
| Teste de failover zonal do Cloud SQL | Semestral | Que o failover automático cabe no RTO de 5 minutos |
| Gameday de failover regional | Semestral, e só se a alternativa B for aprovada | O roteiro acima, ponta a ponta, medindo RTO e RPO reais |
| Replay completo do outbox num consolidado vazio | Semestral, ou quando o outbox dobrar | Tempo de reconstrução |

## O que está provado e o que não está

- **Provado por teste automatizado local** (ver [testes.md](testes.md)): lançamentos 201 com o consolidado parado e com o broker parado, drenagem do outbox na volta, convergência do saldo, idempotência de reentrega, reconexão do consumidor, 30 s de banco do consolidado fora sem nada na DLQ, consolidado pronto sem o Redis e reprocessamento da DLQ.
- **Não provado:** qualquer comportamento do Pub/Sub (o adaptador não existe), failover do Cloud SQL, promoção de réplica entre regiões, redirecionamento do balanceador, replay completo do outbox em volume, restauração de backup. São metas de projeto até o primeiro exercício.
