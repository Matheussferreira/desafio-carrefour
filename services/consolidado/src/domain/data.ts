const FORMATO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Aceita apenas datas reais do calendário no formato YYYY-MM-DD (2026-02-30 é rejeitada). */
export function isDataReal(valor: string): boolean {
  const m = FORMATO.exec(valor);
  if (!m) return false;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (ano < 1900) return false;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

const MS_POR_DIA = 86_400_000;

/** Quantidade de dias corridos entre duas datas YYYY-MM-DD válidas, contando as duas pontas. */
export function diasNoIntervalo(inicio: string, fim: string): number {
  const [ai, mi, di] = inicio.split('-').map(Number);
  const [af, mf, df] = fim.split('-').map(Number);
  return Math.round((Date.UTC(af, mf - 1, df) - Date.UTC(ai, mi - 1, di)) / MS_POR_DIA) + 1;
}
