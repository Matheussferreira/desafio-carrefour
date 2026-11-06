# ADR-013: Stack tecnológica

**Status:** Aceito  
**Data:** 2026-11-05

---

## Contexto

Os ADRs anteriores decidem o estilo (dois serviços, comunicação assíncrona), o broker, o cache e a nuvem alvo. Faltava registrar a escolha da linguagem, do framework HTTP, do banco e da forma de execução local, que condicionam todo o código. O critério prático foi entregar e manter uma solução correta e testada dentro do prazo de um desafio, sem abrir mão do que os requisitos exigem: dinheiro sem erro de arredondamento, publicação confiável de eventos, concorrência segura entre relays e execução reproduzível com um comando.

## Decisão

| Camada | Escolha | Papel |
|---|---|---|
| Linguagem e runtime | TypeScript sobre Node.js 20 | Os dois serviços e o consumidor |
| Framework HTTP | Express 4 | APIs REST, middlewares de autenticação, limite de taxa e métricas |
| Banco | PostgreSQL 16 (Cloud SQL for PostgreSQL em produção no GCP) | Lançamentos, outbox, projeção do consolidado |
| Execução local | Docker Compose | Pilha completa com um comando, incluindo broker, cache, Keycloak e observabilidade |

### TypeScript e Node.js 20

- É a linguagem que o autor domina, e isso pesa: o risco de um desafio com prazo é errar no que não se conhece bem.
- O modelo de I/O assíncrono atende o perfil dos dois serviços, que passam o tempo esperando banco, cache e broker, e não calculando. O consumidor processa uma mensagem por vez, e o relay é um laço de consulta e publicação.
- O ecossistema cobre o que é preciso com bibliotecas maduras: `amqplib` (RabbitMQ), `pg` (PostgreSQL), `ioredis` (Redis), `jose` (validação de JWT), `prom-client` (Prometheus), `zod` (validação de entrada) e `decimal.js` (valores monetários).
- O tipo estático do TypeScript protege os contratos de evento e as fronteiras entre as camadas, e os testes com Jest cobrem o resto.

### Express

- É mínimo e sem convenções implícitas: cada middleware aparece na ordem em que executa, o que ajuda a revisar autenticação, limite de payload e métricas, que são pontos de segurança.
- **NestJS** daria injeção de dependência, módulos e decoradores prontos, e pesaria a favor de uma equipe grande que precisa de padrão imposto. Para dois serviços pequenos, acrescentaria uma camada de abstração e de convenções maior que o código de negócio.
- **Fastify** é mais rápido em benchmarks de terceiros e tem validação por esquema embutida. A vazão medida aqui, cerca de 197 a 199 req/s numa instância ([testes.md](../testes.md)), sobra frente ao requisito de 50 req/s, então a vantagem de desempenho não decide. O ganho não compensou o custo de adotar outro modelo de plugins quando Express já resolve.

### PostgreSQL

- Transações ACID: o lançamento e o evento do outbox são gravados na mesma transação ([ADR-005](ADR-005-outbox-pattern.md)).
- `NUMERIC` guarda valores monetários exatos, sem ponto flutuante. O valor trafega como string na API e é tratado com `decimal.js` no código.
- `FOR UPDATE SKIP LOCKED` permite que mais de um relay divida as linhas pendentes do outbox ([ADR-008](ADR-008-relay-processo-separado.md)).
- `ON CONFLICT` implementa a idempotência com uma constraint única, sem depender de isolamento serializável ([ADR-007](ADR-007-idempotencia.md)) e também o upsert da projeção do consolidado ([ADR-009](ADR-009-saldo-acumulado-e-multi-comerciante.md)).
- No Google Cloud existe como serviço gerenciado (Cloud SQL), com alta disponibilidade regional, recuperação para um instante e backups ([arquitetura-alvo-cloud.md](../arquitetura-alvo-cloud.md)). A única extensão usada é a `pgcrypto` (para `gen_random_uuid()`), que deve ser conferida na lista de extensões suportadas pelo Cloud SQL antes do primeiro ambiente; no PostgreSQL 13 ou superior a função também existe sem extensão.

### Docker Compose

- Um `docker compose up` sobe a pilha inteira, o que é parte da avaliação (execução local reproduzível) e também a base dos testes de integração e de resiliência, que derrubam serviços reais.
- É um recurso de desenvolvimento. Produção roda em Kubernetes ([arquitetura-alvo-cloud.md](../arquitetura-alvo-cloud.md)), e as imagens são as mesmas.

## Alternativas

### Java com Spring Boot
Ecossistema muito maduro para domínio financeiro, tipos fortes, transações declarativas, bibliotecas de resiliência e grande base de profissionais em bancos. Seria uma escolha defensável, e numa equipe com Java consolidado eu a preferiria. Aqui o custo seria maior tempo de partida dos serviços, mais código de cerimônia para dois serviços pequenos e menor domínio do autor, o que aumenta o risco de erro dentro do prazo. **Não escolhido** por adequação ao contexto, e não por limitação técnica.

### .NET
Desempenho alto, ótimas ferramentas e bom suporte no Azure. A cobertura de bibliotecas para RabbitMQ, PostgreSQL e Redis é boa. Descartado pelo mesmo motivo do Java (domínio do autor e prazo), e porque a nuvem alvo é o Google Cloud, onde o .NET não tem vantagem de integração.

### Go
Binários pequenos, partida rápida, uso baixo de memória e concorrência simples, o que é bom para relay e consumidor. O custo é a ausência de tipos monetários e de ecossistema de validação tão prontos quanto os de TypeScript, mais código manual e menor domínio do autor. É a alternativa que mais faria sentido se o consumo de memória por pod virasse custo relevante; nesse caso o relay poderia ser reescrito em Go sem afetar o resto, porque a fronteira é o banco e o broker.

### Outros bancos
Um banco NoSQL não oferece a transação entre lançamento e outbox com a mesma simplicidade. MySQL cobriria o essencial, mas `SKIP LOCKED` só existe a partir da versão 8, e o ecossistema de `NUMERIC` e `ON CONFLICT` do PostgreSQL é mais direto. Descartados.

## Consequências

Positivas:
- Uma linguagem só para serviços, testes, scripts de carga e contratos, o que reduz a troca de contexto.
- As propriedades que os requisitos exigem (dinheiro exato, publicação confiável, idempotência, concorrência segura) vêm de recursos do PostgreSQL, e não de bibliotecas.
- Execução local com um comando, e testes de integração contra os mesmos componentes reais.

Negativas:
- Node.js tem um único thread de execução por processo: uma tarefa de CPU pesada bloqueia o event loop. Hoje não há tarefa assim, e a escala é horizontal por processo.
- O Express não impõe estrutura; a disciplina de camadas depende da equipe e da revisão.
- TypeScript e Express não são uma escolha habitual em bancos grandes que padronizam em Java ou .NET. Numa equipe assim, a decisão seria revisitada pelo padrão da casa, e o custo de reescrita seria limitado, por serem apenas dois serviços pequenos.
- O Node.js 20 sai do suporte pelo calendário público de versões do Node.js (previsto para abril de 2026, a confirmar). Subir para uma versão LTS mais nova é manutenção pendente, listada em [evolucoes.md](../evolucoes.md).
- O Express 4 está em manutenção, e a versão 5 existe; a migração é pequena, mas não foi feita.
