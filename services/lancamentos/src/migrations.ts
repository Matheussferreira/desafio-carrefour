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
  {
    // Multi-comerciante. Linhas existentes ficam com o comerciante padrao e o default é
    // removido em seguida, para que o código seja obrigado a informar o comerciante.
    // A chave de idempotência passa a ser única por comerciante. Eventos já gravados no
    // outbox não são reescritos: o consumidor aceita schemaVersion 1.0 como comerciante padrao.
    name: '003_multi_comerciante',
    sql: `
      ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS comerciante_id TEXT NOT NULL DEFAULT 'padrao';
      ALTER TABLE lancamentos ALTER COLUMN comerciante_id DROP DEFAULT;

      ALTER TABLE lancamentos DROP CONSTRAINT IF EXISTS lancamentos_idempotency_key_key;
      ALTER TABLE lancamentos
        ADD CONSTRAINT lancamentos_comerciante_idempotency_key UNIQUE (comerciante_id, idempotency_key);

      DROP INDEX IF EXISTS idx_lancamentos_data;
      CREATE INDEX IF NOT EXISTS idx_lancamentos_comerciante_data ON lancamentos (comerciante_id, data);
    `,
  },
  {
    // Contexto de trace (W3C traceparent) da requisição que gerou o evento. O relay o usa para
    // continuar o mesmo trace ao publicar, mesmo que isso aconteça segundos depois.
    name: '004_outbox_traceparent',
    sql: `
      ALTER TABLE outbox ADD COLUMN IF NOT EXISTS traceparent TEXT;
    `,
  },
  {
    // Paginação por cursor de GET /lancamentos: ordem (comerciante, mais recente primeiro, id como desempate).
    name: '005_indice_listagem',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_lancamentos_comerciante_criado
        ON lancamentos (comerciante_id, created_at DESC, id DESC);
    `,
  },
];

/** Aplica as migrations pendentes. O parâmetro `ate` (nome da migration) existe para testar upgrades. */
export async function runMigrations(pool: Pool, ate?: string): Promise<void> {
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
    if (rowCount && rowCount > 0) {
      if (ate && m.name === ate) return;
      continue;
    }

    await pool.query(m.sql);
    await pool.query('INSERT INTO _migrations (name) VALUES ($1)', [m.name]);
    logger.info({ migration: m.name }, 'Migration applied');
    if (ate && m.name === ate) return;
  }
}
