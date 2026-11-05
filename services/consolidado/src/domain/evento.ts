import Decimal from 'decimal.js';
import { z } from 'zod';
import { isDataReal } from './data';

export const eventoSchema = z.object({
  eventoId: z.string().uuid(),
  schemaVersion: z.string().optional(),
  tipo: z.literal('LancamentoRegistrado'),
  correlationId: z.string().optional(),
  createdAt: z.string().optional(),
  data: z.object({
    lancamentoId: z.string().uuid(),
    // Decimal em string, até 13 dígitos inteiros e 2 casas (cabe em NUMERIC(15,2))
    valor: z
      .string()
      .regex(/^\d{1,13}(\.\d{1,2})?$/)
      .refine(v => /[1-9]/.test(v)),
    tipo: z.enum(['credito', 'debito']),
    descricao: z.string().nullish(),
    data: z.string().refine(isDataReal, 'data deve ser YYYY-MM-DD e existir no calendário'),
  }),
});

export type EventoLancamentoRegistrado = z.infer<typeof eventoSchema>;

export type MensagemInterpretada =
  | { tipo: 'evento'; evento: EventoLancamentoRegistrado }
  | { tipo: 'ignorado'; tipoEvento: string }
  | { tipo: 'invalido'; motivo: string };

/** Converte o corpo da mensagem em evento tipado, sem lançar exceção. */
export function interpretarMensagem(corpo: string): MensagemInterpretada {
  let bruto: unknown;
  try {
    bruto = JSON.parse(corpo);
  } catch {
    return { tipo: 'invalido', motivo: 'JSON inválido' };
  }
  if (typeof bruto !== 'object' || bruto === null) {
    return { tipo: 'invalido', motivo: 'corpo não é um objeto' };
  }
  const tipoEvento = (bruto as { tipo?: unknown }).tipo;
  if (typeof tipoEvento === 'string' && tipoEvento !== 'LancamentoRegistrado') {
    // Evento de outro tipo: compatibilidade futura, reconhece e segue sem processar.
    return { tipo: 'ignorado', tipoEvento };
  }
  const r = eventoSchema.safeParse(bruto);
  if (!r.success) {
    const motivo = r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { tipo: 'invalido', motivo };
  }
  return { tipo: 'evento', evento: r.data };
}

export interface DeltaSaldo {
  creditos: string;
  debitos: string;
  saldo: string;
}

/** Quanto o evento soma em créditos, débitos e saldo do dia. Débito reduz o saldo. */
export function calcularDelta(tipo: 'credito' | 'debito', valor: string): DeltaSaldo {
  const v = new Decimal(valor);
  if (tipo === 'credito') {
    return { creditos: v.toFixed(2), debitos: '0.00', saldo: v.toFixed(2) };
  }
  return { creditos: '0.00', debitos: v.toFixed(2), saldo: v.negated().toFixed(2) };
}
