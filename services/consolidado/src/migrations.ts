import { Pool } from 'pg';
import { logger } from './logger';

const migrations = [
  {
    name: '001_create_tables',
    sql: `
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";

      CREATE TABLE IF NOT EXISTS saldo_diario (
        data            DATE          PRIMARY KEY,
        total_creditos  NUMERIC(15,2) NOT NULL DEFAULT 0,
        total_debitos   NUMERIC(15,2) NOT NULL DEFAULT 0,
        saldo           NUMERIC(15,2) NOT NULL DEFAULT 0,
        updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS eventos_processados (
        evento_id    UUID        PRIMARY KEY,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
  {
    // Multi-comerciante. A chave primária de saldo_diario passa a ser (comerciante_id, data), o
    // que também serve o índice da soma acumulada por intervalo de datas. Linhas existentes
    // ficam com o comerciante padrao. comerciante_progresso guarda, por comerciante, o instante
    // do último evento aplicado (campo atualizadoAte da API).
    name: '002_multi_comerciante',
    sql: `
      ALTER TABLE saldo_diario ADD COLUMN IF NOT EXISTS comerciante_id TEXT NOT NULL DEFAULT 'padrao';
      ALTER TABLE saldo_diario ALTER COLUMN comerciante_id DROP DEFAULT;
      ALTER TABLE saldo_diario DROP CONSTRAINT IF EXISTS saldo_diario_pkey;
      ALTER TABLE saldo_diario ADD PRIMARY KEY (comerciante_id, data);

      CREATE TABLE IF NOT EXISTS comerciante_progresso (
        comerciante_id    TEXT        PRIMARY KEY,
        ultimo_evento_em  TIMESTAMPTZ NOT NULL,
        processado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `,
  },
];

/** Aplica as migrations pendentes. O parâmetro `ate` (nome da migration) existe para testar upgrades. */
export async function runMigrations(pool: Pool, ate?: string): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id     SERIAL      PRIMARY KEY,
      name   TEXT        UNIQUE NOT NULL,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
