/**
 * Upgrade da migration 003 sobre dados que já existiam, em um banco temporário:
 * sobe o schema até a 002, grava lançamentos antigos e aplica o restante.
 */
import { Pool } from 'pg';
import { runMigrations } from '../../src/migrations';

const urlBase = process.env.DATABASE_URL as string;
const nomeBanco = `migracao_${Date.now()}`;
const urlAdmin = urlBase.replace(/\/[^/]+$/, '/postgres');
const urlTemporario = urlBase.replace(/\/[^/]+$/, `/${nomeBanco}`);

let admin: Pool;
let pool: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: urlAdmin });
  await admin.query(`CREATE DATABASE ${nomeBanco}`);
  pool = new Pool({ connectionString: urlTemporario });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${nomeBanco}`);
  await admin.end();
});

describe('migration 003_multi_comerciante sobre dados existentes', () => {
  it('lançamentos antigos ficam com o comerciante padrao e a chave passa a ser por comerciante', async () => {
    await runMigrations(pool, '002_request_hash');
    await pool.query(
      `INSERT INTO lancamentos (valor, tipo, data, idempotency_key)
       VALUES (10.00, 'credito', '2026-01-10', 'chave-antiga'), (5.00, 'debito', '2026-01-10', NULL)`,
    );

    await runMigrations(pool);

    const { rows } = await pool.query('SELECT comerciante_id, idempotency_key FROM lancamentos ORDER BY valor');
    expect(rows).toEqual([
      { comerciante_id: 'padrao', idempotency_key: null },
      { comerciante_id: 'padrao', idempotency_key: 'chave-antiga' },
    ]);

    // Outro comerciante pode reutilizar a chave; o mesmo comerciante, não
    await pool.query(
      `INSERT INTO lancamentos (comerciante_id, valor, tipo, data, idempotency_key)
       VALUES ('loja-2', 1.00, 'credito', '2026-01-10', 'chave-antiga')`,
    );
    await expect(
      pool.query(
        `INSERT INTO lancamentos (comerciante_id, valor, tipo, data, idempotency_key)
         VALUES ('padrao', 1.00, 'credito', '2026-01-10', 'chave-antiga')`,
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    // O default foi removido: o código é obrigado a informar o comerciante
    await expect(
      pool.query(`INSERT INTO lancamentos (valor, tipo, data) VALUES (1.00, 'credito', '2026-01-10')`),
    ).rejects.toThrow(/comerciante_id/);
  });

  it('é idempotente: rodar de novo não reaplica nem falha', async () => {
    await expect(runMigrations(pool)).resolves.toBeUndefined();
  });
});
