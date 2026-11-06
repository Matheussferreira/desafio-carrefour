# ADR-012: Broker em produção no Google Cloud

**Status:** Aceito como direção; o adaptador do Pub/Sub **ainda não foi escrito**  
**Data:** 2026-11-05

---

## Contexto

A empresa usa o Google Cloud, então a arquitetura alvo de produção é GCP ([arquitetura-alvo-cloud.md](../arquitetura-alvo-cloud.md)). O [ADR-003](ADR-003-rabbitmq-vs-kafka-vs-pubsub.md) escolheu o RabbitMQ pelo critério de rodar com `docker compose up`, sem conta em nuvem. Esse critério continua valendo para desenvolvimento e testes, mas não decide o que roda em produção. No Google Cloud não existe RabbitMQ gerenciado de primeira parte, então a pergunta é: operar um cluster RabbitMQ no Kubernetes ou usar o serviço de mensagens nativo, o Pub/Sub.

Um fato sobre o código de hoje precisa ficar explícito: **o repositório só tem o adaptador de RabbitMQ** (AMQP 0-9-1, `amqplib`). O relay usa `ConfirmChannel` com `mandatory`, e o consumidor usa `ack`, `nack` e `prefetch`. Nada disso existe ainda para o Pub/Sub. Esta decisão descreve a direção e o trabalho necessário; ela não afirma que o código já funciona com o Pub/Sub.

## Decisão

1. **Ambiente local e testes automatizados:** RabbitMQ, como hoje.
2. **Produção no Google Cloud:** Pub/Sub, com um tópico de eventos, uma assinatura do consolidado (pull, com controle de fluxo) e um tópico de mensagens mortas.
3. O acesso ao broker passa por uma **interface** (publicar com confirmação; consumir com `ack` e `nack`), com dois adaptadores. A escolha é por configuração.
4. Tópicos, assinaturas e permissões são criados pela infraestrutura como código, e **não** pelos serviços em tempo de execução.

## Alternativas

### RabbitMQ em cluster no GKE
Mantém o mesmo broker em todos os ambientes, e o código de hoje funciona sem alteração. O custo é operar um cluster de três nós (StatefulSet, volumes persistentes, filas de quórum, atualizações, partição de rede, disco cheio) numa equipe pequena. A estimativa de custo (ver [custos.md](../custos.md)) é de US$ 215 a 242 por mês só de infraestrutura (pods no preço oficial do Autopilot em São Paulo mais discos em hipótese), contra cerca de zero do Pub/Sub neste volume, sem contar as horas de operação. **Descartado para produção**, mas é o plano B se o adaptador do Pub/Sub se mostrar inviável: nenhuma linha de código muda.

### RabbitMQ gerenciado por terceiro (Marketplace)
Elimina a operação do cluster e mantém o protocolo. Introduz outro fornecedor, outro contrato, e a rede e a residência dos dados precisam ser conferidas. Não foi avaliado em profundidade. **Fica como alternativa a verificar.**

### Google Cloud Managed Service for Apache Kafka
Daria replay nativo e vários consumidores independentes. A 1,2 mensagem por segundo em média (estimativa) é desproporcional, pelos mesmos motivos do ADR-003. **Descartado.**

### Pub/Sub (escolhido)
Gerenciado, regional, com as mensagens replicadas entre zonas, sem cluster para operar e com cobrança por volume de dados (a vazão deste sistema cabe na franquia gratuita, ver [custos.md](../custos.md)). O preço é escrever e testar o adaptador, e o desvio entre o broker de teste e o de produção.

## As garantias do desenho continuam válidas

| Garantia | Com RabbitMQ (hoje) | Com Pub/Sub |
|---|---|---|
| Evento gravado junto com o lançamento ([ADR-005](ADR-005-outbox-pattern.md)) | Outbox | **Igual.** O Pub/Sub não participa da transação do banco; o outbox continua necessário |
| Só marcar como publicado depois da confirmação | `ConfirmChannel` | **Equivalente.** A publicação devolve o identificador da mensagem somente depois de o serviço tê-la gravado; o relay espera esse retorno antes do `UPDATE ... 'publicado'` |
| Falha de rota não pode ser silenciosa (`mandatory`) | Mensagem sem fila volta ao relay | **Diferente, exige cuidado.** Publicar num tópico que não tem assinatura **não é erro**: a mensagem é descartada. Mitigação: **a assinatura é criada pela infraestrutura antes do primeiro `publish`** (a infraestrutura como código cria tópico e assinatura juntos, e o relay só é implantado depois; os serviços não criam recursos em tempo de execução). Além disso, ligar a retenção de mensagens do tópico (permite reexecutar a leitura a partir de um instante) e alertar quando o atraso da assinatura ou a idade da mensagem mais antiga crescer. Como o evento permanece no outbox até a confirmação, e a confirmação só diz que o tópico aceitou a mensagem, a assinatura existir antes é o que fecha a lacuna. Confirmar os detalhes na documentação |
| Entrega pelo menos uma vez | Sim | **Sim.** O Pub/Sub também pode entregar mais de uma vez |
| Consumidor idempotente ([ADR-007](ADR-007-idempotencia.md)) | `eventos_processados` | **Igual, e continua sendo obrigatório.** Não se apoia na entrega exata uma vez que alguns tipos de assinatura oferecem, porque o relay já pode publicar duas vezes |
| Uma mensagem por vez (`prefetch=1`) | `prefetch` | Controle de fluxo do cliente com no máximo 1 mensagem pendente por instância |
| Falha transitória retém a mensagem ([ADR-011](ADR-011-falha-transitoria-nao-vai-para-dlq.md)) | Sem `ack` nem `nack`, espera e tenta de novo | **Muda, exige desenho.** Ver abaixo |
| DLQ só para o que não passa | DLX | Tópico de mensagens mortas. Mensagem inválida: o consumidor a publica no tópico de mensagens mortas e dá `ack`. Erro permanente: idem após as tentativas |
| Reprocessar a DLQ | `scripts/reprocessar-dlq` pela API de gerenciamento do RabbitMQ | Ler a assinatura do tópico de mensagens mortas e republicar no tópico principal. O script de hoje não serve |

### Ordenação não é necessária

O Pub/Sub tem chaves de ordenação (*ordering keys*), e **não vamos usá-las**. A projeção do consolidado é comutativa: o upsert soma o delta do evento ao total do dia (`saldo = saldo + delta`), o `eventos_processados` impede a repetição, o `saldoAcumulado` é calculado na leitura somando os dias, e o `ultimoEventoAplicadoEm` guarda o maior `createdAt` já aplicado, sem depender da ordem de chegada ([ADR-009](ADR-009-saldo-acumulado-e-multi-comerciante.md)). Um lançamento retroativo, que chega "fora de ordem" por natureza, já é o caso normal. Ordenação ainda custaria vazão e disponibilidade (uma chave bloqueada espera a mensagem anterior).

### Falha transitória e o limite de tentativas

No RabbitMQ, o consumidor segura a mensagem sem confirmar até o banco voltar. No Pub/Sub há duas formas, e a escolha é do adaptador:

- **Segurar a mensagem estendendo o prazo de confirmação.** A biblioteca estende o prazo automaticamente até um limite configurável; passado o limite, a mensagem volta e **conta como uma nova tentativa de entrega**.
- **Recusar (`nack`) e deixar a política de nova tentativa com espera exponencial agir.** Cada recusa **conta para o limite de tentativas de entrega** da política de mensagens mortas. Um banco fora por tempo suficiente levaria mensagens válidas para a DLQ, que é exatamente o erro que o ADR-011 corrigiu.

#### Mitigação adotada

1. **Em erro transitório o consumidor não faz `nack`.** Erro transitório é banco fora, timeout ou conexão recusada, a mesma classificação do ADR-011. Recusar contaria a tentativa sem que a mensagem tenha culpa.
2. **O consumidor pausa a puxada pelo controle de fluxo** (para de receber novas mensagens) enquanto uma sonda de saúde do banco falhar, e retoma quando o banco voltar. Assim um banco fora não faz o consumidor consumir tentativas de várias mensagens ao mesmo tempo.
3. **A mensagem em mãos é reentregue pela política de nova tentativa com espera exponencial** (do prazo de confirmação expirado), em vez de ser segurada indefinidamente. A espera cresce a cada tentativa e limita o ritmo de reentrega.
4. **`max_delivery_attempts` fica alto, até 100** (o máximo que o Pub/Sub aceita para a política de mensagens mortas). Com a espera exponencial no teto, 100 tentativas cobrem uma indisponibilidade de muitas horas (ordem de grandeza: se a espera média ficasse em alguns minutos, seriam mais de um dia; **estimativa**, depende do `minimum_backoff` e do `maximum_backoff` configurados). O valor exato sai do teste de indisponibilidade do banco, e não deste texto.
5. **Quem chega à DLQ por esgotar tentativas continua sendo tratado:** o alerta de mensagem na DLQ dispara, e o script de reprocessamento a devolve ao tópico principal. É a última rede, e não o caminho esperado.

Erro permanente (mensagem inválida ou versão 2.x) segue o caminho próprio: publicar no tópico de mensagens mortas e dar `ack`, sem depender da contagem de tentativas.

Nada disso foi executado: precisa ser **validado em teste** com o emulador e na nuvem (derrubar o banco por mais tempo que o prazo de confirmação e conferir que nenhuma mensagem vai à DLQ e que o consumo retoma sozinho).

## O trabalho para criar o adaptador do Pub/Sub

Esforço relativo: **M** (médio). Não é uma troca de configuração.

1. **Extrair as interfaces** do código atual. Hoje o relay (`CanalPublicador`) e o consumidor falam em termos do `amqplib`. Uma interface `PublicadorDeEventos` (publicar um evento e esperar a confirmação) e outra `ConsumidorDeEventos` (receber, `ack`, `nack`, controle de fluxo) isolam o broker.
2. **Publicador do Pub/Sub:** publicar o corpo do evento com atributos (`eventoId`, `schemaVersion`, `traceparent`) e esperar o identificador devolvido. O `eventoId` continua sendo o `id` da linha do outbox.
3. **Assinante do Pub/Sub:** assinatura de pull com controle de fluxo de 1 mensagem, `ack` depois do commit, o tratamento do ADR-011 acima e o encerramento gracioso (parar de puxar, esperar a mensagem em processamento).
4. **Mensagens mortas:** política da assinatura, mais a publicação explícita no tópico de mensagens mortas para mensagem inválida ou de versão 2.x.
5. **Saúde e métricas:** `/ready` do consolidado e do relay passa a refletir a assinatura e a publicação; as métricas `*_rabbitmq_connected` precisam de um nome neutro (por exemplo `*_broker_connected`), o que mexe em painéis e alertas.
6. **Infraestrutura como código** para tópicos, assinaturas, política de mensagens mortas, retenção e a restrição de armazenamento à região `southamerica-east1`.
7. **Substituir `scripts/reprocessar-dlq`** (ou ter uma versão por broker).
8. **Testes:** o conjunto de integração roda contra o RabbitMQ. É preciso rodar o **mesmo conjunto de contrato** contra os dois adaptadores, usando o emulador do Pub/Sub no ambiente de integração, e ter pelo menos uma execução na nuvem real. A resiliência (cenários A, B, D e E) tem de ser reescrita para o Pub/Sub, porque não se "para" um serviço gerenciado: o equivalente é derrubar o emulador ou revogar a permissão.
9. **Logging:** não é do broker, mas entra no mesmo pacote de adaptação à plataforma: ajustar os campos do log JSON (`severity`, `message`) e o campo de correlação de trace para o Cloud Logging.

## Consequências

**Positivas:**
- Sem cluster de mensageria para operar. Custo de broker próximo de zero neste volume (estimativa; ver [custos.md](../custos.md)).
- Mensagens replicadas entre zonas e retenção configurável; o armazenamento pode ser restrito à região de São Paulo, o que ajuda na LGPD.
- O outbox, a confirmação de publicação e o consumidor idempotente continuam sendo o que garante zero perda.

**Negativas:**
- **O que roda em produção não é o que os testes cobrem hoje.** Até existir o conjunto de contrato rodando nos dois adaptadores, a garantia de zero perda com o Pub/Sub é um argumento de desenho, e não uma prova. Esta é a principal limitação desta decisão.
- Diferenças sutis de semântica (tópico sem assinatura descarta, contagem de tentativas, prazo de confirmação) exigem atenção e teste.
- O desenvolvedor local roda RabbitMQ e a produção roda Pub/Sub: dois caminhos de código a manter.
- Acoplamento ao Google Cloud no adaptador (não no restante do código). Trocar de nuvem de novo é escrever outro adaptador.
