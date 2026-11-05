import Decimal from 'decimal.js';
import type { Pool } from 'pg';

export interface SaldoDia {
  data: string;
  totalCreditos: string;
  totalDebitos: string;
  /** Créditos menos débitos apenas do dia. */
  resultadoDia: string;
  /** Soma do resultado de todos os dias do comerciante até esta data, inclusive. */
  saldoAcumulado: string;
}

const dinheiro = (v: string | number): string => new Decimal(v).toFixed(2);

/**
 * Saldo de um dia e acumulado até ele, em uma única consulta (mesmo snapshot).
 * Dia sem movimento devolve zeros no dia e o acumulado vigente.
 * A soma percorre as linhas do comerciante até a data pelo índice da chave primária
 * (comerciante_id, data).
 */
export async function consultarDia(pool: Pool, comercianteId: string, data: string): Promise<SaldoDia> {
  const { rows } = await pool.query<{ creditos: string; debitos: string; resultado: string; acumulado: string }>(
    `SELECT
       COALESCE(SUM(total_creditos) FILTER (WHERE data = $2::date), 0) AS creditos,
       COALESCE(SUM(total_debitos)  FILTER (WHERE data = $2::date), 0) AS debitos,
       COALESCE(SUM(saldo)          FILTER (WHERE data = $2::date), 0) AS resultado,
       COALESCE(SUM(saldo), 0)                                         AS acumulado
     FROM saldo_diario
     WHERE comerciante_id = $1 AND data <= $2::date`,
    [comercianteId, data],
  );
  const r = rows[0];
  return {
    data,
    totalCreditos: dinheiro(r.creditos),
    totalDebitos: dinheiro(r.debitos),
    resultadoDia: dinheiro(r.resultado),
    saldoAcumulado: dinheiro(r.acumulado),
  };
}

/**
 * Um item por dia do intervalo, inclusive dias sem movimento. O acumulado parte da soma de tudo
 * o que veio antes do início e segue somando dia a dia.
 */
export async function consultarIntervalo(
  pool: Pool,
  comercianteId: string,
  inicio: string,
  fim: string,
): Promise<SaldoDia[]> {
  const { rows } = await pool.query<{
    data: string;
    creditos: string;
    debitos: string;
    resultado: string;
    acumulado: string;
  }>(
    `WITH dias AS (
       SELECT d::date AS data
       FROM generate_series($2::date, $3::date, interval '1 day') AS d
     ),
     anterior AS (
       SELECT COALESCE(SUM(saldo), 0) AS total
       FROM saldo_diario
       WHERE comerciante_id = $1 AND data < $2::date
     )
     SELECT dias.data,
            COALESCE(s.total_creditos, 0) AS creditos,
            COALESCE(s.total_debitos, 0)  AS debitos,
            COALESCE(s.saldo, 0)          AS resultado,
            anterior.total + SUM(COALESCE(s.saldo, 0)) OVER (ORDER BY dias.data) AS acumulado
     FROM dias
     CROSS JOIN anterior
     LEFT JOIN saldo_diario s ON s.comerciante_id = $1 AND s.data = dias.data
     ORDER BY dias.data`,
    [comercianteId, inicio, fim],
  );
  return rows.map(r => ({
    data: r.data,
    totalCreditos: dinheiro(r.creditos),
    totalDebitos: dinheiro(r.debitos),
    resultadoDia: dinheiro(r.resultado),
    saldoAcumulado: dinheiro(r.acumulado),
  }));
}

/** Instante (ISO) do último evento aplicado para o comerciante, ou null se nunca houve. */
export async function consultarAtualizadoAte(pool: Pool, comercianteId: string): Promise<string | null> {
  const { rows } = await pool.query<{ ultimo_evento_em: Date }>(
    'SELECT ultimo_evento_em FROM comerciante_progresso WHERE comerciante_id = $1',
    [comercianteId],
  );
  return rows.length > 0 ? rows[0].ultimo_evento_em.toISOString() : null;
}
