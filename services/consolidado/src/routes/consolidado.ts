import { NextFunction, Request, Response, Router } from 'express';
import { pool } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { diasNoIntervalo, isDataReal } from '../domain/data';
import {
  consultarAtualizadoAte,
  consultarDia,
  consultarIntervalo,
  SaldoDia,
} from '../domain/saldoQueries';
import {
  gravarAtualizadoAte,
  gravarSaldo,
  lerAtualizadoAte,
  lerSaldo,
} from '../cache/saldoCache';
import { sendProblem } from '../http/problem';

const router = Router();

/** atualizadoAte vem do Redis (atualizado pelo consumidor a cada evento) e cai para o banco. */
async function obterAtualizadoAte(comercianteId: string): Promise<string | null> {
  try {
    const emCache = await lerAtualizadoAte(comercianteId);
    if (emCache) return emCache;
  } catch (err) {
    logger.warn({ err }, 'Redis indisponível ao ler atualizadoAte, usando o banco');
  }
  const doBanco = await consultarAtualizadoAte(pool, comercianteId);
  if (doBanco) {
    try {
      await gravarAtualizadoAte(comercianteId, doBanco);
    } catch {
      // cache é otimização
    }
  }
  return doBanco;
}

// GET /consolidado?inicio=YYYY-MM-DD&fim=YYYY-MM-DD
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { inicio, fim } = req.query;
  const comercianteId = req.comercianteId as string;

  if (typeof inicio !== 'string' || typeof fim !== 'string' || !isDataReal(inicio) || !isDataReal(fim)) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos',
      'Informe inicio e fim como datas reais no formato YYYY-MM-DD.');
    return;
  }
  if (inicio > fim) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', 'inicio não pode ser posterior a fim.');
    return;
  }
  const dias = diasNoIntervalo(inicio, fim);
  if (dias > config.maxDiasIntervalo) {
    sendProblem(res, 400, 'interval-too-large', 'Intervalo grande demais',
      `O intervalo tem ${dias} dias e o máximo é ${config.maxDiasIntervalo}.`, { maxDias: config.maxDiasIntervalo });
    return;
  }

  try {
    const [itens, atualizadoAte] = await Promise.all([
      consultarIntervalo(pool, comercianteId, inicio, fim),
      obterAtualizadoAte(comercianteId),
    ]);
    res.json({ comercianteId, inicio, fim, atualizadoAte, dias: itens });
  } catch (err) {
    next(err);
  }
});

// GET /consolidado/:data
router.get('/:data', async (req: Request, res: Response, next: NextFunction) => {
  const { data } = req.params;
  const comercianteId = req.comercianteId as string;

  if (!isDataReal(data)) {
    sendProblem(res, 400, 'validation-error', 'Dados inválidos', 'data deve ser uma data real no formato YYYY-MM-DD.');
    return;
  }

  try {
    let saldo: SaldoDia | null = null;
    let source: 'cache' | 'database' = 'cache';

    // 1. Cache por comerciante e data. Falha do Redis não derruba a leitura.
    try {
      saldo = await lerSaldo<SaldoDia>(comercianteId, data);
    } catch (cacheErr) {
      logger.warn({ cacheErr }, 'Redis unavailable, falling back to database');
    }

    // 2. Banco. Dia sem movimento não é erro: vem com zeros e o acumulado vigente.
    if (!saldo) {
      source = 'database';
      saldo = await consultarDia(pool, comercianteId, data);
      try {
        await gravarSaldo(comercianteId, data, saldo);
      } catch {
        // não bloqueia a resposta
      }
    }

    const atualizadoAte = await obterAtualizadoAte(comercianteId);
    res.json({ source, comercianteId, ...saldo, atualizadoAte });
  } catch (err) {
    next(err);
  }
});

export default router;
