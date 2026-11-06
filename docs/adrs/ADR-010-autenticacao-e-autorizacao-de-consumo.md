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

### Validar só no gateway (balanceador, API Gateway)
Útil na borda, mas deixaria os serviços confiando cegamente em qualquer chamada que chegue à rede interna. A validação nos serviços é a defesa em profundidade; o gateway pode repetir a checagem.

### Identity Platform do Google Cloud
É o serviço de identidade gerenciado do Google Cloud e fala OIDC, mas é voltado à autenticação de **usuários finais**. O consumo desta solução é de máquina a máquina, pelo fluxo *client credentials*, e eu **não confirmei** que o produto o ofereça; se não oferecer, ele não substitui o Keycloak aqui. Mesmo que oferecesse, a troca **não seria só configuração** (`OIDC_ISSUER`, `OIDC_JWKS_URI`, `OIDC_AUDIENCE`): os claims e os nomes dos escopos mudam, e o claim `comerciante_id` exigiria um mecanismo de geração de token. A validação em `auth.ts` precisaria aceitar esses formatos. Confirmar na documentação do produto antes de decidir diferente; a comparação de custo está em [custos.md](../custos.md).

### Tokens de identidade de contas de serviço do Google
Para chamadas entre serviços dentro do próprio Google Cloud, uma conta de serviço pode obter um token OIDC assinado pelo Google, validável por JWKS, sem Keycloak. Não carrega o `comerciante_id` nem escopos de negócio, então o vínculo entre o cliente e o comerciante ficaria em configuração dos serviços, e não serve a integradores externos (ERPs de comerciantes). **Descartado** para o consumo externo; fica como opção para chamadas internas futuras.

### Introspecção de token a cada requisição
Permitiria revogação imediata, ao custo de uma chamada ao provedor por requisição e de acoplar a disponibilidade das APIs ao Keycloak. Com a validação local por JWKS, o Keycloak pode cair sem derrubar quem já tem token. **Descartado.**

### Por que 401, e não 403, para um token com audiência errada

Um token do `bi-loja-1` (audiência `consolidado-api`) enviado ao lançamentos recebe **401**, e não 403. A distinção segue a RFC 6750:

- **401 `invalid_token`**: o token não é válido **para este recurso**. Assinatura, emissor, expiração e **audiência** definem para quem o token foi emitido. Um token cuja audiência não inclui a API chamada é, para essa API, um token inválido, do mesmo modo que um token expirado.
- **403 `insufficient_scope`**: o token é válido para a API, mas não carrega o escopo que a rota exige. A RFC 6750 reserva esse erro à insuficiência de privilégio.

Tratar audiência errada como 403 faria a API reconhecer e "autorizar" a identidade de um token que não foi emitido para ela, e revelaria a um chamador não autorizado que a credencial é legítima. Com 401 a API se comporta do mesmo jeito para qualquer token que não seja dela. Quem precisa demonstrar o 403 usa o `contabil-loja-1`, que tem as duas audiências e só o escopo de leitura: ao gravar no lançamentos recebe 403 `insufficient_scope`.

### Custo medido da validação do JWT

Para saber quanto a autenticação pesa por requisição, o benchmark `npm run bench:auth` (no consolidado) compara dois servidores Express idênticos, um sem autenticação e outro com o `authMiddleware` real, alternando as requisições na mesma conexão. A diferença é o que o middleware acrescenta, sem banco, Redis ou Keycloak.

| Execução | Sem autenticação (média / p50 / p95) | Com autenticação (média / p50 / p95) | Custo médio |
|---|---|---|---|
| 1 | 0,471 / 0,304 / 1,050 ms | 0,914 / 0,615 / 2,039 ms | 0,443 ms |
| 2 | 0,509 / 0,315 / 1,247 ms | 0,976 / 0,637 / 2,482 ms | 0,467 ms |

Em ambas, o JWKS foi buscado uma vez nas 22.000 requisições (o resto vem do cache). A validação custa **cerca de 0,3 ms na mediana e 0,45 ms na média** por requisição, e algo como 1 ms no p95 dessa máquina. A 50 req/s, isso é uma fração de um núcleo.

Isso responde à pergunta sobre a diferença entre o p95 de 12 ms medido na fase 2 e o de 24,6 ms medido na fase 3: **a validação do JWT explica, no máximo, 1 ms dessa diferença de cerca de 12 ms**. O restante não é atribuível ao JWT. O que se mediu depois sobre as outras causas:

- O **tracing** custa mais que o JWT: com ele ligado, a mediana do consolidado a 50 req/s subiu de 5,9, 6,3 e 6,1 ms para 8,7, 11,4 e 9,1 ms em três rodadas alternadas (cerca de 3 ms a mais; `docs/evidencias/custo-tracing-ablacao.txt`). A medição foi feita com o Jaeger parado, então inclui o custo de criar os spans e de falhar ao exportá-los. O tracing não existia nas medições das fases 2 e 3, então ele não explica aquela diferença; ele entra em quem liga o OpenTelemetry agora.
- A **variação entre execuções** é grande. Nas medições da fase 4, execuções idênticas deram p95 de 75 a 150 ms com a mesma mediana de cerca de 6 ms, e uma degradação de latência apareceu em várias configurações (investigação em `docs/evidencias/regressao-latencia.txt`). Os p95 de 12 e 24,6 ms foram medidos em momentos diferentes e, na própria fase 3, a primeira rodada do k6, logo depois de reiniciar o Keycloak, deu p95 de 80 ms contra 24,6 ms na segunda, com o mesmo código. Não tenho como separar quanto da diferença é variação de execução.

Resumindo: o custo da autenticação é pequeno e medido; a diferença entre 12 e 24,6 ms não é o JWT.

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
