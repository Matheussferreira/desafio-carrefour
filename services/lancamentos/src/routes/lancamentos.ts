import { NextFunction, Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { logger } from '../logger';
import { lancamentosCreatedTotal } from '../metrics';
import { isDataReal } from '../domain/data';
import { lancamentoSchema } from '../domain/lancamento';
import { ConflitoIdempotenciaError, registrarLancamento } from '../domain/lancamentoService';
import { sendProblem } from '../http/problem';

const router = Router();

const COLUNAS = 'id, valor, tipo, descricao, data, created_at';

// POST /lancamentos
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? uuidv4();
  const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

  if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 255)) {
    sendProblem(res, 400, 'invalid-idempotency-key', 'Chave de idempotência inválida',
      'X-Idempotency-Key deve ter entre 1 e 255 caracteres.');
    return;
  }

  const parsed = lancamentoSchema.safeParse(req.body);
  if (!parsed.success) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', 'Um ou mais campos não passaram na validação.', {
      errors: parsed.error.issues.map(i => ({ campo: i.path.join('.') || 'corpo', mensagem: i.message })),
    });
    return;
  }

  try {
    const { criado, lancamento } = await registrarLancamento(pool, parsed.data, { correlationId, idempotencyKey });
    if (!criado) {
      logger.info({ correlationId, idempotencyKey }, 'Reenvio idempotente, devolvendo o lançamento original');
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(200).json(lancamento);
      return;
    }
    lancamentosCreatedTotal.inc({ tipo: parsed.data.tipo });
    logger.info({ correlationId, lancamentoId: lancamento.id }, 'Lancamento registered');
    res.status(201).json(lancamento);
  } catch (err) {
    if (err instanceof ConflitoIdempotenciaError) {
      sendProblem(res, 409, 'idempotency-key-conflict', 'Conflito de idempotência',
        'Esta X-Idempotency-Key já foi usada com um corpo diferente. Use outra chave para um novo lançamento.');
      return;
    }
    next(err);
  }
});

// GET /lancamentos
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const data = req.query.data;

  if (data !== undefined && (typeof data !== 'string' || !isDataReal(data))) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', 'data deve ser uma data real no formato YYYY-MM-DD.');
    return;
  }

  try {
    const { rows } = data
      ? await pool.query(`SELECT ${COLUNAS} FROM lancamentos WHERE data = $1 ORDER BY created_at`, [data])
      : await pool.query(`SELECT ${COLUNAS} FROM lancamentos ORDER BY created_at DESC LIMIT 100`);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
