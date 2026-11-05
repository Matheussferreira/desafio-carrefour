import type { ConfirmChannel, Message } from 'amqplib';
import express from 'express';
import { config } from './config';
import { logger } from './logger';
import { pool, waitForDb } from './db';
import { criarBroker } from './rabbitmq';
import { iniciarLoopRelay, relayTick } from './relay/outboxRelay';
import { register } from './metrics';

// Processo separado da API: publica o outbox no RabbitMQ.
// Pode ser escalado sem duplicar eventos (FOR UPDATE SKIP LOCKED).
async function main(): Promise<void> {
  logger.info('Iniciando lancamentos-relay...');
  await waitForDb();

  const devolvidas = new Set<string>();
  const broker = criarBroker();
  broker.on('connected', (canal: ConfirmChannel) => {
    canal.on('return', (msg: Message) => {
      const id = msg.properties.messageId as string | undefined;
      if (id) devolvidas.add(id);
    });
  });
  broker.start();

  const loop = iniciarLoopRelay({
    intervaloMs: config.outboxIntervalMs,
    tamanhoLote: config.outboxBatchSize,
    ciclo: async () => {
      if (!broker.isConnected()) return 0;
      return relayTick({
        pool,
        canal: broker.getChannel(),
        devolvidas,
        tamanhoLote: config.outboxBatchSize,
      });
    },
  });

  const app = express();
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'lancamentos-relay' });
  });
  app.get('/ready', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      if (!broker.isConnected()) throw new Error('RabbitMQ desconectado');
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'not ready', error: String(err) });
    }
  });
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  });
  const server = app.listen(config.relayPort, () => {
    logger.info({ port: config.relayPort }, 'Relay: endpoints de saúde e métricas no ar');
  });

  const encerrar = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Encerrando relay...');
    const forcar = setTimeout(() => process.exit(1), 10_000);
    await loop.parar();
    await broker.close();
    server.close();
    await pool.end();
    clearTimeout(forcar);
    process.exit(0);
  };
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
  process.on('SIGINT', () => void encerrar('SIGINT'));
}

main().catch(err => {
  console.error('Falha ao iniciar o relay:', err);
  process.exit(1);
});
