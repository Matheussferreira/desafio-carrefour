# Contrato do evento LancamentoRegistrado

Evento publicado pelo `lancamentos-relay` na exchange `lancamentos.events` (routing key `lancamento.registrado`) e consumido pelo Consolidado. Entrega at-least-once; o consumidor é idempotente por `eventoId`.

## Campos (versão atual: 1.1)

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `eventoId` | UUID v4 | sim | Identificador único; chave de idempotência do consumidor (`eventos_processados`) |
| `schemaVersion` | `"maior.menor"` | sim a partir da 1.0 | Versão do contrato. Ausente é tratado como `1.0` |
| `tipo` | `"LancamentoRegistrado"` | sim | Tipo do evento. Tipo desconhecido é reconhecido (ack) e ignorado |
| `comercianteId` | string | **sim a partir da 1.1** | Dono do lançamento. 1 a 64 caracteres entre letras, números, hífen e sublinhado |
| `correlationId` | string | não | Rastreamento entre serviços |
| `createdAt` | ISO 8601 | não | Instante em que o lançamento foi registrado. Alimenta o `atualizadoAte` do consolidado |
| `data.lancamentoId` | UUID | sim | Lançamento de origem |
| `data.valor` | string decimal | sim | Maior que zero, até 2 casas, nunca número JSON |
| `data.tipo` | `"credito"` ou `"debito"` | sim | Define o sinal no resultado do dia |
| `data.descricao` | string ou null | não | Não afeta o cálculo |
| `data.data` | `YYYY-MM-DD` | sim | Data de competência. Data real do calendário, nunca timestamp |

```json
{
  "eventoId": "550e8400-e29b-41d4-a716-446655440000",
  "schemaVersion": "1.1",
  "tipo": "LancamentoRegistrado",
  "comercianteId": "loja-7",
  "correlationId": "7f3e9c1a-0000-4000-a000-000000000001",
  "createdAt": "2026-06-24T14:30:00.000Z",
  "data": {
    "lancamentoId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "valor": "1500.00",
    "tipo": "credito",
    "descricao": "Venda produto X",
    "data": "2026-06-24"
  }
}
```

## Histórico de versões

| Versão | Mudança | Como o consumidor trata |
|---|---|---|
| 1.0 | Contrato inicial, sem `comercianteId` | Credita o comerciante padrão (`padrao`) |
| 1.1 | Adiciona `comercianteId` obrigatório | Credita o comerciante informado |

## Política de versionamento

O versionamento segue `maior.menor` e o objetivo é nunca exigir deploy coordenado entre produtor e consumidor.

1. **Mudança compatível, versão menor (1.1, 1.2, ...).** Só adiciona campos. Campo novo é opcional para quem lê, ou obrigatório apenas na versão que o introduz (como `comercianteId` na 1.1). Quem consome **ignora campos que não conhece** e **aceita qualquer `1.x`**. Remover campo, mudar tipo ou mudar o significado de um campo nunca é uma mudança menor.
2. **Mudança incompatível, versão maior (2.0).** Remoção ou mudança de tipo de campo, ou de significado. O consumidor atual **recusa** a mensagem (vai para a DLQ, onde o alerta chama atenção) em vez de interpretá-la errado. A migração é feita publicando a versão nova em outra routing key (por exemplo `lancamento.registrado.v2`) com uma fila própria, enquanto a versão 1 continua sendo publicada pelo período de transição.
3. **Ordem de deploy.** Primeiro o consumidor passa a aceitar a versão nova; só depois o produtor passa a emitir. Mensagens antigas que ainda estão na fila continuam válidas, porque o consumidor aceita todas as `1.x`.
4. **Eventos já gravados no outbox não são reescritos.** Um evento pendente de versão 1.0 é publicado como está e o consumidor o trata como do comerciante padrão.
5. **O contrato é testado.** `evento-versoes.test.ts` cobre cada linha da tabela acima e as recusas (2.0, `schemaVersion` malformado, 1.1 sem `comercianteId`).
