// Executado via setupFiles ANTES de qualquer import de módulo nos testes.
// Garante que process.env está correto quando config.ts for carregado pela primeira vez.
// Os valores abaixo apontam para a infra do docker-compose.integration.yml.
// Se as env vars já estiverem definidas no shell (ex: via test-integration.sh), prevalece o shell.

process.env.RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://rabbit:rabbit@localhost:5673';
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/consolidado_db';
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
process.env.JWT_SECRET = 'integration-test-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
