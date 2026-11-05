import { Pool } from 'pg';
import { logger } from './logger';

const migrations = [
  {
    name: '001_create_tables',
    sql: `
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS lancamentos (
        id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        valor            NUMERIC(15,2) NOT NULL CHECK (valor > 0),
        tipo             VARCHAR(10)   NOT NULL CHECK (tipo IN ('credito','debito')),
        descricao        TEXT,
        data             DATE          NOT NULL,
        idempotency_key  TEXT          UNIQUE,
        created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_lancamentos_data ON lancamentos(data);

      CREATE TABLE IF NOT EXISTS outbox (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tipo_evento  TEXT        NOT NULL,
        payload      JSONB       NOT NULL,
        status       VARCHAR(20) NOT NULL DEFAULT 'pendente'
                     CHECK (status IN ('pendente','publicado')),
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status) WHERE status = 'pendente';
    `,
  },
  {
    // Impressão digital do corpo, para responder 409 quando a chave de idempotência
    // é reutilizada com outro conteúdo.
    name: '002_request_hash',
    sql: `
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS request_hash TEXT;
    `,
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id       SERIAL      PRIMARY KEY,
      name     TEXT        UNIQUE NOT NULL,
      ran_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  for (const m of migrations) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM _migrations WHERE name = $1',
      [m.name],
    );
    if (rowCount && rowCount > 0) continue;

    await pool.query(m.sql);
    await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name]);
    logger.info({ migration: m.name }, 'Migration applied');
  }
}
