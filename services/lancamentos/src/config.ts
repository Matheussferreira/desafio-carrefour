import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3001),
  relayPort: Number(process.env.RELAY_PORT ?? 3003),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/lancamentos_db',
  rabbitmqUrl:
    process.env.RABBITMQ_URL ?? 'amqp://rabbit:rabbit@localhost:5672',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 1000),
  outboxBatchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
};
