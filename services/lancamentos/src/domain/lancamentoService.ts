import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { hashCorpo, NovoLancamento } from './lancamento';

export interface LancamentoRow {
  id: string;
  valor: string;
  tipo: 'credito' | 'debito';
  descricao: string | null;
  data: string;
  created_at: Date;
}

export interface ResultadoRegistro {
  criado: boolean;
  lancamento: LancamentoRow;
}

export class ConflitoIdempotenciaError extends Error {
  constructor(public readonly chave: string) {
    super(`Chave de idempotência ${chave} já foi usada com outro conteúdo`);
  }
}

/** Versão do contrato do evento publicado. Política de versionamento em docs/eventos.md. */
export const SCHEMA_VERSION_EVENTO = '1.1';

const COLUNAS = 'id, valor, tipo, descricao, data, created_at';

/**
 * Grava o lançamento e o evento do outbox na mesma transação.
 * A chave de idempotência vale por comerciante. Com a mesma chave: mesmo corpo devolve
 * o lançamento original, corpo diferente lança ConflitoIdempotenciaError.
 */
export async function registrarLancamento(
  pool: Pool,
  comercianteId: string,
  entrada: NovoLancamento,
  ctx: { correlationId: string; idempotencyKey?: string },
): Promise<ResultadoRegistro> {
  const hash = hashCorpo(entrada);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserido = await client.query<LancamentoRow>(
      `INSERT INTO lancamentos (comerciante_id, valor, tipo, descricao, data, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (comerciante_id, idempotency_key) DO NOTHING
       RETURNING ${COLUNAS}`,
      [comercianteId, entrada.valor, entrada.tipo, entrada.descricao ?? null, entrada.data, ctx.idempotencyKey ?? null, hash],
    );

    if (inserido.rows.length === 0) {
      // Só há conflito quando existe chave. Reenvio idêntico devolve o original.
      const { rows } = await client.query<LancamentoRow & { request_hash: string | null }>(
        `SELECT ${COLUNAS}, request_hash FROM lancamentos
         WHERE comerciante_id = $1 AND idempotency_key = $2`,
        [comercianteId, ctx.idempotencyKey],
      );
      await client.query('COMMIT');
      const existente = rows[0];
      if (!existente) throw new Error('Conflito de idempotência sem linha correspondente');
      if (existente.request_hash && existente.request_hash !== hash) {
        throw new ConflitoIdempotenciaError(ctx.idempotencyKey as string);
      }
      const { request_hash: _descartado, ...lancamento } = existente;
      return { criado: false, lancamento };
    }

    const lancamento = inserido.rows[0];
    const eventoId = uuidv4();
    const payload = {
      eventoId,
      schemaVersion: SCHEMA_VERSION_EVENTO,
      tipo: 'LancamentoRegistrado',
      comercianteId,
      correlationId: ctx.correlationId,
      createdAt: new Date().toISOString(),
      data: {
        lancamentoId: lancamento.id,
        valor: lancamento.valor,
        tipo: lancamento.tipo,
        descricao: lancamento.descricao,
        data: lancamento.data,
      },
    };

    await client.query(
      'INSERT INTO outbox (id, tipo_evento, payload) VALUES ($1, $2, $3)',
      [eventoId, 'LancamentoRegistrado', JSON.stringify(payload)],
    );
    await client.query('COMMIT');
    return { criado: true, lancamento };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
