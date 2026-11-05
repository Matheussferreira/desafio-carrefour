import { Pool, types } from 'pg';
import { config } from './config';
import { logger } from './logger';

// DATE (oid 1082) volta como "YYYY-MM-DD". O parser padrão cria um Date no fuso do
// processo, que serializa como timestamp e desloca o dia conforme o TZ.
types.setTypeParser(1082, valor => valor);

export const pool = new Pool({ connectionString: config.databaseUrl });

export async function waitForDb(maxAttempts = 15, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await pool.connect();
      client.release();
      logger.info('Database connection established');
      return;
    } catch (err) {
      logger.warn({ attempt, maxAttempts }, 'Database not ready, retrying...');
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}
