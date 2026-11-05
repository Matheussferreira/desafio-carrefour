import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { isDataReal } from './data';

/** Limite por lançamento: 9 dígitos inteiros e 2 casas, bem abaixo do NUMERIC(15,2) do banco. */
export const VALOR_MAXIMO = '999999999.99';

export const lancamentoSchema = z.object({
  valor: z
    .string({
      required_error: 'valor é obrigatório',
      invalid_type_error: 'valor deve ser uma string decimal, por exemplo "150.00"',
    })
    .regex(
      /^\d{1,9}(\.\d{1,2})?$/,
      `valor deve ter até 2 casas decimais e no máximo ${VALOR_MAXIMO}`,
    )
    .refine(v => /[1-9]/.test(v), 'valor deve ser maior que zero'),
  tipo: z.enum(['credito', 'debito'], {
    errorMap: () => ({ message: 'tipo deve ser "credito" ou "debito"' }),
  }),
  descricao: z.string().max(500, 'descricao aceita no máximo 500 caracteres').optional(),
  data: z
    .string({ required_error: 'data é obrigatória' })
    .refine(isDataReal, 'data deve ser uma data real no formato YYYY-MM-DD'),
});

export type NovoLancamento = z.infer<typeof lancamentoSchema>;

export function normalizarValor(valor: string): string {
  return new Decimal(valor).toFixed(2);
}

/**
 * Impressão digital do corpo da requisição, usada para distinguir um reenvio legítimo
 * de uma reutilização da chave de idempotência com outro conteúdo.
 * O valor é normalizado para que "100" e "100.00" sejam o mesmo pedido.
 */
export function hashCorpo(l: NovoLancamento): string {
  const canonico = JSON.stringify([normalizarValor(l.valor), l.tipo, l.descricao ?? null, l.data]);
  return createHash('sha256').update(canonico).digest('hex');
}
