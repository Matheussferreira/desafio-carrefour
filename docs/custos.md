# Estimativa de custos de infraestrutura e licenças

Todos os valores são **estimativas**, em dólares americanos, para a região `sa-east-1` (São Paulo), calculadas sobre a lista de preços pública da AWS consultada em **2026-11-05**. Nada aqui foi cobrado nem medido numa conta real. A memória de cálculo está nas tabelas, para que qualquer número possa ser refeito.

## Fonte e como validar

Os preços unitários vêm da API pública de lista de preços da AWS (`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<serviço>/current/sa-east-1/index.json`), nas versões abaixo. Preços da AWS mudam; antes de qualquer decisão, **refaça a conta na [AWS Pricing Calculator](https://calculator.aws/)** com a região `South America (São Paulo)` e anote a data da validação ao lado do resultado.

| Serviço | Versão da lista de preços consultada |
|---|---|
| Amazon MQ | 20260911124456 |
| ECS (Fargate) | 20261019224317 |
| ElastiCache | 20261028192450 |
| RDS | 20261029070635 |
| Elastic Load Balancing | 20261102102527 |
| CloudWatch | 20261104213532 |
| Secrets Manager, ECR | 20260911 |
| EC2 (NAT Gateway, instâncias, EBS, transferência regional) | 20261105162628 |
| Cognito | 20261020233814 |
| X-Ray | 20260911124622 |

Validação na calculadora: **pendente** (a ser preenchida com a data em que for feita: ____/____/______).

## Premissas

- Volume: pico de 50 req/s no consolidado (requisito), cerca de 1 milhão de requisições por dia e 100 mil lançamentos por dia (premissa de dimensionamento, não medida).
- 730 horas por mês, preço sob demanda, sem Reserved Instances nem Savings Plans (não há preço confirmado nesta consulta para esses modelos, então não calculo desconto).
- Dois bancos PostgreSQL em instâncias RDS separadas, como pede o [ADR-004](adrs/ADR-004-banco-por-servico.md).
- Quatro componentes de aplicação em ECS Fargate: `lancamentos`, `lancamentos-relay`, `consolidado` e o provedor de identidade (Keycloak, ver a comparação com o Cognito mais adiante).
- O tamanho de cada tarefa Fargate é uma **hipótese**. A capacidade medida do consolidado (cerca de 197 a 199 req/s numa instância, em máquina de desenvolvimento, ver [testes.md](testes.md)) não foi medida em Fargate, então o dimensionamento da seção de produção deve ser validado com o k6 numa conta real.

## Licenças

**Zero.** PostgreSQL, RabbitMQ, Redis, Node.js, Keycloak, Prometheus, Grafana, Jaeger e k6 são software livre. No RDS, no Amazon MQ e no ElastiCache a licença do motor está embutida no preço do serviço, sem cobrança separada. A única licença paga a considerar seria a de ferramentas comerciais de observabilidade ou de WAF de terceiros, que esta solução não usa.

## Cenário A: mínimo viável (um ambiente enxuto, sem alta disponibilidade)

Serve para homologação ou para uma operação pequena que aceita parada. **Não atende produção de um banco**: o broker é instância única, os bancos não são Multi-AZ e há uma tarefa de cada serviço.

| Item | Especificação | Cálculo | US$/mês |
|---|---|---|---|
| Fargate `lancamentos` | 1 tarefa, 0,25 vCPU, 0,5 GB | (0,25 x 0,0696 + 0,5 x 0,0076) x 730 | 15,48 |
| Fargate `lancamentos-relay` | 1 tarefa, 0,25 vCPU, 0,5 GB | idem | 15,48 |
| Fargate `consolidado` | 1 tarefa, 0,5 vCPU, 1 GB | (0,5 x 0,0696 + 1 x 0,0076) x 730 | 30,95 |
| Fargate Keycloak | 1 tarefa, 1 vCPU, 2 GB | (1 x 0,0696 + 2 x 0,0076) x 730 | 61,90 |
| RDS `lancamentos_db` | `db.t4g.small`, Single-AZ, 20 GB gp3 | 0,069 x 730 + 20 x 0,219 | 54,75 |
| RDS `consolidado_db` | `db.t4g.small`, Single-AZ, 20 GB gp3 | idem | 54,75 |
| Amazon MQ for RabbitMQ | `mq.t3.micro`, instância única | 0,04368 x 730 | 31,89 |
| ElastiCache Redis | `cache.t4g.micro`, 1 nó | 0,030 x 730 | 21,90 |
| ALB | 1 balanceador, 1 LCU médio | 0,034 x 730 + 0,011 x 730 | 32,85 |
| NAT Gateway | 1 gateway, 50 GB processados | 0,093 x 730 + 50 x 0,093 | 72,54 |
| CloudWatch Logs | 10 GB ingeridos, 10 GB armazenados | 10 x 0,90 + 10 x 0,0408 | 9,41 |
| Secrets Manager | 5 segredos | 5 x 0,40 | 2,00 |
| ECR | 1 GB | 1 x 0,10 | 0,10 |
| Transferência para a internet | 50 GB (limite superior, sem franquia gratuita) | 50 x 0,15 | 7,50 |
| **Total estimado** | | | **cerca de 411** |

Faixa conforme as premissas variáveis (LCU de 1 a 3, 20 a 100 GB no NAT, 5 a 20 GB de logs, 0 a 100 GB de saída): **US$ 396 a 449 por mês**.

Observações do cenário A:
- O `mq.t3.micro` só existe como instância única (a lista de preços não traz esse tamanho para cluster). A AWS o destina a avaliação e desenvolvimento. O armazenamento do broker não está no total: a lista traz o armazenamento do RabbitMQ a US$ 0,19 por GB-mês (single) e o volume efetivamente alocado deve ser confirmado na calculadora.
- Para economizar o NAT Gateway (cerca de US$ 68 por mês), as tarefas poderiam rodar em sub-redes públicas com IP público e grupos de segurança restritivos. Não recomendo para um banco; fica registrado como opção.

## Cenário B: produção Multi-AZ

Duas zonas de disponibilidade, duas ou mais tarefas por serviço, bancos Multi-AZ, broker em cluster.

| Item | Especificação | Cálculo | US$/mês |
|---|---|---|---|
| Fargate `lancamentos` | 2 tarefas, 0,5 vCPU, 1 GB | 2 x 30,95 | 61,90 |
| Fargate `lancamentos-relay` | 2 tarefas, 0,25 vCPU, 0,5 GB | 2 x 15,48 | 30,95 |
| Fargate `consolidado` | 2 tarefas, 0,5 vCPU, 1 GB | 2 x 30,95 | 61,90 |
| Fargate Keycloak | 2 tarefas, 1 vCPU, 2 GB | 2 x 61,90 | 123,81 |
| RDS `lancamentos_db` | `db.t4g.medium`, Multi-AZ, 50 GB gp3 | 0,275 x 730 + 50 x 0,438 | 222,65 |
| RDS `consolidado_db` | `db.t4g.medium`, Multi-AZ, 50 GB gp3 | idem | 222,65 |
| Amazon MQ for RabbitMQ | **cluster de 3 nós**, `mq.m7g.medium` | 0,6533 x 730 | 476,91 |
| ElastiCache Redis | `cache.t4g.small`, 1 primário + 1 réplica em AZs distintas | 2 x 0,061 x 730 | 89,06 |
| ALB | 1 balanceador, 2 LCU médios | 0,034 x 730 + 2 x 0,011 x 730 | 40,88 |
| NAT Gateway | 2 gateways (um por AZ), 100 GB processados | 2 x 0,093 x 730 + 100 x 0,093 | 145,08 |
| CloudWatch | 30 GB de logs, 100 métricas customizadas, 15 alarmes | 30 x 0,90 + 30 x 0,0408 + 100 x 0,30 + 15 x 0,135 | 60,25 |
| X-Ray | 5% de amostragem: cerca de 1,5 milhão de traces por mês, 100 mil gratuitos | (1,5 milhão - 100 mil) x 0,000005 | 7,00 |
| Secrets Manager | 8 segredos | 8 x 0,40 | 3,20 |
| ECR | 2 GB | 2 x 0,10 | 0,20 |
| Transferência para a internet | 100 GB (limite superior) | 100 x 0,15 | 15,00 |
| Transferência entre AZs | 200 GB, cobrada nos dois sentidos | 200 x 0,01 x 2 | 4,00 |
| **Total estimado** | | | **cerca de 1.565** |

Faixa conforme as premissas variáveis (1 a 5 LCU, 50 a 300 GB no NAT, 15 a 60 GB de logs, 0 a 300 GB de saída): **US$ 1.522 a 1.674 por mês**.

### Por que o Amazon MQ domina o custo

Um erro fácil de cometer é dimensionar o cluster de 3 nós com `mq.t3.micro`. Na lista de preços de `sa-east-1` o `mq.t3.micro` aparece apenas como instância única de RabbitMQ; as entradas de cluster de 3 nós (Multi-AZ) existem para a família `m5` e para a `m7g`. O menor tamanho de cluster listado é o `mq.m7g.medium`, e é ele que o cenário B usa.

| Tamanho | Instância única (US$/h) | Cluster de 3 nós (US$/h) | Cluster, US$/mês |
|---|---|---|---|
| `mq.t3.micro` | 0,04368 | não listado | n/a |
| `mq.m7g.medium` | 0,2178 | 0,6533 | 476,91 |
| `mq.m7g.large` | 0,4358 | 1,3075 | 954,48 |
| `mq.m5.large` | 0,459 | 1,377 | 1.005,21 |

O preço de cluster listado é exatamente três vezes o da instância única, o que indica que ele já cobre os três nós; confirme essa leitura na calculadora, porque, se o preço for por nó, o custo do broker triplica (cerca de US$ 1.430 por mês) e o total do cenário B sobe na mesma proporção. Os tamanhos e os preços de cluster **devem ser conferidos** na calculadora e na [documentação de tipos de instância do Amazon MQ for RabbitMQ](https://docs.aws.amazon.com/amazon-mq/latest/developer-guide/rmq-broker-instance-types.html), porque a AWS pode mudar a família suportada.

## Itens sem preço confirmado, fora dos totais

Não consegui confirmar preço para estes itens nesta consulta, então **não entram nos totais** e precisam ser levantados na calculadora antes de qualquer proposta:

| Item | Quando entra | O que fazer |
|---|---|---|
| AWS WAF (conjunto gerenciado OWASP, regras por taxa) | Borda pública, recomendado em [seguranca.md](seguranca.md) | Calcular na calculadora por ACL, regras e requisições |
| API Gateway HTTP API | Opcional, se o throttling por cliente ficar no gateway | A lista traz US$ 1,59 por milhão de requisições (primeiros 300 milhões); com 30 milhões de requisições por mês seria cerca de US$ 47,70 |
| AWS KMS (chaves gerenciadas pelo cliente) | Criptografia em repouso com chave própria | Calcular por chave e por requisição |
| Backups do RDS acima do tamanho provisionado e cópia entre regiões | Plano de DR ([disaster-recovery.md](disaster-recovery.md)) | Calcular pelo volume de backup e pela região de destino |
| Armazenamento do Amazon MQ | Qualquer cenário | Confirmar o volume alocado e o preço por GB-mês |
| Savings Plans e instâncias reservadas | Operação contínua | Calcular na calculadora; não estimo percentual |

## Gerenciado ou auto gerenciado

### Amazon MQ ou RabbitMQ próprio

| | Amazon MQ (cluster `mq.m7g.medium`) | RabbitMQ próprio em EC2 |
|---|---|---|
| Custo mensal estimado | 476,91 | 3 x `t4g.medium` (0,0536 x 730) + 3 x 50 GB gp3 (0,152 por GB-mês) = 117,38 + 22,80 = **140,18** |
| Quem opera | AWS: patch, failover, cluster em 3 AZs | A equipe: atualização, quorum queues, backup, monitoramento do cluster |
| Risco | Baixo | Médio a alto: partição de rede e disco cheio caem na operação própria |

O RabbitMQ em Fargate não é uma boa alternativa: o cluster precisa de disco persistente com bom desempenho e identidade de nó estável, que o Fargate atende mal. Três tarefas de 1 vCPU e 2 GB custariam cerca de US$ 185,71 por mês sem esses atributos. A diferença para o gerenciado, cerca de US$ 337 por mês, paga a operação que a equipe deixaria de fazer; para uma equipe pequena de um banco, é o preço de não manter um cluster de mensageria.

Uma terceira via, descrita no [ADR-003](adrs/ADR-003-rabbitmq-vs-kafka-vs-sqs.md), é trocar o RabbitMQ por SQS e SNS. Com 100 mil eventos por dia (3 milhões por mês) e três chamadas por mensagem (envio, recebimento e remoção), a lista de `sa-east-1` (US$ 0,40 por milhão de requisições padrão, 1 milhão gratuito) leva a algo como US$ 3 por mês. É a opção mais barata, mas muda o contrato de mensageria (fila, DLQ, ordenação, `mandatory`) e o código do relay e do consumidor.

### Keycloak ou Cognito

| | Keycloak em Fargate (2 tarefas) | Amazon Cognito (credenciais de cliente) |
|---|---|---|
| Custo mensal estimado | 123,81, mais o banco (um terceiro schema no RDS de lançamentos) | Por requisição de token: US$ 0,00225 por requisição nas primeiras 250 mil do mês. Com 20 integradores renovando a cada 5 minutos seriam 172.800 requisições, cerca de **US$ 388,80**; renovando a cada hora, 14.400 requisições, cerca de **US$ 32,40**. Os clientes M2M em si não têm cobrança na lista |
| Quem opera | A equipe: atualização, realm, alta disponibilidade, TLS | AWS |
| Observação | O que o código já usa; tudo é configuração | A lista de preços mostra variantes "Free" e "Full" para a requisição de token, e não consegui determinar o que a gratuita cobre: validar na calculadora |

O custo do Cognito depende de quantas vezes o integrador pede token, e isso é controle do cliente: um integrador que reutiliza o token até expirar custa pouco; um que pede token a cada chamada custa muito. A mudança para o Cognito também **não é só configuração**: os tokens de credencial de cliente do Cognito, segundo a documentação da AWS, trazem `client_id` e `scope` em vez de `aud`, e o claim `comerciante_id` exigiria um gatilho de geração de token. Isso muda a validação do JWT ([ADR-010](adrs/ADR-010-autenticacao-e-autorizacao-de-consumo.md)). Verifique na documentação do Cognito antes de decidir.

## Otimizações com valor calculável

| Otimização | Efeito | Cálculo |
|---|---|---|
| Fargate em ARM (Graviton) no cenário B | de US$ 278,57 para US$ 223,18 por mês, **economia de US$ 55,39** | 4,5 vCPU e 9 GB: x86 (4,5 x 0,0696 + 9 x 0,0076) x 730; ARM (4,5 x 0,0557 + 9 x 0,00612) x 730. Exige imagens arm64 e novo teste de carga |
| RabbitMQ em EC2 no lugar do Amazon MQ | economia de cerca de US$ 337 por mês | ver a comparação acima; troca custo por operação |
| SQS e SNS no lugar do RabbitMQ | economia de cerca de US$ 474 por mês | troca contrato de mensageria; exige reescrever relay e consumidor |
| Um NAT Gateway no cenário B | economia de US$ 67,89 por mês | perde a tolerância à falha de uma AZ para a saída à internet |

## O que este documento não afirma

- Não há custo medido numa conta AWS. Os totais são aritmética sobre preços de lista e premissas de volume.
- O tamanho das tarefas e dos bancos é hipótese a validar com teste de carga na própria AWS.
- Não incluo impostos, suporte AWS, taxas de câmbio nem horas de operação da equipe.
