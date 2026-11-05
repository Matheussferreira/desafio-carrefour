/**
 * Upgrade da migration 002 sobre saldos que já existiam, em um banco temporário:
 * sobe o schema até a 001, grava saldos por data e aplica o restante.
 */
import { Pool } from 'pg';
import '../../src/db'; // registra o parser de DATE como string
import { consultarDia } from '../../src/domain/saldoQueries';
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

describe('migration 002_multi_comerciante sobre dados existentes', () => {
  it('saldos antigos viram do comerciante padrao e a chave primária passa a ser composta', async () => {
    await runMigrations(pool, '001_create_tables');
    await pool.query(
      `INSERT INTO saldo_diario (data, total_creditos, total_debitos, saldo)
       VALUES ('2026-01-10', 100.00, 20.00, 80.00), ('2026-01-12', 50.00, 0, 50.00)`,
    );

    await runMigrations(pool);

    const { rows } = await pool.query('SELECT comerciante_id, data, saldo FROM saldo_diario ORDER BY data');
    expect(rows).toEqual([
      { comerciante_id: 'padrao', data: '2026-01-10', saldo: '80.00' },
      { comerciante_id: 'padrao', data: '2026-01-12', saldo: '50.00' },
    ]);

    // As consultas novas enxergam os dados antigos como do comerciante padrao
    expect(await consultarDia(pool, 'padrao', '2026-01-12')).toMatchObject({
      resultadoDia: '50.00',
      saldoAcumulado: '130.00',
    });
    expect(await consultarDia(pool, 'outra-loja', '2026-01-12')).toMatchObject({ saldoAcumulado: '0.00' });

    // Outro comerciante pode ter a mesma data; o mesmo comerciante, não
    await pool.query(
      `INSERT INTO saldo_diario (comerciante_id, data, saldo) VALUES ('outra-loja', '2026-01-10', 1.00)`,
    );
    await expect(
      pool.query(`INSERT INTO saldo_diario (comerciante_id, data, saldo) VALUES ('padrao', '2026-01-10', 1.00)`),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('cria a tabela de progresso e é idempotente', async () => {
    await expect(runMigrations(pool)).resolves.toBeUndefined();
    const { rows } = await pool.query("SELECT to_regclass('comerciante_progresso') AS t");
    expect(rows[0].t).toBe('comerciante_progresso');
  });
});
