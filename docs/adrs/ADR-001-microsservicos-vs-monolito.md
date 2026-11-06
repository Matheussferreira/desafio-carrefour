# ADR-001: Microsserviços vs. Monolito Modular

**Status:** Aceito (revisado em 2026-11-05)  
**Data:** 2026-06-24

---

## Contexto

Sistema de controle de fluxo de caixa para um comerciante. Volume projetado: cerca de 50 req/s de pico no consolidado. Dois domínios funcionais bem delimitados: registro de lançamentos e consulta de saldo consolidado.

O requisito não funcional que governa esta decisão foi enunciado de forma explícita:

> "O serviço de Lançamentos **nunca** pode ficar indisponível em função de falha no serviço de Consolidado."

Este ADR foi revisado para registrar com mais honestidade um ponto: um monólito modular seria uma resposta defensável a este problema, e a decisão por dois processos se apoia em um único argumento, o requisito acima, não em preferência por microsserviços.

---

## Decisão

Dois processos independentes: `lancamentos` (porta 3001) e `consolidado` (porta 3002), cada um com seu próprio banco de dados e ciclo de deploy. O relay do outbox roda como um terceiro processo do domínio de lançamentos (`lancamentos-relay`, ver ADR-008).

## O argumento que decide: o RNF pede isolamento de processo

O requisito fala em **falha**. Para ele valer, uma falha no consolidado não pode alcançar o lançamento por nenhum caminho. Os caminhos de propagação de falha entre dois módulos no mesmo processo são:

| Caminho | Exemplo | Isolamento dentro do mesmo processo |
|---|---|---|
| Memória | Vazamento no consolidado esgota o heap; o OOM killer derruba o processo | Nenhum: lançamentos cai junto |
| Event loop | Uma consulta ou um laço síncrono pesado no consolidado bloqueia o único thread do Node.js | Nenhum: lançamentos fica sem atender |
| Falha não tratada | Exceção não capturada ou erro nativo no consumidor | Nenhum: o processo encerra |
| Deploy | Subir uma versão nova do consolidado reinicia o processo inteiro | Nenhum: lançamentos reinicia junto |
| Pool de conexões e locks | Consumidor lento esgota o pool do banco compartilhado | Só se houver bancos e pools separados |

Circuit breaker interno, filas em memória e *worker threads* mitigam parte desses caminhos (falhas de lógica), mas não os de processo (memória, crash nativo, deploy). A forma estrutural de eliminar os caminhos é **separar o processo**, e é isso que o ADR registra. A separação de banco (ADR-004) complementa: sem ela, o isolamento de processo seria contornado pelo pool e pelos locks.

Note que o RNF não exige **microsserviços** no sentido organizacional (times independentes, tecnologias diferentes). Exige processos separados. Duas entregas do mesmo repositório, com módulos bem delimitados e um contrato de evento entre eles, cumprem o requisito.

---

## Alternativas

### Opção A: monólito modular (descartada para este requisito, mas defensável)

Um único processo Node.js com dois módulos internos separados (`lancamentos/` e `consolidado/`), compartilhando ou não o banco.

O que ela teria de bom. A 50 req/s, um monólito modular bem estruturado atende o volume com folga. Haveria menos complexidade operacional, nenhuma necessidade de broker para integrar os módulos (uma chamada de função, ou um barramento em memória), transações entre os dois domínios triviais, uma única imagem e um único deploy, e observabilidade e depuração mais simples (um único trace, sem propagação de contexto por mensageria). Para uma equipe pequena ou um MVP, é um ponto de partida correto, e o próprio enunciado de volume não pede mais do que isso.

Por que não resolve este requisito. Ver a tabela acima: memória, event loop, falha não tratada e deploy compartilhados. Quando o enunciado diz "nunca pode ficar indisponível em função de falha no Consolidado", a primeira pergunta de um arquiteto é "o que acontece se o consolidado travar?". No monólito, a resposta é "o lançamento trava também". Aceitar isso seria reinterpretar o requisito como "indisponível por erro de lógica", o que é uma leitura mais fraca do que a escrita.

Quando a decisão deveria ser revista. Se o negócio aceitar uma indisponibilidade conjunta e curta (por exemplo, com várias réplicas do monólito e deploy sem parada), a Opção A volta a ser a melhor, porque o custo operacional dos dois processos deixa de se pagar. Também se o volume ficar muito abaixo do projetado e a equipe for de uma ou duas pessoas.

### Opção B: monólito com circuit breaker interno

Módulos separados no mesmo processo com um circuit breaker entre eles (por exemplo, `opossum`).

Por que foi descartada. Mitiga falha de lógica, não de processo (OOM, crash nativo, deploy). O esforço de ajustar breakers é comparável ao de manter dois contêineres leves, sem o ganho de isolamento real.

### Opção C: três ou mais microsserviços

Separar também o consumidor e a API de cada domínio em processos distintos.

Por que foi descartada. Sem ganho mensurável a este volume. Aumenta a superfície operacional (imagens, healthchecks, rede interna) sem resolver um problema real. O consumidor é parte natural do processo do consolidado. O relay é a exceção, separado por motivos próprios (ADR-008).

---

## Consequências

Ganhos reais com essa decisão:
- Isolamento de processo: crash, OOM ou deploy do consolidado não interrompe o lançamentos. O teste `tests/resiliencia` (cenário A) prova o comportamento com o consolidado parado.
- Deploy e escala independentes: o consolidado, que é de leitura intensiva, escala sem escalar o lançamentos.

Custos reais com essa decisão:
- Comunicação assíncrona obrigatória: não há transação distribuída simples, e a consistência eventual é consequência da arquitetura, não uma escolha opcional (ADR-002).
- Mais complexidade operacional: dois conjuntos de logs, métricas, healthchecks e imagens (três com o relay), um broker, um outbox e um consumidor idempotente. Tudo isso existe por causa desta decisão e não existiria no monólito.
- Observabilidade mais trabalhosa: uma requisição atravessa dois serviços e um broker. Mitigado com `correlationId` no evento e com propagação do `traceparent` na mensagem (ver [observabilidade.md](../observabilidade.md)), mas ainda inferior a um processo único.
- Custo de infraestrutura maior (ver [custos.md](../custos.md)): mais tarefas, dois bancos e um broker em cluster.

O que eu faria em uma greenfield real com este volume e sem o RNF: monólito modular primeiro, com interfaces bem definidas entre os módulos de lançamentos e de consolidado e um contrato de eventos já pronto (dentro do processo). Extrairia o consolidado para outro processo quando surgisse um requisito que o monólito não atendesse: escala assimétrica, equipes separadas ou exatamente esse requisito de disponibilidade independente. O desenho atual preserva essa possibilidade nos dois sentidos, porque o contrato entre os módulos já é o evento versionado ([eventos.md](../eventos.md)).

## Atualização (ADR-008)

O relay do outbox passou a rodar como processo separado (`lancamentos-relay`), por motivos de resiliência e de escala. A decisão de manter um único serviço de lançamentos e um único serviço de consolidado continua valendo; o que mudou foi apenas o relay.
