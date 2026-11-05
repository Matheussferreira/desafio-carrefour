# ADR-010: Autenticação e autorização de consumo com Keycloak e OAuth2

**Status:** Aceito  
**Data:** 2026-11-05  
**Detalhes operacionais:** [seguranca.md](../seguranca.md)

## Contexto

O enunciado pede critérios de segurança para o consumo (integração) dos serviços. O estado anterior tinha dois problemas sérios:

1. `POST /auth/login` emitia um JWT para qualquer chamador, sem credencial, nos dois serviços.
2. Os tokens usavam HS256 com **um segredo compartilhado** entre os serviços. Quem conhece o segredo emite token de qualquer comerciante, e os serviços não tinham como distinguir um emissor legítimo de outro.

Além disso, não havia noção de autorização: qualquer token válido podia tudo, e o comerciante era um claim fabricado no mesmo login.

## Decisão

- **Provedor de identidade:** Keycloak, com um realm `caixa`. Os integradores são clientes OAuth2 confidenciais no fluxo **client credentials**, sem usuários humanos.
- **Validação nos serviços:** os dois serviços verificam o JWT por conta própria (assinatura **RS256** pelo JWKS, `iss`, `aud`, `exp`), com o algoritmo fixado. Não há segredo de assinatura nos serviços.
- **Autorização por escopo:** `lancamentos.write`, `lancamentos.read` e `consolidado.read`. Cada rota exige o seu.
- **Audiência por API:** os escopos carregam um mapper de audiência. Um token emitido para o consolidado não é aceito pelo lançamentos, mesmo que traga um escopo de nome parecido.
- **Comerciante amarrado à credencial:** o `comerciante_id` é um claim fixo configurado **no cliente** pelo administrador do realm. O integrador não escolhe e o serviço nunca lê o comerciante do corpo.
- **Token curto:** 300 s e sem refresh. A revogação imediata não existe; a janela de risco é a validade.
- **`/auth/login` removido** dos dois serviços, junto com `JWT_SECRET` e a dependência `jsonwebtoken`.
- **Falha do provedor é 503, não 401.** Se não for possível obter o JWKS, a resposta é 503 com `Retry-After`. 401 fica para token realmente inválido.

## Alternativas

### Manter HS256 com segredo compartilhado
Era o estado anterior. Qualquer serviço que conheça o segredo emite tokens de qualquer comerciante, e girar o segredo exige deploy coordenado. **Descartado.**

### Chaves de API estáticas
Simples, mas sem expiração padronizada, sem escopos, sem audiência e com revogação manual. Reimplementaria pior o que o OAuth2 já resolve. **Descartado.**

### Somente mTLS
Dá identidade forte ao cliente, mas não expressa escopos nem o vínculo com o comerciante. Fica como **complemento** (autenticação do cliente por certificado, RFC 8705) para integradores sensíveis, não como substituto.

### Validar só no gateway (ALB, API Gateway)
Útil na borda, mas deixaria os serviços confiando cegamente em qualquer chamada que chegue à rede interna. A validação nos serviços é a defesa em profundidade; o gateway pode repetir a checagem.

### Amazon Cognito
É a opção natural na AWS e fala o mesmo OIDC, então a troca não exige mudança de código, só de configuração (`OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`). Para o ambiente local reproduzível, Keycloak roda em um container e dispensa conta de nuvem. **Cognito segue como equivalente de produção.**

### Introspecção de token a cada requisição
Permitiria revogação imediata, ao custo de uma chamada ao provedor por requisição e de acoplar a disponibilidade das APIs ao Keycloak. Com a validação local por JWKS, o Keycloak pode cair sem derrubar quem já tem token. **Descartado.**

### Por que 401, e não 403, para um token com audiência errada

Um token do `bi-loja-1` (audiência `consolidado-api`) enviado ao lançamentos recebe **401**, e não 403. A distinção segue a RFC 6750:

- **401 `invalid_token`**: o token não é válido **para este recurso**. Assinatura, emissor, expiração e **audiência** definem para quem o token foi emitido. Um token cuja audiência não inclui a API chamada é, para essa API, um token inválido, do mesmo modo que um token expirado.
- **403 `insufficient_scope`**: o token é válido para a API, mas não carrega o escopo que a rota exige. A RFC 6750 reserva esse erro à insuficiência de privilégio.

Tratar audiência errada como 403 faria a API reconhecer e "autorizar" a identidade de um token que não foi emitido para ela, e revelaria a um chamador não autorizado que a credencial é legítima. Com 401 a API se comporta do mesmo jeito para qualquer token que não seja dela. Quem precisa demonstrar o 403 usa o `contabil-loja-1`, que tem as duas audiências e só o escopo de leitura: ao gravar no lançamentos recebe 403 `insufficient_scope`.

## Consequências

**Positivas:**
- Nenhum serviço consegue emitir token. Só o provedor assina.
- Consumo com privilégio mínimo: o BI só lê o consolidado, a contabilidade lê mas não grava, comprovado com os clientes `bi-loja-1` e `contabil-loja-1`.
- O isolamento entre comerciantes agora depende de uma credencial, não de uma declaração do chamador.
- O Keycloak fora do ar não derruba as APIs para quem já tem token, e a rotação de chaves é absorvida sem reinício.
- Os logs registram cliente e comerciante, e o cabeçalho `Authorization` é redigido.

**Negativas:**
- Mais um componente para operar. No ambiente local o Keycloak em modo desenvolvimento usou cerca de 400 MiB de memória (observado com `docker stats`) e leva alguns minutos para ficar saudável na primeira subida, por causa do pull da imagem e da importação do realm.
- Um token roubado vale até expirar (até 300 s).
- O segredo do cliente é compartilhado entre o Keycloak e o integrador; vazá-lo permite emitir tokens daquele cliente. A evolução é `private_key_jwt` ou mTLS.
- O Keycloak local roda em HTTP e com banco embutido; produção exige o modo de produção com PostgreSQL e TLS.
