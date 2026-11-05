// Executado antes de qualquer import dos testes, para que o config.ts leia estas variáveis.
// Apontam para a infra do docker-compose.integration.yml; o que já estiver definido no shell prevalece.
process.env.RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://rabbit:rabbit@localhost:5673';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/lancamentos_db';
process.env.JWT_SECRET = 'integration-test-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
