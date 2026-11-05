// Códigos do PostgreSQL que indicam falha da infraestrutura ou da concorrência, e não do dado:
// classe 08 (conexão), 57P01 a 57P03 (desligamento ou "não aceita conexões"), 53300 (excesso de
// conexões), 40001 e 40P01 (serialização e deadlock) e 55P03 (lock indisponível).
const CODIGOS_PG = new Set(['57P01', '57P02', '57P03', '53300', '53400', '40001', '40P01', '55P03']);

const CODIGOS_REDE = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const MENSAGENS = [
  /connection terminated/i,
  /timeout exceeded when trying to connect/i,
  /terminating connection/i,
  /connection (?:ended|closed) unexpectedly/i,
  /client has encountered a connection error/i,
  /the database system is (?:starting up|shutting down|in recovery)/i,
  /not currently accepting connections/i,
];

/**
 * Diz se o erro vem de uma falha que passa sozinha (banco fora, conexão derrubada, tempo esgotado).
 * Esses erros nunca devem mandar a mensagem para a DLQ: o evento é válido e só precisa esperar.
 * Dado inválido e violação de regra (classe 22 e 23 do PostgreSQL, erro de programação) não entram aqui.
 */
export function erroTransitorio(err: unknown): boolean {
  if (err instanceof AggregateError) return err.errors.some(erroTransitorio);
  if (!(err instanceof Error)) return false;

  const codigo = (err as { code?: unknown }).code;
  if (typeof codigo === 'string') {
    if (codigo.startsWith('08') || CODIGOS_PG.has(codigo) || CODIGOS_REDE.has(codigo)) return true;
  }
  return MENSAGENS.some(r => r.test(err.message));
}
