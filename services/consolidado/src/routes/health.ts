import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { getRedis } from '../redis';
import { broker } from '../rabbitmq';
import { consumerAtivo } from '../consumer/lancamentosConsumer';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'consolidado' });
});

// Fica vermelho quando o banco, o Redis ou a conexão com o RabbitMQ caem
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    await getRedis().ping();
    if (!broker.isConnected()) throw new Error('RabbitMQ desconectado');
    if (!consumerAtivo()) throw new Error('consumidor inativo');
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: String(err) });
  }
});

export default router;
