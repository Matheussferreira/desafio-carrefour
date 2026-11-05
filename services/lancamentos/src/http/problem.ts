import { NextFunction, Request, Response } from 'express';
import { logger } from '../logger';

export interface ProblemExtras {
  errors?: Array<{ campo: string; mensagem: string }>;
  [chave: string]: unknown;
}

/** Resposta de erro no formato RFC 7807 (application/problem+json). */
export function sendProblem(
  res: Response,
  status: number,
  slug: string,
  title: string,
  detail?: string,
  extras: ProblemExtras = {},
): void {
  res
    .status(status)
    .type('application/problem+json')
    .json({ type: `/problems/${slug}`, title, status, ...(detail ? { detail } : {}), ...extras });
}

export function notFoundHandler(_req: Request, res: Response): void {
  sendProblem(res, 404, 'not-found', 'Recurso não encontrado');
}

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const tipo = (err as { type?: string } | null)?.type;
  if (tipo === 'entity.parse.failed') {
    sendProblem(res, 400, 'invalid-json', 'JSON inválido', 'O corpo da requisição não é um JSON válido.');
    return;
  }
  if (tipo === 'entity.too.large') {
    sendProblem(res, 413, 'payload-too-large', 'Corpo da requisição grande demais');
    return;
  }
  logger.error({ err }, 'Erro não tratado');
  sendProblem(res, 500, 'internal-error', 'Erro interno');
}
