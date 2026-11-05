import { encerrarTracing } from './tracing';
import app from './app';
import { config } from './config';
import { logger } from './logger';
import { pool, waitForDb } from './db';
import { runMigrations } from './migrations';

// A API só escreve no banco (lançamento + outbox na mesma transação).
// A publicação no RabbitMQ é responsabilidade do processo lancamentos-relay.
async function main(): Promise<void> {
  logger.info('Starting lancamentos service...');

  await waitForDb();
  await runMigrations(pool);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'HTTP server listening');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutting down gracefully...');
    const forcar = setTimeout(() => process.exit(1), 10_000);
    server.close(async () => {
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
