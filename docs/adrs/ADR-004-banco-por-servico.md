# ADR-004: Banco por Serviço

**Status:** Aceito  
**Data:** 2026-06-24

## Contexto

Com dois microsserviços, precisamos decidir a estratégia de banco de dados: banco compartilhado, schema compartilhado ou banco por serviço.

## Decisão

**Banco por serviço:** `lancamentos_db` e `consolidado_db` na mesma instância PostgreSQL, mas nenhum serviço acessa o banco do outro.

> Mesma instância Postgres para simplificar o ambiente local. Em produção, seriam instâncias RDS separadas.

## Alternativas

### Banco compartilhado (mesmo schema)
Ambos os serviços conectam no mesmo database e nas mesmas tabelas.

**Por que foi descartado:** Viola o isolamento de microsserviços. Um JOIN ou migration de um serviço pode travar o outro. Impossibilita deployments independentes de schema.

### Schema por serviço (mesmo database, schemas diferentes)
`lancamentos.lancamentos` e `consolidado.saldo_diario` na mesma database.

**Descartado:** Ainda é possível fazer JOIN entre schemas acidentalmente. Menos isolamento real.

## Consequências

**Positivas:**
- Nenhum serviço pode fazer JOIN nas tabelas do outro: isolamento garantido pelo banco
- Migrations independentes: cada serviço evolui seu schema sem coordenar com o outro
- Em produção, cada banco pode ter políticas de backup, retenção e réplicas independentes

**Negativas:**
- Não existe foreign key entre `lancamentos.lancamentos.id` e `consolidado.saldo_diario.data`: consistência é responsabilidade da camada de evento
- Duas strings de conexão para gerenciar
- Em caso de necessidade de relatório que cruza os dois domínios, seria necessário uma camada de BI/analytics separada
