# Segurança

## Estado Atual — O que está implementado

### Autenticação — JWT

- Todos os endpoints de negócio (`/lancamentos`, `/consolidado`) exigem JWT Bearer token
- Secret configurado via variável de ambiente `JWT_SECRET` — nunca hardcoded; default `dev-secret-change-in-production` funciona localmente
- Endpoint `/auth/login` de desenvolvimento: aceita qualquer corpo (sem credenciais), devolve token válido por 24h
- **Por que existe:** Para que o avaliador obtenha um token em 5 segundos sem configurar usuários. É uma concessão deliberada de segurança, documentada explicitamente como tal.
- **Em produção:** substituir por OAuth2 (Authorization Code para usuários humanos, Client Credentials para serviço-a-serviço). O endpoint `/auth/login` deve ser desabilitado ou protegido por IP allowlist.

### Validação de Input

- Todos os inputs de API validados com **zod** antes de qualquer acesso ao banco
- `valor`: string decimal positiva, até 2 casas e no máximo 999999999.99. Número JSON é recusado, porque já chegaria como float
- `tipo`: enum estrito `credito` | `debito`
- `data`: precisa ser uma data real do calendário no formato `YYYY-MM-DD` (2024-02-30 é recusada com 400)
- `valor` armazenado como `NUMERIC(15,2)`, nunca `float`; processado como `Decimal` (decimal.js) na aplicação

### Idempotency Key

O `X-Idempotency-Key` é tratado como **string opaca**: o servidor não inspeciona, não valida formato, não infere semântica. Um UUID v4 é a convenção recomendada, mas qualquer string serve. Isso evita acoplar clientes a um formato específico de ID.

### Rate Limiting

| Serviço | Rota | Limite | Janela | Justificativa |
|---|---|---|---|---|
| Lancamentos | `/auth`, `/lancamentos` | 1.200 req | 60s por IP | 20 req/s — comporta integração ERP em lote sem bloquear uso legítimo |
| Consolidado | `/auth`, `/consolidado` | 6.000 req | 60s por IP | 100 req/s — cobre 50 req/s de pico com folga 2× para rajadas |

**Endpoints isentos de rate limiting:** `/health`, `/ready` e `/metrics` são registrados antes do middleware de rate limiting em ambos os serviços.

- `/health` e `/ready`: um `429` aqui pode fazer o orquestrador (ECS, Kubernetes) declarar o container não-saudável e matá-lo — criando uma falha artificial em container completamente funcional.
- `/metrics`: o scraper do Prometheus faz polls contínuos (a cada 15s); incluí-los na cota de negócio consome cota de um IP legítimo (o próprio scraper) e pode causar alertas falsos.

### Segredos

- Todos os segredos via variáveis de ambiente
- `.env` no `.gitignore` — nunca commitado
- `.env.example` com valores default funcionais para ambiente local
- **Em produção:** AWS Secrets Manager com rotação automática

---

## Segurança para Produção

### mTLS — Comunicação Interna

Para comunicação síncrona eventual entre serviços, usar **mTLS** (mutual TLS):

```
Serviço A → [certificado de cliente] → Serviço B → [verifica CA interna]
```

- Emitir certificados via **AWS Certificate Manager Private CA** ou **Vault PKI**
- Rotação automática de certificados (cert-manager em Kubernetes, ou ACM no ECS)
- Cada serviço tem identidade única — impossível spoofar

### OAuth2 Client Credentials — Serviço-a-Serviço

Para autenticação de serviço-a-serviço nas APIs REST:

```
Serviço A → POST /token (client_id + client_secret) → Auth Server → access_token
Serviço A → GET /consolidado (Bearer access_token) → Serviço B → [valida com JWKS]
```

- `client_id` e `client_secret` armazenados no **Secrets Manager**
- Tokens de curta duração (15-60 minutos) com renovação automática
- Escopo limitado por serviço

### TLS no RabbitMQ

- Em produção, RabbitMQ com TLS: `amqps://`
- No Amazon MQ, TLS é habilitado por padrão; clientes se conectam via `amqps://`
- Certificados do broker via ACM Private CA

### Defesa em Profundidade

| Camada | Controle |
|---|---|
| Borda | AWS WAF (OWASP Core Rule Set) no ALB |
| Rede | VPC com subnets privadas; serviços não expostos à internet |
| Aplicação | JWT + validação de input (zod) + rate limiting |
| Serviço-a-serviço | mTLS ou OAuth2 Client Credentials |
| Broker | TLS + autenticação por usuário/senha |
| Banco | Senha via Secrets Manager; acesso apenas de dentro da VPC via Security Group |
| Secrets | Secrets Manager com rotação automática e auditoria via CloudTrail |

### Checklist de Segurança para Deploy em Produção

- [ ] `JWT_SECRET` substituído por valor aleatório de 256 bits gerado de forma segura
- [ ] Endpoint `/auth/login` desabilitado ou protegido por IP allowlist restrita
- [ ] TLS habilitado em todas as conexões externas (banco, broker, Redis, entre serviços)
- [ ] Secrets Manager configurado com rotação automática habilitada
- [ ] VPC com subnets privadas para todos os serviços internos
- [ ] WAF habilitado no ALB com OWASP ruleset
- [ ] Security Groups com princípio do menor privilégio (ingress apenas das fontes necessárias)
- [ ] Imagens Docker escaneadas com ECR Image Scanning antes de deploy
- [ ] CloudTrail habilitado para auditoria de acesso a secrets e mudanças de configuração
- [ ] Rate limiter ajustado para limites de produção (diferente do ambiente de teste de carga)
