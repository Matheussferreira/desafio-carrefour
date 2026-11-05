import rateLimit from 'express-rate-limit';

const LIMITE_PADRAO = 6_000;

// RATE_LIMIT_MAX existe para o teste determinístico do 429 (tests/load/limite-429.js).
// Valor ausente ou inválido volta ao padrão de produção.
export function limitePorMinuto(bruto: string | undefined = process.env.RATE_LIMIT_MAX): number {
  const n = Number(bruto);
  return Number.isInteger(n) && n > 0 ? n : LIMITE_PADRAO;
}

export function criarRateLimiter(max: number = limitePorMinuto()) {
  return rateLimit({
    windowMs: 60_000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please slow down' },
  });
}

export const rateLimiter = criarRateLimiter();
