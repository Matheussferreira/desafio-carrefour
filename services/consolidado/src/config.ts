import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3002),
  databaseUrl:
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:5432/consolidado_db',
  rabbitmqUrl:
    process.env.RABBITMQ_URL ?? 'amqp://rabbit:rabbit@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // Provedor de identidade (Keycloak). O issuer é validado por igualdade; o JWKS é buscado no
  // endereço de rede interno, que pode diferir do issuer público.
  oidcIssuer: process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/caixa',
  oidcJwksUri:
    process.env.OIDC_JWKS_URI ?? 'http://localhost:8080/realms/caixa/protocol/openid-connect/certs',
  oidcAudience: process.env.OIDC_AUDIENCE ?? 'consolidado-api',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  cacheTtlSeconds: Number(process.env.CACHE_TTL_SECONDS ?? 60),
  // Maior intervalo aceito em GET /consolidado?inicio=&fim=, em dias corridos (inclusive)
  maxDiasIntervalo: Number(process.env.MAX_DIAS_INTERVALO ?? 92),
};
