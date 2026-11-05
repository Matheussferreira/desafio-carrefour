import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3002),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/consolidado_db',
  rabbitmqUrl:
    process.env.RABBITMQ_URL ?? 'amqp://rabbit:rabbit@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-in-production',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 60),
  // Maior intervalo aceito em GET /consolidado?inicio=&fim=, em dias corridos (inclusive)
  maxDiasIntervalo: Number(process.env.MAX_DIAS_INTERVALO ?? 92),
};
