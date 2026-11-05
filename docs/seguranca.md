# Segurança

Este documento cobre o modelo de segurança do **consumo** das APIs (quem pode chamar o quê, em nome de qual comerciante), os controles implementados no código e o que falta para produção. As decisões estão no [ADR-010](adrs/ADR-010-autenticacao-e-autorizacao-de-consumo.md).

## Modelo de consumo

Cada sistema que integra (ERP, BI, contabilidade) é um **cliente OAuth2 confidencial** no Keycloak, usando o fluxo *client credentials* (RFC 6749, seção 4.4). Não há usuário humano nem senha no caminho.

```mermaid
sequenceDiagram
    participant S as Sistema integrador
    participant K as Keycloak
    participant L as API lancamentos
    participant C as API consolidado

    S->>K: client_id + client_secret (client credentials)
    K-->>S: access token JWT RS256, validade 300 s
    S->>L: POST /lancamentos (Bearer token)
    L->>K: GET JWKS (só na 1ª vez ou ao girar a chave; fica em cache)
    L->>L: verifica assinatura, iss, aud, exp, escopo e comerciante_id
    L-->>S: 201
    S->>C: GET /consolidado/data (Bearer token)
    C->>C: mesma verificação, com a audiência do consolidado
    C-->>S: 200
```

### O que cada chamada precisa ter

| Verificação | Regra | Falha |
|---|---|---|
| Assinatura | RS256, chave obtida do JWKS do realm. HS256 e `alg: none` são recusados (testado) | 401 `invalid_token` |
| Issuer | Igual a `OIDC_ISSUER` | 401 |
| Audiência | O token precisa citar a API chamada (`lancamentos-api` ou `consolidado-api`). Um token do consolidado não vale no lançamentos | 401 |
| Expiração | Claim `exp` obrigatório; tolerância de 5 s para relógio | 401 |
| Comerciante | Claim `comerciante_id` válido. Fixado no cliente pelo administrador do realm, nunca lido do corpo | 403 |
| Escopo | Cada rota exige um escopo (tabela abaixo) | 403 `insufficient_scope` |

As respostas seguem a RFC 6750 (`WWW-Authenticate: Bearer ... error="invalid_token"` ou `insufficient_scope, scope="..."`) e a RFC 7807 no corpo.

### Escopos

| Escopo | Rotas |
|---|---|
| `lancamentos.write` | `POST /lancamentos` |
| `lancamentos.read` | `GET /lancamentos` |
| `consolidado.read` | `GET /consolidado/{data}` e `GET /consolidado?inicio=&fim=` |

### Clientes do realm de desenvolvimento

Definidos em [keycloak/realm-caixa.json](../keycloak/realm-caixa.json). Os segredos abaixo são só para desenvolvimento.

| Cliente | Comerciante | Escopos | Uso típico |
|---|---|---|---|
| `erp-loja-1` | loja-1 | write, read, consolidado | ERP que registra e consulta |
| `erp-loja-2` | loja-2 | write, read, consolidado | Segundo comerciante, para provar isolamento |
| `bi-loja-1` | loja-1 | consolidado.read | Painel que só lê o saldo |
| `contabil-loja-1` | loja-1 | lancamentos.read, consolidado.read | Contabilidade: lê, não grava |

### Critérios para onboarding de um novo consumidor

1. Criar um cliente confidencial no realm, com **service account** e sem fluxos interativos.
2. Conceder apenas os **escopos mínimos** para o caso de uso. Leitura e escrita são escopos separados.
3. Fixar o `comerciante_id` no cliente por mapper. O consumidor não escolhe em nome de quem age.
4. Guardar o segredo no cofre do consumidor (em produção, AWS Secrets Manager) e definir rotação.
5. Informar o consumidor sobre `X-Idempotency-Key` para escritas e sobre os limites de taxa.

## Resiliência da autenticação

| Situação | Comportamento | Evidência |
|---|---|---|
| Keycloak fora do ar, serviço já tem as chaves | Tokens válidos continuam sendo aceitos (as chaves ficam em cache por 10 min e a revalidação só ocorre ao girar a chave) | Teste unitário e verificação manual: com o Keycloak parado, POST e GET responderam 201 e 200 |
| Keycloak fora do ar, serviço acabou de subir e nunca viu as chaves | **503** com `Retry-After: 5`, e não 401, porque a falha é do provedor, não do token | Teste unitário e verificação manual |
| Rotação de chaves no Keycloak | Um `kid` desconhecido dispara nova busca do JWKS (com intervalo mínimo de 15 s entre buscas) | Verificado ao recriar o Keycloak: as chaves mudaram e os serviços aceitaram os tokens novos sem reinício |
| Keycloak fora do ar, cliente quer token novo | Não consegue até o Keycloak voltar. O token dura 300 s, então a janela de tolerância do consumidor é de até 5 minutos | Verificação manual |

Os serviços não dependem do Keycloak para subir nem para ficar prontos: o `/ready` não o consulta.

## Outros controles

### Validação de entrada

- Toda entrada é validada com **zod** antes de qualquer acesso ao banco
- `valor`: string decimal positiva, até 2 casas e no máximo 999999999.99. Número JSON é recusado, porque já chegaria como float
- `tipo`: enum estrito `credito` ou `debito`
- `data`: data real do calendário no formato `YYYY-MM-DD` (2024-02-30 é recusada com 400)
- `valor` armazenado como `NUMERIC(15,2)`, nunca `float`; processado como `Decimal` (decimal.js)

### Chave de idempotência

O `X-Idempotency-Key` é uma string opaca de 1 a 255 caracteres, **escopada por comerciante**. A mesma chave com o mesmo corpo devolve o lançamento original; com corpo diferente, 409.

### Rate limiting

| Serviço | Rota | Limite | Janela | Justificativa |
|---|---|---|---|---|
| Lancamentos | `/lancamentos` | 1.200 req | 60 s por IP | 20 req/s, comporta integração ERP em lote sem bloquear uso legítimo |
| Consolidado | `/consolidado` | 6.000 req (configurável por `RATE_LIMIT_MAX`, usado só no teste do 429) | 60 s por IP | 100 req/s, cobre 50 req/s de pico com folga 2x para rajadas |

`/health`, `/ready` e `/metrics` ficam antes do limitador: um 429 neles poderia fazer o orquestrador matar um container saudável ou interromper o scraping do Prometheus.

### Auditoria e logs

- Todo log de requisição inclui `clienteId` (claim `azp`) e `comercianteId`, de modo que é possível responder "quem chamou, em nome de quem".
- O cabeçalho `Authorization` é **redigido** nos logs (`[Redacted]`). Foi verificado que nenhum log dos dois serviços contém um token.

### Segredos

- Configuração por variáveis de ambiente; `.env` fora do Git e `.env.example` com valores só para desenvolvimento.
- Os serviços **não guardam segredo de assinatura**: validam com a chave pública do JWKS. Não existe mais `JWT_SECRET`.
- Os segredos dos clientes no `realm-caixa.json` são de desenvolvimento. Em produção ficam no Secrets Manager e são rotacionados.

### Cabeçalhos e tamanho de corpo

- O `helmet` está ativo nos dois serviços (`src/app.ts`): `X-Content-Type-Options: nosniff`, `Strict-Transport-Security`, `Content-Security-Policy` restritiva e outros. O `X-Powered-By` é desligado para não anunciar o framework.
- O corpo JSON é limitado a **16 kB** (`express.json({ limit: '16kb' })`). Um lançamento tem poucas centenas de bytes; o campo `descricao` aceita no máximo 500 caracteres. Acima do limite a resposta é **413** `problem+json`. O limite é aplicado antes da autenticação, então um chamador sem credencial também não consegue fazer o serviço processar um corpo grande.
- Testes: `tests/unit/protecao-http.test.ts` nos dois serviços.

## Modelo de ameaças (STRIDE resumido)

| Ameaça | Cenário | Controle | Onde |
|---|---|---|---|
| **S**poofing (falsificação de identidade) | Chamador se passa por outro comerciante ou emite token próprio | Token assinado pelo Keycloak (RS256, JWKS), `iss`, `aud` e `exp` verificados; comerciante vem de claim fixado no cliente, não do corpo. HS256 e `alg: none` recusados | `src/middleware/auth.ts`, `keycloak/realm-caixa.json`, ADR-010 |
| **T**ampering (adulteração) | Alterar um lançamento em trânsito ou repetir uma requisição com valor diferente | Token com assinatura; mesma chave de idempotência com corpo diferente dá 409 (hash do corpo); `valor` validado e armazenado como `NUMERIC`; TLS em produção | `domain/lancamento.ts`, `domain/lancamentoService.ts`, seção de produção |
| **R**epudiation (repúdio) | Integrador nega ter registrado um lançamento | Log de cada requisição com `clienteId` e `comercianteId`; lançamento é imutável (não há PUT nem DELETE); estorno é um novo lançamento. Trilha imutável em produção (abaixo) | `src/app.ts` (pino-http), `routes/lancamentos.ts` |
| **I**nformation disclosure (vazamento) | Um comerciante lê dados de outro; token ou segredo em log; detalhes internos em erro | Toda consulta filtra por `comerciante_id` e o cache é separado por comerciante; `Authorization` redigido nos logs; erros 500 sem detalhe interno; helmet | `routes/*.ts`, `cache/saldoCache.ts`, `src/app.ts`, `http/problem.ts` |
| **D**enial of service (negação de serviço) | Rajada de requisições, corpo gigante, intervalo de consulta enorme, consolidado fora do ar | Rate limit; corpo de 16 kB (413); intervalo de até 92 dias; lançamentos independente do consolidado via Outbox; Redis como cache de leitura | `middleware/rateLimit.ts`, `src/app.ts`, `MAX_DIAS_INTERVALO`, ADR-001 |
| **E**levation of privilege (elevação) | Cliente só de leitura grava; token de uma API usado em outra | Escopo por rota (403); audiência por API (401); privilégio mínimo por cliente (BI só lê o consolidado) | `exigirEscopo` em `middleware/auth.ts`, ADR-010 |

## OWASP API Security Top 10 (2023)

| Risco | Controle | Onde | Situação |
|---|---|---|---|
| API1 Broken Object Level Authorization | Não há id de objeto escolhido pelo chamador para outro comerciante: o `comerciante_id` do token entra em todo `WHERE`, na chave de idempotência, no saldo e no cache. Teste de isolamento entre comerciantes | `routes/lancamentos.ts`, `domain/saldoQueries.ts`, `tests/integration/*multi-comerciante*` | Implementado |
| API2 Broken Authentication | OAuth2 client credentials, JWT RS256 com algoritmo fixado, `exp` obrigatório, token de 300 s. Sem endpoint de login nos serviços | `src/middleware/auth.ts`, `tests/unit/seguranca.test.ts` | Implementado |
| API3 Broken Object Property Level Authorization | Entrada validada por zod com lista fixa de campos; o `comerciante_id` nunca é aceito do corpo e campos desconhecidos são descartados. A resposta devolve só campos conhecidos, sem expor `request_hash` nem `idempotency_key` internos | `domain/lancamento.ts` | Implementado |
| API4 Unrestricted Resource Consumption | Rate limit por IP, corpo de 16 kB, intervalo de consulta de até 92 dias, `GET /lancamentos` limitado a 100 linhas, timeouts de JWKS. O rate limit é por IP e em memória (limitação registrada abaixo); a lista de lançamentos ainda não tem paginação | `middleware/rateLimit.ts`, `src/app.ts`, `routes/lancamentos.ts` | Implementado, com limitações |
| API5 Broken Function Level Authorization | Escopos separados para escrita e leitura, exigidos por rota. Cliente sem o escopo recebe 403 `insufficient_scope` | `exigirEscopo`, `tests/unit/seguranca.test.ts` | Implementado |
| API6 Unrestricted Access to Sensitive Business Flows | O fluxo sensível é o registro financeiro: idempotência por comerciante evita duplicação por reenvio; lançamentos não são alteráveis nem apagáveis. Detecção de abuso por comportamento (volume anormal por cliente) depende do gateway | `domain/lancamentoService.ts`; API Gateway em produção | Parcial (gateway proposto) |
| API7 Server Side Request Forgery | Os serviços não fazem requisições a URLs fornecidas pelo chamador. A única chamada HTTP de saída é a busca do JWKS, em endereço fixado por configuração | `src/config.ts` (`OIDC_JWKS_URI`) | Não aplicável por desenho |
| API8 Security Misconfiguration | helmet, `X-Powered-By` desligado, erros em `problem+json` sem pilha, imagens sem segredos, `.env.example` só com valores de desenvolvimento. Pendências: Keycloak em modo de desenvolvimento e HTTP no ambiente local; contêiner ainda roda como root | `src/app.ts`, `http/problem.ts`, limitações abaixo | Parcial |
| API9 Improper Inventory Management | Dois serviços, uma versão, portas e rotas listadas no README; política de versão do evento em `docs/eventos.md`; a documentação é revisada junto com o código. Falta uma especificação OpenAPI publicada | `README.md`, `docs/eventos.md` | Parcial |
| API10 Unsafe Consumption of APIs | O consolidado trata o evento do broker como entrada não confiável: valida o esquema e a versão (2.x vai para a DLQ), é idempotente e descarta o que não interpreta. O JWKS vem por HTTP com timeout e só é aceito se verificar a assinatura | `domain/evento.ts`, `consumer/lancamentosConsumer.ts`, DLQ | Implementado |

## Limitações conhecidas desta entrega

| Limitação | Por que importa | Evolução |
|---|---|---|
| Keycloak em modo desenvolvimento (banco embutido, HTTP) | Sem persistência e sem TLS | Keycloak em modo produção com PostgreSQL próprio e TLS, ou Amazon Cognito na AWS (mesmo contrato OIDC) |
| Autenticação do cliente por segredo compartilhado | Quem vaza o segredo emite tokens | `private_key_jwt` ou mTLS (RFC 8705) para os integradores mais sensíveis |
| Sem revogação imediata | Um token roubado vale até expirar (até 300 s) | Manter a validade curta; introspecção só se o risco justificar o custo de uma chamada por requisição |
| `/metrics` sem autenticação | Expõe métricas operacionais a quem alcança a porta | Restringir por rede (security group) ou scrape autenticado |
| Rate limit por IP e em memória | Atrás de um balanceador, todos compartilham o IP; com várias réplicas, o limite é por réplica | Limite por cliente (`azp`) em Redis, ou no gateway |
| HTTP sem TLS entre cliente e API | Token em texto claro em rede aberta | TLS no ALB/ingress; mTLS interno |

## Controles propostos para produção

Nada desta seção está implementado no ambiente local. São a arquitetura alvo, e o que muda no código é só configuração (URLs, certificados, variáveis).

| Tema | Proposta | Observações |
|---|---|---|
| **mTLS entre serviços** | Malha de serviço (por exemplo AWS App Mesh ou Istio) ou certificados emitidos pela AWS Private CA, com rotação automática, entre ALB, serviços, Keycloak, Redis e broker | Impede que um processo qualquer na VPC converse com as APIs. Para integradores externos sensíveis, autenticação do cliente por certificado (RFC 8705) como complemento ao token |
| **API Gateway com WAF e throttling** | Amazon API Gateway ou ALB com AWS WAF (conjunto gerenciado OWASP, regras por taxa e por IP). Plano de uso e limite por cliente (chave do token), em vez de por IP | Resolve a limitação do rate limit por IP atrás de balanceador e cobre a detecção de abuso de fluxo (API6) |
| **Segredos** | AWS Secrets Manager para senhas do banco, do broker e segredos de cliente OAuth2, com rotação automática; leitura por papel IAM da tarefa, nunca por variável gravada em imagem ou repositório | Os segredos do `realm-caixa.json` são descartados. Evolução para `private_key_jwt` elimina o segredo compartilhado |
| **Criptografia em trânsito** | TLS 1.2 ou superior em toda conexão: cliente até o gateway, `amqps://` no broker, `sslmode=verify-full` no PostgreSQL, TLS no Redis (ElastiCache) e no Keycloak | HSTS já é enviado pelo helmet |
| **Criptografia em repouso** | KMS com chave gerenciada pelo cliente (CMK) para RDS, volumes do broker, ElastiCache, S3 de backups, CloudWatch Logs e Secrets Manager. Rotação anual da chave | Política de chave separando quem administra de quem usa |
| **Trilha de auditoria imutável** | CloudTrail para acesso a segredos, chaves e configuração, entregue em bucket S3 com Object Lock (modo compliance) e validação de integridade; logs de aplicação (cliente, comerciante, operação) enviados ao CloudWatch e arquivados no mesmo tipo de bucket | Os lançamentos já são imutáveis por desenho, e o Outbox guarda o histórico de eventos |

## LGPD

As informações abaixo descrevem o que o sistema trata hoje e o que precisa ser decidido com o jurídico e o encarregado (DPO). Não são parecer jurídico.

| Aspecto | Situação |
|---|---|
| **Dados tratados** | Lançamentos: valor, tipo, data e uma descrição livre. Identificadores do comerciante e do cliente de integração (`comerciante_id`, `clienteId`) e logs de acesso. Não há CPF, nome nem dado de consumidor final como campo. O risco está na **descrição livre**, onde o integrador pode digitar nome de pessoa, documento ou outro dado pessoal |
| **Mitigação da descrição** | O limite é de 500 caracteres. Orientar o integrador a não enviar dado pessoal nesse campo; se o negócio exigir, tratá-lo como dado pessoal (mascaramento em log, direito de eliminação) |
| **Base legal (proposta)** | Execução de contrato com o comerciante (art. 7, V) para o registro do fluxo de caixa, e cumprimento de obrigação legal ou regulatória (art. 7, II) para a guarda de registros contábeis e fiscais. A validação cabe ao DPO |
| **Retenção (proposta)** | Lançamentos e saldos: pelo prazo legal de guarda contábil e fiscal, a confirmar com o jurídico (a referência usual é de cinco anos ou mais conforme a obrigação aplicável). Logs de aplicação: prazo curto e configurável (por exemplo 90 dias no CloudWatch, depois arquivo imutável). Eventos processados e DLQ: purga periódica |
| **Eliminação e anonimização** | Como o lançamento é imutável, a eliminação por pedido do titular se resolve por anonimização do campo `descricao`, mantendo valor, tipo e data. Esse procedimento ainda não está implementado |
| **Direitos do titular** | Os dados do consumidor final não são tratados como campo estruturado, então o fluxo de atendimento fica no comerciante, que é o controlador; o banco atua como operador. Papéis a formalizar em contrato |
| **Incidentes** | Auditoria e alertas permitem identificar o escopo (quem acessou o quê); o processo de comunicação à ANPD e aos titulares é organizacional |

## Segurança em produção

### Defesa em profundidade

| Camada | Controle |
|---|---|
| Borda | AWS WAF (OWASP Core Rule Set) no ALB; TLS terminando no ALB |
| Rede | VPC com sub-redes privadas; serviços e Keycloak sem exposição direta à internet |
| Aplicação | JWT (RS256, iss, aud, exp), escopos, comerciante amarrado, validação de entrada, rate limiting |
| Identidade | Keycloak em modo produção ou Cognito; rotação de segredos de cliente |
| Broker | TLS (`amqps://`) e usuário por serviço |
| Banco | Senhas no Secrets Manager; acesso só de dentro da VPC por Security Group |
| Auditoria | Logs com cliente e comerciante; CloudTrail para segredos e configuração |

### Checklist de deploy

- [ ] Keycloak em modo produção (PostgreSQL, TLS), sem o console administrativo exposto à internet
- [ ] Segredos dos clientes no Secrets Manager, com rotação, e os do `realm-caixa.json` descartados
- [ ] TLS em todas as conexões externas (clientes, banco, broker, Redis, Keycloak)
- [ ] `/metrics` restrito por rede
- [ ] WAF habilitado no ALB com o conjunto OWASP
- [ ] Security Groups com privilégio mínimo
- [ ] Imagens escaneadas (ECR Image Scanning) e executadas sem root
- [ ] Limite de taxa ajustado ao tráfego real, por cliente
- [ ] CloudTrail habilitado para auditoria de acesso a segredos
