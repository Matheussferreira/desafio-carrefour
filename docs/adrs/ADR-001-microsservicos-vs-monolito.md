# ADR-001 — Microsserviços vs. Monolito Modular

**Status:** Aceito  
**Data:** 2026-06-24

---

## Contexto

Sistema de controle de fluxo de caixa para um comerciante. Volume projetado: ~50 req/s de pico. Dois domínios funcionais bem delimitados: registro de lançamentos e consulta de saldo consolidado.

O requisito não-funcional que governa esta decisão foi enunciado de forma explícita e não-negociável:

> "O serviço de Lançamentos **nunca** pode ficar indisponível em função de falha no serviço de Consolidado."

---

## Decisão

Dois processos independentes: `lancamentos` (porta 3001) e `consolidado` (porta 3002), cada um com seu próprio banco de dados e ciclo de deploy.

---

## Alternativas Descartadas

### Opção A — Monolito Modular (descartada, mas tecnicamente viável)

Um único processo Node.js com dois módulos internos bem separados (`lancamentos/` e `consolidado/`), compartilhando o mesmo banco de dados.

**Por que seria uma escolha legítima:** A 50 req/s, um monolito modular bem estruturado seria perfeitamente adequado. Menor complexidade operacional, sem necessidade de broker, transações cross-domain simples, uma única imagem Docker, deploy trivial. Para uma equipe pequena ou um MVP, este seria o ponto de partida correto antes de qualquer extração de serviço.

**Por que foi descartada neste contexto específico:** O requisito de disponibilidade independente é incompatível com um processo único. Um memory leak, stack overflow, OOM killer ou deadlock no módulo Consolidado derruba o processo inteiro — incluindo o Lançamentos. Isolamento de falha real exige isolamento de processo. Essa é a única razão para usar microsserviços aqui; o volume não justificaria.

### Opção B — Monolito com Circuit Breaker Interno

Módulos separados dentro do mesmo processo com circuit breaker entre eles (ex: `opossum`).

**Por que foi descartada:** Mitiga falhas de lógica mas não protege contra falhas de processo (OOM, crash nativo). A complexidade de tunar circuit breakers internos é comparável à de rodar dois containers leves, sem o ganho de isolamento real. Solução de complexidade para um problema que tem solução estrutural mais limpa.

### Opção C — Três ou mais microsserviços

Separar também o outbox relay, o consumer e a API de cada domínio em processos distintos.

**Por que foi descartada:** Overengineering sem ganho mensurável a esse volume. Aumenta a superfície operacional (mais healthchecks, mais imagens, mais pontos de falha de rede interna) sem resolver um problema real. O outbox relay e o consumer são parte natural do processo do seu respectivo serviço.

---

## Consequências

**Ganhos reais com essa decisão:**
- Isolamento de processo: crash, OOM ou deploy do Consolidado não interrompe o Lançamentos
- Deploy independente: cada serviço pode ser atualizado, escalado ou rollbackado sem parar o outro

**Custos reais com essa decisão:**
- Comunicação assíncrona obrigatória: não há como fazer uma transação distribuída simples; consistência eventual é um efeito colateral da arquitetura, não uma escolha opcional
- Complexidade operacional: dois conjuntos de logs, métricas, healthchecks e imagens onde um bastaria para o volume atual
- Tracing distribuído mais trabalhoso: uma requisição atravessa dois serviços e um broker; mitigado com `correlationId` propagado no evento, mas ainda inferior à observabilidade de um processo único

**O que eu faria em uma greenfield real a esse volume:** Monolito modular primeiro, com interfaces bem definidas entre os módulos de Lançamentos e Consolidado. Extrairia para microsserviços apenas quando surgisse um requisito que o monolito não pudesse atender — escalabilidade assimétrica, times separados, ou exatamente esse requisito de disponibilidade independente.

## Atualização (ADR-008)

O relay do outbox passou a rodar como processo separado (`lancamentos-relay`), por motivos de resiliência e de escala. A decisão de manter um único serviço de lançamentos e um único serviço de consolidado continua valendo; o que mudou foi apenas o relay.
