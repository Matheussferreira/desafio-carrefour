import Redis from 'ioredis';
import { config } from './config';
import { logger } from './logger';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) throw new Error('Redis not initialized');
  return client;
}

/**
 * O Redis é um cache, então a falta dele tem de custar pouco: sem fila offline e com tempo
 * máximo por comando, uma queda vira erro imediato (e a leitura cai para o banco) em vez de
 * deixar a requisição esperando a reconexão.
 */
function novoCliente(): Redis {
  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
    retryStrategy: tentativas => Math.min(tentativas * 200, 2000),
  });
  let ultimoAviso = 0;
  redis.on('error', err => {
    // Um aviso a cada 10 s no máximo, para uma queda longa não inundar o log
    if (Date.now() - ultimoAviso > 10_000) {
      ultimoAviso = Date.now();
      logger.warn({ err: err.message }, 'Redis indisponível');
    }
  });
  return redis;
}

export async function connectRedis(maxAttempts = 15, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const redis = novoCliente();
    try {
      await redis.connect();
      await redis.ping();
      client = redis;
      logger.info('Redis connected');
      return;
    } catch (err) {
      redis.disconnect();
      logger.warn({ attempt, maxAttempts }, 'Redis not ready, retrying...');
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

export async function closeRedis(): Promise<void> {
  try {
    await client?.quit();
  } catch {
    client?.disconnect();
  }
}
