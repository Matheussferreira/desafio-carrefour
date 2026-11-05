import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3001),
  relayPort: Number(process.env.RELAY_PORT ?? 3003),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/lancamentos_db',
  rabbitmqUrl:
    process.env.RABBITMQ_URL ?? 'amqp://rabbit:rabbit@localhost:5672',
  // Provedor de identidade (Keycloak). O issuer é validado por igualdade; o JWKS é buscado no
  // endereço de rede interno, que pode diferir do issuer público.
  oidcIssuer: process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/caixa',
  oidcJwksUri:
    process.env.OIDC_JWKS_URI ?? 'http://localhost:8080/realms/caixa/protocol/openid-connect/certs',
  oidcAudience: process.env.OIDC_AUDIENCE ?? 'lancamentos-api',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 1000),
  outboxBatchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
};
