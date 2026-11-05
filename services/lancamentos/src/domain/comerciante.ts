/** Comerciante usado por tokens de desenvolvimento e por eventos antigos (schemaVersion 1.0). */
export const COMERCIANTE_PADRAO = 'padrao';

const FORMATO = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Identificador do comerciante: 1 a 64 caracteres entre letras, números, hífen e sublinhado.
 * Sem dois-pontos de propósito, porque entra em chaves de cache.
 */
export function isComercianteId(valor: unknown): valor is string {
  return typeof valor === 'string' && FORMATO.test(valor);
}
