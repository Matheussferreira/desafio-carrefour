import { NextFunction, Request, Response, Router } from 'express';
import { pool } from '../db';
import { getRedis } from '../redis';
import { config } from '../config';
import { logger } from '../logger';
import { isDataReal } from '../domain/data';
import { sendProblem } from '../http/problem';

const router = Router();

router.get('/:data', async (req: Request, res: Response, next: NextFunction) => {
  const { data } = req.params;

  if (!isDataReal(data)) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', 'data deve ser uma data real no formato YYYY-MM-DD.');
    return;
  }

  const cacheKey = `saldo:${data}`;

  try {
    // 1. Tenta servir do cache
    const cached = await getRedis().get(cacheKey);
    if (cached) {
      logger.debug({ data, source: 'cache' }, 'Serving from cache');
      res.json({ source: 'cache', ...JSON.parse(cached) });
      return;
    }
  } catch (cacheErr) {
    // Cache indisponível: segue para o banco sem interromper o fluxo
    logger.warn({ cacheErr }, 'Redis unavailable, falling back to database');
  }

  // 2. Fallback no banco
  try {
    const { rows } = await pool.query(
      `SELECT data, total_creditos, total_debitos, saldo, updated_at
       FROM saldo_diario
       WHERE data = $1`,
      [data],
    );

    if (rows.length === 0) {
      sendProblem(res, 404, 'not-found', 'Consolidado não encontrado', `Nenhum consolidado encontrado para ${data}.`);
      return;
    }

    const result = rows[0];

    // Guarda no cache com TTL; falha aqui não bloqueia a resposta
    try {
      await getRedis().setex(cacheKey, config.cacheTtlSeconds, JSON.stringify(result));
    } catch {
      // ignorado
    }

    logger.debug({ data, source: 'database' }, 'Serving from database');
    res.json({ source: 'database', ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
