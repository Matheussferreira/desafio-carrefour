import Decimal from 'decimal.js';
import { z } from 'zod';
import { COMERCIANTE_PADRAO, isComercianteId } from './comerciante';
import { isDataReal } from './data';

/**
 * Contrato do evento LancamentoRegistrado. Política de versionamento em docs/eventos.md:
 *  - 1.0: sem comercianteId (assume o comerciante padrão)
 *  - 1.1: comercianteId obrigatório
 *  - 1.x seguintes: apenas campos novos opcionais; este consumidor ignora o que não conhece
 *  - 2.x: mudança incompatível; este consumidor recusa e a mensagem vai para a DLQ
 */
export const VERSAO_MAIOR_SUPORTADA = 1;

const versaoSchema = z.string().regex(/^\d+\.\d+$/, 'schemaVersion deve ser maior.menor, por exemplo 1.1');

export const eventoSchema = z
  .object({
    eventoId: z.string().uuid(),
    schemaVersion: versaoSchema.optional(),
    tipo: z.literal('LancamentoRegistrado'),
    comercianteId: z.string().optional(),
    correlationId: z.string().optional(),
    createdAt: z.string().datetime().optional(),
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
  })
  .superRefine((e, ctx) => {
    const [maior, menor] = (e.schemaVersion ?? '1.0').split('.').map(Number);
    if (maior !== VERSAO_MAIOR_SUPORTADA) {
      ctx.addIssue({ code: 'custom', path: ['schemaVersion'], message: `versão ${e.schemaVersion} não suportada` });
      return;
    }
    if (menor >= 1 && e.comercianteId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['comercianteId'], message: 'comercianteId é obrigatório a partir da 1.1' });
    }
    if (e.comercianteId !== undefined && !isComercianteId(e.comercianteId)) {
      ctx.addIssue({ code: 'custom', path: ['comercianteId'], message: 'comercianteId inválido' });
    }
  });

type EventoBruto = z.infer<typeof eventoSchema>;

/** Evento já normalizado: comercianteId sempre presente (1.0 recebe o comerciante padrão). */
export type EventoLancamentoRegistrado = Omit<EventoBruto, 'comercianteId'> & { comercianteId: string };

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
  return { tipo: 'evento', evento: { ...r.data, comercianteId: r.data.comercianteId ?? COMERCIANTE_PADRAO } };
}

export interface DeltaSaldo {
  creditos: string;
  debitos: string;
  saldo: string;
}

/** Quanto o evento soma em créditos, débitos e resultado do dia. Débito reduz o resultado. */
export function calcularDelta(tipo: 'credito' | 'debito', valor: string): DeltaSaldo {
  const v = new Decimal(valor);
  if (tipo === 'credito') {
    return { creditos: v.toFixed(2), debitos: '0.00', saldo: v.toFixed(2) };
  }
  return { creditos: '0.00', debitos: v.toFixed(2), saldo: v.negated().toFixed(2) };
}
