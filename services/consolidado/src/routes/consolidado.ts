import { NextFunction, Request, Response, Router } from 'express';
import { pool } from '../db';
import { config } from '../config';
import { logger } from '../logger';
import { diasNoIntervalo, isDataReal } from '../domain/data';
import {
  consultarUltimoEventoAplicadoEm,
  consultarDia,
  consultarIntervalo,
  SaldoDia,
} from '../domain/saldoQueries';
import {
  gravarUltimoEventoAplicadoEm,
  gravarSaldo,
  lerUltimoEventoAplicadoEm,
  lerSaldo,
  versaoAtual,
} from '../cache/saldoCache';
import { sendProblem } from '../http/problem';

const router = Router();

/** ultimoEventoAplicadoEm vem do Redis (atualizado pelo consumidor a cada evento) e cai para o banco. */
async function obterUltimoEventoAplicadoEm(comercianteId: string): Promise<string | null> {
  try {
    const emCache = await lerUltimoEventoAplicadoEm(comercianteId);
    if (emCache) return emCache;
  } catch (err) {
    logger.warn({ err }, 'Redis indisponível ao ler ultimoEventoAplicadoEm, usando o banco');
  }
  const doBanco = await consultarUltimoEventoAplicadoEm(pool, comercianteId);
  if (doBanco) {
    try {
      await gravarUltimoEventoAplicadoEm(comercianteId, doBanco);
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
    const [itens, ultimoEventoAplicadoEm] = await Promise.all([
      consultarIntervalo(pool, comercianteId, inicio, fim),
      obterUltimoEventoAplicadoEm(comercianteId),
    ]);
    res.json({ comercianteId, inicio, fim, ultimoEventoAplicadoEm, dias: itens });
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

    // 1. Cache por comerciante, versão e data. A versão é lida ANTES de consultar o banco: se um
    //    evento for aplicado enquanto esta leitura está em andamento, a gravação abaixo cai numa
    //    versão velha, que ninguém mais lê. Falha do Redis não derruba a leitura.
    let versao: string | null = null;
    try {
      versao = await versaoAtual(comercianteId);
      saldo = await lerSaldo<SaldoDia>(comercianteId, versao, data);
    } catch (cacheErr) {
      logger.warn({ cacheErr }, 'Redis unavailable, falling back to database');
    }

    // 2. Banco. Dia sem movimento não é erro: vem com zeros e o acumulado vigente.
    if (!saldo) {
      source = 'database';
      saldo = await consultarDia(pool, comercianteId, data);
      if (versao !== null) {
        try {
          await gravarSaldo(comercianteId, versao, data, saldo);
        } catch {
          // não bloqueia a resposta
        }
      }
    }

    const ultimoEventoAplicadoEm = await obterUltimoEventoAplicadoEm(comercianteId);
    res.json({ source, comercianteId, ...saldo, ultimoEventoAplicadoEm });
  } catch (err) {
    next(err);
  }
});

export default router;
