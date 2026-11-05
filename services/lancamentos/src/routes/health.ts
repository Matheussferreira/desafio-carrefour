import { Router, Request, Response } from 'express';
import { pool } from '../db';

const router = Router();

// Liveness: o processo está vivo?
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'lancamentos' });
});

// Readiness: a API só depende do banco. O broker é problema do lancamentos-relay,
// então a API continua aceitando lançamentos com o RabbitMQ fora do ar.
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: String(err) });
  }
});

export default router;
