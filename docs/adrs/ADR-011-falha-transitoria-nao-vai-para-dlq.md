# ADR-011: Falha transitória não vai para a DLQ

**Status:** Aceito  
**Data:** 2026-11-05

---

## Contexto

O consumidor do consolidado tentava aplicar o evento até 4 vezes, com 1 s, 2 s e 4 s de espera, e mandava a mensagem para a DLQ (`consolidado.lancamentos.dlq`) se todas falhassem. Isso tratava igual dois problemas muito diferentes:

- **Mensagem que nunca vai passar:** JSON quebrado, campo fora do contrato, versão 2.x. Repetir não ajuda.
- **Infraestrutura fora do ar:** o banco do consolidado indisponível, uma conexão derrubada, um tempo esgotado. A mensagem é válida; basta esperar.

Com a regra antiga, uma queda do banco de mais de cerca de 7 segundos esvaziava a fila principal para a DLQ, e alguém precisava devolver tudo à mão. Em uma queda de minutos, o resultado era uma DLQ cheia de eventos corretos. Isso contradiz o objetivo do desenho: o consolidado pode atrasar, mas não pode exigir intervenção manual por uma falha que passa sozinha.

## Decisão

1. O consumidor **classifica o erro**. São transitórios os erros de conexão e de disponibilidade do PostgreSQL (classe 08, `57P01` a `57P03`, `53300`, `40001`, `40P01`, `55P03`), de rede (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT` e semelhantes) e as mensagens equivalentes do driver (conexão terminada, tempo esgotado ao conectar). Todo o resto é permanente.
2. Em **erro transitório**, a mensagem fica **retida**: o consumidor não faz `ack` nem `nack` e tenta de novo com espera crescente (1 s, 2 s, 4 s, 8 s e depois 15 s) até o banco voltar. Como o `prefetch` é 1, isso pausa o consumo naturalmente. O contador `consolidado_consumer_transient_errors_total` mostra que está acontecendo.
3. Em **erro permanente**, vale a regra de antes: 3 retentativas com backoff e, esgotadas, a DLQ. Mensagem inválida e versão 2.x continuam indo direto para a DLQ, sem retentativa.
4. Se o processo for desligado durante a espera, a mensagem volta para a fila com `nack` e `requeue`, sem contar como falha.
5. A DLQ passa a significar **"precisa de uma pessoa"**. O reprocessamento é feito por `scripts/reprocessar-dlq.ps1` (ou `.sh`), que devolve as mensagens à fila principal pela API de gerenciamento.

## Alternativas

### `nack` com `requeue` imediato
Simples, mas o RabbitMQ devolve a mensagem na hora e o consumidor entra em laço quente, consumindo CPU e enchendo o log enquanto o banco está fora. **Descartado.**

### Cancelar o consumidor e registrar de novo quando o banco voltar
Pausa de verdade, mas exige uma sonda de saúde do banco separada e coordenação com a reconexão do broker, com mais estados para errar. A retenção dentro do tratamento da mensagem consegue o mesmo efeito com o código que já existe. **Descartado.**

### Fila de retentativa com TTL (a mensagem espera em uma fila e volta)
É o padrão mais robusto para atrasos longos e não segura o consumidor. Exige uma fila e uma exchange a mais, e a contagem de tentativas passa para os cabeçalhos. O volume e o requisito não justificam a complexidade hoje. **Adiado**; a mudança caberia aqui sem alterar o contrato.

### Manter a DLQ para tudo e automatizar o reprocessamento
Esconde o problema: a DLQ continuaria recebendo eventos válidos a cada queda, e o alerta de "DLQ não vazia" perderia o sentido. **Descartado.**

## Consequências

**Positivas:**
- Uma queda do banco do consolidado, de qualquer duração, termina com o saldo convergindo sozinho e a DLQ intacta. Está provado por teste de integração (banco bloqueado de verdade) e pelo cenário D do teste de resiliência (30 segundos, na stack real).
- O alerta da DLQ volta a ter significado: qualquer mensagem lá é um problema de dado ou de versão.

**Negativas e limites:**
- A mensagem retida ocupa o consumidor. Com `prefetch=1` e uma réplica, nada mais é processado durante a queda, o que é desejado (o banco está fora). Com várias réplicas, cada uma retém uma mensagem.
- O tempo para voltar ao normal depende da espera: depois que o banco volta, a próxima tentativa pode demorar até 15 s.
- Um erro classificado como permanente por engano vai para a DLQ depois de 7 s, e um classificado como transitório por engano fica retido para sempre. A lista de códigos é conservadora (só o que o PostgreSQL e o Node documentam como falha de infraestrutura) e coberta por testes unitários.
- O broker tem um limite de tempo para a confirmação do consumidor (`consumer_timeout`; o padrão é de 30 minutos nas versões recentes, conferir na versão em uso). Uma queda mais longa fecha o canal; a mensagem é reentregue e o ciclo recomeça, sem perda.
- Uma mensagem inválida reprocessada volta à DLQ. O script avisa e processa só o que havia ao começar, para não entrar em laço.
