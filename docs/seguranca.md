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
| Consolidado | `/consolidado` | 6.000 req | 60 s por IP | 100 req/s, cobre 50 req/s de pico com folga 2x para rajadas |

`/health`, `/ready` e `/metrics` ficam antes do limitador: um 429 neles poderia fazer o orquestrador matar um container saudável ou interromper o scraping do Prometheus.

### Auditoria e logs

- Todo log de requisição inclui `clienteId` (claim `azp`) e `comercianteId`, de modo que é possível responder "quem chamou, em nome de quem".
- O cabeçalho `Authorization` é **redigido** nos logs (`[Redacted]`). Foi verificado que nenhum log dos dois serviços contém um token.

### Segredos

- Configuração por variáveis de ambiente; `.env` fora do Git e `.env.example` com valores só para desenvolvimento.
- Os serviços **não guardam segredo de assinatura**: validam com a chave pública do JWKS. Não existe mais `JWT_SECRET`.
- Os segredos dos clientes no `realm-caixa.json` são de desenvolvimento. Em produção ficam no Secrets Manager e são rotacionados.

## Limitações conhecidas desta entrega

| Limitação | Por que importa | Evolução |
|---|---|---|
| Keycloak em modo desenvolvimento (banco embutido, HTTP) | Sem persistência e sem TLS | Keycloak em modo produção com PostgreSQL próprio e TLS, ou Amazon Cognito na AWS (mesmo contrato OIDC) |
| Autenticação do cliente por segredo compartilhado | Quem vaza o segredo emite tokens | `private_key_jwt` ou mTLS (RFC 8705) para os integradores mais sensíveis |
| Sem revogação imediata | Um token roubado vale até expirar (até 300 s) | Manter a validade curta; introspecção só se o risco justificar o custo de uma chamada por requisição |
| `/metrics` sem autenticação | Expõe métricas operacionais a quem alcança a porta | Restringir por rede (security group) ou scrape autenticado |
| Rate limit por IP e em memória | Atrás de um balanceador, todos compartilham o IP; com várias réplicas, o limite é por réplica | Limite por cliente (`azp`) em Redis, ou no gateway |
| HTTP sem TLS entre cliente e API | Token em texto claro em rede aberta | TLS no ALB/ingress; mTLS interno |

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
