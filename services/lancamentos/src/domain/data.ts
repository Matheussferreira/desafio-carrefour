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
