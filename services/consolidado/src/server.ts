import { encerrarTracing } from './tracing';
import app from './app';
import { config } from './config';
import { logger } from './logger';
import { pool, waitForDb } from './db';
import { runMigrations } from './migrations';
import { broker } from './rabbitmq';
import { connectRedis, closeRedis } from './redis';
import { iniciarConsumidor, stopConsumer } from './consumer/lancamentosConsumer';

async function main(): Promise<void> {
  logger.info('Starting consolidado service...');

  await waitForDb();
  await runMigrations(pool);
  await connectRedis();

  // O consumidor se registra a cada (re)conexão. O HTTP sobe sem esperar o broker:
  // a leitura do saldo continua funcionando e /ready indica o estado da conexão.
  iniciarConsumidor(broker);
  broker.start();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'HTTP server listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down gracefully...');
    const forcar = setTimeout(() => {
      logger.error('Shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, 10_000);

    // 1. Para de aceitar novas conexões HTTP
    server.close(async () => {
      // 2. Cancela o consumer e aguarda a mensagem em andamento terminar
      await stopConsumer();
      // 3. Fecha conexões em ordem reversa de dependência
      await broker.close();
      await closeRedis();
      await pool.end();
      await encerrarTracing();
      clearTimeout(forcar);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
