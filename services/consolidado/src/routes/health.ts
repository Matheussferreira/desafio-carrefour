import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { broker } from '../rabbitmq';
import { consumerAtivo } from '../consumer/lancamentosConsumer';

const router = Router();

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'consolidado' });
});

// Fica vermelho quando o banco ou a conexão com o RabbitMQ caem. O Redis é só cache e fica de fora
// de propósito: sem ele a leitura cai para o banco, e tirar o serviço do balanceador pioraria a queda.
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    if (!broker.isConnected()) throw new Error('RabbitMQ desconectado');
    if (!consumerAtivo()) throw new Error('consumidor inativo');
    res.json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: String(err) });
  }
});

export default router;
