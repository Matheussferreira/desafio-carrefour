/** Espera antes da próxima tentativa: exponencial com teto e jitter parcial. */
export function backoffDelay(
  tentativa: number,
  baseMs = 500,
  maxMs = 15_000,
  aleatorio: () => number = Math.random,
): number {
  const teto = Math.min(maxMs, baseMs * 2 ** tentativa);
  return Math.round(teto / 2 + (aleatorio() * teto) / 2);
}
