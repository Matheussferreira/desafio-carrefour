# ADR-006: Cache Redis para GET /consolidado

**Status:** Aceito  
**Data:** 2026-06-24

---

## Contexto

O requisito não-funcional exige suporte a 50 req/s no `GET /consolidado` com menos de 5% de perda de requisições.

Antes de qualquer decisão de cache, é necessário quantificar o problema real:

- **Consulta sem cache, medida:** a consulta de saldo no PostgreSQL leva de 0,24 a 1,17 ms (`EXPLAIN ANALYZE` com 3 anos de histórico, [ADR-009](ADR-009-saldo-acumulado-e-multi-comerciante.md)). Na ponta do cliente (k6, com validação do JWT e rede), a mediana foi de 8,97 ms com o cache frio e 4,76 ms com o cache quente.
- **Conclusão:** o PostgreSQL sozinho atende 50 req/s com folga; a diferença que o cache faz, medida de ponta a ponta, é de alguns milissegundos. O cache **não é necessário para passar no requisito de volume**.

---

## Decisão

**Implementar Redis com Cache-Aside e invalidação ativa**, mesmo que o banco sozinho seja suficiente.

Essa decisão é uma simplificação consciente com dois objetivos que não são de capacidade:

1. **Headroom para crescimento:** A 500 req/s ou 5.000 req/s, o banco seria gargalo. Implementar o padrão agora evita uma refatoração urgente sob pressão.
2. **Demonstração do padrão de read model:** O saldo consolidado é uma projeção derivada de eventos. Servi-lo de um store otimizado para leitura (Redis) em vez do banco transacional é a separação de responsabilidades correta em uma arquitetura orientada a eventos, independente de volume.

**Redis é cache, não fonte de verdade.** A fonte de verdade é sempre o `saldo_diario` no Postgres. Perder o Redis gera cache miss, nunca perda de dados.

---

## Estratégia implementada

```
GET /consolidado/:data
  ├─ Redis HIT  → retorna do cache, campo "source": "cache"
  ├─ Redis MISS → query Postgres → SETEX 60s → retorna, campo "source": "database"
  └─ Redis DOWN → fallback direto no Postgres, sem erro para o cliente
```

Invalidação ativa: ao processar um `LancamentoRegistrado`, o consumer avança, após o COMMIT, a versão do cache do comerciante (contador no Redis incluído na chave `saldo:e{epoca}:{comerciante}:v{versao}:{data}`; a época é um contador global que sobe quando o cliente Redis reconecta). O próximo request usa a versão nova, vai ao banco e repopula o cache. Detalhes, inclusive a corrida que isso elimina, no ADR-009.

---

## Alternativas Descartadas

### Sem cache: só banco

**Análise honesta:** Funcionaria para o requisito atual. 50 req/s com query por chave primária (DATE) é trivial para qualquer banco relacional moderno. Seria a escolha mais simples e a correta se o único objetivo fosse passar no threshold de 50 req/s.

**Por que não:** Não demonstra o padrão de separação entre write model (banco transacional) e read model (store de leitura), que é um componente relevante da arquitetura em sistemas orientados a eventos.

### Write-through (atualizar cache e banco juntos)

O consumer atualiza Redis e Postgres na mesma operação de processamento do evento.

**Descartado:** Se o `SET` no Redis falhar após o `COMMIT` no Postgres, o cache fica stale indefinidamente, sem TTL para corrigir automaticamente. A invalidação ativa é mais segura: o pior caso é um miss, não um dado errado no cache.

### TTL longo (5+ minutos)

Aumentaria hit rate mas manteria o saldo stale por mais tempo após um lançamento.

**Descartado:** Com invalidação ativa por evento, o TTL de 60s serve apenas como fallback de segurança (por exemplo, entradas que escaparem da época e da versão). Um TTL de 60s é um equilíbrio razoável entre consistência e proteção contra eventos de invalidação perdidos.

### Redis como broker (Redis Streams)

Usar Redis tanto como cache quanto como broker, eliminando o RabbitMQ.

**Descartado:** Ver ADR-003. A semântica de redelivery, DLQ e ACK do AMQP é mais adequada para o padrão Outbox do que Redis Streams. Usar Redis para ambos os papéis misturaria responsabilidades em um componente único.

---

## Consequências

**Positivas:**
- Leitura servida do Redis para datas em cache; a diferença medida de ponta a ponta é pequena (mediana de 4,76 ms contra 8,97 ms, ADR-009)
- Demonstra o padrão Cache-Aside com invalidação ativa por evento
- Fallback automático no banco se Redis estiver indisponível, sem degradação de disponibilidade, apenas de latência

**Negativas:**
- Janela de inconsistência entre o COMMIT e o avanço da versão do cache: o cache ainda pode servir, por instantes, o valor anterior ao evento (a corrida de gravação atrasada é tratada pelo versionamento, ADR-009)
- Um componente extra para operar, monitorar e fazer backup (ainda que Redis seja stateless do ponto de vista de dados críticos)
- Single-node neste setup: perda do Redis descarta o cache inteiro (aceitável, o banco assume)

**Honestidade sobre o tamanho da aposta:** Se o requisito fosse "50 req/s, entregue em 2 dias, custo mínimo", eu não adicionaria Redis. A decisão aqui é uma troca consciente: mais complexidade operacional em troca de demonstrar o padrão corretamente e ter headroom para crescimento sem redesign.
