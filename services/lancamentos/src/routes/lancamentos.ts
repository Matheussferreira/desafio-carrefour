import { NextFunction, Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db';
import { logger } from '../logger';
import { lancamentosCreatedTotal } from '../metrics';
import { isDataReal } from '../domain/data';
import { lancamentoSchema } from '../domain/lancamento';
import { ConflitoIdempotenciaError, LancamentoRow, registrarLancamento } from '../domain/lancamentoService';
import { sendProblem } from '../http/problem';
import { exigirEscopo } from '../middleware/auth';
import { codificarCursor, decodificarCursor, lerLimite, LIMITE_MAXIMO } from '../domain/paginacao';

const router = Router();

const COLUNAS = 'id, valor, tipo, descricao, data, created_at';

// POST /lancamentos
router.post('/', exigirEscopo('lancamentos.write'), async (req: Request, res: Response, next: NextFunction) => {
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
    // O comerciante vem do token (authMiddleware). Campos do corpo com esse nome são ignorados.
    const comercianteId = req.comercianteId as string;
    const { criado, lancamento } = await registrarLancamento(pool, comercianteId, parsed.data, {
      correlationId,
      idempotencyKey,
    });
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

// GET /lancamentos?data=&limite=&cursor=
// Paginação por cursor: do mais recente para o mais antigo (created_at, id). O cursor é o valor de
// proximoCursor da página anterior; `null` indica que não há mais páginas.
router.get('/', exigirEscopo('lancamentos.read'), async (req: Request, res: Response, next: NextFunction) => {
  const { data, cursor: cursorBruto } = req.query;

  if (data !== undefined && (typeof data !== 'string' || !isDataReal(data))) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', 'data deve ser uma data real no formato YYYY-MM-DD.');
    return;
  }
  const limite = lerLimite(req.query.limite);
  if (limite === null) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', `limite deve ser um inteiro entre 1 e ${LIMITE_MAXIMO}.`);
    return;
  }
  const cursor = cursorBruto === undefined ? undefined : typeof cursorBruto === 'string' ? decodificarCursor(cursorBruto) : null;
  if (cursor === null) {
    sendProblem(res, 400, 'invalid-cursor', 'Cursor inválido', 'Use o valor de proximoCursor devolvido pela página anterior.');
    return;
  }

  try {
    const comercianteId = req.comercianteId as string;
    const params: unknown[] = [comercianteId];
    const filtros = ['comerciante_id = $1'];
    if (data) {
      params.push(data);
      filtros.push(`data = $${params.length}`);
    }
    if (cursor) {
      params.push(cursor.criadoEm, cursor.id);
      filtros.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limite + 1); // uma linha a mais só para saber se existe próxima página

    const { rows } = await pool.query<LancamentoRow & { cursor_instante: string }>(
      `SELECT ${COLUNAS},
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_instante
         FROM lancamentos
        WHERE ${filtros.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length}`,
      params,
    );

    const temMais = rows.length > limite;
    const pagina = temMais ? rows.slice(0, limite) : rows;
    const ultimo = pagina[pagina.length - 1];
    res.json({
      itens: pagina.map(({ cursor_instante: _descartado, ...item }) => item),
      proximoCursor: temMais && ultimo ? codificarCursor({ criadoEm: ultimo.cursor_instante, id: ultimo.id }) : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
